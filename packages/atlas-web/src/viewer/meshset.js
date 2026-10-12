/**
 * Mesh sets (W2/W3 `meshes.*.bin` + `structures.json`) as drawable, pickable
 * world geometry. No DOM, no WebGL. Rationale: docs/viewer-meshes.md.
 */

import { readMeshBin } from './atlm.js';

const IDENTITY = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** `set.id.structureId`, the one spelling a structure has in the URL and the API. */
export const structureKey = (setId, id) => `${setId}.${id}`;

/**
 * Decode one ATLM file into world millimetres. `affine` (3x4 rows) maps the
 * file's frame to the world, `null` for identity. `describe(id, centre)` gives
 * a table entry's metadata from its box, or null to leave it out. `split(id)`, if given,
 * returns `{ labels, describe(value) }` to cut an entry into labelled parts by
 * per-vertex label (each triangle takes its vertices' majority).
 */
export function decodeMeshSet(bytes, { affine = null, describe, split = null }) {
  const m = readMeshBin(bytes);
  const A = affine ?? IDENTITY;
  const N = [crs(A[1], A[2]), crs(A[2], A[0]), crs(A[0], A[1])];
  const n = m.vertexCount;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const p = [0, 0, 0];
  for (let v = 0; v < n; v += 1) {
    for (let a = 0; a < 3; a += 1) p[a] = m.origin[a] + m.step[a] * m.positions[v * 3 + a];
    // octDecode, inlined: one call per vertex allocated more than the decode cost.
    const u = Math.max(-1, m.normals[v * 2] / 127);
    const w = Math.max(-1, m.normals[v * 2 + 1] / 127);
    const z = 1 - Math.abs(u) - Math.abs(w);
    const x = z < 0 ? (1 - Math.abs(w)) * (u >= 0 ? 1 : -1) : u;
    const y = z < 0 ? (1 - Math.abs(u)) * (w >= 0 ? 1 : -1) : w;
    let l = 0;
    for (let a = 0; a < 3; a += 1) {
      positions[v * 3 + a] = A[a][0] * p[0] + A[a][1] * p[1] + A[a][2] * p[2] + A[a][3];
      const c = N[a][0] * x + N[a][1] * y + N[a][2] * z;
      normals[v * 3 + a] = c;
      l += c * c;
    }
    l = Math.sqrt(l) || 1;
    for (let a = 0; a < 3; a += 1) normals[v * 3 + a] /= l;
  }

  const pieces = new Map();
  const piece = (meta) => {
    if (!pieces.has(meta.key)) pieces.set(meta.key, { meta, whole: [], tris: [] });
    return pieces.get(meta.key);
  };
  for (const e of m.table) {
    const base = m.index32 ? 0 : e.firstVertex;
    const own = describe(e.id, boxOf(positions, e.firstVertex, e.vertexCount));
    const parts = split?.(e.id);
    if (!parts) {
      if (own) piece(own).whole.push(e);
      continue;
    }
    for (let i = e.firstIndex; i < e.firstIndex + e.indexCount; i += 3) {
      const t = [m.indices[i] + base, m.indices[i + 1] + base, m.indices[i + 2] + base];
      const [la, lb, lc] = t.map((x) => parts.labels[x - e.firstVertex]);
      const meta = parts.describe(lb === lc ? lb : la) ?? own;
      if (meta) piece(meta).tris.push(...t);
    }
  }

  // Grouped by layer, so a layer is a run of triangles and a frame is a few draws.
  const ordered = [...pieces.values()].sort((x, y) => (x.meta.group < y.meta.group ? -1 : x.meta.group > y.meta.group ? 1 : 0));
  let total = 0;
  for (const pc of ordered) total += pc.tris.length + pc.whole.reduce((s, e) => s + e.indexCount, 0);
  const triangles = new Uint32Array(total);
  const structures = [];
  let at = 0;
  for (const { meta, whole, tris } of ordered) {
    const first = at;
    for (const e of whole) {
      const base = m.index32 ? 0 : e.firstVertex;
      for (let i = 0; i < e.indexCount; i += 1) triangles[at + i] = m.indices[e.firstIndex + i] + base;
      at += e.indexCount;
    }
    triangles.set(tris, at);
    at += tris.length;
    structures.push({ ...meta, firstTriangle: first / 3, triangleCount: (at - first) / 3, ...boxOfTriangles(positions, triangles, first, at) });
  }
  return { positions, normals, triangles, structures };
}

