/**
 * Plain geometry on indexed triangle meshes: welding, normals, area, bounds,
 * degeneracy and surface distance. No dependencies, so the build and the gate
 * compute the same figures with the same code. A gate that re-measured with
 * different code would be checking agreement between two implementations
 * rather than the geometry.
 *
 * Positions are flat xyz arrays, indices flat triangle lists.
 */

/** Merge vertices with bit-identical positions. Returns new positions, indices and the remap. */
export function weld(positions, indices) {
  const key = new Map();
  const remap = new Uint32Array(positions.length / 3);
  const out = [];
  for (let v = 0; v < positions.length / 3; v += 1) {
    const k = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
    let id = key.get(k);
    if (id === undefined) {
      id = out.length / 3;
      key.set(k, id);
      out.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    }
    remap[v] = id;
  }
  const welded = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i += 1) welded[i] = remap[indices[i]];
  return { positions: Float32Array.from(out), indices: dropDegenerate(welded) };
}

/** Remove triangles that repeat a vertex. */
export function dropDegenerate(indices) {
  const keep = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    if (a !== b && b !== c && a !== c) keep.push(a, b, c);
  }
  return Uint32Array.from(keep);
}

function cross(ax, ay, az, bx, by, bz) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

/** Twice the area of triangle t, and its unnormalised normal. */
function triangleNormal(p, i, t) {
  const a = i[t] * 3;
  const b = i[t + 1] * 3;
  const c = i[t + 2] * 3;
  return cross(
    p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2],
    p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2],
  );
}

/** Area-weighted vertex normals, unit length; a vertex on no triangle gets +z. */
export function vertexNormals(positions, indices) {
  const n = new Float64Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const f = triangleNormal(positions, indices, t);
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t + k] * 3;
      n[v] += f[0];
      n[v + 1] += f[1];
      n[v + 2] += f[2];
    }
  }
  const out = new Float32Array(positions.length);
  for (let v = 0; v < positions.length; v += 3) {
    const l = Math.hypot(n[v], n[v + 1], n[v + 2]);
    if (l > 0) {
      out[v] = n[v] / l;
      out[v + 1] = n[v + 1] / l;
      out[v + 2] = n[v + 2] / l;
    } else out[v + 2] = 1;
  }
  return out;
}

export function surfaceArea(positions, indices) {
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const f = triangleNormal(positions, indices, t);
    area += Math.hypot(f[0], f[1], f[2]) / 2;
  }
  return area;
}

/** Triangles of zero area, or that repeat a vertex. */
export function degenerateTriangles(positions, indices) {
  let count = 0;
  for (let t = 0; t < indices.length; t += 3) {
    if (indices[t] === indices[t + 1] || indices[t + 1] === indices[t + 2] || indices[t] === indices[t + 2]) {
      count += 1;
      continue;
    }
    const f = triangleNormal(positions, indices, t);
    if (f[0] === 0 && f[1] === 0 && f[2] === 0) count += 1;
  }
  return count;
}

export function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < positions.length; v += 3) {
    for (let a = 0; a < 3; a += 1) {
      if (positions[v + a] < min[a]) min[a] = positions[v + a];
      if (positions[v + a] > max[a]) max[a] = positions[v + a];
    }
  }
  return { min, max, extent: [0, 1, 2].map((a) => max[a] - min[a]) };
}

/** The closest point found by the last pointTriangleDist2 call; read by nearestSurfacePoint. */
const LAST_Q = new Float64Array(3);

/** Squared distance from point p to triangle abc (Ericson, Real-Time Collision Detection, 5.1.5). */
function pointTriangleDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz);
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom;
              const w = vc * denom;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  LAST_Q[0] = qx;
  LAST_Q[1] = qy;
  LAST_Q[2] = qz;
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * A uniform grid over a mesh's triangles, for nearest-surface queries. Each
 * triangle is filed in every cell its bounding box touches; a query searches
 * shells of cells outward until no unsearched cell can be nearer than the best
 * hit. Exact, not approximate: the stopping rule is a proof, not a cap.
 */
export function triangleGrid(positions, indices, cellsPerAxis = 24) {
  const b = bounds(positions);
  const size = Math.max(...b.extent) / cellsPerAxis || 1;
  const dims = b.extent.map((e) => Math.max(1, Math.ceil(e / size) + 1));
  const cells = new Map();
  const cellOf = (x, a) => Math.min(dims[a] - 1, Math.max(0, Math.floor((x - b.min[a]) / size)));
  for (let t = 0; t < indices.length; t += 3) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t + k] * 3;
      for (let a = 0; a < 3; a += 1) {
        lo[a] = Math.min(lo[a], positions[v + a]);
        hi[a] = Math.max(hi[a], positions[v + a]);
      }
    }
    for (let x = cellOf(lo[0], 0); x <= cellOf(hi[0], 0); x += 1) {
      for (let y = cellOf(lo[1], 1); y <= cellOf(hi[1], 1); y += 1) {
        for (let z = cellOf(lo[2], 2); z <= cellOf(hi[2], 2); z += 1) {
          const k = (x * dims[1] + y) * dims[2] + z;
          let list = cells.get(k);
          if (!list) cells.set(k, (list = []));
          list.push(t);
        }
      }
    }
  }
  return { positions, indices, size, dims, cells, cellOf };
}

