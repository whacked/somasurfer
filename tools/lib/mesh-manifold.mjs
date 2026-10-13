/**
 * Make a simplified surface's edges 2-manifold again.
 *
 * Edge-collapse simplification of a closed surface can flatten a thin sheet
 * (two banks of a gyrus a millimetre apart) into two coincident triangles of
 * opposite winding, and can pinch two parts of the surface together along an
 * edge. Both leave edges shared by more than two triangles. The repair:
 *
 *   1. DROP COINCIDENT PAIRS. Two triangles on the same three vertices enclose
 *      nothing; both go.
 *   2. SPLIT NON-MANIFOLD VERTICES. Around each vertex, its triangles are
 *      grouped into fans connected through edges that exactly two triangles
 *      share. A vertex with more than one fan is duplicated, one copy per fan.
 *      An edge that more than two triangles shared is thereby unzipped into
 *      separate edges, one per sheet.
 *   3. CLOSE HOLES. Dropping a pair whose edge only one other triangle used
 *      leaves a small hole. Each boundary loop is closed by a fan, wound
 *      against the triangles beside it, from whichever loop vertex makes the
 *      fan's smallest triangle largest (a fan from a badly chosen apex can be
 *      flat). Holes are closed before vertices are split in each pass, so a
 *      loop never runs through a vertex and its own copy, which share a
 *      position. The passes repeat until nothing changes (at most
 *      REPAIR_PASSES times).
 *
 *   4. SEPARATE COPIES. A split copy starts at its original's position, so a
 *      hole closed across the two can hold a zero-area triangle. Each copy is
 *      moved COPY_NUDGE_MM toward the middle of its own fan. That is the only
 *      vertex this repair moves, by about seven steps of the int16 grid and far
 *      less than the simplification error it sits inside.
 *
 * The result is checked by the caller (manifoldReport, degenerateTriangles);
 * this function does not claim success. `source[v]` is the input vertex each
 * output vertex copies, and `positions` the output positions.
 */

const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);

export const REPAIR_PASSES = 4;
export const COPY_NUDGE_MM = 0.02;

export function makeManifold(indices, positions, { split = true } = {}) {
  const vertexCount = positions.length / 3;
  // 1. Coincident pairs.
  const byVertexSet = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const key = [indices[t], indices[t + 1], indices[t + 2]].sort((x, y) => x - y).join(',');
    if (!byVertexSet.has(key)) byVertexSet.set(key, []);
    byVertexSet.get(key).push(t / 3);
  }
  const drop = new Uint8Array(indices.length / 3);
  let droppedPairs = 0;
  for (const tris of byVertexSet.values()) {
    // Drop in pairs; an odd one out stays.
    for (let k = 0; k + 1 < tris.length; k += 2) {
      drop[tris[k]] = 1;
      drop[tris[k + 1]] = 1;
      droppedPairs += 1;
    }
  }
  const kept = [];
  for (let t = 0; t < indices.length; t += 3) if (!drop[t / 3]) kept.push(indices[t], indices[t + 1], indices[t + 2]);
  let source = Array.from({ length: vertexCount }, (_, v) => v);
  let tris = kept;
  let splitVertices = 0;
  let holesClosed = 0;
  for (let pass = 0; pass < REPAIR_PASSES; pass += 1) {
    const r = split ? splitAndClose(tris, source.length, source, positions) : closeOnly(tris, source, positions);
    tris = r.indices;
    source = r.source;
    splitVertices += r.splitVertices;
    holesClosed += r.holesClosed;
    if (r.splitVertices === 0 && r.holesClosed === 0) break;
  }
  const out = new Float32Array(source.length * 3);
  for (let v = 0; v < source.length; v += 1) out.set(positions.subarray(source[v] * 3, source[v] * 3 + 3), v * 3);
  // 4. Copies, nudged into their own fans.
  const sum = new Float64Array(source.length * 3);
  const count = new Uint32Array(source.length);
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const v = tris[t + k];
      if (v < vertexCount) continue;
      for (const j of [1, 2]) {
        const w = tris[t + ((k + j) % 3)];
        for (let a = 0; a < 3; a += 1) sum[v * 3 + a] += out[w * 3 + a];
        count[v] += 1;
      }
    }
  }
  for (let v = vertexCount; v < source.length; v += 1) {
    if (count[v] === 0) continue;
    const d = [0, 1, 2].map((a) => sum[v * 3 + a] / count[v] - out[v * 3 + a]);
    const len = Math.hypot(...d) || 1;
    for (let a = 0; a < 3; a += 1) out[v * 3 + a] += (d[a] / len) * COPY_NUDGE_MM;
  }
  return { indices: Uint32Array.from(tris), source: Uint32Array.from(source), positions: out, droppedPairs, splitVertices, holesClosed };
}

