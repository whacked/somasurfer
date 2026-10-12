/**
 * brain.glb → two tiers of `ATLM` meshes for the structures that may ship.
 *
 * The decisions, and why:
 *
 *   - ONE FILE PER CLEARANCE GROUP AND TIER. §7.3 of docs/asset-licensing.md:
 *     a later clearance adds a file instead of re-cutting a shipped one, and a
 *     held structure can never ride along inside a cleared file. v2 ships one
 *     group, `cleared`.
 *   - FULL TIER = THE SOURCE, WELDED AND QUANTISED. Nothing is decimated.
 *     Positions are welded (Draco splits vertices at attribute seams), put on a
 *     16-bit grid shared by every structure in the file, and normals are
 *     recomputed from the welded surface.
 *   - LOW TIER = PER-STRUCTURE DECIMATION WITH A FLOOR. Each structure keeps
 *     `ratio` of its triangles, but never fewer than `floorTriangles` (or all
 *     of them, if it has fewer). The floor is what stops the smallest nuclei
 *     from being simplified out of existence: a global ratio alone takes the
 *     subthalamic nucleus to a handful of triangles.
 *   - ERROR IS MEASURED AGAINST THE FULL TIER, NOT THE SOURCE, so the gate can
 *     re-measure it from the two committed files without the source. The full
 *     tier differs from the source only by quantisation, which is reported
 *     separately as `quantisationStepMm`.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO_ROOT } from './repo.mjs';
import { mergeParts } from './glb.mjs';
import { octEncode, writeMeshBin } from './meshbin.mjs';
import { bounds, degenerateTriangles, dropDegenerate, surfaceArea, surfaceDeviation, vertexNormals, weld } from './mesh-geometry.mjs';

let meshopt = null;
async function meshoptimizer() {
  if (meshopt) return meshopt;
  const require = createRequire(join(REPO_ROOT, 'tools', 'mesh-build', 'package.json'));
  const entry = require.resolve('meshoptimizer');
  const mod = await import(entry);
  await mod.MeshoptSimplifier.ready;
  await mod.MeshoptEncoder.ready;
  meshopt = mod;
  return mod;
}

/** One quantisation frame for a set of float meshes: centred, int16, per-axis step. */
export function quantisationFrame(meshes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const b = bounds(m.positions);
    for (let a = 0; a < 3; a += 1) {
      min[a] = Math.min(min[a], b.min[a]);
      max[a] = Math.max(max[a], b.max[a]);
    }
  }
  const origin = [0, 1, 2].map((a) => Math.fround((min[a] + max[a]) / 2));
  // 65534 steps across the extent, so the extremes land on ±32767 exactly.
  const step = [0, 1, 2].map((a) => Math.fround((max[a] - min[a]) / 65534 || 1e-9));
  return { origin, step };
}

/** Quantise a float mesh into the frame, drop what collapses, recompute normals. */
function quantise(mesh, frame) {
  const n = mesh.positions.length / 3;
  const q = new Int16Array(n * 3);
  for (let v = 0; v < n; v += 1) {
    for (let a = 0; a < 3; a += 1) {
      const t = Math.round((mesh.positions[v * 3 + a] - frame.origin[a]) / frame.step[a]);
      q[v * 3 + a] = Math.max(-32767, Math.min(32767, t));
    }
  }
  const back = dequantise(q, frame);
  // Quantisation can collapse a sliver to zero area; keep only real triangles.
  const keep = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = mesh.indices.subarray(t, t + 3);
    if (degenerateTriangles(back, tri) === 0) keep.push(tri[0], tri[1], tri[2]);
  }
  const indices = Uint32Array.from(keep);
  const normals = vertexNormals(back, indices);
  const oct = new Int8Array(n * 2);
  for (let v = 0; v < n; v += 1) {
    const [u, w] = octEncode(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    oct[v * 2] = u;
    oct[v * 2 + 1] = w;
  }
  return { q, oct, indices, dequantised: back };
}

/**
 * Drop the vertices no triangle uses, keeping the rest in order. `quantise`
 * drops triangles that collapse and keeps their vertices, so a structure can
 * carry vertices that are never drawn; every per-vertex measure then counts
 * them (DOG-173 F1: 1,922 in 120 body structures, and the right cornea
 * published a 55.43 mm error whose drawn surface is 0.76 mm off). The body
 * compacts; the brain does not, and is built exactly as it was reviewed.
 */
