/**
 * How much cerebellum the cerebrum cut lets through, counted against a
 * reference we can read the licence of today.
 *
 * The ICBM152 2009c distribution has no cerebellum label, so the cut cannot be
 * checked against its own data. The reference used instead is the cerebellum
 * already committed in this repository: the 31 cerebellar structures of
 * packages/atlas-assets/brain/zanatomy-2929e94 (Z-Anatomy, CC BY-SA 4.0,
 * cleared in docs/asset-licensing.md), carried into MNI space by our own
 * affine, packages/atlas-assets/registration/mni-to-zanatomy-2929e94.json. It is
 * used to measure only. Nothing derived from it is in the cortex or its labels.
 *
 * The method, for a set of surface vertices in MNI millimetres:
 *
 *   1. Map each vertex into the brain-mesh frame with the affine's mniToMesh.
 *   2. It is INSIDE the reference when rays from it along +x AND along -x each
 *      cross some cerebellar structure's surface an odd number of times (each
 *      structure is tested on its own, then the results are OR-ed). Requiring
 *      both is what keeps a structure that is not perfectly closed from
 *      reading a point 37 mm outside it as inside, which one ray did.
 *   3. For inside vertices, the distance to the nearest cerebellar surface is
 *      the leak's depth. The affine's held-out error is 8.55 mm, measured at the
 *      deep grey nuclei; for the cerebellum it is extrapolated and unmeasured.
 *      So the counts are reported at three depths: any, deeper than 4 mm, and
 *      deeper than the held-out error. Only the last is robust to the error
 *      the registration is known to have.
 *
 * And a check on the reference itself: the share of reference vertices that
 * land, in MNI space, in tissue the cut removed. If the reference were badly
 * placed, that share would be low, and a low leak count would mean nothing.
 *
 * None of this validates the cut. It bounds the leak against one imperfect
 * reference, and says how imperfect.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './repo.mjs';
import { readMeshBin, structureGeometry } from './meshbin.mjs';
import { applyAffine, invertAffine } from './brain-registration.mjs';
import { nearestSurfaceDistance, triangleGrid } from './mesh-geometry.mjs';

export const REFERENCE = Object.freeze({
  set: 'zanatomy-2929e94',
  category: 'cerebellum',
  structures: 'packages/atlas-assets/brain/zanatomy-2929e94/structures.json',
  geometry: 'packages/atlas-assets/brain/zanatomy-2929e94/meshes.fullres.bin',
  registration: 'packages/atlas-assets/registration/mni-to-zanatomy-2929e94.json',
  licence: 'CC-BY-SA-4.0 (Z-Anatomy; the brainproject-brain-glb source in attribution.json)',
});
export const DEPTHS_MM = [0, 4];

/** The reference: per cerebellar structure, its triangles in the mesh frame (mm), bucketed for +x rays. */
export function loadReference() {
  const doc = JSON.parse(readFileSync(join(REPO_ROOT, REFERENCE.structures), 'utf8'));
  const mesh = readMeshBin(readFileSync(join(REPO_ROOT, REFERENCE.geometry)));
  const reg = JSON.parse(readFileSync(join(REPO_ROOT, REFERENCE.registration), 'utf8'));
  const picked = doc.structures.filter((s) => s.category === REFERENCE.category);
  const parts = picked.map((s) => {
    const g = structureGeometry(mesh, mesh.table[s.slot]);
    const positions = Float64Array.from(g.positions, (x) => x * 1000);
    return { name: s.name, positions, indices: Uint32Array.from(g.indices), ...rayBuckets(positions, g.indices) };
  });
  const allPos = [];
  const allIdx = [];
  for (const p of parts) {
    const base = allPos.length / 3;
    for (const x of p.positions) allPos.push(x);
    for (const i of p.indices) allIdx.push(i + base);
  }
  const grid = triangleGrid(Float64Array.from(allPos), Uint32Array.from(allIdx), 48);
  return { parts, grid, reg, heldOutMm: reg.summary.heldOut.meanMm, structureCount: picked.length };
}

