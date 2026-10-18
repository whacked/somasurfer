/**
 * Whether a Z-Anatomy structure, carried into MNI space by our affine, stays
 * inside the ICBM152 cortex it is drawn with (DOG-238).
 *
 * The cortex the viewer shows is ICBM152 2009c; everything else is Z-Anatomy,
 * placed by one affine fitted on deep grey nuclei. Far from those nuclei the
 * affine's error is unmeasured, and at the top of the head it put the falx
 * 15 mm above the cortex. A structure that pokes out through the brain it is
 * drawn with is not anatomy, so it does not ship.
 *
 * Per vertex, in MNI millimetres (the mesh frame through `meshToMni`):
 *
 *   inside   inside the closed cortex surface (both hemispheres; each is
 *            checked closed and manifold by tools/check-icbm-cortex.mjs), by
 *            ray parity along +x, +y and +z, taken by majority
 *   under    the cortex lies above it: an upward ray from it, or from a point
 *            ROOF_OFFSET_MM to its left, right, front or back, crosses the
 *            cortex surface; or it is below the cortex's lowest point. The
 *            surface is the cerebrum only, so the cerebellum, brainstem, fourth
 *            ventricle and the vessels and nerves at the skull base are all
 *            outside it, and are under it. The offsets close the cleft between
 *            the hemispheres, which a single ray at the midline slips through
 *   beyond   neither: outside the cortex where nothing of it is above. Its
 *            distance outside is the distance to the nearest cortex surface
 *
 * A structure is held when its farthest beyond vertex is more than
 * TOLERANCE_MM outside: roughly the CSF gap between the brain and the dura.
 *
 * What this cannot see: a structure that is misplaced but stays inside or
 * under the cortex, and so any structure displaced DOWNWARD: the exemption is
 * everything below the cerebrum's overhang. The tentorium, 26 mm short of the
 * occipital pole, and the orbitofrontal ACA branches, 8-13 mm below the orbital
 * surface (DOG-240), are under it and pass; both are held by decision. So that
 * the next one shows, each row also records `underMaxMm`, the farthest outside
 * vertex the exemption excuses (above the cortex's lowest point), and the mesh
 * report lists the largest. It is reported, not gated: the posterior fossa and
 * the skull base are legitimately far outside the cerebrum.
 */

import { readMeshBin, structureGeometry } from './meshbin.mjs';
import { applyAffine } from './brain-registration.mjs';
import { nearestSurfaceDistance, triangleGrid } from './mesh-geometry.mjs';

export const CONTAINMENT = Object.freeze({
  /** How far outside the cortex a vertex may be. The CSF gap; proposed in the DOG-238 feedback and adopted. */
  toleranceMm: 3,
  /**
   * The roof test's sideways reach. 3, 5 and 8 mm hold the same eight
   * structures on the committed build; 0 leaves the vermis, the fourth
   * ventricle and a medullary pyramid exposed through the midline cleft.
   */
  roofOffsetMm: 5,
});

/** Side length of the 2D bins that file triangles for axis-aligned rays, mm. */
const BIN_MM = 2;

/**
 * Rays along +axis from a point, against a triangle soup: for each axis, the
 * triangles filed by their footprint on the other two axes. Returns the number
 * of crossings strictly ahead of the point.
 */
function axisRays(P, I, axis) {
  const [u, w] = [0, 1, 2].filter((k) => k !== axis);
  const bins = new Map();
  const key = (a, b) => `${a},${b}`;
  for (let t = 0; t < I.length; t += 3) {
    let lu = Infinity;
    let hu = -Infinity;
    let lw = Infinity;
    let hw = -Infinity;
    for (let k = 0; k < 3; k += 1) {
      const v = I[t + k] * 3;
      lu = Math.min(lu, P[v + u]);
      hu = Math.max(hu, P[v + u]);
      lw = Math.min(lw, P[v + w]);
      hw = Math.max(hw, P[v + w]);
    }
    for (let x = Math.floor(lu / BIN_MM); x <= Math.floor(hu / BIN_MM); x += 1) {
      for (let y = Math.floor(lw / BIN_MM); y <= Math.floor(hw / BIN_MM); y += 1) {
        const k = key(x, y);
        let list = bins.get(k);
        if (!list) bins.set(k, (list = []));
        list.push(t);
      }
    }
  }
  return (p) => {
    const list = bins.get(key(Math.floor(p[u] / BIN_MM), Math.floor(p[w] / BIN_MM)));
    if (!list) return 0;
    let n = 0;
    for (const t of list) {
      const a = I[t] * 3;
      const b = I[t + 1] * 3;
      const c = I[t + 2] * 3;
      const ax = P[a + u] - p[u];
      const ay = P[a + w] - p[w];
      const bx = P[b + u] - p[u];
      const by = P[b + w] - p[w];
      const cx = P[c + u] - p[u];
      const cy = P[c + w] - p[w];
      const d1 = ax * by - ay * bx;
      const d2 = bx * cy - by * cx;
      const d3 = cx * ay - cy * ax;
      // Strictly inside the footprint; a ray through an edge counts for neither
      // triangle, which the majority over three axes absorbs.
      if (!((d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0))) continue;
      const hit = (d2 * P[a + axis] + d3 * P[b + axis] + d1 * P[c + axis]) / (d1 + d2 + d3);
      if (hit > p[axis]) n += 1;
    }
    return n;
  };
}

