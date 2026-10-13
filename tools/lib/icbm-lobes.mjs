/**
 * First-party lobe delineation on the ICBM152 2009c cerebral surface.
 *
 * Nothing here reads a parcellation. The input is a set of landmarks that we
 * placed ourselves (tools/lib/icbm-lobe-landmarks.mjs), and the surface with
 * its per-vertex depth and cut flags (tools/lib/icbm-surface-measures.mjs).
 *
 *   1. SNAP. Every control point is an MNI coordinate we chose by inspecting
 *      the surface. It is snapped to a vertex. A sulcal point goes to the
 *      deepest non-cut vertex within SNAP_RADIUS_MM, which puts it on the
 *      fundus. A convention point (the preoccipital notch, a margin point, a
 *      cut rim) goes to the nearest non-cut vertex. Both the coordinate we gave
 *      and the vertex it landed on are recorded.
 *   2. TRACE. Consecutive control points of a boundary are joined by a
 *      minimum-cost path over the mesh edges (Dijkstra):
 *        - `sulcus`: cost = length / (1 + depth^2). A path at a 3 mm deep
 *          fundus costs a tenth of one on a crown, so the path keeps to the
 *          sulcus between the points. This is how the central sulcus, the
 *          lateral fissure, the parieto-occipital sulcus, the cingulate sulcus
 *          and the circular sulcus are traced.
 *        - `line`: cost = length x (1 + (d / LINE_WIDTH_MM)^2), where d is the
 *          distance from the straight chord between the two points. This is the
 *          "line drawn between landmarks" of the textbook definitions, kept on
 *          the surface. The lines used are: the parieto-occipital sulcus to the
 *          preoccipital notch, the posterior end of the lateral fissure to that
 *          line, the central sulcus to the lateral fissure, and the margins.
 *   3. FLOOD. The traced paths and the cut faces are barriers. Each lobe is a
 *      flood fill from one seed per hemisphere, over vertices that are not
 *      barriers. A flood that reaches another lobe's seed means the boundaries
 *      do not close. That is a build failure, never a silent merge.
 *   4. FILL. Barrier vertices take the label of the nearest labelled
 *      neighbour, by breadth-first propagation. Cut-face vertices keep label 0.
 *      Non-barrier vertices that no seed reached are counted and filled the
 *      same way. They are small pockets sealed off by crossing paths.
 */

import { fail } from './repo.mjs';
import { vertexNormals as vertexNormalsOf } from './mesh-geometry.mjs';

export const SNAP_RADIUS_MM = 5;
export const LINE_WIDTH_MM = 3;
/** A sulcus path's small pull toward the chord, so it cannot detour into a deeper neighbouring sulcus. */
export const SULCUS_CHORD_WEIGHT = 0.01;

export const LOBES = Object.freeze([
  { id: 0, key: 'cut', label: 'Cut surface (not cortex)' },
  { id: 1, key: 'frontal', label: 'Frontal lobe' },
  { id: 2, key: 'parietal', label: 'Parietal lobe' },
  { id: 3, key: 'temporal', label: 'Temporal lobe' },
  { id: 4, key: 'occipital', label: 'Occipital lobe' },
  { id: 5, key: 'insula', label: 'Insula' },
  { id: 6, key: 'limbic', label: 'Limbic lobe' },
  // Grown like a lobe so its extent is bounded by landmarks, then written as 0.
  { id: 7, key: 'medialWall', label: 'Medial wall (not cortex)' },
]);
const LOBE_ID = new Map(LOBES.map((l) => [l.key, l.id]));

/** Vertex adjacency as CSR, with edge lengths. */
export function adjacency(positions, indices) {
  const n = positions.length / 3;
  const deg = new Uint32Array(n + 1);
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      deg[indices[t + k]] += 2;
    }
  }
  const start = new Uint32Array(n + 1);
  for (let v = 0; v < n; v += 1) start[v + 1] = start[v] + deg[v];
  const fill = start.slice(0, n);
  const nbr = new Uint32Array(start[n]);
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const a = indices[t + k];
      const b = indices[t + ((k + 1) % 3)];
      const c = indices[t + ((k + 2) % 3)];
      nbr[fill[a]++] = b;
      nbr[fill[a]++] = c;
    }
  }
  // Deduplicate each row (every edge was entered once per adjacent triangle).
  const outStart = new Uint32Array(n + 1);
  const out = [];
  for (let v = 0; v < n; v += 1) {
    const row = [...new Set(nbr.subarray(start[v], start[v + 1]))];
    outStart[v + 1] = outStart[v] + row.length;
    for (const u of row) out.push(u);
  }
  return { start: outStart, nbr: Uint32Array.from(out) };
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const { k, v } = this;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const { k, v } = this;
    const top = v[0];
    const lastK = k.pop();
    const lastV = v.pop();
    if (k.length > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c += 1;
        if (k[c] >= lastK) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lastK; v[i] = lastV;
    }
    return top;
  }
}