function compact(r) {
  const n = r.q.length / 3;
  const used = new Uint8Array(n);
  for (let i = 0; i < r.indices.length; i += 1) used[r.indices[i]] = 1;
  const remap = new Int32Array(n).fill(-1);
  let m = 0;
  for (let v = 0; v < n; v += 1) if (used[v]) remap[v] = m++;
  if (m === n) return r;
  const q = new Int16Array(m * 3);
  const oct = new Int8Array(m * 2);
  const dequantised = new Float64Array(m * 3);
  for (let v = 0; v < n; v += 1) {
    const to = remap[v];
    if (to < 0) continue;
    for (let a = 0; a < 3; a += 1) {
      q[to * 3 + a] = r.q[v * 3 + a];
      dequantised[to * 3 + a] = r.dequantised[v * 3 + a];
    }
    oct[to * 2] = r.oct[v * 2];
    oct[to * 2 + 1] = r.oct[v * 2 + 1];
  }
  return { q, oct, indices: Uint32Array.from(r.indices, (i) => remap[i]), dequantised };
}

export function dequantise(q, frame) {
  const out = new Float64Array(q.length);
  for (let i = 0; i < q.length; i += 1) out[i] = frame.origin[i % 3] + frame.step[i % 3] * q[i];
  return out;
}

/** Vertex-cache and fetch order, then drop unreferenced vertices. Smaller after gzip, same surface. */
function reorder(M, mesh) {
  const indices = Uint32Array.from(mesh.indices);
  const [remap, unique] = M.MeshoptEncoder.reorderMesh(indices, true, true);
  const positions = new Float32Array(unique * 3);
  // `remap` covers only up to the highest referenced vertex. Reading past its
  // end gives undefined, and `set` at an undefined offset writes slot 0: that
  // silently moved vertex 0 of every decimated tube and doubled its area.
  for (let v = 0; v < Math.min(remap.length, mesh.positions.length / 3); v += 1) {
    const to = remap[v];
    if (to === 0xffffffff) continue;
    positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), to * 3);
  }
  return { positions, indices };
}

/** Decimate to `target` triangles. */
function decimate(M, mesh, target) {
  const sourceTriangles = mesh.indices.length / 3;
  if (target >= sourceTriangles) return mesh;
  const [indices] = M.MeshoptSimplifier.simplify(
    Uint32Array.from(mesh.indices),
    mesh.positions,
    3,
    target * 3,
    1, // relative error bound of 1 = the whole extent: the triangle target decides, not the error
    // Open borders stay where they are. Without this, simplification erodes them
    // and drops isolated source triangles outright: the superior semilunar
    // lobules lost four stray triangles 7.85 mm off the surface. With it, the
    // worst structure in the file is 3.1 mm and the file is the same size.
    ['LockBorder'],
  );
  return { positions: mesh.positions, indices: dropDegenerate(indices) };
}

const decimateWhole = decimate;

/** The connected components of an indexed mesh, each as its own triangle list. */
export function componentsOf(indices, vertexCount) {
  const parent = new Uint32Array(vertexCount).map((_, i) => i);
  const find = (v) => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]);
    parent[find(indices[t + 1])] = a;
    parent[find(indices[t + 2])] = a;
  }
  const byRoot = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const r = find(indices[t]);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(indices[t], indices[t + 1], indices[t + 2]);
  }
  return [...byRoot.values()];
}

/**
 * Decimate to `target` triangles, shared across connected components in
 * proportion to their size, with at least `minComponentTriangles` each (or all
 * of a component's triangles, if it has fewer). Measured on the body: one
 * simplifier call over a multi-piece structure spends its budget where the
 * error is cheapest and collapses small pieces whole. The right inferior
 * phrenic artery, eight pieces, came out at 0.38 of its area and 112 mm off.
 */
function decimateByComponent(M, mesh, target, minComponentTriangles) {
  const total = mesh.indices.length / 3;
  if (target >= total) return mesh;
  const parts = componentsOf(mesh.indices, mesh.positions.length / 3);
  if (parts.length === 1) return decimate(M, mesh, target);
  const out = [];
  for (const part of parts) {
    const n = part.length / 3;
    const t = Math.min(n, Math.max(minComponentTriangles, Math.ceil((target * n) / total)));
    const kept = decimate(M, { positions: mesh.positions, indices: Uint32Array.from(part) }, t).indices;
    for (let i = 0; i < kept.length; i += 1) out.push(kept[i]);
  }
  return { positions: mesh.positions, indices: Uint32Array.from(out) };
}

