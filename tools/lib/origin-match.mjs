/**
 * The machinery of the pre-registered origin test (docs/brain-origin-test.md):
 * one global similarity transform fitted by ICP, then per-structure figures
 * judged by tools/lib/origin-test.mjs. Nothing in here chooses a threshold.
 */

import { nearestSurfacePoint, oneSidedDistance, triangleGrid } from './mesh-geometry.mjs';
import { ORIGIN_TEST, originPasses } from './origin-test.mjs';

const centroidOf = (positions) => {
  const c = [0, 0, 0];
  const n = positions.length / 3;
  for (let v = 0; v < positions.length; v += 3) for (let k = 0; k < 3; k += 1) c[k] += positions[v + k];
  return c.map((x) => x / n);
};

/** 3x3 SVD by Jacobi on M^T M; enough for Umeyama's 3x3 cross-covariance. */
function svd3(M) {
  const At = (A) => A[0].map((_, j) => A.map((r) => r[j]));
  const mul = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((n, x, k) => n + x * B[k][j], 0)));
  let S = mul(At(M), M);
  let V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep += 1) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(S[p][q]) < 1e-30) continue;
      const theta = (S[q][q] - S[p][p]) / (2 * S[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      const J = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      J[p][p] = c;
      J[q][q] = c;
      J[p][q] = s;
      J[q][p] = -s;
      S = mul(mul(At(J), S), J);
      V = mul(V, J);
    }
  }
  const sig = [0, 1, 2].map((i) => Math.sqrt(Math.max(0, S[i][i])));
  const order = [0, 1, 2].sort((a, b) => sig[b] - sig[a]);
  const Vs = V.map((r) => order.map((i) => r[i]));
  const sigma = order.map((i) => sig[i]);
  const MV = mul(M, Vs);
  const U = MV.map((r) => r.map((x, j) => (sigma[j] > 1e-30 ? x / sigma[j] : 0)));
  return { U, sigma, V: Vs };
}

const det3 = (A) => A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);

/** Umeyama (1991): the similarity minimising |dst - (s R src + t)|^2. Proper rotation only. */
export function umeyama(src, dst) {
  const n = src.length;
  const ms = [0, 1, 2].map((k) => src.reduce((a, p) => a + p[k], 0) / n);
  const md = [0, 1, 2].map((k) => dst.reduce((a, p) => a + p[k], 0) / n);
  let varS = 0;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i += 1) {
    const a = [0, 1, 2].map((k) => src[i][k] - ms[k]);
    const b = [0, 1, 2].map((k) => dst[i][k] - md[k]);
    varS += a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) C[r][c] += (b[r] * a[c]) / n;
  }
  varS /= n;
  const { U, sigma, V } = svd3(C);
  const D = [1, 1, det3(U) * det3(V) < 0 ? -1 : 1];
  const R = [0, 1, 2].map((r) => [0, 1, 2].map((c) => U[r][0] * D[0] * V[c][0] + U[r][1] * D[1] * V[c][1] + U[r][2] * D[2] * V[c][2]));
  const s = (sigma[0] * D[0] + sigma[1] * D[1] + sigma[2] * D[2]) / varS;
  const t = [0, 1, 2].map((r) => md[r] - s * (R[r][0] * ms[0] + R[r][1] * ms[1] + R[r][2] * ms[2]));
  return { s, R, t };
}

export const applySim = ({ s, R, t }, p) => [0, 1, 2].map((r) => s * (R[r][0] * p[0] + R[r][1] * p[1] + R[r][2] * p[2]) + t[r]);

function transformAll(sim, positions) {
  const out = new Float64Array(positions.length);
  for (let v = 0; v < positions.length; v += 3) {
    const q = applySim(sim, [positions[v], positions[v + 1], positions[v + 2]]);
    out[v] = q[0];
    out[v + 1] = q[1];
    out[v + 2] = q[2];
  }
  return out;
}

