/**
 * Mesh primitives for the asset pipeline: read a zipped OBJ set, measure a
 * closed surface, and cast rays at one.
 *
 * Deliberately dependency-free. The repository ships no runtime dependencies
 * and CI asserts that, so a pipeline that needed a mesh library would either
 * break that promise or live outside the repo where nobody could re-run it.
 * None of this is clever; it is a few hundred lines of arithmetic that the
 * numbers in docs/alc-1-body-template-audit.md are computed by, and it is in
 * the tree so those numbers can be re-derived.
 *
 * Coordinates are whatever the OBJ carries. `loadObj` does not transform
 * anything; the caller states the convention. See `tools/lib/bp3d.mjs`.
 */

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Zip reading
// ---------------------------------------------------------------------------

/**
 * The smallest zip reader that can open the BodyParts3D archive: central
 * directory, stored and deflated entries, no encryption, no zip64.
 *
 * Reading the archive directly rather than a pre-extracted directory is the
 * difference between a pipeline anyone can re-run from the published bytes and
 * one that depends on how somebody happened to unpack them. `unzip` is also
 * not installed on the CI image, which settled it.
 */
export function openZip(path) {
  const buf = readFileSync(path);
  // End of central directory record: signature 0x06054b50, scanned backwards
  // because it is followed by a variable-length comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${path}: no zip end-of-central-directory record`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path}: bad central directory header at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const read = (name) => {
    const e = entries.get(name);
    if (!e) throw new Error(`${path}: no entry ${name}`);
    if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) {
      throw new Error(`${path}: bad local header for ${name}`);
    }
    // The local header repeats the name and extra fields with its own lengths.
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compressedSize);
    if (e.method === 0) return raw;
    if (e.method === 8) return inflateRawSync(raw);
    throw new Error(`${path}: entry ${name} uses unsupported compression method ${e.method}`);
  };

  return { names: () => [...entries.keys()], has: (n) => entries.has(n), read };
}

// ---------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------

/**
 * Parse an OBJ into a flat vertex array and a triangle index array.
 *
 * Only `v` and `f` matter here. Faces are fan-triangulated, which is correct
 * for the convex planar polygons BodyParts3D emits and is the same thing every
 * renderer does with them.
 */
export function parseObj(text) {
  const V = [];
  const F = [];
  let line = 0;
  for (const raw of text.split('\n')) {
    line += 1;
    if (raw.charCodeAt(0) === 118 /* v */ && raw.charCodeAt(1) === 32) {
      const p = raw.split(/\s+/);
      const x = Number(p[1]); const y = Number(p[2]); const z = Number(p[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error(`OBJ line ${line}: non-finite vertex`);
      }
      V.push(x, y, z);
    } else if (raw.charCodeAt(0) === 102 /* f */ && raw.charCodeAt(1) === 32) {
      const p = raw.trim().split(/\s+/);
      const idx = [];
      for (let i = 1; i < p.length; i += 1) {
        const slash = p[i].indexOf('/');
        const n = parseInt(slash < 0 ? p[i] : p[i].slice(0, slash), 10);
        // OBJ indices are 1-based and may be negative (relative to the end).
        idx.push(n > 0 ? n - 1 : V.length / 3 + n);
      }
      for (let k = 1; k < idx.length - 1; k += 1) F.push(idx[0], idx[k], idx[k + 1]);
    }
  }
  return { V: Float64Array.from(V), F: Int32Array.from(F) };
}

/** Axis-aligned bounds of a vertex array. */
export function bounds(V) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const v = V[i + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  return { lo, hi };
}

/**
 * Volume and volume centroid of a closed triangle mesh, by the divergence
 * theorem over signed tetrahedra against the origin.
 *
 * Why not the vertex mean: vertex density in a decimated mesh follows local
 * curvature, not mass. On a thoracic vertebra the processes carry far more
 * vertices than the body does, so a vertex mean sits measurably posterior of
 * the centre of mass. `VertebralSlab.origin` is documented as a centroid, so
 * it should be the centroid of the solid.
 *
 * Returns `volume: 0` for a surface that is not closed enough to integrate,
 * which the caller must treat as a measurement failure rather than a zero.
 */
export function volumeCentroid(V, F) {
  let vol = 0;
  const c = [0, 0, 0];
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t] * 3; const b = F[t + 1] * 3; const d = F[t + 2] * 3;
    const ax = V[a]; const ay = V[a + 1]; const az = V[a + 2];
    const bx = V[b]; const by = V[b + 1]; const bz = V[b + 2];
    const cx = V[d]; const cy = V[d + 1]; const cz = V[d + 2];
    // Signed volume of the tetrahedron (origin, a, b, c), times 6.
    const v6 = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    vol += v6;
    c[0] += v6 * (ax + bx + cx);
    c[1] += v6 * (ay + by + cy);
    c[2] += v6 * (az + bz + cz);
  }
  if (vol === 0) return { volume: 0, centroid: [NaN, NaN, NaN] };
  return {
    volume: vol / 6,
    centroid: [c[0] / (4 * vol), c[1] / (4 * vol), c[2] / (4 * vol)],
  };
}

