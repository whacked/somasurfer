/**
 * A cell, drawn at its true extent.
 *
 * This module is the honesty argument made geometric, so it is worth being
 * explicit about what it refuses to do. A cell is **not** drawn as a marker at
 * `pointMm`, and its size is **not** read off `extentMm` and rendered as an
 * axis-aligned box of that size. Both of those would be lies of a different
 * kind:
 *
 *   - A marker says "the address means this point". It does not. `BD-T07-03O`
 *     means a region about 40 mm across, and an address with three more digits
 *     means a region 8 times smaller in each direction. If both draw as the
 *     same dot, the screen has erased the entire precision argument, and an
 *     over-precise address looks exactly as authoritative as an honest one.
 *   - An axis-aligned box of size `extentMm` is the right *size* in the wrong
 *     *shape*. A `BD` cell is curvilinear: it is bounded by two bisector
 *     planes, two radial surfaces and two azimuthal sweeps, and it bends with
 *     the spine. A straight box drawn at a kyphotic level pokes out through the
 *     skin on one side and leaves a gap on the other.
 *
 * So the cell is built by pushing its dimensionless bounding box through the
 * frame's own forward map — `bodyLocalToMm`, `bvLocalToMm` — on a subdivided
 * grid. What is drawn is then the actual set of millimetres the address denotes,
 * curvature and all. A coarse address draws a visibly huge region; that is the
 * feature.
 *
 * `BV` cells are genuinely straight boxes in template millimetres, so they need
 * no subdivision and get none.
 */

import { bodyCellBox, bodyLocalToMm, bvCellBox, bvLocalToMm, parse } from '../alc.js';

/**
 * The six faces of the unit cube, each as `[origin, alongU, alongV]` in cube
 * coordinates, wound so the normal points out of the cube.
 */
const FACES = [
  [[0, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[1, 0, 0], [1, 1, 0], [1, 0, 1]],
  [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 1, 0], [0, 1, 1], [1, 1, 0]],
  [[0, 0, 0], [0, 1, 0], [1, 0, 0]],
  [[0, 0, 1], [1, 0, 1], [0, 1, 1]],
];

/** The 12 edges of the unit cube, as corner-coordinate pairs. */
const EDGES = [
  [[0, 0, 0], [1, 0, 0]], [[0, 1, 0], [1, 1, 0]], [[0, 0, 1], [1, 0, 1]], [[0, 1, 1], [1, 1, 1]],
  [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]], [[0, 0, 1], [0, 1, 1]], [[1, 0, 1], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1]], [[1, 0, 0], [1, 0, 1]], [[0, 1, 0], [0, 1, 1]], [[1, 1, 0], [1, 1, 1]],
];

/**
 * `03O` -> `{ clock: 3, depth: 'O' }`.
 *
 * Reads the parsed anchor segment rather than the raw input, so it only ever
 * sees the canonical two-digit-plus-letter form that `parse()` produced.
 */
function azimuthOf(segment) {
  const clock = Number(segment.slice(0, 2));
  const depth = segment.slice(2);
  return { clock, depth };
}

/**
 * The dimensionless box an address denotes, plus which frame it is in.
 *
 * Both branches go through the library's own decoders, so the box here is the
 * same box `locate()` measured `extentMm` from. Deriving it independently is
 * how a drawn cell and a reported extent come to disagree.
 */
export function cellBoxOf(address) {
  const a = parse(address);
  if (a.frame === 'BD') {
    const anchors = a.anchors.length > 1
      ? { level: a.anchors[0], ...azimuthOf(a.anchors[1]) }
      : { level: a.anchors[0] };
    return { frame: 'BD', level: anchors.level, box: bodyCellBox(anchors, a.digits) };
  }
  if (a.frame === 'BV') {
    return { frame: 'BV', hemisphere: a.anchors[0], box: bvCellBox(a.anchors[0], a.digits) };
  }
  return { frame: a.frame, box: null };
}

const lerp = (range, f) => range[0] + (range[1] - range[0]) * f;

/**
 * Build a hexahedral mesh from a parametric corner function over the unit cube.
 *
 * `at(i, j, k)` takes three fractions in [0,1] and returns millimetres. Only
 * the six faces are tessellated — the interior is never seen — and each face is
 * subdivided `n * n`, so a curved face bends instead of cutting a chord.
 */
function hexahedron(at, n) {
  const positions = [];
  const triangles = [];
  const edges = [];

  for (const [o, du, dv] of FACES) {
    const base = positions.length / 3;
    for (let j = 0; j <= n; j += 1) {
      for (let i = 0; i <= n; i += 1) {
        const fu = i / n;
        const fv = j / n;
        const coord = [0, 0, 0];
        for (let axis = 0; axis < 3; axis += 1) {
          coord[axis] = o[axis] + (du[axis] - o[axis]) * fu + (dv[axis] - o[axis]) * fv;
        }
        const p = at(coord[0], coord[1], coord[2]);
        positions.push(p[0], p[1], p[2]);
      }
    }
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const a = base + j * (n + 1) + i;
        const b = a + 1;
        const c = a + (n + 1);
        const d = c + 1;
        triangles.push(a, c, b, b, c, d);
      }
    }
  }

  // Edges are drawn as their own subdivided polylines. The outline is what
  // actually communicates the cell's size, so it follows the curvature too.
  for (const [p0, p1] of EDGES) {
    const line = [];
    for (let s = 0; s <= n; s += 1) {
      const f = s / n;
      const p = at(
        p0[0] + (p1[0] - p0[0]) * f,
        p0[1] + (p1[1] - p0[1]) * f,
        p0[2] + (p1[2] - p0[2]) * f,
      );
      line.push(p);
    }
    edges.push(line);
  }

  return {
    positions: Float32Array.from(positions),
    triangles: Uint32Array.from(triangles),
    edges,
  };
}

/**
 * The subdivision a cell needs, from how much of a turn it spans.
 *
 * A whole-level cell with no azimuth segment sweeps the full 360 degrees and
 * needs real subdivision to look like a body and not a prism; a cell five
 * digits deep spans a fraction of a degree and is straight to well inside a
 * pixel. Scaling with the sweep keeps the honest shape at every depth without
 * paying for triangles nobody can see.
 */
function subdivisionFor(turnSpan) {
  const degrees = turnSpan * 360;
  if (degrees >= 180) return 16;
  if (degrees >= 45) return 8;
  if (degrees >= 10) return 4;
  return 2;
}

/**
 * The geometry of a `BD` cell, in template millimetres.
 *
 * Returns `null` when the template does not realise the level: a `variant` or
 * `absent` homology has no millimetres at all, and inventing a shape for it is
 * exactly the guess the flag exists to prevent. The caller shows the flag's
 * message instead of a cell.
 */
export function bodyCellMesh(template, box, options = {}) {
  if (!template.slabs.some((s) => s.label === box.level)) return null;
  const n = options.subdivision ?? subdivisionFor(box.t[1] - box.t[0]);
  return hexahedron(
    (i, j, k) => bodyLocalToMm(template, {
      level: box.level,
      u: lerp(box.u, i),
      t: lerp(box.t, j),
      r: lerp(box.r, k),
    }),
    n,
  );
}

/** The geometry of a `BV` cell: a true box in template millimetres, so `n = 1`. */
export function brainCellMesh(template, hemisphere, box) {
  return hexahedron(
    (i, j, k) => bvLocalToMm(template, hemisphere, {
      a: lerp(box.a, i),
      b: lerp(box.b, j),
      c: lerp(box.c, k),
    }),
    1,
  );
}
