/**
 * Isosurface extraction from a scalar volume: an indexed triangle mesh in
 * voxel coordinates, with every vertex shared by the triangles that use it.
 *
 * The decisions, and why:
 *
 *   - MARCHING TETRAHEDRA, NOT CLASSIC MARCHING CUBES. The file keeps the
 *     familiar name because that is what a reader will look for. Classic
 *     Lorensen-Cline marching cubes resolves the ambiguous faces of a cube
 *     from that cube alone, so two neighbouring cubes can disagree about a
 *     shared face and leave a crack, and its 256-entry triangle table is 4 KB
 *     of literals that nobody can review by eye. Each cube here is cut into
 *     six tetrahedra around its main diagonal (the Kuhn / Freudenthal
 *     triangulation). A tetrahedron has no ambiguous case: the isosurface of a
 *     linear interpolant over it is one triangle or one quad, and there are
 *     only three cases up to symmetry, written out below. Because every cube
 *     splits each of its faces along the diagonal that starts at the face's
 *     lowest corner, neighbouring cubes split a shared face the same way, so
 *     the surface is crack-free and, where it does not touch the volume's
 *     edge, closed and 2-manifold. The callers count connected components and
 *     run a topology-preserving simplifier, and both need exactly that.
 *   - WHAT IT COSTS. Roughly twice the triangles of marching cubes, with more
 *     slivers, and a faint directional bias from the fixed diagonal. The full
 *     tier pays the triangle count; the decimated tier does not see it.
 *   - VERTICES ARE KEYED BY GRID EDGE, so a vertex is created once and shared
 *     by every triangle on that edge with no position welding. Each Kuhn edge
 *     runs from a grid point in one of seven non-negative directions (three
 *     axes, three face diagonals, the body diagonal); the key is
 *     `gridPoint * 8 + direction`.
 *   - A CROSSING NEVER LANDS ON A GRID POINT. A value exactly at the iso level
 *     counts as outside, and the interpolation parameter is clamped into
 *     [EPS, 1 - EPS]. Otherwise two different edges could put a vertex at the
 *     same grid point, and a later position weld would pinch the surface there.
 *   - ORIENTATION IS COMPUTED, NOT TABULATED. Inside a tetrahedron the field
 *     is linear, so the isosurface's normal is parallel to the gradient, and
 *     the gradient points from the outside corners to the inside ones. Each
 *     triangle is wound so its normal points the other way: from high values
 *     to low, which for a tissue-probability volume is outward.
 *
 * Plain JS, no dependencies, like everything else under tools/lib.
 */

/** Interpolation clamp: keeps every crossing strictly inside its edge. */
export const EPS = 1e-4;

// Corner n of a cube sits at offset (n & 1, (n >> 1) & 1, (n >> 2) & 1).
const AXIS_BITS = [1, 2, 4];

// The six Kuhn tetrahedra: each walks from corner 0 to corner 7 adding one
// axis at a time, in one of the 3! orders. Corners along the walk are nested
// subsets, so in any pair the lower corner is the subset and the edge's
// direction is the difference.
const TETS = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
].map(([a, b]) => [0, AXIS_BITS[a], AXIS_BITS[a] | AXIS_BITS[b], 7]);

/**
 * Extract the `iso` level set of `data` (x fastest, then y, then z) on a grid
 * of `dims` = [nx, ny, nz]. Voxels with a value strictly above `iso` are
 * inside. Returns `{ positions: Float32Array, indices: Uint32Array }` with
 * positions in voxel-index coordinates and triangles wound outward (towards
 * lower values).
 *
 * `box` optionally restricts the walk to an inclusive voxel range
 * `{ lo: [i, j, k], hi: [i, j, k] }`; cubes outside it are skipped, which is
 * only correct if the field is entirely on one side of `iso` out there.
 */