/** Area-weighted centroid of a triangle subset. Used where a region is not closed. */
export function areaCentroid(V, F, keep) {
  let area = 0;
  const c = [0, 0, 0];
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t] * 3; const b = F[t + 1] * 3; const d = F[t + 2] * 3;
    const gx = (V[a] + V[b] + V[d]) / 3;
    const gy = (V[a + 1] + V[b + 1] + V[d + 1]) / 3;
    const gz = (V[a + 2] + V[b + 2] + V[d + 2]) / 3;
    if (keep && !keep(gx, gy, gz)) continue;
    const ux = V[b] - V[a]; const uy = V[b + 1] - V[a + 1]; const uz = V[b + 2] - V[a + 2];
    const vx = V[d] - V[a]; const vy = V[d + 1] - V[a + 1]; const vz = V[d + 2] - V[a + 2];
    const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
    const w = Math.hypot(nx, ny, nz) / 2;
    area += w;
    c[0] += w * gx; c[1] += w * gy; c[2] += w * gz;
  }
  if (area === 0) return { area: 0, centroid: [NaN, NaN, NaN] };
  return { area, centroid: [c[0] / area, c[1] / area, c[2] / area] };
}

/**
 * Area-weighted principal axes of a triangle subset, smallest variance last.
 *
 * Used to measure the plane of the S1 endplate. Fitting a plane by least
 * variance needs no surface normals, which matters: at 99% decimation a single
 * triangle spans tens of millimetres, and selecting faces by their normal
 * direction picks up the sacral alae, which are superior-facing, lateral and
 * not the endplate.
 *
 * Jacobi rotation on the 3x3 covariance. Thirty lines, exact to machine
 * precision in a dozen sweeps, and no dependency.
 */
