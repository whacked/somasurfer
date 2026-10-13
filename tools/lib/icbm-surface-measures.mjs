/**
 * Per-vertex measurements on the ICBM152 cerebral surface, all taken from the
 * template volumes (so, like tools/lib/icbm-cortex.mjs, build-time only):
 *
 *   depth   distance in mm from the vertex to the outside of the hemisphere's
 *           morphological closing (radius CLOSING_RADIUS_MM): ~0 on a gyral
 *           crown, large at a sulcal fundus. It is what the sulcal landmarks
 *           are traced along. It is our own measure, not FreeSurfer's `sulc`.
 *           On the medial cap (below) the surface is flat wherever the two
 *           hemispheres touch in the template, and the medial sulci (calcarine,
 *           parieto-occipital, cingulate) survive only as closed cavities under
 *           it, invisible at the GM + WM iso level but clear in the template's
 *           CSF probability map. There, depth is the HIDDEN SULCUS measure
 *           instead: CSF probability summed (1 mm steps) along the voxel column
 *           beneath the vertex, read along x into the hemisphere for
 *           HIDDEN_REACH_MM. It is in mm-equivalents of pure CSF: a cap vertex
 *           over a buried sulcus reads several; over solid cortex, ~0.
 *   cut     the vertex lies on a face the build cut, not on the brain's own
 *           surface: the voxel 1 mm beyond it along its outward normal is
 *           tissue (GM + WM > iso) that the build REMOVED, by the tentorial or
 *           brainstem cut or because it belongs to the other hemisphere. That is
 *           the medial cap where the hemispheres were split, and the faces of
 *           the two cuts. Tissue across a narrow sulcus is kept tissue, so the
 *           opposite bank of a sulcus does not read as a cut. Cut faces are not
 *           cortex and get no lobe.
 */

import { vertexNormals } from './mesh-geometry.mjs';
import { ISO, distanceTransform, sampler } from './icbm-cortex.mjs';

export const CLOSING_RADIUS_MM = 12;
export const CUT_PROBE_MM = 1;
export const HIDDEN_REACH_MM = 15;
/** Why a vertex is on a cut face: the hemisphere split, or the tentorial / brainstem cut. */
export const CUT = Object.freeze({ none: 0, medial: 1, fossa: 2 });

/**
 * Closing of one hemisphere's kept tissue, and the depth field inside it (mm),
 * on a sub-grid cropped to the hemisphere plus the closing radius, so the
 * distance transforms stay small. Returns `{ values, frame }` for `sampler`.
 */
export function depthField({ F: P, isoF, keep }, frame, inSide) {
  const [nx, ny, nz] = frame.dims;
  const lo = [nx, ny, nz];
  const hi = [-1, -1, -1];
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const v = (k * ny + j) * nx + i;
        if (!(keep[v] && P[v] > isoF && inSide(i))) continue;
        lo[0] = Math.min(lo[0], i); lo[1] = Math.min(lo[1], j); lo[2] = Math.min(lo[2], k);
        hi[0] = Math.max(hi[0], i); hi[1] = Math.max(hi[1], j); hi[2] = Math.max(hi[2], k);
      }
    }
  }
  const pad = CLOSING_RADIUS_MM + 2;
  const a = lo.map((x) => x - pad);
  const dims = hi.map((x, n) => x + pad - a[n] + 1);
  const [mx, my, mz] = dims;
  const count = mx * my * mz;
  const tissue = new Uint8Array(count);
  for (let k = 0; k < mz; k += 1) {
    for (let j = 0; j < my; j += 1) {
      for (let i = 0; i < mx; i += 1) {
        const [gi, gj, gk] = [i + a[0], j + a[1], k + a[2]];
        if (gi < 0 || gj < 0 || gk < 0 || gi >= nx || gj >= ny || gk >= nz) continue;
        const v = (gk * ny + gj) * nx + gi;
        if (keep[v] && P[v] > isoF && inSide(gi)) tissue[(k * my + j) * mx + i] = 1;
      }
    }
  }
  const r2 = CLOSING_RADIUS_MM * CLOSING_RADIUS_MM;
  // Dilate: every voxel within R of tissue. distanceTransform measures to the
  // nearest 0, so feed it the complement.
  for (let v = 0; v < count; v += 1) tissue[v] = tissue[v] ? 0 : 1;
  let d = distanceTransform(tissue, dims);
  for (let v = 0; v < count; v += 1) tissue[v] = d[v] <= r2 ? 1 : 0;
  // Erode the dilation by the same R: closed = voxels further than R from outside it.
  d = distanceTransform(tissue, dims);
  for (let v = 0; v < count; v += 1) tissue[v] = d[v] > r2 ? 1 : 0;
  d = distanceTransform(tissue, dims);
  const values = new Float32Array(count);
  for (let v = 0; v < count; v += 1) values[v] = Math.sqrt(d[v]);
  return { values, frame: { dims, offset: a.map((x, n) => x + frame.offset[n]) } };
}

/** depth, cut flag and outward normal per vertex of `mesh` (MNI mm). */
export function surfaceMeasures(mesh, { F: P, isoF, keep, wm, csf }, depthVolume, frame, inSide) {
  const n = mesh.positions.length / 3;
  const [nx, ny, nz] = frame.dims;
  const normals = vertexNormals(mesh.positions, mesh.indices);
  const removedAt = (x, y, z) => {
    const i = Math.round(x - frame.offset[0]);
    const j = Math.round(y - frame.offset[1]);
    const k = Math.round(z - frame.offset[2]);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return false;
    const v = (k * ny + j) * nx + i;
    if (!(P[v] > isoF)) return 0;
    if (!keep[v]) return CUT.fossa;
    if (!inSide(i)) return CUT.medial;
    return 0;
  };
  const depthAt = sampler(depthVolume.values, depthVolume.frame);
  const csfAt = sampler(csf, frame);
  const depth = new Float32Array(n);
  const cut = new Uint8Array(n);
  const wmAtProbe = new Float32Array(n);
  const wmAt = sampler(wm, frame);
  for (let v = 0; v < n; v += 1) {
    const [x, y, z] = [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];
    depth[v] = depthAt(x, y, z);
    const [a, b, c] = [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]];
    const [px, py, pz] = [x + a * CUT_PROBE_MM, y + b * CUT_PROBE_MM, z + c * CUT_PROBE_MM];
    cut[v] = removedAt(px, py, pz);
    wmAtProbe[v] = wmAt(px, py, pz);
    if (cut[v] === CUT.medial) {
      // Into the hemisphere is away from x = 0.
      const inward = x < 0 ? -1 : 1;
      let cavity = 0;
      for (let t = 1; t <= HIDDEN_REACH_MM; t += 1) cavity += csfAt(x + inward * t, y, z);
      depth[v] = cavity;
    }
  }
  return { depth, cut, wmAtProbe, normals };
}