const dist = (P, a, b) => Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);

/**
 * Snap an MNI point to a vertex: the deepest within the radius (`sulcus`), the
 * nearest (`surface`), or the nearest that touches the medial wall or a cut face
 * (`rim`), so that a boundary ending there closes against it.
 */
export function snap(surface, point, mode, adj = null) {
  const { positions: P, depth, blocked } = surface;
  const n = P.length / 3;
  let best = -1;
  let bestScore = Infinity;
  const onRim = (v) => {
    for (let e = adj.start[v]; e < adj.start[v + 1]; e += 1) if (blocked[adj.nbr[e]]) return true;
    return false;
  };
  for (let v = 0; v < n; v += 1) {
    if (blocked[v]) continue;
    if (mode === 'rim' && !onRim(v)) continue;
    const d = Math.hypot(P[v * 3] - point[0], P[v * 3 + 1] - point[1], P[v * 3 + 2] - point[2]);
    if (mode === 'sulcus') {
      if (d > SNAP_RADIUS_MM) continue;
      // Deepest first; distance breaks ties so the snap is deterministic.
      const score = -depth[v] + d * 1e-3;
      if (score < bestScore) { bestScore = score; best = v; }
    } else if (d < bestScore) {
      bestScore = d;
      best = v;
    }
  }
  return best;
}

/** Minimum-cost vertex path from `from` to `to`. */
export function trace(surface, adj, from, to, kind) {
  const { positions: P, depth, blocked } = surface;
  const n = P.length / 3;
  const a = [P[from * 3], P[from * 3 + 1], P[from * 3 + 2]];
  const b = [P[to * 3], P[to * 3 + 1], P[to * 3 + 2]];
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ab2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
  const chordDistance = (v) => {
    const p = [P[v * 3] - a[0], P[v * 3 + 1] - a[1], P[v * 3 + 2] - a[2]];
    const t = Math.max(0, Math.min(1, (p[0] * ab[0] + p[1] * ab[1] + p[2] * ab[2]) / ab2));
    return Math.hypot(p[0] - t * ab[0], p[1] - t * ab[1], p[2] - t * ab[2]);
  };
  const weight = kind === 'sulcus'
    ? (u, v) => dist(P, u, v) * (1 / (1 + ((depth[u] + depth[v]) / 2) ** 2) + SULCUS_CHORD_WEIGHT * (chordDistance(v) / LINE_WIDTH_MM) ** 2)
    : (u, v) => dist(P, u, v) * (1 + (chordDistance(v) / LINE_WIDTH_MM) ** 2);
  const best = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  best[from] = 0;
  heap.push(0, from);
  while (heap.size > 0) {
    const u = heap.pop();
    if (u === to) break;
    const bu = best[u];
    for (let e = adj.start[u]; e < adj.start[u + 1]; e += 1) {
      const v = adj.nbr[e];
      // A path never runs over the medial wall or a cut face: those are not cortex.
      if (blocked[v] && v !== to) continue;
      const c = bu + weight(u, v);
      if (c < best[v]) {
        best[v] = c;
        prev[v] = u;
        heap.push(c, v);
      }
    }
  }
  if (!Number.isFinite(best[to])) return null;
  const path = [];
  for (let v = to; v !== -1; v = prev[v]) path.push(v);
  return path.reverse();
}

/**
 * Which vertices are not cortex, and why. A fossa cut face (the tentorial and
 * brainstem cuts) never is. A medial cap vertex is part of the MEDIAL WALL when
 * its connected patch of cap vertices contains white matter (WM > WALL_WM at the
 * probe): the corpus callosum, fornix and anterior commissure, and the
 * diencephalon joined to them. A cap patch with no white matter in it is
 * cortex where the two hemispheres touch in the template; it is labelled like
 * any other cortex.
 */