export function principalAxes(V, F, keep) {
  let w = 0;
  const m = [0, 0, 0];
  const samples = [];
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t] * 3; const b = F[t + 1] * 3; const d = F[t + 2] * 3;
    const g = [(V[a] + V[b] + V[d]) / 3, (V[a + 1] + V[b + 1] + V[d + 1]) / 3, (V[a + 2] + V[b + 2] + V[d + 2]) / 3];
    if (keep && !keep(g[0], g[1], g[2])) continue;
    const ux = V[b] - V[a]; const uy = V[b + 1] - V[a + 1]; const uz = V[b + 2] - V[a + 2];
    const vx = V[d] - V[a]; const vy = V[d + 1] - V[a + 1]; const vz = V[d + 2] - V[a + 2];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    if (!(area > 0)) continue;
    samples.push([g, area]);
    w += area;
    m[0] += area * g[0]; m[1] += area * g[1]; m[2] += area * g[2];
  }
  if (w === 0) return null;
  const mean = [m[0] / w, m[1] / w, m[2] / w];

  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const [g, area] of samples) {
    const d = [g[0] - mean[0], g[1] - mean[1], g[2] - mean[2]];
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) C[i][j] += (area * d[i] * d[j]) / w;
  }

  // Jacobi: rotate away the largest off-diagonal until none is left.
  let Q = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 64; sweep += 1) {
    let p = 0; let q = 1; let best = Math.abs(C[0][1]);
    for (const [i, j] of [[0, 2], [1, 2]]) {
      if (Math.abs(C[i][j]) > best) { best = Math.abs(C[i][j]); p = i; q = j; }
    }
    if (best < 1e-14) break;
    const theta = 0.5 * Math.atan2(2 * C[p][q], C[q][q] - C[p][p]);
    const c = Math.cos(theta); const s = Math.sin(theta);
    const R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    R[p][p] = c; R[q][q] = c; R[p][q] = s; R[q][p] = -s;
    // C <- R^T C R, Q <- Q R
    const mul = (A, B) => A.map((row, i) => B[0].map((_, j) => A[i].reduce((t, _v, k) => t + A[i][k] * B[k][j], 0)));
    const Rt = [0, 1, 2].map((i) => [0, 1, 2].map((j) => R[j][i]));
    const next = mul(mul(Rt, C), R);
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) C[i][j] = next[i][j];
    Q = mul(Q, R);
  }

  const order = [0, 1, 2].sort((a, b) => C[b][b] - C[a][a]);
  return {
    mean,
    area: w,
    triangles: samples.length,
    axes: order.map((i) => [Q[0][i], Q[1][i], Q[2][i]]),
    variances: order.map((i) => C[i][i]),
  };
}

/** Total surface area, and the mean triangle edge length derived from it. */
export function surfaceStats(V, F) {
  let area = 0;
  let edge = 0;
  const triangles = F.length / 3;
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t] * 3; const b = F[t + 1] * 3; const d = F[t + 2] * 3;
    const ux = V[b] - V[a]; const uy = V[b + 1] - V[a + 1]; const uz = V[b + 2] - V[a + 2];
    const vx = V[d] - V[a]; const vy = V[d + 1] - V[a + 1]; const vz = V[d + 2] - V[a + 2];
    const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
    area += Math.hypot(nx, ny, nz) / 2;
    edge += (Math.hypot(ux, uy, uz)
      + Math.hypot(vx, vy, vz)
      + Math.hypot(V[d] - V[b], V[d + 1] - V[b + 1], V[d + 2] - V[b + 2])) / 3;
  }
  return { area, triangles, meanEdgeMm: triangles === 0 ? NaN : edge / triangles };
}

// ---------------------------------------------------------------------------
// Ray casting
// ---------------------------------------------------------------------------

/**
 * A uniform voxel grid over a mesh, so a ray tests tens of triangles instead
 * of hundreds of thousands.
 *
 * The skin mesh is 203 382 triangles and the pipeline casts one fan per
 * vertebral level. Brute force is tolerable once and intolerable the moment
 * anyone wants to sweep a parameter, and a parameter sweep is how the
 * centreline rule below was chosen, so the grid earns its 60 lines.
 */