/** Area ratio and per-axis extent shares of `indices` over `mesh`'s positions, against `reference`. */
function shapeAgainst(mesh, indices, reference) {
  const used = new Set(indices);
  const p = new Float64Array(used.size * 3);
  let k = 0;
  for (const v of used) {
    p[k++] = mesh.positions[v * 3];
    p[k++] = mesh.positions[v * 3 + 1];
    p[k++] = mesh.positions[v * 3 + 2];
  }
  const b = bounds(p);
  return {
    area: surfaceArea(mesh.positions, indices) / reference.area,
    axes: [0, 1, 2].map((a) => (reference.extent[a] > 0 ? b.extent[a] / reference.extent[a] : 1)),
  };
}

/**
 * The smallest target at or above `base` whose decimation of `mesh` keeps its
 * shape inside `margin` (`{ area, axis }`: area within 1 +/- area, every axis
 * at least `axis` of its extent). This is the floor idea taken from a count to
 * a shape: a thin vessel needs more of its triangles than a ratio leaves it,
 * a large smooth surface far fewer, and one ratio cannot serve both. The
 * margin is the build's and is stricter than the gate's, so what this keeps
 * passes the gate with room to spare. The result is always one that met the
 * margin; the whole mesh meets it trivially.
 */
function shapeKeepingTarget(M, decimate, mesh, base, margin) {
  const total = mesh.indices.length / 3;
  const reference = { area: surfaceArea(mesh.positions, mesh.indices), extent: bounds(mesh.positions).extent };
  const keeps = (t) => {
    const s = shapeAgainst(mesh, decimate(M, mesh, t).indices, reference);
    return s.area >= 1 - margin.area && s.area <= 1 + margin.area && s.axes.every((x) => x >= margin.axis);
  };
  if (base >= total || keeps(base)) return Math.min(base, total);
  let lo = base;
  let hi = total;
  while (hi - lo > Math.max(1, Math.floor(lo * 0.05))) {
    const mid = Math.floor((lo + hi) / 2);
    if (keeps(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Build both tiers for `structures` (the provenance records of one clearance
 * group) from decoded glb `nodes`.
 */
export async function buildTiers({ nodes, structures, floorTriangles, ratio, replacements = new Map() }) {
  const byId = new Map(nodes.map((n) => [n.extras.bx_id, n]));
  const meshes = structures.map((s) => {
    // A replaced structure's geometry comes from its replacement source, already
    // in the mesh frame; everything else from the glb.
    const merged = replacements.get(s.id) ?? mergeParts(byId.get(s.id).parts);
    return { id: s.id, positions: merged.positions, indices: merged.indices };
  });
  // The glb is in metres.
  return buildMeshTiers({ meshes, floorTriangles, ratio, mmPerUnit: 1000 });
}

/**
 * The tier builder itself, for any set of float meshes in one frame. The brain
 * (from the glb, in metres) and the body (DOG-128, from BodyParts3D, in
 * millimetres) both come through here, so both are welded, quantised,
 * decimated and measured by the same code.
 *
 * `meshes` is `[{ id, positions, indices }]`, unwelded. `mmPerUnit` converts
 * the frame's units to the millimetres every reported figure is in.
 *
 * The full tier is the source, undecimated, unless `fullRatio` is below 1.
 * Then it is decimated the way the low tier is, to `fullRatio` of the source
 * with a floor of `fullFloorTriangles`, and the build reports how far it moved
 * from the source (`fullVsSource`). That figure is the build's, not the gate's:
 * the gate has the two tiers and not the source.
 *
 * `minComponentTriangles`, if given, decimates each connected component of a
 * structure separately (`decimateByComponent`), so no piece of it can vanish.
 * `shapeMargin`, if given (`{ full: { area, axis }, low: { area, axis } }`),
 * raises each structure's target to the least that keeps its shape inside the
 * margin (`shapeKeepingTarget`): the full tier against the source, the low tier
 * against the full tier. `compactVertices` drops vertices no triangle uses.
 * The brain sets none of these, and is built exactly as it was reviewed.
 */
export async function buildMeshTiers({
  meshes, floorTriangles, ratio, mmPerUnit, fullRatio = 1, fullFloorTriangles = 0, minComponentTriangles = null, shapeMargin = null,
  compactVertices = false,
}) {
  const M = await meshoptimizer();
  const mm2 = mmPerUnit * mmPerUnit;
  // `compactVertices`: every vertex in a tier is drawn (see `compact`).
  const quantiseTier = compactVertices ? (mesh, f) => compact(quantise(mesh, f)) : quantise;
  const decimate = minComponentTriangles === null
    ? decimateWhole
    : (m, mesh, target) => decimateByComponent(m, mesh, target, minComponentTriangles);
  // A mesh may be given lazily, as `{ id, load() }`, and is then never held
  // beside the others: one pass takes each welded mesh's bounds for the shared
  // frame, and a second loads it again, builds its tiers and lets it go. The
  // body needs this (DOG-128): all 6.4 million source triangles at once is more
  // memory than the build host has; the run that tried was killed at 868 MB
  // RSS with 270 MB left on the host. Same weld, same bounds, same frame, so
  // the output is the eager path's, byte for byte.
  const weldOf = (m) => {
    const g = m.load ? m.load() : m;
    return { record: m, mesh: weld(g.positions, g.indices), sourceTriangles: g.indices.length / 3 };
  };
  const lazy = meshes.some((m) => typeof m.load === 'function');
  const eager = lazy ? null : meshes.map(weldOf);
  const frame = quantisationFrame(eager
    ? eager.map((w) => w.mesh)
    : meshes.map((m) => {
      const b = bounds(weldOf(m).mesh.positions);
      return { positions: Float64Array.of(...b.min, ...b.max) };
    }));

  const full = [];
  const low = [];
  const report = [];
  for (const [k, m] of meshes.entries()) {
    const w = eager ? eager[k] : weldOf(m);
    const sourceMesh = reorder(M, w.mesh);
    const sourceTris = sourceMesh.indices.length / 3;
    // A mesh marked `keepFull` ships its full tier undecimated even when the
    // set's is decimated: the body's 25 BD vertebrae, the frame's own witnesses
    // (DOG-128). Decimated to ~256 triangles, they moved BD's T07 and T09 axis
    // points 1.03 and 1.31 mm, past the registration gate's 1 mm.
    const decimateFull = fullRatio < 1 && !m.keepFull;
    let fullTarget = Math.min(sourceTris, Math.max(fullFloorTriangles, Math.ceil(sourceTris * fullRatio)));
    if (decimateFull && shapeMargin) fullTarget = shapeKeepingTarget(M, decimate, sourceMesh, fullTarget, shapeMargin.full);
    const fullMesh = decimateFull ? reorder(M, decimate(M, sourceMesh, fullTarget)) : sourceMesh;
    const fq = quantiseTier(fullMesh, frame);
    const fullTris = fq.indices.length / 3;
    // The floor is a guarantee, not a target: the simplifier may stop short of
    // the count it is given, and quantisation may drop a sliver, so ask again
    // with a higher target until what lands in the file meets it. The gate
    // checks exactly this inequality.
    const required = Math.min(fullTris, floorTriangles);
    let target = Math.min(fullTris, Math.max(floorTriangles, Math.ceil(fullTris * ratio)));
    if (shapeMargin) target = shapeKeepingTarget(M, decimate, fullMesh, target, shapeMargin.low);
    let lq;
    for (;;) {
      lq = quantiseTier(reorder(M, decimate(M, fullMesh, target)), frame);
      if (lq.indices.length / 3 >= required || target >= fullMesh.indices.length / 3) break;
      target += Math.max(1, required - lq.indices.length / 3);
    }
    full.push({ id: w.record.id, positions: fq.q, normals: fq.oct, indices: fq.indices });
    low.push({ id: w.record.id, positions: lq.q, normals: lq.oct, indices: lq.indices });

    const deviation = surfaceDeviation(
      { positions: lq.dequantised, indices: lq.indices },
      { positions: fq.dequantised, indices: fq.indices },
    );
    const fullVsSource = fullMesh === sourceMesh
      ? null
      : surfaceDeviation({ positions: fq.dequantised, indices: fq.indices }, sourceMesh);
    report.push({
      id: w.record.id,
      sourceTriangles: w.sourceTriangles,
      full: { triangles: fq.indices.length / 3, vertices: fq.q.length / 3, areaMm2: surfaceArea(fq.dequantised, fq.indices) * mm2 },
      low: { triangles: lq.indices.length / 3, vertices: lq.q.length / 3, areaMm2: surfaceArea(lq.dequantised, lq.indices) * mm2 },
      targetTriangles: target,
      hausdorffMm: deviation.hausdorff * mmPerUnit,
      meanDeviationMm: deviation.meanSymmetric * mmPerUnit,
      ...(fullVsSource && {
        fullVsSource: {
          sourceAreaMm2: surfaceArea(sourceMesh.positions, sourceMesh.indices) * mm2,
          hausdorffMm: fullVsSource.hausdorff * mmPerUnit,
          meanDeviationMm: fullVsSource.meanSymmetric * mmPerUnit,
        },
      }),
    });
  }

  return {
    frame,
    full: writeMeshBin({ ...frame, structures: full }),
    low: writeMeshBin({ ...frame, structures: low }),
    report,
  };
}