const BODY_CATEGORIES = new Set(['skin', 'muscle', 'skeleton', 'cardiovascular', 'nervous', 'respiratory', 'alimentary', 'urinary', 'genital', 'endocrine']);
const REGION = { C: 'cervical', T: 'thoracic', L: 'lumbar', S: 'sacral' };
export const BANDS = ['cranial', 'cervical', 'thoracic', 'lumbar', 'sacral', 'caudal'];

/**
 * The body layer a point falls in: the `BD` level its projection on the spine
 * axis lands in, `cranial` above C01, `caudal` past the last level.
 */
export function bandOf(template, point) {
  const slabs = template.slabs;
  let nearest = null;
  for (let i = 0; i < slabs.length; i += 1) {
    const s = slabs[i];
    const u = ((point[0] - s.origin[0]) * s.axial[0] + (point[1] - s.origin[1]) * s.axial[1] + (point[2] - s.origin[2]) * s.axial[2]) / s.heightMm;
    if (i === 0 && u < 0) return 'cranial';
    if (u >= 0 && u < 1) return REGION[s.label[0]];
    if (i === slabs.length - 1 && u >= 1) return 'caudal';
    if (!nearest || Math.abs(u - 0.5) < nearest.d) nearest = { d: Math.abs(u - 0.5), label: s.label };
  }
  return REGION[nearest.label[0]];
}

/**
 * Every band a structure's box spans, top to bottom, so the skin belongs to
 * all six and a layer hides it only when every band it spans is hidden.
 */
export function bandsOf(template, box) {
  const [x, y] = box.centre;
  const ends = [bandOf(template, [x, y, box.hi[2]]), bandOf(template, [x, y, box.lo[2]])].map((b) => BANDS.indexOf(b)).sort();
  return BANDS.slice(ends[0], ends[1] + 1);
}

/**
 * One declared mesh set (`index.meshSets[]`) and its documents, decoded from
 * `bytes` (a tier file) into world millimetres with every structure carrying
 * `key`, `name`, `category`, `parts` (its hemisphere, both for a midline
 * structure, or the body bands it spans) and `group`.
 * `body` is the bound `BD` template, which assigns body bands.
 */
export function meshSetFrom(entry, { structures: doc, labels = null, registration = null }, bytes, body = null) {
  const byId = new Map(doc.structures.map((s) => [s.id, s]));
  const meta = (s, extra = {}) => {
    const category = entry.atlas === 'body' && !BODY_CATEGORIES.has(s.category) ? 'other' : s.category;
    const sided = s.side === 'left' || s.side === 'right';
    const parts = extra.parts ?? (sided ? [s.side] : ['left', 'right']);
    // `name` is the source's (`Caudate nucleus.l`); `title` is what a reader sees.
    const title = s.label ? `${s.label}${sided ? ` (${s.side})` : ''}` : s.name;
    // Its key in the research API's region tree (DOG-132), when this set declares one.
    const apiId = entry.research && !extra.lobe ? s[entry.research.idField] : undefined;
    const regionKey = apiId === undefined ? null : `${entry.research.representation}/${apiId}`;
    return { key: structureKey(entry.id, s.id), id: s.id, set: entry.id, name: s.name, title, label: s.label ?? null, category, side: s.side ?? null, parts, group: `${category}|${parts.join('+')}`, regionKey, ...extra };
  };
  const placedBy = registration
    ? { errorMm: Math.max(...registration.heldOut.map((h) => h.errorMm)), registration: registration.id }
    : null;
  const describe = (id, box) => {
    const s = byId.get(id);
    if (!s) return null;
    if (entry.atlas === 'body') return meta(s, { parts: body ? bandsOf(body, box) : BANDS });
    return meta(s, placedBy ? { placedBy } : {});
  };
  let split = null;
  if (labels) {
    const lobes = labels.structures;
    split = (id) => {
      const string = labels.vertexLabels[String(id)];
      if (typeof string !== 'string') return null;
      const own = byId.get(id);
      return {
        labels: string,
        describe: (value) => {
          const lobe = lobes.find((l) => l.geometryStructure === id && l.value === Number(value));
          if (lobe) return meta({ ...lobe, category: own.category }, { lobe: true, labelSet: labels.id });
          // Unlabelled surface (the medial wall, the cut faces) keeps the
          // geometry's id and says what it is rather than calling it cortex.
          const v = labels.values.find((x) => x.value === Number(value));
          return v ? meta({ ...own, name: `${v.label}, ${own.side}`, label: v.label }) : null;
        },
      };
    };
  }
  return { id: entry.id, atlas: entry.atlas, ...decodeMeshSet(bytes, { affine: registration?.meshToMni ?? null, describe, split }) };
}