export function buildGrid(V, F, targetPerCell = 2) {
  const { lo, hi } = bounds(V);
  const triangles = F.length / 3;
  const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const volume = Math.max(1, span[0] * span[1] * span[2]);
  // Cell edge chosen so an average cell holds ~`targetPerCell` triangles.
  const cell = Math.max(1, Math.cbrt((volume * targetPerCell) / Math.max(1, triangles)));
  const dim = span.map((s) => Math.max(1, Math.ceil(s / cell)));
  const counts = new Int32Array(dim[0] * dim[1] * dim[2] + 1);

  const cellOf = (x, a) => {
    const i = Math.floor((x - lo[a]) / cell);
    return i < 0 ? 0 : i >= dim[a] ? dim[a] - 1 : i;
  };
  const triBox = (t) => {
    const a = F[t] * 3; const b = F[t + 1] * 3; const d = F[t + 2] * 3;
    const out = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 3; k += 1) {
      const v0 = V[a + k]; const v1 = V[b + k]; const v2 = V[d + k];
      out[k] = cellOf(Math.min(v0, v1, v2), k);
      out[k + 3] = cellOf(Math.max(v0, v1, v2), k);
    }
    return out;
  };

  // Two passes: count per cell, prefix-sum, then fill. Avoids an array of arrays.
  for (let t = 0; t < F.length; t += 3) {
    const [x0, y0, z0, x1, y1, z1] = triBox(t);
    for (let z = z0; z <= z1; z += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) counts[(z * dim[1] + y) * dim[0] + x + 1] += 1;
      }
    }
  }
  for (let i = 1; i < counts.length; i += 1) counts[i] += counts[i - 1];
  const starts = counts;
  const items = new Int32Array(starts[starts.length - 1]);
  const cursor = Int32Array.from(starts.subarray(0, starts.length - 1));
  for (let t = 0; t < F.length; t += 3) {
    const [x0, y0, z0, x1, y1, z1] = triBox(t);
    for (let z = z0; z <= z1; z += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const c = (z * dim[1] + y) * dim[0] + x;
          items[cursor[c]] = t;
          cursor[c] += 1;
        }
      }
    }
  }
  return { V, F, lo, hi, cell, dim, starts, items };
}

const EPS = 1e-9;

/** Möller-Trumbore, returning the ray parameter or -1. Two-sided. */
function rayTriangle(V, F, t, ox, oy, oz, dx, dy, dz) {
  const a = F[t] * 3; const b = F[t + 1] * 3; const c = F[t + 2] * 3;
  const e1x = V[b] - V[a]; const e1y = V[b + 1] - V[a + 1]; const e1z = V[b + 2] - V[a + 2];
  const e2x = V[c] - V[a]; const e2y = V[c + 1] - V[a + 1]; const e2z = V[c + 2] - V[a + 2];
  const px = dy * e2z - dz * e2y; const py = dz * e2x - dx * e2z; const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -EPS && det < EPS) return -1;
  const inv = 1 / det;
  const tx = ox - V[a]; const ty = oy - V[a + 1]; const tz = oz - V[a + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -EPS || u > 1 + EPS) return -1;
  const qx = ty * e1z - tz * e1y; const qy = tz * e1x - tx * e1z; const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -EPS || u + v > 1 + EPS) return -1;
  const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return s > EPS ? s : -1;
}

/**
 * Distance from `origin` to the FIRST surface crossing along `dir`, or -1 if
 * the ray leaves the mesh's bounds without hitting anything.
 *
 * First, not farthest, and the choice is load bearing. `surfaceRadiiMm` is the
 * distance to the body surface that bounds the trunk containing the spine. A
 * ray cast laterally at T06 leaves the thorax at about 150 mm, enters the arm,
 * and leaves it again at about 230 mm; the farthest crossing would put the
 * skin of a `BD` address outside the arm and inflate every thoracic radius by
 * the width of the limb beside it. The first crossing is the trunk.
 *
 * Returns -1 rather than a guess. The caller must report that azimuth
 * UNVERIFIED; a missing measurement is not a radius.
 */