const CELL = 2;
function rayBuckets(P, I) {
  const buckets = new Map();
  for (let t = 0; t < I.length; t += 3) {
    const ys = [P[I[t] * 3 + 1], P[I[t + 1] * 3 + 1], P[I[t + 2] * 3 + 1]];
    const zs = [P[I[t] * 3 + 2], P[I[t + 1] * 3 + 2], P[I[t + 2] * 3 + 2]];
    for (let gy = Math.floor(Math.min(...ys) / CELL); gy <= Math.floor(Math.max(...ys) / CELL); gy += 1) {
      for (let gz = Math.floor(Math.min(...zs) / CELL); gz <= Math.floor(Math.max(...zs) / CELL); gz += 1) {
        const k = `${gy},${gz}`;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(t);
      }
    }
  }
  return { buckets };
}

/** Odd numbers of crossings both ways along x with one structure. */
function inside(part, x, y, z) {
  const list = part.buckets.get(`${Math.floor(y / CELL)},${Math.floor(z / CELL)}`);
  if (!list) return false;
  const P = part.positions;
  const I = part.indices;
  let ahead = 0;
  let behind = 0;
  for (const t of list) {
    const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
    // Project to the (y, z) plane; barycentric test, then the x of the hit.
    const [ay, az, by, bz, cy, cz] = [P[a + 1], P[a + 2], P[b + 1], P[b + 2], P[c + 1], P[c + 2]];
    const d = (by - ay) * (cz - az) - (cy - ay) * (bz - az);
    if (d === 0) continue;
    const u = ((y - ay) * (cz - az) - (cy - ay) * (z - az)) / d;
    const v = ((by - ay) * (z - az) - (y - ay) * (bz - az)) / d;
    if (u < 0 || v < 0 || u + v > 1) continue;
    const hx = P[a] + u * (P[b] - P[a]) + v * (P[c] - P[a]);
    if (hx > x) ahead += 1;
    else behind += 1;
  }
  return ahead % 2 === 1 && behind % 2 === 1;
}

/** Count the vertices (MNI mm) that fall inside the mapped reference, by depth. */
export function countLeak(ref, positionsMni) {
  const n = positionsMni.length / 3;
  const counts = { vertices: n, inside: 0 };
  for (const d of DEPTHS_MM.slice(1)) counts[`deeperThan${d}Mm`] = 0;
  counts.deeperThanHeldOutError = 0;
  const examples = [];
  for (let v = 0; v < n; v += 1) {
    const m = applyAffine(ref.reg.mniToMesh, [positionsMni[v * 3], positionsMni[v * 3 + 1], positionsMni[v * 3 + 2]]).map((x) => x * 1000);
    if (!ref.parts.some((p) => inside(p, m[0], m[1], m[2]))) continue;
    counts.inside += 1;
    // Mesh-frame millimetres; the affine's scale is within a few per cent of 1.
    const depth = nearestSurfaceDistance(ref.grid, m[0], m[1], m[2]);
    for (const d of DEPTHS_MM.slice(1)) if (depth > d) counts[`deeperThan${d}Mm`] += 1;
    if (depth > ref.heldOutMm) counts.deeperThanHeldOutError += 1;
    if (examples.length < 5 || depth > examples[examples.length - 1].depthMm) {
      examples.push({ mni: [0, 1, 2].map((a) => Math.round(positionsMni[v * 3 + a])), depthMm: Math.round(depth * 10) / 10 });
      examples.sort((p, q) => q.depthMm - p.depthMm);
      if (examples.length > 5) examples.pop();
    }
  }
  return { ...counts, deepestExamples: examples };
}

/** The reference's own placement: where its vertices land relative to the cut. */
export function referenceAgainstCut(ref, cutAt, tissueAt) {
  const meshToMni = invertAffine(ref.reg.mniToMesh);
  let removed = 0;
  let kept = 0;
  let outside = 0;
  let total = 0;
  for (const p of ref.parts) {
    for (let v = 0; v < p.positions.length; v += 3) {
      const mni = applyAffine(meshToMni, [p.positions[v] / 1000, p.positions[v + 1] / 1000, p.positions[v + 2] / 1000]);
      total += 1;
      if (!tissueAt(mni)) outside += 1;
      else if (cutAt(mni[0], mni[1], mni[2])) removed += 1;
      else kept += 1;
    }
  }
  return { referenceVertices: total, inRemovedTissue: removed, inKeptCerebrum: kept, outsideTissue: outside };
}