export const WALL_WM = 0.5;
export function nonCortex(surface, adj) {
  const { cut, wm } = surface;
  const n = cut.length;
  const blocked = new Uint8Array(n);
  const patch = new Int32Array(n).fill(-1);
  const counts = { fossaCut: 0, medialWall: 0, corticalContact: 0, corticalContactPatches: 0 };
  for (let v = 0; v < n; v += 1) if (cut[v] === 2) { blocked[v] = 1; counts.fossaCut += 1; }
  for (let s = 0; s < n; s += 1) {
    if (cut[s] !== 1 || patch[s] !== -1) continue;
    const members = [s];
    patch[s] = s;
    let white = false;
    for (let q = 0; q < members.length; q += 1) {
      const u = members[q];
      if (wm[u] > WALL_WM) white = true;
      for (let e = adj.start[u]; e < adj.start[u + 1]; e += 1) {
        const v = adj.nbr[e];
        if (cut[v] === 1 && patch[v] === -1) { patch[v] = s; members.push(v); }
      }
    }
    if (white) {
      for (const v of members) blocked[v] = 1;
      counts.medialWall += members.length;
    } else {
      counts.corticalContact += members.length;
      counts.corticalContactPatches += 1;
    }
  }
  return { blocked, counts };
}

/**
 * The insula, placed from its landmark: everything inside the circular sulcus.
 * The insular floor is the cortex at the bottom of the lateral fissure that
 * faces laterally: vertices deeper than INSULA.minDepthMm whose outward normal
 * points laterally (|n_x| >= INSULA.lateralNormal), inside INSULA.box. Its
 * largest connected patch, with the holes inside it filled, is the insula, and
 * the patch's border is where the circular sulcus is recorded: the fold where
 * the laterally facing floor turns into the medially facing opercula.
 */
export const INSULA = Object.freeze({ minDepthMm: 12, lateralNormal: 0.6, box: { absX: [25, 45], y: [-40, 35], z: [-25, 30] } });
export function insularFloor(surface, adj, normals) {
  const { positions: P, depth, blocked } = surface;
  const n = P.length / 3;
  const cand = new Uint8Array(n);
  const { absX, y: by, z: bz } = INSULA.box;
  for (let v = 0; v < n; v += 1) {
    const [x, y, z] = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
    if (blocked[v] || depth[v] < INSULA.minDepthMm) continue;
    if (Math.abs(x) < absX[0] || Math.abs(x) > absX[1] || y < by[0] || y > by[1] || z < bz[0] || z > bz[1]) continue;
    // Lateral is away from x = 0.
    if (normals[v * 3] * Math.sign(x) >= INSULA.lateralNormal) cand[v] = 1;
  }
  const components = (member) => {
    const comp = new Int32Array(n).fill(-1);
    const sizes = [];
    for (let s = 0; s < n; s += 1) {
      if (!member(s) || comp[s] !== -1) continue;
      const id = sizes.length;
      const q = [s];
      comp[s] = id;
      for (let k = 0; k < q.length; k += 1) {
        const u = q[k];
        for (let e = adj.start[u]; e < adj.start[u + 1]; e += 1) {
          const v = adj.nbr[e];
          if (member(v) && comp[v] === -1) { comp[v] = id; q.push(v); }
        }
      }
      sizes.push(q.length);
    }
    return { comp, sizes };
  };
  const c = components((v) => cand[v] === 1);
  const biggest = c.sizes.indexOf(Math.max(...c.sizes));
  const floor = new Uint8Array(n);
  for (let v = 0; v < n; v += 1) if (c.comp[v] === biggest) floor[v] = 1;
  // Holes: every patch of the rest of the surface except its largest is enclosed by the floor.
  const rest = components((v) => floor[v] === 0);
  const outside = rest.sizes.indexOf(Math.max(...rest.sizes));
  let filled = 0;
  for (let v = 0; v < n; v += 1) {
    if (floor[v] === 0 && rest.comp[v] !== outside && !blocked[v]) { floor[v] = 1; filled += 1; }
  }
  let border = 0;
  let depthSum = 0;
  for (let v = 0; v < n; v += 1) {
    if (!floor[v]) continue;
    for (let e = adj.start[v]; e < adj.start[v + 1]; e += 1) {
      if (!floor[adj.nbr[e]]) { border += 1; depthSum += depth[v]; break; }
    }
  }
  return { floor, patchVertices: c.sizes[biggest], holesFilled: filled, borderVertices: border, borderMeanDepthMm: depthSum / Math.max(1, border) };
}