function splitAndClose(keptIn, vertexCount, sourceIn, positions) {
  const kept = closeHoles(keptIn, sourceIn, positions);
  const { holesClosed } = kept;
  // 2. Fans around each vertex.
  const edgeUse = new Map();
  for (let t = 0; t < kept.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const key = edgeKey(kept[t + k], kept[t + ((k + 1) % 3)]);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const trisOf = Array.from({ length: vertexCount }, () => []);
  for (let t = 0; t < kept.length; t += 3) for (let k = 0; k < 3; k += 1) trisOf[kept[t + k]].push(t / 3);
  const out = Array.from(kept);
  const source = Array.from(sourceIn);
  let splitVertices = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    const tris = trisOf[v];
    if (tris.length === 0) continue;
    // Two triangles around v are in one fan if they share an edge through v
    // that exactly two triangles use.
    const fan = new Map(tris.map((t) => [t, -1]));
    let fans = 0;
    for (const t0 of tris) {
      if (fan.get(t0) !== -1) continue;
      const stack = [t0];
      fan.set(t0, fans);
      while (stack.length > 0) {
        const t = stack.pop();
        const others = [0, 1, 2].map((k) => kept[t * 3 + k]).filter((w) => w !== v);
        for (const w of others) {
          if (edgeUse.get(edgeKey(v, w)) !== 2) continue;
          for (const u of tris) {
            if (fan.get(u) !== -1) continue;
            const hasW = kept[u * 3] === w || kept[u * 3 + 1] === w || kept[u * 3 + 2] === w;
            if (hasW) { fan.set(u, fans); stack.push(u); }
          }
        }
      }
      fans += 1;
    }
    if (fans < 2) continue;
    splitVertices += 1;
    for (let f = 1; f < fans; f += 1) {
      const copy = source.length;
      source.push(v);
      for (const t of tris) {
        if (fan.get(t) !== f) continue;
        for (let k = 0; k < 3; k += 1) if (out[t * 3 + k] === v) out[t * 3 + k] = copy;
      }
    }
  }
  return { indices: out, source, splitVertices, holesClosed };
}

function closeOnly(tris, source, positions) {
  const out = closeHoles(tris, source, positions);
  return { indices: Array.from(out), source, splitVertices: 0, holesClosed: out.holesClosed };
}

function closeHoles(kept, source, positions) {
  const out = Array.from(kept);
  // 3. Holes: directed edges whose reverse is missing, chained into loops.
  const half = new Map();
  for (let t = 0; t < out.length; t += 3) {
    for (let k = 0; k < 3; k += 1) half.set(`${out[t + k]},${out[t + ((k + 1) % 3)]}`, true);
  }
  const nextOf = new Map();
  for (const key of half.keys()) {
    const [a, b] = key.split(',').map(Number);
    if (!half.has(`${b},${a}`)) {
      // The hole runs the other way round: b -> a.
      if (!nextOf.has(b)) nextOf.set(b, []);
      nextOf.get(b).push(a);
    }
  }
  let holesClosed = 0;
  const used = new Set();
  for (const start of [...nextOf.keys()]) {
    for (const first of nextOf.get(start)) {
      if (used.has(`${start},${first}`)) continue;
      const loop = [start];
      let cur = first;
      used.add(`${start},${first}`);
      let ok = false;
      for (let guard = 0; guard < 64; guard += 1) {
        if (cur === start) { ok = true; break; }
        loop.push(cur);
        const options = (nextOf.get(cur) ?? []).filter((w) => !used.has(`${cur},${w}`));
        if (options.length !== 1) break;
        used.add(`${cur},${options[0]}`);
        cur = options[0];
      }
      if (!ok || loop.length < 3) continue;
      const apex = bestApex(loop, source, positions);
      const ring = [...loop.slice(apex), ...loop.slice(0, apex)];
      for (let k = 1; k + 1 < ring.length; k += 1) out.push(ring[0], ring[k], ring[k + 1]);
      holesClosed += 1;
    }
  }
  out.holesClosed = holesClosed;
  return out;
}

function bestApex(loop, source, positions) {
  const at = (v) => [0, 1, 2].map((a) => positions[source[v] * 3 + a]);
  const area = (a, b, c) => {
    const [p, q, r] = [at(a), at(b), at(c)];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    return Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
  };
  let best = 0;
  let bestMin = -1;
  for (let s = 0; s < loop.length; s += 1) {
    const ring = [...loop.slice(s), ...loop.slice(0, s)];
    let min = Infinity;
    for (let k = 1; k + 1 < ring.length; k += 1) min = Math.min(min, area(ring[0], ring[k], ring[k + 1]));
    if (min > bestMin) { bestMin = min; best = s; }
  }
  return best;
}