export function firstHit(grid, origin, dir, maxDistance = Infinity) {
  const { V, F, lo, hi, cell, dim, starts, items } = grid;
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;

  // Clip the ray to the grid bounds so the traversal starts inside.
  let tEnter = 0;
  let tExit = maxDistance;
  for (let a = 0; a < 3; a += 1) {
    const o = origin[a]; const d = dir[a];
    if (Math.abs(d) < 1e-12) {
      if (o < lo[a] || o > hi[a]) return -1;
      continue;
    }
    let t0 = (lo[a] - o) / d;
    let t1 = (hi[a] - o) / d;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > tEnter) tEnter = t0;
    if (t1 < tExit) tExit = t1;
    if (tEnter > tExit) return -1;
  }

  const at = (t, a) => origin[a] + dir[a] * t;
  const idx = (t, a) => {
    const i = Math.floor((at(t, a) - lo[a]) / cell);
    return i < 0 ? 0 : i >= dim[a] ? dim[a] - 1 : i;
  };
  let cx = idx(tEnter, 0); let cy = idx(tEnter, 1); let cz = idx(tEnter, 2);

  const step = [0, 0, 0];
  const tDelta = [0, 0, 0];
  const tMax = [0, 0, 0];
  const c0 = [cx, cy, cz];
  for (let a = 0; a < 3; a += 1) {
    const d = dir[a];
    if (Math.abs(d) < 1e-12) { step[a] = 0; tDelta[a] = Infinity; tMax[a] = Infinity; continue; }
    step[a] = d > 0 ? 1 : -1;
    tDelta[a] = Math.abs(cell / d);
    const boundary = lo[a] + (c0[a] + (d > 0 ? 1 : 0)) * cell;
    tMax[a] = (boundary - origin[a]) / d;
  }

  let best = -1;
  // Amanatides-Woo traversal. Stop one cell after the first hit, because a
  // triangle straddling a cell boundary can be reached from the next cell with
  // a smaller parameter than one found in this cell.
  let guard = 0;
  const limit = (dim[0] + dim[1] + dim[2]) * 3 + 8;
  for (;;) {
    const c = (cz * dim[1] + cy) * dim[0] + cx;
    for (let i = starts[c]; i < starts[c + 1]; i += 1) {
      const s = rayTriangle(V, F, items[i], ox, oy, oz, dx, dy, dz);
      if (s > 0 && s <= tExit && (best < 0 || s < best)) best = s;
    }
    const tNext = Math.min(tMax[0], tMax[1], tMax[2]);
    if (best >= 0 && best <= tNext) return best;
    if (tNext > tExit) return best;
    guard += 1;
    if (guard > limit) return best;
    if (tMax[0] <= tMax[1] && tMax[0] <= tMax[2]) { cx += step[0]; tMax[0] += tDelta[0]; }
    else if (tMax[1] <= tMax[2]) { cy += step[1]; tMax[1] += tDelta[1]; }
    else { cz += step[2]; tMax[2] += tDelta[2]; }
    if (cx < 0 || cy < 0 || cz < 0 || cx >= dim[0] || cy >= dim[1] || cz >= dim[2]) return best;
  }
}

/**
 * Number of times a ray from `origin` along `dir` crosses the surface.
 *
 * Odd means inside, for a closed surface. Used to turn an organ mesh into
 * interior sample points, which is what a structure covering has to be built
 * from: a covering made of surface points is a shell, and a shell says the
 * middle of the liver is not liver.
 *
 * Triangles can be registered in several grid cells, so a crossing can be
 * found more than once. Distances are collected and deduplicated at 1e-7 mm
 * rather than counted as they are found — double-counting one crossing flips
 * the parity, and a flipped parity is a hole in the middle of an organ.
 */