/** Triangles around each vertex, as CSR. */
function vertexTriangles(indices, n) {
  const start = new Uint32Array(n + 1);
  for (const v of indices) start[v + 1] += 1;
  for (let v = 0; v < n; v += 1) start[v + 1] += start[v];
  const fill = start.slice(0, n);
  const tri = new Uint32Array(indices.length);
  for (let t = 0; t < indices.length; t += 1) tri[fill[indices[t]]++] = Math.floor(t / 3);
  return { start, tri };
}

/**
 * Side seeds of a traced path. From every path vertex, walk over the surface
 * toward each of the two lobes' directions: each step goes to the neighbour
 * that advances furthest along the direction, never onto a barrier, until
 * SIDE_WALK_MM is covered or no step advances. Where the walk ends is a seed
 * for that lobe. From the fundus of a sulcus, the walk toward one lobe can only
 * climb the bank on that lobe's side, so the seed lands on the gyrus flanking
 * the sulcus there (for the central sulcus: the precentral gyrus for frontal,
 * the postcentral for parietal). A walk that does not get SIDE_MIN_WALK_MM
 * clear of the boundary's band within its band radius plus that distance seeds
 * nothing, and a vertex reached by walks for both lobes is dropped.
 */
export const SIDE_MIN_WALK_MM = 3;
/** Path vertices at each end of a segment that never start a walk: the ends are junctions. */
export const SIDE_END_SKIP = 4;
/**
 * A boundary is a band, not a line. A sulcal boundary covers the sulcus from its
 * fundus to its lips: every vertex within (depth at the nearest path vertex +
 * BAND_LIP_MM) of the path, capped at BAND_MAX_MM. In the template the banks of a
 * sulcus are often joined by a bridge above the fundus (a pli de passage, or two
 * gyri fused by averaging), and a line at the fundus leaves the bridge open; the
 * band covers it. A line boundary is BAND_LIP_MM wide. Band vertices take their
 * label afterwards from the nearer labelled side. A boundary may set its own
 * width (`bandMm`) where its course is a lip rather than a fundus.
 */
export const BAND_LIP_MM = 1.5;
export const BAND_MAX_MM = 12;
function band(P, pathVertices, radiusOf) {
  const n = P.length / 3;
  const cell = 4;
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (const u of pathVertices) {
    const k = key(P[u * 3], P[u * 3 + 1], P[u * 3 + 2]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(u);
  }
  const out = new Uint8Array(n);
  const reach = Math.ceil(BAND_MAX_MM / cell);
  for (let v = 0; v < n; v += 1) {
    const [x, y, z] = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
    const [cx, cy, cz] = [Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell)];
    let hit = false;
    for (let dx = -reach; dx <= reach && !hit; dx += 1) {
      for (let dy = -reach; dy <= reach && !hit; dy += 1) {
        for (let dz = -reach; dz <= reach && !hit; dz += 1) {
          const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const u of list) {
            if (Math.hypot(P[u * 3] - x, P[u * 3 + 1] - y, P[u * 3 + 2] - z) <= radiusOf(u)) { hit = true; break; }
          }
        }
      }
    }
    if (hit) out[v] = 1;
  }
  return out;
}
function sideSeedsOf(path, { P, adj, barrier, onPath, bandRadius, owner, self, cap }, hint) {
  const hn = Math.hypot(...hint) || 1;
  const h = hint.map((x) => x / hn);
  const ends = new Map();
  let ambiguous = 0;
  // Walk out of the band toward `dir`, then SIDE_MIN_WALK_MM beyond it, and no
  // further than that: a longer walk can cross some other sulcus or fissure.
  const walk = (start, dir) => {
    const limit = bandRadius[start] + SIDE_MIN_WALK_MM + 1;
    let u = start;
    let outside = 0;
    let walked = 0;
    for (;;) {
      let best = -1;
      let gain = 1e-6;
      for (let e = adj.start[u]; e < adj.start[u + 1]; e += 1) {
        const v = adj.nbr[e];
        // Nor over the medial cap: where the two hemispheres touch, it can
        // bridge the opening of a medial sulcus far above its fundus.
        if (onPath[v] || cap[v]) continue;
        const g = (P[v * 3] - P[u * 3]) * dir[0] + (P[v * 3 + 1] - P[u * 3 + 1]) * dir[1] + (P[v * 3 + 2] - P[u * 3 + 2]) * dir[2];
        if (g > gain) { gain = g; best = v; }
      }
      if (best < 0) break;
      const step = dist(P, u, best);
      walked += step;
      u = best;
      if (!barrier[u]) outside += step;
      else outside = 0;
      if (outside >= SIDE_MIN_WALK_MM || walked >= limit) break;
    }
    return !barrier[u] && outside >= SIDE_MIN_WALK_MM ? u : -1;
  };
  // A walk never starts at a junction: from a vertex another boundary shares
  // or touches, a step can land on either side of that other boundary.
  const nearOther = (u) => {
    if (owner[u] !== self) return true;
    for (let e = adj.start[u]; e < adj.start[u + 1]; e += 1) {
      const v = adj.nbr[e];
      if (onPath[v] && owner[v] !== self) return true;
    }
    return false;
  };
  for (let k = SIDE_END_SKIP; k < path.length - SIDE_END_SKIP; k += 1) {
    const start = path[k];
    if (nearOther(start)) { ambiguous += 1; continue; }
    const a = walk(start, h);
    const c = walk(start, h.map((x) => -x));
    if (a < 0 && c < 0) { ambiguous += 1; continue; }
    for (const [v, isA] of [[a, true], [c, false]]) {
      if (v < 0) continue;
      const prior = ends.get(v);
      ends.set(v, prior === undefined || prior === isA ? isA : null);
    }
  }
  const out = [];
  for (const [v, isA] of ends) if (isA !== null) out.push([v, isA]);
  return { seeds: out, ambiguous };
}