function boxOf(positions, first, count) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let v = first; v < first + count; v += 1) grow(lo, hi, positions, v);
  return finish(lo, hi);
}

function boxOfTriangles(positions, triangles, from, to) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = from; i < to; i += 1) grow(lo, hi, positions, triangles[i]);
  return finish(lo, hi);
}

function grow(lo, hi, positions, v) {
  for (let a = 0; a < 3; a += 1) {
    const x = positions[v * 3 + a];
    if (x < lo[a]) lo[a] = x;
    if (x > hi[a]) hi[a] = x;
  }
}

function finish(lo, hi) {
  const centre = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
  return { lo, hi, centre, radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1 };
}

/** The bounds of a list of structures, in the shape `fitCamera` takes. */
export function boundsOfStructures(structures) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const s of structures) {
    for (let a = 0; a < 3; a += 1) {
      lo[a] = Math.min(lo[a], s.lo[a]);
      hi[a] = Math.max(hi[a], s.hi[a]);
    }
  }
  return finish(lo, hi);
}

/** Ray parameter where the ray enters a box, or null if it misses. */
function enterBox(o, d, lo, hi) {
  let t0 = 0;
  let t1 = Infinity;
  for (let a = 0; a < 3; a += 1) {
    const inv = 1 / d[a];
    let ta = (lo[a] - o[a]) * inv;
    let tb = (hi[a] - o[a]) * inv;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}

/**
 * Nearest hit on any structure `accept` admits, as `{ structure, t, pointMm }`,
 * or null. Both faces hit, as in the v1 picker.
 */
export function pickStructure(meshes, origin, direction, accept = () => true) {
  let best = null;
  for (const mesh of meshes) {
    const { positions: P, triangles: T } = mesh;
    for (const s of mesh.structures) {
      if (!accept(s)) continue;
      const enter = enterBox(origin, direction, s.lo, s.hi);
      if (enter === null || (best && enter > best.t)) continue;
      for (let i = s.firstTriangle * 3; i < (s.firstTriangle + s.triangleCount) * 3; i += 3) {
        const t = hitTriangle(origin, direction, P, T[i] * 3, T[i + 1] * 3, T[i + 2] * 3);
        if (t !== null && (!best || t < best.t)) best = { structure: s, t };
      }
    }
  }
  if (!best) return null;
  return { ...best, pointMm: [0, 1, 2].map((a) => origin[a] + direction[a] * best.t) };
}

/** Möller–Trumbore over a flat position array, without allocating. */
function hitTriangle(o, d, P, a, b, c) {
  const e1x = P[b] - P[a]; const e1y = P[b + 1] - P[a + 1]; const e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a]; const e2y = P[c + 1] - P[a + 1]; const e2z = P[c + 2] - P[a + 2];
  const px = d[1] * e2z - d[2] * e2y; const py = d[2] * e2x - d[0] * e2z; const pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const tx = o[0] - P[a]; const ty = o[1] - P[a + 1]; const tz = o[2] - P[a + 2];
  const u = (tx * px + ty * py + tz * pz) / det;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y; const qy = tz * e1x - tx * e1z; const qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) / det;
  return t > 1e-6 ? t : null;
}

/**
 * What a set's `structures.json` holds back under `excluded[]`, as
 * `{ set, title, group, reasons }`, so a search for a withheld name can say
 * why in the file's own words instead of finding nothing. The brain sets give
 * `group` and `heldBecause[]`, the body one `reason` per file; files sharing a
 * name are one entry, and a file that names no concept is left out.
 */
export function withheldOf(entry, doc) {
  const byTitle = new Map();
  for (const x of doc?.excluded ?? []) {
    if (typeof x.name !== 'string') continue;
    const sided = x.side === 'left' || x.side === 'right';
    const title = sided ? `${x.name.replace(/\.[lr]$/, '')} (${x.side})` : x.name;
    const w = byTitle.get(title) ?? byTitle.set(title, { set: entry.id, title, group: x.group ?? null, reasons: [] }).get(title);
    for (const r of x.heldBecause ?? [x.reason]) if (typeof r === 'string' && !w.reasons.includes(r)) w.reasons.push(r);
  }
  return [...byTitle.values()];
}

/**
 * Structures whose title contains every word of `query`, best first: a title
 * that starts with the query, then shorter titles. Case-insensitive.
 */
export function searchStructures(structures, query, limit = 12) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const q = words.join(' ');
  return structures
    .filter((s) => words.every((w) => s.title.toLowerCase().includes(w)))
    .sort((a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)) || a.title.length - b.title.length || (a.title < b.title ? -1 : 1))
    .slice(0, limit);
}