export function marchingTetrahedra(data, dims, iso, box = null) {
  const [nx, ny, nz] = dims;
  if (data.length !== nx * ny * nz) throw new Error(`volume has ${data.length} values, dims say ${nx * ny * nz}`);
  const lo = box ? box.lo.map((v) => Math.max(0, v - 1)) : [0, 0, 0];
  const hi = box ? box.hi.map((v, a) => Math.min(dims[a] - 2, v)) : [nx - 2, ny - 2, nz - 2];

  const vertexOf = new Map();
  const positions = [];
  const indices = [];

  const cv = new Float64Array(8); // corner values
  const cin = new Uint8Array(8); // corner inside flags
  const cbase = new Int32Array(8); // corner grid-point index
  const cpos = new Float64Array(24); // corner positions

  const vertex = (ca, cb) => {
    // ca is the lower corner (a subset of cb), so the edge leaves grid point
    // cbase[ca] in direction cb ^ ca.
    const key = cbase[ca] * 8 + (cb ^ ca);
    let id = vertexOf.get(key);
    if (id !== undefined) return id;
    let t = (iso - cv[ca]) / (cv[cb] - cv[ca]);
    if (!(t >= EPS)) t = EPS;
    else if (t > 1 - EPS) t = 1 - EPS;
    id = positions.length / 3;
    positions.push(
      cpos[ca * 3] + t * (cpos[cb * 3] - cpos[ca * 3]),
      cpos[ca * 3 + 1] + t * (cpos[cb * 3 + 1] - cpos[ca * 3 + 1]),
      cpos[ca * 3 + 2] + t * (cpos[cb * 3 + 2] - cpos[ca * 3 + 2]),
    );
    vertexOf.set(key, id);
    return id;
  };

  // Emit triangle (a, b, c), wound so that its normal points along `out`.
  const triangle = (a, b, c, ox, oy, oz) => {
    const p = positions;
    const ux = p[b * 3] - p[a * 3];
    const uy = p[b * 3 + 1] - p[a * 3 + 1];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3];
    const vy = p[c * 3 + 1] - p[a * 3 + 1];
    const vz = p[c * 3 + 2] - p[a * 3 + 2];
    const nx2 = uy * vz - uz * vy;
    const ny2 = uz * vx - ux * vz;
    const nz2 = ux * vy - uy * vx;
    if (nx2 * ox + ny2 * oy + nz2 * oz >= 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  };

  // Direction from the inside corners' centroid to the outside corners'.
  const outward = (ins, outs) => {
    const d = [0, 0, 0];
    for (let a = 0; a < 3; a += 1) {
      let si = 0;
      let so = 0;
      for (const c of ins) si += cpos[c * 3 + a];
      for (const c of outs) so += cpos[c * 3 + a];
      d[a] = so / outs.length - si / ins.length;
    }
    return d;
  };

  const sliceStride = nx * ny;
  for (let k = lo[2]; k <= hi[2]; k += 1) {
    for (let j = lo[1]; j <= hi[1]; j += 1) {
      for (let i = lo[0]; i <= hi[0]; i += 1) {
        let insideCount = 0;
        for (let c = 0; c < 8; c += 1) {
          const dx = c & 1;
          const dy = (c >> 1) & 1;
          const dz = (c >> 2) & 1;
          const g = (k + dz) * sliceStride + (j + dy) * nx + (i + dx);
          cbase[c] = g;
          cv[c] = data[g];
          cin[c] = data[g] > iso ? 1 : 0;
          insideCount += cin[c];
        }
        if (insideCount === 0 || insideCount === 8) continue;
        for (let c = 0; c < 8; c += 1) {
          cpos[c * 3] = i + (c & 1);
          cpos[c * 3 + 1] = j + ((c >> 1) & 1);
          cpos[c * 3 + 2] = k + ((c >> 2) & 1);
        }
        for (const tet of TETS) {
          const ins = [];
          const outs = [];
          for (const c of tet) (cin[c] ? ins : outs).push(c);
          if (ins.length === 0 || outs.length === 0) continue;
          const [ox, oy, oz] = outward(ins, outs);
          const v = (a, b) => (a < b ? vertex(a, b) : vertex(b, a));
          if (ins.length === 1 || outs.length === 1) {
            // One corner alone on its side: one triangle across its three edges.
            const lone = ins.length === 1 ? ins[0] : outs[0];
            const others = ins.length === 1 ? outs : ins;
            triangle(v(lone, others[0]), v(lone, others[1]), v(lone, others[2]), ox, oy, oz);
          } else {
            // Two and two: a quad on edges a-c, a-d, b-d, b-c, in that cyclic
            // order, split into two triangles.
            const [a, b] = ins;
            const [c, d] = outs;
            const ac = v(a, c);
            const ad = v(a, d);
            const bd = v(b, d);
            const bc = v(b, c);
            triangle(ac, ad, bd, ox, oy, oz);
            triangle(ac, bd, bc, ox, oy, oz);
          }
        }
      }
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/**
 * Connected components of an indexed mesh, joined through shared vertices.
 * Returns `{ count, triangleComponent: Int32Array, sizes: number[] }` with
 * components numbered by descending triangle count, so component 0 is the
 * largest.
 */
export function meshComponents(indices, vertexCount) {
  const parent = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v += 1) parent[v] = v;
  const find = (v) => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]);
    for (let k = 1; k < 3; k += 1) {
      const b = find(indices[t + k]);
      if (a !== b) parent[b] = a;
    }
  }
  const counts = new Map();
  const roots = new Int32Array(indices.length / 3);
  for (let t = 0; t < indices.length; t += 3) {
    const r = find(indices[t]);
    roots[t / 3] = r;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const order = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const rank = new Map(order.map(([r], n) => [r, n]));
  const triangleComponent = new Int32Array(roots.length);
  for (let t = 0; t < roots.length; t += 1) triangleComponent[t] = rank.get(roots[t]);
  return { count: order.length, triangleComponent, sizes: order.map(([, n]) => n) };
}

/** Keep the triangles of the listed components and drop the vertices nothing uses. */
export function keepComponents(mesh, triangleComponent, keep) {
  const want = new Set(keep);
  const remap = new Int32Array(mesh.positions.length / 3).fill(-1);
  const positions = [];
  const indices = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    if (!want.has(triangleComponent[t / 3])) continue;
    for (let k = 0; k < 3; k += 1) {
      const v = mesh.indices[t + k];
      if (remap[v] < 0) {
        remap[v] = positions.length / 3;
        positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      }
      indices.push(remap[v]);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/**
 * Edges used by other than exactly two triangles, and edges whose two
 * triangles traverse them in the same direction. Both are zero for a closed,
 * consistently wound 2-manifold.
 */
export function manifoldReport(indices) {
  const uses = new Map();
  let edges = 0;
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const a = indices[t + k];
      const b = indices[t + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let e = uses.get(key);
      if (!e) {
        uses.set(key, (e = { n: 0, forward: 0 }));
        edges += 1;
      }
      e.n += 1;
      if (a < b) e.forward += 1;
    }
  }
  let open = 0;
  let overShared = 0;
  let inconsistent = 0;
  for (const e of uses.values()) {
    if (e.n === 1) open += 1;
    else if (e.n > 2) overShared += 1;
    else if (e.forward !== 1) inconsistent += 1;
  }
  return { edges, nonManifoldEdges: open + overShared, openEdges: open, overSharedEdges: overShared, inconsistentlyWoundEdges: inconsistent };
}

/** Signed enclosed volume (divergence theorem); positive for an outward-wound closed surface. */
export function signedVolume(positions, indices) {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    v += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v / 6;
}