/**
 * Label every vertex of one hemisphere. `landmarks` is that hemisphere's entry
 * from icbm-lobe-landmarks.mjs. Returns the labels, the per-boundary provenance
 * (control points as given and as snapped, the traced polyline) and the QA
 * figures.
 *
 * The surface has handles (it is extracted from a probability map, and its
 * genus is in the hundreds), so a closed boundary curve need not separate it,
 * and a plain flood fill from one seed per lobe leaks through them. So every
 * traced segment also seeds BOTH of its sides: each segment names the lobe on
 * each side by a direction (for the central sulcus, frontal toward +y), the
 * winding gives the two sides, and the side whose vertices lie toward a lobe's
 * direction is that lobe's. All lobes then grow at once, by geodesic distance,
 * over vertices that are not on a boundary, the insula or non-cortex. A handle
 * can still carry a lobe across a boundary, but only as far as the region it
 * reaches is closer to the handle than to the boundary's own seeded side; the
 * QA figures (side-seed conflicts, lobe fragments) measure what that leaves.
 */
export function labelHemisphere(gate, surface, landmarks) {
  const { positions: P, indices } = surface;
  const n = P.length / 3;
  const adj = adjacency(P, indices);
  const vt = vertexTriangles(indices, n);
  const { blocked, counts } = nonCortex(surface, adj);
  surface = { ...surface, blocked };
  const normals = vertexNormalsOf(P, indices);
  const insula = insularFloor(surface, adj, normals);
  const barrier = Uint8Array.from(blocked);
  for (let v = 0; v < n; v += 1) if (insula.floor[v]) barrier[v] = 1;
  const xyz = (v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]].map((x) => Math.round(x * 10) / 10);
  const boundaries = [];
  const problems = [];
  const sideSeeds = [];
  const onPath = new Uint8Array(n);
  // Which boundary a path vertex belongs to; -1 where two share it.
  const owner = new Int32Array(n).fill(-1);

  for (const b of landmarks.boundaries) {
    const snapped = b.points.map((pt) => {
      const v = snap(surface, pt.mni, pt.snap, adj);
      if (v < 0) problems.push(`${landmarks.side} ${b.key}: control point ${pt.mni.join(', ')} has no ${pt.snap} vertex within reach.`);
      return v;
    });
    if (snapped.some((v) => v < 0)) continue;
    const vertices = [];
    const segmentPaths = [];
    let length = 0;
    for (let s = 0; s + 1 < snapped.length; s += 1) {
      const kind = b.segments?.[s] ?? b.kind;
      const path = trace(surface, adj, snapped[s], snapped[s + 1], kind);
      if (!path) {
        problems.push(`${landmarks.side} ${b.key}: no path from point ${s} to point ${s + 1}.`);
        continue;
      }
      for (let k = 1; k < path.length; k += 1) length += dist(P, path[k - 1], path[k]);
      vertices.push(...(s === 0 ? path : path.slice(1)));
      segmentPaths.push({ s, path });
    }
    for (const v of vertices) { barrier[v] = 1; if (onPath[v] && owner[v] !== boundaries.length) owner[v] = -1; else owner[v] = boundaries.length; onPath[v] = 1; }
    let depthSum = 0;
    for (const v of vertices) depthSum += surface.depth[v];
    boundaries.push({
      key: b.key,
      landmark: b.landmark,
      separates: b.separates,
      kind: b.kind,
      segments: b.segments,
      placement: b.placement,
      sides: b.sides,
      bandMm: b.bandMm,
      controlPoints: b.points.map((pt, k) => ({
        role: pt.role,
        snap: pt.snap,
        givenMni: pt.mni,
        snappedMni: xyz(snapped[k]),
        snappedDepthMm: Math.round(surface.depth[snapped[k]] * 10) / 10,
      })),
      lengthMm: Math.round(length * 10) / 10,
      meanDepthMm: Math.round((depthSum / Math.max(1, vertices.length)) * 10) / 10,
      vertices,
      segmentPaths,
    });
  }
  if (problems.length > 0) fail(gate, problems);

  // Bands, then side seeds, now that every path is a barrier.
  const bandRadius = new Float32Array(n);
  for (const b of boundaries) {
    for (const v of b.vertices) {
      const r = b.bandMm ?? (b.kind === 'sulcus' ? Math.min(BAND_MAX_MM, surface.depth[v] + BAND_LIP_MM) : BAND_LIP_MM);
      bandRadius[v] = Math.max(bandRadius[v], r);
    }
  }
  const allPath = [];
  for (let v = 0; v < n; v += 1) if (onPath[v]) allPath.push(v);
  const inBand = band(P, allPath, (u) => bandRadius[u]);
  let bandVertices = 0;
  for (let v = 0; v < n; v += 1) if (inBand[v] && !blocked[v] && !insula.floor[v]) { barrier[v] = 1; bandVertices += 1; }

  for (const b of boundaries) {
    for (const { s, path } of b.segmentPaths) {
      const spec = Array.isArray(b.sides) ? b.sides[s] : b.sides;
      const lobes = Object.keys(spec ?? {});
      if (lobes.length !== 2) fail(gate, [`${landmarks.side} ${b.key}: segment ${s} must name exactly two lobes in \`sides\`.`]);
      const [a, c] = lobes;
      const hint = spec[a].map((x, k) => x - spec[c][k]);
      const { seeds: sides, ambiguous } = sideSeedsOf(path, { P, adj, barrier, onPath, bandRadius, owner, self: boundaries.indexOf(b), cap: surface.cut }, hint);
      for (const [w, isA] of sides) sideSeeds.push([w, LOBE_ID.get(isA ? a : c), b.key]);
      b.sideSeeds = (b.sideSeeds ?? 0) + sides.length;
      b.unseededVertices = (b.unseededVertices ?? 0) + ambiguous;
    }
    delete b.segmentPaths;
  }

  // All lobes grow at once by geodesic distance.
  const label = new Int8Array(n).fill(-1);
  const best = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const heap = new Heap();
  const seeds = [];
  let sideConflicts = 0;
  const claimed = new Int8Array(n).fill(-1);
  for (const [w, id] of sideSeeds) {
    if (claimed[w] !== -1 && claimed[w] !== id) sideConflicts += 1;
    claimed[w] = id;
  }
  for (const s of landmarks.seeds) {
    const id = LOBE_ID.get(s.lobe);
    if (!id) fail(gate, [`${landmarks.side}: seed for unknown lobe ${s.lobe}.`]);
    if (s.lobe === 'insula') continue;
    const v = snap(surface, s.mni, 'surface');
    if (barrier[v]) fail(gate, [`${landmarks.side} ${s.lobe}: seed ${s.mni.join(', ')} lands on a boundary, the insula or non-cortex.`]);
    seeds.push({ lobe: s.lobe, givenMni: s.mni, snappedMni: xyz(v) });
    claimed[v] = id;
  }
  for (let v = 0; v < n; v += 1) {
    if (claimed[v] === -1) continue;
    label[v] = claimed[v];
    best[v] = 0;
    heap.push(0, v);
  }
  while (heap.size > 0) {
    const u = heap.pop();
    for (let e = adj.start[u]; e < adj.start[u + 1]; e += 1) {
      const v = adj.nbr[e];
      if (barrier[v]) continue;
      const c = best[u] + dist(P, u, v);
      if (c < best[v]) {
        best[v] = c;
        label[v] = label[u];
        parent[v] = u;
        heap.push(c, v);
      }
    }
  }
  let unreached = 0;
  for (let v = 0; v < n; v += 1) if (label[v] === -1 && !barrier[v]) unreached += 1;

  // Open fronts: two lobes that met in open cortex, with no boundary between
  // them. Every legitimate meeting is across a boundary, the insula or the
  // medial wall, so an open front is where the boundaries leave a gap or a
  // handle let a lobe across. Counted per lobe pair, with its extent.
  const openFronts = {};
  const frontVertex = new Uint8Array(n);
  for (let u = 0; u < n; u += 1) {
    if (barrier[u] || label[u] < 1) continue;
    for (let e = adj.start[u]; e < adj.start[u + 1]; e += 1) {
      const v = adj.nbr[e];
      if (v <= u || barrier[v] || label[v] < 1 || label[v] === label[u]) continue;
      const key = [LOBES[label[u]].key, LOBES[label[v]].key].sort().join('/');
      const f = (openFronts[key] ??= { edges: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
      f.edges += 1;
      frontVertex[u] = 1;
      frontVertex[v] = 1;
      for (let a = 0; a < 3; a += 1) {
        f.min[a] = Math.min(f.min[a], Math.round(P[u * 3 + a]));
        f.max[a] = Math.max(f.max[a], Math.round(P[u * 3 + a]));
      }
    }
  }
  for (let v = 0; v < n; v += 1) {
    if (blocked[v]) label[v] = 0;
    else if (insula.floor[v]) label[v] = LOBE_ID.get('insula');
  }

  // Boundary vertices and unreached pockets take the nearest labelled neighbour
  // (never the medial wall or a cut face).
  // The insula is exactly its floor: it never fills a band.
  const insulaId = LOBE_ID.get('insula');
  let frontier = [];
  for (let v = 0; v < n; v += 1) if (label[v] > 0 && label[v] !== insulaId) frontier.push(v);
  while (frontier.length > 0) {
    const next = [];
    for (const u of frontier) {
      for (let e = adj.start[u]; e < adj.start[u + 1]; e += 1) {
        const v = adj.nbr[e];
        if (label[v] !== -1) continue;
        label[v] = label[u];
        next.push(v);
      }
    }
    frontier = next;
  }
  let orphan = 0;
  for (let v = 0; v < n; v += 1) if (label[v] === -1) { orphan += 1; label[v] = 0; }
  const wallId = LOBE_ID.get('medialWall');
  let medialWallSurface = 0;
  for (let v = 0; v < n; v += 1) if (label[v] === wallId) { medialWallSurface += 1; label[v] = 0; }

  // Fragments: each lobe should be one connected region.
  const fragments = {};
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s += 1) {
    if (seen[s] || label[s] <= 0) continue;
    const q = [s];
    seen[s] = 1;
    for (let k = 0; k < q.length; k += 1) {
      const u = q[k];
      for (let e = adj.start[u]; e < adj.start[u + 1]; e += 1) {
        const v = adj.nbr[e];
        if (!seen[v] && label[v] === label[s]) { seen[v] = 1; q.push(v); }
      }
    }
    const c = [0, 0, 0];
    for (const u of q) for (let a = 0; a < 3; a += 1) c[a] += P[u * 3 + a] / q.length;
    (fragments[LOBES[label[s]].key] ??= []).push({ vertices: q.length, centroidMni: c.map((x) => Math.round(x)) });
  }
  for (const k of Object.keys(fragments)) fragments[k].sort((x, y) => y.vertices - x.vertices);

  return {
    label: Uint8Array.from(label),
    boundaries,
    seeds,
    insula: { patchVertices: insula.patchVertices, holesFilled: insula.holesFilled, circularSulcusVertices: insula.borderVertices, circularSulcusMeanDepthMm: Math.round(insula.borderMeanDepthMm * 10) / 10 },
    nonCortex: { ...counts, medialWallSurface },
    bandVertices,
    sideSeeds: sideSeeds.length,
    sideConflicts,
    openFronts,
    frontVertex,
    sideSeedList: sideSeeds,
    parent,
    barrier,
    unreachedVertices: unreached,
    orphanVertices: orphan,
    fragments,
  };
}