/** Every k-th vertex, so one large structure cannot dominate the fit. */
function sampleVertices(positions, max) {
  const n = positions.length / 3;
  const step = Math.max(1, Math.floor(n / max));
  const out = [];
  for (let v = 0; v < n; v += step) out.push([positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
  return out;
}

/**
 * Fit ONE similarity for the whole set by ICP: every candidate vertex is paired
 * with the nearest point of its own same-named reference. `init` is the
 * starting similarity, from the stated axis conventions of the two frames.
 */
export function fitGlobalSimilarity(pairs, init, { iterations = 40, perStructure = 1500 } = {}) {
  const grids = new Map(pairs.map((p) => [p.name, triangleGrid(p.reference.positions, p.reference.indices)]));
  const samples = pairs.map((p) => ({ name: p.name, pts: sampleVertices(p.candidate.positions, perStructure) }));
  // Start by matching centroids under the initial rotation and scale.
  let sim = init;
  const cAll = centroidOf(Float64Array.from(samples.flatMap((s) => s.pts.flat())));
  const rAll = centroidOf(Float64Array.from(pairs.flatMap((p) => [...p.reference.positions])));
  const moved = applySim(sim, cAll);
  sim = { ...sim, t: sim.t.map((x, k) => x + rAll[k] - moved[k]) };
  let last = Infinity;
  const history = [];
  for (let it = 0; it < iterations; it += 1) {
    const src = [];
    const dst = [];
    let sum = 0;
    for (const s of samples) {
      const g = grids.get(s.name);
      for (const p of s.pts) {
        const q = applySim(sim, p);
        const hit = nearestSurfacePoint(g, q[0], q[1], q[2]);
        src.push(p);
        dst.push(hit.point);
        sum += hit.distance;
      }
    }
    const mean = sum / src.length;
    history.push(mean);
    sim = umeyama(src, dst);
    if (Math.abs(last - mean) < 1e-4) break;
    last = mean;
  }
  return { sim, history };
}

/**
 * Per-structure figures under one fitted similarity, and the negative control:
 * the same figures against the nearest DIFFERENTLY named reference.
 */
export function scoreStructures(pairs, sim) {
  const refs = pairs.map((p) => ({ name: p.name, ...p.reference, grid: triangleGrid(p.reference.positions, p.reference.indices), centroid: centroidOf(p.reference.positions) }));
  // Label agreement asks which reference is nearest, over all of them. One grid
  // over every reference, each triangle labelled, answers that in one query;
  // a query per reference grid walks nearly every cell of each far-away one.
  const allPositions = [];
  const allIndices = [];
  const labelOf = [];
  for (const r of refs) {
    const base = allPositions.length / 3;
    for (const x of r.positions) allPositions.push(x);
    for (let t = 0; t < r.indices.length; t += 3) {
      allIndices.push(r.indices[t] + base, r.indices[t + 1] + base, r.indices[t + 2] + base);
      labelOf.push(r.name);
    }
  }
  const allGrid = triangleGrid(Float64Array.from(allPositions), Uint32Array.from(allIndices), 64);

  const out = [];
  for (const p of pairs) {
    const moved = transformAll(sim, p.candidate.positions);
    const candGrid = triangleGrid(moved, p.candidate.indices);
    const figures = (ref) => {
      const fwd = oneSidedDistance(moved, ref.grid);
      const back = oneSidedDistance(ref.positions, candGrid);
      const meanSymmetric = (fwd.mean * fwd.count + back.mean * back.count) / (fwd.count + back.count);
      // Label agreement: the share of candidate vertices whose nearest reference
      // surface, among ALL references in the set, is `ref`.
      let agree = 0;
      for (let v = 0; v < moved.length; v += 3) {
        const hit = nearestSurfacePoint(allGrid, moved[v], moved[v + 1], moved[v + 2]);
        if (labelOf[hit.triangle / 3] === ref.name) agree += 1;
      }
      const r = { meanSymmetricMm: meanSymmetric, p95Mm: fwd.p95, labelAgreement: agree / (moved.length / 3) };
      return { ...r, passes: originPasses({ meanSymmetricMm: r.meanSymmetricMm, p95Mm: r.p95Mm, labelAgreement: r.labelAgreement }) };
    };
    const own = refs.find((r) => r.name === p.name);
    const cc = centroidOf(moved);
    const other = refs
      .filter((r) => r.name !== p.name)
      .sort((a, b) => Math.hypot(...a.centroid.map((x, k) => x - cc[k])) - Math.hypot(...b.centroid.map((x, k) => x - cc[k])))[0];
    out.push({ name: p.name, role: p.role, matched: figures(own), control: { against: other.name, ...figures(other) } });
  }
  return out;
}

/** The aggregate verdict, including the negative control's veto. */
export function verdict(scores) {
  const control = scores.filter((s) => s.control.passes).length;
  const controlShare = control / scores.length;
  const discriminates = controlShare <= ORIGIN_TEST.maxNegativeControlPassShare;
  return { controlPasses: control, controlShare, discriminates };
}