/** Distance from (x, y, z) to the nearest point of the gridded surface. */
export function nearestSurfaceDistance(grid, x, y, z) {
  const { positions: p, indices: ix, dims, cells, size } = grid;
  // A point outside the grid's box starts from the nearest cell on its edge.
  // The stopping bound below still holds: clamping only moves the start cell
  // closer to the point, never farther.
  const c = [x, y, z].map((v, a) => grid.cellOf(v, a));
  let best = Infinity;
  const maxShell = Math.max(...dims);
  for (let r = 0; r <= maxShell; r += 1) {
    // Every cell in shell r is at least (r - 1) * size from the query point.
    if (r > 0 && (r - 1) * size > Math.sqrt(best)) break;
    for (let dx = -r; dx <= r; dx += 1) {
      const gx = c[0] + dx;
      if (gx < 0 || gx >= dims[0]) continue;
      for (let dy = -r; dy <= r; dy += 1) {
        const gy = c[1] + dy;
        if (gy < 0 || gy >= dims[1]) continue;
        for (let dz = -r; dz <= r; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const gz = c[2] + dz;
          if (gz < 0 || gz >= dims[2]) continue;
          const list = cells.get((gx * dims[1] + gy) * dims[2] + gz);
          if (!list) continue;
          for (const t of list) {
            const a = ix[t] * 3;
            const b2 = ix[t + 1] * 3;
            const cc = ix[t + 2] * 3;
            const d = pointTriangleDist2(x, y, z, p[a], p[a + 1], p[a + 2], p[b2], p[b2 + 1], p[b2 + 2], p[cc], p[cc + 1], p[cc + 2]);
            if (d < best) best = d;
          }
        }
      }
    }
  }
  return Math.sqrt(best);
}

/** The nearest point of the gridded surface to (x, y, z), its distance, and the triangle (index-buffer offset) it lies on. */
export function nearestSurfacePoint(grid, x, y, z) {
  const { positions: p, indices: ix, dims, cells, size } = grid;
  // A point outside the grid's box starts from the nearest cell on its edge.
  // The stopping bound below still holds: clamping only moves the start cell
  // closer to the point, never farther.
  const c = [x, y, z].map((v, a) => grid.cellOf(v, a));
  let best = Infinity;
  let triangle = -1;
  const at = [NaN, NaN, NaN];
  const maxShell = Math.max(...dims);
  for (let r = 0; r <= maxShell; r += 1) {
    // Every cell in shell r is at least (r - 1) * size from the query point.
    if (r > 0 && (r - 1) * size > Math.sqrt(best)) break;
    for (let dx = -r; dx <= r; dx += 1) {
      const gx = c[0] + dx;
      if (gx < 0 || gx >= dims[0]) continue;
      for (let dy = -r; dy <= r; dy += 1) {
        const gy = c[1] + dy;
        if (gy < 0 || gy >= dims[1]) continue;
        for (let dz = -r; dz <= r; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const gz = c[2] + dz;
          if (gz < 0 || gz >= dims[2]) continue;
          const list = cells.get((gx * dims[1] + gy) * dims[2] + gz);
          if (!list) continue;
          for (const t of list) {
            const a = ix[t] * 3;
            const b2 = ix[t + 1] * 3;
            const cc = ix[t + 2] * 3;
            const d = pointTriangleDist2(x, y, z, p[a], p[a + 1], p[a + 2], p[b2], p[b2 + 1], p[b2 + 2], p[cc], p[cc + 1], p[cc + 2]);
            if (d < best) {
              best = d;
              triangle = t;
              at[0] = LAST_Q[0];
              at[1] = LAST_Q[1];
              at[2] = LAST_Q[2];
            }
          }
        }
      }
    }
  }
  return { distance: Math.sqrt(best), point: at, triangle };
}

/**
 * One-sided distances from every vertex of `from` to the surface of `to`:
 * max, mean and p95. Every vertex, not a sample.
 */
export function oneSidedDistance(fromPositions, toGrid) {
  const n = fromPositions.length / 3;
  const d = new Float64Array(n);
  let sum = 0;
  let max = 0;
  for (let v = 0; v < n; v += 1) {
    d[v] = nearestSurfaceDistance(toGrid, fromPositions[v * 3], fromPositions[v * 3 + 1], fromPositions[v * 3 + 2]);
    sum += d[v];
    if (d[v] > max) max = d[v];
  }
  const sorted = Float64Array.from(d).sort();
  return { max, mean: n ? sum / n : 0, p95: n ? sorted[Math.min(n - 1, Math.floor(0.95 * n))] : 0, count: n };
}

/** Symmetric Hausdorff distance and mean between two meshes. */
export function surfaceDeviation(a, b) {
  const ab = oneSidedDistance(a.positions, triangleGrid(b.positions, b.indices));
  const ba = oneSidedDistance(b.positions, triangleGrid(a.positions, a.indices));
  return {
    hausdorff: Math.max(ab.max, ba.max),
    meanSymmetric: (ab.mean * ab.count + ba.mean * ba.count) / (ab.count + ba.count),
    forward: ab,
    backward: ba,
  };
}
