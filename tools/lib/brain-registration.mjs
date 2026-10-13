/**
 * Our own MNI → brain-mesh affine (DOG-127), and the measurements that judge it.
 *
 * brainproject ships an affine of its own, and placed its imaging-registered
 * nuclei with it. We do not reuse it, and we do not fit to anything it placed:
 * a landmark that brainproject's affine put into the mesh would just hand that
 * affine back to us with a flattering residual. Every landmark here is a
 * structure whose SURFACE is Z-Anatomy's own (its globus pallidus, hypothalamus,
 * caudate, putamen and mammillary bodies; the pallidus and hypothalamus as the
 * union of the partitions brainproject cut them into, which is the original
 * surface), paired with the centroid of the same structure in an independent
 * MNI-space atlas (CIT168, CC BY 4.0, in ICBM152 2009c).
 *
 * The held-out figure is the red nucleus, which is in both and never in the fit:
 * the same control brainproject used, so the two numbers are comparable.
 */

import { readMeshBin, structureGeometry } from './meshbin.mjs';

/** Landmarks: CIT168 label → the Z-Anatomy mesh structures whose union is the same structure. */
export const LANDMARKS = Object.freeze([
  { key: 'putamen', cit168: ['Pu'], mesh: { l: ['Putamen.l'], r: ['Putamen.r'] } },
  { key: 'caudate', cit168: ['Ca'], mesh: { l: ['Caudate nucleus.l'], r: ['Caudate nucleus.r'] } },
  {
    key: 'globus-pallidus',
    cit168: ['GPe', 'GPi'],
    mesh: { l: ['Globus pallidus external.l', 'Globus pallidus internal.l'], r: ['Globus pallidus external.r', 'Globus pallidus internal.r'] },
  },
  {
    key: 'hypothalamus',
    cit168: ['HTH'],
    mesh: Object.fromEntries(['l', 'r'].map((s) => [s, ['Preoptic', 'Anterior', 'Tuberal', 'Lateral', 'Posterior'].map((z) => `${z} hypothalamus.${s}`)])),
  },
  { key: 'mammillary-body', cit168: ['MN'], mesh: { l: ['Mamillary body.l'], r: ['Mamillary body.r'] } },
]);

/** Above this share of boundary edges a surface is not closed enough to have a volume centroid. */
export const MAX_OPEN_EDGE_SHARE = 0.005;

/** Never in the fit. */
export const HELD_OUT = Object.freeze([
  { key: 'red-nucleus', cit168: ['RN'], mesh: { l: ['Red nucleus.l'], r: ['Red nucleus.r'] } },
]);

/** CIT168 v1.1.0 `labels.txt`, volume index by label. */
export const CIT168_LABELS = Object.freeze(['Pu', 'Ca', 'NAC', 'EXA', 'GPe', 'GPi', 'SNc', 'RN', 'SNr', 'PBP', 'VTA', 'VeP', 'HN', 'HTH', 'MN', 'STH']);

/**
 * The volume centroid of a closed surface (the union of `geoms`), by the
 * divergence theorem: each triangle with the origin spans a signed tetrahedron.
 * A surface that is not closed has no volume to speak of, so the boundary-edge
 * count is returned with it. A few open edges (a sliver triangle lost to
 * quantisation) move the centroid by far less than the residuals at stake; a
 * real hole does not, and the caller refuses a surface more than
 * MAX_OPEN_EDGE_SHARE open.
 */