/**
 * The cortex as a reference: the committed ICBM low tier (the one the page
 * draws), every structure in it, in MNI mm.
 */
export function cortexReference(icbmDoc, icbmBytes) {
  const mesh = readMeshBin(icbmBytes);
  const parts = icbmDoc.structures.map((s) => structureGeometry(mesh, mesh.table[s.slot]));
  const P = new Float64Array(parts.reduce((n, g) => n + g.positions.length, 0));
  const I = new Uint32Array(parts.reduce((n, g) => n + g.indices.length, 0));
  let pv = 0;
  let pi = 0;
  for (const g of parts) {
    P.set(g.positions, pv);
    for (let i = 0; i < g.indices.length; i += 1) I[pi + i] = g.indices[i] + pv / 3;
    pv += g.positions.length;
    pi += g.indices.length;
  }
  let zMin = Infinity;
  for (let v = 2; v < P.length; v += 3) zMin = Math.min(zMin, P[v]);
  const rays = [0, 1, 2].map((a) => axisRays(P, I, a));
  const up = rays[2];
  const r = CONTAINMENT.roofOffsetMm;
  const roof = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]];
  const grid = triangleGrid(P, I, 48);
  return {
    zMin,
    inside: (p) => rays.filter((ray) => ray(p) % 2 === 1).length >= 2,
    under: (p) => p[2] < zMin || roof.some(([dx, dy]) => up([p[0] + dx, p[1] + dy, p[2]]) > 0),
    distance: (p) => nearestSurfaceDistance(grid, p[0], p[1], p[2]),
  };
}

/** One structure's vertices (mesh frame) against the reference. */
export function measureContainment(ref, positions, meshToMni) {
  let outside = 0;
  let beyond = 0;
  let beyondMaxMm = 0;
  let overTolerance = 0;
  let underMaxMm = 0;
  for (let v = 0; v < positions.length; v += 3) {
    const p = applyAffine(meshToMni, [positions[v], positions[v + 1], positions[v + 2]]);
    if (ref.inside(p)) continue;
    outside += 1;
    if (ref.under(p)) {
      if (p[2] >= ref.zMin) underMaxMm = Math.max(underMaxMm, ref.distance(p));
      continue;
    }
    beyond += 1;
    const d = ref.distance(p);
    if (d > beyondMaxMm) beyondMaxMm = d;
    if (d > CONTAINMENT.toleranceMm) overTolerance += 1;
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { vertices: positions.length / 3, outside, beyond, overTolerance, beyondMaxMm: r2(beyondMaxMm), underMaxMm: r2(underMaxMm) };
}

/** Whether a measured row holds its structure. The only place the rule is applied. */
export const outsideCortex = (row) => row.beyondMaxMm > CONTAINMENT.toleranceMm;

/** Every structure of an ATLM file + its structures.json (or a subset by id), measured. */
export function measureMeshSet(ref, meshBytes, structures, meshToMni) {
  const mesh = readMeshBin(meshBytes);
  const bySlotId = new Map(mesh.table.map((t) => [t.id, t]));
  return structures.map((s) => {
    const entry = bySlotId.get(s.id);
    if (!entry) throw new Error(`${s.name} (id ${s.id}) is not in the mesh file`);
    const g = structureGeometry(mesh, entry);
    return { id: s.id, name: s.name.trim(), category: s.category, ...measureContainment(ref, g.positions, meshToMni) };
  });
}