export function countCrossings(grid, origin, dir) {
  const { V, F, lo, hi, cell, dim, starts, items } = grid;
  const hits = [];

  let tEnter = 0;
  let tExit = Infinity;
  for (let a = 0; a < 3; a += 1) {
    const o = origin[a]; const d = dir[a];
    if (Math.abs(d) < 1e-12) {
      if (o < lo[a] || o > hi[a]) return 0;
      continue;
    }
    let t0 = (lo[a] - o) / d;
    let t1 = (hi[a] - o) / d;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > tEnter) tEnter = t0;
    if (t1 < tExit) tExit = t1;
    if (tEnter > tExit) return 0;
  }

  const idx = (t, a) => {
    const i = Math.floor((origin[a] + dir[a] * t - lo[a]) / cell);
    return i < 0 ? 0 : i >= dim[a] ? dim[a] - 1 : i;
  };
  let cx = idx(tEnter, 0); let cy = idx(tEnter, 1); let cz = idx(tEnter, 2);
  const step = [0, 0, 0];
  const tDelta = [0, 0, 0];
  const tMax = [0, 0, 0];
  const c0 = [cx, cy, cz];
  for (let a = 0; a < 3; a += 1) {
    const d = dir[a];
    if (Math.abs(d) < 1e-12) { step[a] = 0; tDelta[a] = Infinity; tMax[a] = Infinity; continue; }
    step[a] = d > 0 ? 1 : -1;
    tDelta[a] = Math.abs(cell / d);
    tMax[a] = (lo[a] + (c0[a] + (d > 0 ? 1 : 0)) * cell - origin[a]) / d;
  }

  const limit = (dim[0] + dim[1] + dim[2]) * 3 + 8;
  for (let guard = 0; guard <= limit; guard += 1) {
    const c = (cz * dim[1] + cy) * dim[0] + cx;
    for (let i = starts[c]; i < starts[c + 1]; i += 1) {
      const s = rayTriangle(V, F, items[i], origin[0], origin[1], origin[2], dir[0], dir[1], dir[2]);
      if (s > 0 && s <= tExit) hits.push(s);
    }
    const tNext = Math.min(tMax[0], tMax[1], tMax[2]);
    if (tNext > tExit) break;
    if (tMax[0] <= tMax[1] && tMax[0] <= tMax[2]) { cx += step[0]; tMax[0] += tDelta[0]; }
    else if (tMax[1] <= tMax[2]) { cy += step[1]; tMax[1] += tDelta[1]; }
    else { cz += step[2]; tMax[2] += tDelta[2]; }
    if (cx < 0 || cy < 0 || cz < 0 || cx >= dim[0] || cy >= dim[1] || cz >= dim[2]) break;
  }

  hits.sort((a, b) => a - b);
  let n = 0;
  let last = -Infinity;
  for (const h of hits) {
    if (h - last > 1e-7) { n += 1; last = h; }
  }
  return n;
}

/**
 * Is the point inside the union of these closed parts?
 *
 * Union, not parity over the merged mesh, and the distinction is load bearing.
 * BodyParts3D builds a large concept out of element meshes — the heart is 83 of
 * them, chambers and valves and vessel stubs — and those parts share walls. A
 * single parity test over the merged triangle soup crosses two coincident
 * surfaces at an internal wall and reports the chamber beyond it as outside. So
 * each part is tested on its own and the answers are OR-ed, which is what a
 * union of solids means.
 *
 * Two orthogonal directions are tried before concluding "outside". A single
 * ray that grazes an edge or runs along a coincident face gives an even count
 * from inside; two do not agree on that by accident, and disagreement is
 * reported so the caller can publish how often the mesh was ambiguous rather
 * than quietly taking one ray's word.
 */
export function insideParts(parts, point, stats) {
  let ambiguous = false;
  for (const part of parts) {
    const { lo, hi } = part;
    if (point[0] < lo[0] || point[0] > hi[0]
      || point[1] < lo[1] || point[1] > hi[1]
      || point[2] < lo[2] || point[2] > hi[2]) continue;
    const a = countCrossings(part.grid, point, [0, 0, 1]) % 2 === 1;
    const b = countCrossings(part.grid, point, [1, 0, 0]) % 2 === 1;
    if (a !== b) { ambiguous = true; continue; }
    if (a) {
      if (stats && ambiguous) stats.ambiguous += 1;
      return true;
    }
  }
  if (stats && ambiguous) stats.ambiguous += 1;
  return false;
}

// ---------------------------------------------------------------------------
// Small vector helpers, in the same style as the frame implementation
// ---------------------------------------------------------------------------

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a) => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