export function volumeCentroid(geoms) {
  // Integrate about the surface's own vertex mean, not the world origin. The
  // mesh frame's origin is 1.6 m away, and an open edge's error grows with the
  // distance to the apex: about the origin, 13 open edges put the hypothalamus
  // 100 mm below the brain. About a point inside, they cost a fraction of a
  // millimetre.
  const o = [0, 0, 0];
  let n = 0;
  for (const { positions } of geoms) {
    for (let v = 0; v < positions.length; v += 3) {
      o[0] += positions[v];
      o[1] += positions[v + 1];
      o[2] += positions[v + 2];
      n += 1;
    }
  }
  for (let k = 0; k < 3; k += 1) o[k] /= n;
  let vol = 0;
  const c = [0, 0, 0];
  const edges = new Map();
  for (const { positions: p, indices: ix } of geoms) {
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3;
      const b = ix[t + 1] * 3;
      const d = ix[t + 2] * 3;
      const A = [p[a] - o[0], p[a + 1] - o[1], p[a + 2] - o[2]];
      const B = [p[b] - o[0], p[b + 1] - o[1], p[b + 2] - o[2]];
      const D = [p[d] - o[0], p[d + 1] - o[1], p[d + 2] - o[2]];
      const v = (A[0] * (B[1] * D[2] - B[2] * D[1]) - A[1] * (B[0] * D[2] - B[2] * D[0]) + A[2] * (B[0] * D[1] - B[1] * D[0])) / 6;
      vol += v;
      for (let k = 0; k < 3; k += 1) c[k] += (v * (A[k] + B[k] + D[k])) / 4;
      // Edges keyed by position, not index: two partitions of one surface
      // share an edge's coordinates but not its vertex ids.
      for (let e = 0; e < 3; e += 1) {
        const u = ix[t + e] * 3;
        const w = ix[t + ((e + 1) % 3)] * 3;
        const ku = `${p[u]},${p[u + 1]},${p[u + 2]}`;
        const kw = `${p[w]},${p[w + 1]},${p[w + 2]}`;
        const k = ku < kw ? `${ku}|${kw}` : `${kw}|${ku}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
  }
  let boundaryEdges = 0;
  for (const n of edges.values()) if (n === 1) boundaryEdges += 1;
  return { centroid: c.map((x, k) => x / vol + o[k]), volume: Math.abs(vol), boundaryEdges, edges: edges.size };
}

/** Geometry of named structures from a committed ATLM file plus its structures.json. */
export function meshGeometries(meshBytes, structuresDoc, names) {
  const mesh = readMeshBin(meshBytes);
  return names.map((name) => {
    const s = structuresDoc.structures.find((x) => x.name === name);
    if (!s) throw new Error(`${name} is not in the shipped brain structures`);
    return structureGeometry(mesh, mesh.table[s.slot]);
  });
}

/** Least-squares affine y = A x + b over pairs, as a 3x4 row-major matrix. */
export function fitAffine(pairs) {
  // Normal equations per output row: (X^T X) w = X^T y, X rows = [x, y, z, 1].
  const XtX = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const XtY = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const { from, to } of pairs) {
    const x = [...from, 1];
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) XtX[i][j] += x[i] * x[j];
      for (let r = 0; r < 3; r += 1) XtY[r][i] += x[i] * to[r];
    }
  }
  return XtY.map((rhs) => solve4(XtX, rhs));
}

function solve4(M, rhs) {
  const a = M.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < 4; col += 1) {
    let piv = col;
    for (let r = col + 1; r < 4; r += 1) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) throw new Error('affine fit is singular: the landmarks are coplanar');
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = 0; r < 4; r += 1) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let k = col; k < 5; k += 1) a[r][k] -= f * a[col][k];
    }
  }
  return a.map((row, i) => row[4] / row[i]);
}

export function applyAffine(T, p) {
  return T.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3]);
}

/** Inverse of a 3x4 affine. */
export function invertAffine(T) {
  const [[a, b, c], [d, e, f], [g, h, i]] = T;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const inv = [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
  const t = T.map((row) => row[3]);
  return inv.map((row) => [...row, -(row[0] * t[0] + row[1] * t[1] + row[2] * t[2])]);
}

/** Singular values of the 3x3 part, largest first, by Jacobi on A^T A. */
export function axisScales(T) {
  const A = T.map((r) => r.slice(0, 3));
  const M = [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[0][i] * A[0][j] + A[1][i] * A[1][j] + A[2][i] * A[2][j]));
  for (let sweep = 0; sweep < 50; sweep += 1) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(M[p][q]) < 1e-18) continue;
      const theta = (M[q][q] - M[p][p]) / (2 * M[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k += 1) {
        const mkp = M[k][p];
        const mkq = M[k][q];
        M[k][p] = c * mkp - s * mkq;
        M[k][q] = s * mkp + c * mkq;
      }
      for (let k = 0; k < 3; k += 1) {
        const mpk = M[p][k];
        const mqk = M[q][k];
        M[p][k] = c * mpk - s * mqk;
        M[q][k] = s * mpk + c * mqk;
      }
    }
  }
  return [M[0][0], M[1][1], M[2][2]].map((x) => Math.sqrt(Math.max(0, x))).sort((x, y) => y - x);
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Fit on `fit` pairs ({ mniMm, meshM }) and judge, in MNI millimetres:
 * in-sample residual per landmark, leave-one-out per landmark, and every
 * held-out pair. Errors are measured in MNI space (mesh centroid mapped back
 * through the inverse) because that is where a reported coordinate lives.
 */
export function evaluate(fit, heldOut) {
  const T = fitAffine(fit.map((l) => ({ from: l.mniMm, to: l.meshM })));
  const inv = invertAffine(T);
  const residual = (Tm, l) => dist(applyAffine(invertAffine(Tm), l.meshM), l.mniMm);
  const inSample = fit.map((l) => ({ id: l.id, mm: residual(T, l) }));
  const loo = fit.map((l, k) => ({ id: l.id, mm: residual(fitAffine(fit.filter((_, j) => j !== k).map((x) => ({ from: x.mniMm, to: x.meshM }))), l) }));
  const held = heldOut.map((l) => ({ id: l.id, mm: residual(T, l) }));
  return { mniToMesh: T, meshToMni: inv, inSample, loo, heldOut: held, scales: axisScales(T) };
}
