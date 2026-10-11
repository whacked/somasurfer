/**
 * Places an MNI point among the shipped brain structures (DOG-130).
 *
 * The point goes through the committed registration (`mniToMesh`) into the
 * mesh frame, then each structure's full-resolution surface is asked whether
 * it contains the point. Containment is decided by ray parity, cast three
 * times in skew directions and taken by majority, so a ray that grazes an edge
 * or slips through one of the few open edges W2 reports cannot decide it alone.
 *
 * The nearest surface is reported too, because "inside nothing" needs saying
 * with a distance. It is never a containing answer; see region-index.ts.
 *
 * Distances are millimetres in the mesh frame. The mesh is not MNI-scaled
 * (`axisScaleMeshMmPerMniMm` in the registration), so they are not MNI mm.
 */

import { readMeshBin, structureGeometry } from './meshbin.mjs';
import { nearestSurfaceDistance, triangleGrid } from './mesh-geometry.mjs';
import { applyAffine } from './brain-registration.mjs';

/** Skew, non-axis directions: no triangle edge of a real mesh lies along them. */
const RAYS = [
  [0.8017837, 0.5345225, 0.2672612],
  [-0.2672612, 0.8017837, -0.5345225],
  [0.5345225, -0.2672612, -0.8017837],
];

/** Crossings of the ray p + t·d (t > 0) with the triangle list: Möller–Trumbore. */
function crossings(pos, idx, p, d) {
  let n = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const e1x = pos[b] - pos[a];
    const e1y = pos[b + 1] - pos[a + 1];
    const e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a];
    const e2y = pos[c + 1] - pos[a + 1];
    const e2z = pos[c + 2] - pos[a + 2];
    const hx = d[1] * e2z - d[2] * e2y;
    const hy = d[2] * e2x - d[0] * e2z;
    const hz = d[0] * e2y - d[1] * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-18) continue;
    const inv = 1 / det;
    const sx = p[0] - pos[a];
    const sy = p[1] - pos[a + 1];
    const sz = p[2] - pos[a + 2];
    const u = (sx * hx + sy * hy + sz * hz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) n += 1;
  }
  return n;
}

/**
 * A locator over the structures listed in `structuresDoc`, reading geometry
 * from `meshBytes` (an ATLM file) and the transform from `registration`.
 * Returns `(mniMm) => { meshM, inside: [{ id, depthMm }], nearest: { id, distanceMm } | null }`.
 */
export function brainLocator(meshBytes, structuresDoc, registration) {
  const mesh = readMeshBin(meshBytes);
  const shapes = structuresDoc.structures.map((s) => {
    const entry = mesh.table[s.slot];
    if (!entry || entry.id !== s.id) throw new Error(`structure ${s.name}: slot ${s.slot} holds id ${entry?.id}, not ${s.id}`);
    const g = structureGeometry(mesh, entry);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < g.positions.length; v += 3) {
      for (let a = 0; a < 3; a += 1) {
        lo[a] = Math.min(lo[a], g.positions[v + a]);
        hi[a] = Math.max(hi[a], g.positions[v + a]);
      }
    }
    return { id: String(s.id), ...g, lo, hi, grid: null };
  });
  const gridOf = (sh) => (sh.grid ??= triangleGrid(sh.positions, sh.indices));
  const boxGap = (sh, p) => Math.hypot(...[0, 1, 2].map((a) => Math.max(sh.lo[a] - p[a], 0, p[a] - sh.hi[a])));

  return (mniMm) => {
    const p = applyAffine(registration.mniToMesh, mniMm);
    const inside = [];
    for (const sh of shapes) {
      if (boxGap(sh, p) > 0) continue;
      const votes = RAYS.filter((d) => crossings(sh.positions, sh.indices, p, d) % 2 === 1).length;
      if (votes >= 2) inside.push({ id: sh.id, depthMm: nearestSurfaceDistance(gridOf(sh), ...p) * 1000 });
    }
    // Exact nearest surface, pruned by box distance: a box farther than the
    // best surface so far cannot hold a nearer one.
    let nearest = null;
    for (const sh of [...shapes].sort((a, b) => boxGap(a, p) - boxGap(b, p))) {
      if (nearest && boxGap(sh, p) * 1000 > nearest.distanceMm) break;
      const d = nearestSurfaceDistance(gridOf(sh), ...p) * 1000;
      if (!nearest || d < nearest.distanceMm) nearest = { id: sh.id, distanceMm: d };
    }
    return { meshM: p, inside, nearest };
  };
}
