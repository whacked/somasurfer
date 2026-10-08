/**
 * Frame `BD` — body, spine-relative.
 *
 *   BD-T07-02O-5316
 *   │  │   │   └── octree refinement digits (octal), optional
 *   │  │   └────── azimuth clock sector 01..12 + depth half I/O
 *   │  └────────── vertebral level anchor (C01..C07, T01..T12, L01..L05, S01..S05)
 *   └───────────── frame id
 *
 * Spoken as: "body, T7, two o'clock, outer, five-three-one-six".
 *
 * The three local coordinates are all DIMENSIONLESS, which is what makes an
 * address portable between a 7-year-old, a 90-year-old, and templates built
 * from different populations:
 *
 *   u  axial fraction within the vertebral slab, 0 = cranial face, 1 = caudal
 *   t  azimuth in turns around the spine axis, 0 = anterior midline,
 *      increasing toward the subject's LEFT (so 0.25 = left, 0.5 = posterior)
 *   r  depth from the spine axis divided by the body surface radius in that
 *      same direction at that same level, 0 = axis, 1 = skin
 *
 * Clock sector 12 is CENTRED on the anterior midline rather than bounded by
 * it, so midline structures (sternum at 12, spinous process at 06) sit in the
 * middle of a cell instead of straddling a boundary.
 */

import { AlcError, OCTAL, digitsToValues } from '../codec.ts';
import type { FrameDescriptor, Located, LocateFlags, Vec3 } from '../types.ts';

export const BD: FrameDescriptor = {
  id: 'BD',
  anchorSegments: 2,
  digitAlphabet: OCTAL,
  maxDigits: 12,
  summary: 'Body, anchored to the vertebral column: level, clock azimuth, normalised depth.',
};

export const VERTEBRAL_LEVELS: readonly string[] = [
  ...Array.from({ length: 7 }, (_, i) => `C0${i + 1}`),
  ...Array.from({ length: 12 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 5 }, (_, i) => `L0${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `S0${i + 1}`),
];

const LEVEL_RE = /^([CTLS])(\d{1,2})$/;

/** Accepts `T7`, `t07`, `T07`; returns the canonical `T07`. */
export function canonicalLevel(input: string): string {
  const m = LEVEL_RE.exec(input.toUpperCase());
  if (!m) throw new AlcError(`not a vertebral level: ${JSON.stringify(input)}`, 'bad_level');
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n < 1 || n > 12) {
    throw new AlcError(`vertebral level out of range: ${input}`, 'bad_level');
  }
  return `${m[1]}${String(n).padStart(2, '0')}`;
}

export interface BodyAnchor {
  level: string;
  /** 1..12; 12 is anterior midline. */
  clock: number;
  depth: 'I' | 'O';
}

// One or two digits on input (`2O` and `02O` both mean two o'clock); the
// canonical form is always two digits.
const CLOCK_RE = /^(\d{1,2})([IO])$/;

export function parseBodyAnchors(segments: string[]): { level: string; clock?: number; depth?: 'I' | 'O' } {
  const level = canonicalLevel(segments[0]);
  if (segments.length < 2) return { level };
  const m = CLOCK_RE.exec(segments[1]);
  const clock = m ? Number(m[1]) : NaN;
  if (!m || !Number.isInteger(clock) || clock < 1 || clock > 12) {
    throw new AlcError(
      `azimuth segment must be a clock sector 1-12 followed by I or O, got ${JSON.stringify(segments[1])}`,
      'bad_azimuth',
    );
  }
  return { level, clock, depth: m[2] as 'I' | 'O' };
}

/** Clock sector -> azimuth interval in turns, half-open, centred on the sector. */
export function clockToTurnInterval(clock: number): [number, number] {
  const centre = (clock % 12) / 12;
  return [centre - 1 / 24, centre + 1 / 24];
}

/** Azimuth in turns -> clock sector 1..12. */
export function turnToClock(t: number): number {
  let x = t % 1;
  if (x < 0) x += 1;
  const sector = Math.floor(x * 12 + 0.5) % 12;
  return sector === 0 ? 12 : sector;
}

export interface LocalBodyCoords {
  level: string;
  /** axial fraction in [0,1) within the level slab */
  u: number;
  /** azimuth in turns, [0,1) */
  t: number;
  /** normalised depth, 0 at spine axis, 1 at skin */
  r: number;
}

/** The dimensionless box an address denotes, before any template is applied. */
export interface BodyCellBox {
  level: string;
  u: [number, number];
  t: [number, number];
  r: [number, number];
}

/** Decode anchors + digits into the dimensionless cell box. */
export function bodyCellBox(
  anchors: { level: string; clock?: number; depth?: 'I' | 'O' },
  digits: string,
): BodyCellBox {
  let u: [number, number] = [0, 1];
  let t: [number, number] = [0, 1];
  let r: [number, number] = [0, 1];

  if (anchors.clock !== undefined) {
    t = clockToTurnInterval(anchors.clock);
    r = anchors.depth === 'I' ? [0, 0.5] : [0.5, 1];
  } else if (digits.length > 0) {
    throw new AlcError('body refinement digits require the azimuth segment', 'missing_azimuth');
  }

  // Octree: each digit splits all three dimensions once.
  // digit = u_bit * 4 + t_bit * 2 + r_bit.
  for (const v of digitsToValues(digits, OCTAL, 'body octree')) {
    const uMid = (u[0] + u[1]) / 2;
    const tMid = (t[0] + t[1]) / 2;
    const rMid = (r[0] + r[1]) / 2;
    u = v & 4 ? [uMid, u[1]] : [u[0], uMid];
    t = v & 2 ? [tMid, t[1]] : [t[0], tMid];
    r = v & 1 ? [rMid, r[1]] : [r[0], rMid];
  }
  return { level: anchors.level, u, t, r };
}

/** Encode dimensionless local coordinates into anchor segments + digits. */
export function bodyEncodeLocal(local: LocalBodyCoords, digitCount: number): {
  anchors: [string, string];
  digits: string;
} {
  if (digitCount < 0 || digitCount > BD.maxDigits) {
    throw new AlcError(`digit count out of range: ${digitCount}`, 'bad_precision');
  }
  const clock = turnToClock(local.t);
  const depth: 'I' | 'O' = local.r < 0.5 ? 'I' : 'O';

  let u: [number, number] = [0, 1];
  let t: [number, number] = clockToTurnInterval(clock);
  let r: [number, number] = depth === 'I' ? [0, 0.5] : [0.5, 1];

  // Unwrap the azimuth into the sector's own (possibly negative) interval.
  let tt = local.t % 1;
  if (tt < 0) tt += 1;
  if (tt > t[1]) tt -= 1;
  if (tt < t[0]) tt += 1;

  const out: number[] = [];
  for (let i = 0; i < digitCount; i += 1) {
    const uMid = (u[0] + u[1]) / 2;
    const tMid = (t[0] + t[1]) / 2;
    const rMid = (r[0] + r[1]) / 2;
    const ub = local.u >= uMid ? 1 : 0;
    const tb = tt >= tMid ? 1 : 0;
    const rb = local.r >= rMid ? 1 : 0;
    out.push(ub * 4 + tb * 2 + rb);
    u = ub ? [uMid, u[1]] : [u[0], uMid];
    t = tb ? [tMid, t[1]] : [t[0], tMid];
    r = rb ? [rMid, r[1]] : [r[0], rMid];
  }
  return {
    anchors: [local.level, `${String(clock).padStart(2, '0')}${depth}`],
    digits: out.map((v) => OCTAL[v]).join(''),
  };
}

// ---------------------------------------------------------------------------
// Template geometry
// ---------------------------------------------------------------------------

export interface VertebralSlab {
  label: string;
  /** Centroid of the vertebral body in template mm. */
  origin: Vec3;
  /** Unit vector, cranial -> caudal along the local spine tangent. */
  axial: Vec3;
  /** Unit vector, local anterior. Orthogonal to `axial`. */
  anterior: Vec3;
  /** Unit vector toward the subject's left. Orthogonal to the other two. */
  left: Vec3;
  /** Axial extent of this slab in mm. */
  heightMm: number;
  /**
   * Body surface radius from the spine axis, in mm, as a function of azimuth
   * in turns. Sampled at `surfaceRadiiMm.length` equally spaced azimuths
   * starting at the anterior midline, linearly interpolated between samples.
   */
  surfaceRadiiMm: readonly number[];
}

export interface BodyTemplate {
  id: string;
  /** Cranial -> caudal. Labels need not be the canonical 24+5 set. */
  slabs: readonly VertebralSlab[];
  /**
   * Finest refinement this template's geometry can justify, in digits.
   * Derived from mesh resolution by the asset pipeline, not guessed here.
   */
  maxUsefulDigits: number;
}

function radiusAt(slab: VertebralSlab, t: number): number {
  const n = slab.surfaceRadiiMm.length;
  let x = (t % 1) * n;
  if (x < 0) x += n;
  const i = Math.floor(x);
  const f = x - i;
  const a = slab.surfaceRadiiMm[i % n];
  const b = slab.surfaceRadiiMm[(i + 1) % n];
  return a + (b - a) * f;
}

function add(a: Vec3, b: Vec3, s: number): Vec3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * Derived geometry: one shared polyline through the whole column, plus a
 * bisector plane at every node.
 *
 * Two earlier designs were wrong, and both failures are instructive.
 *
 * 1. Project onto each slab's own axis and keep the slab whose fraction lands
 *    in [0,1). Not a partition: each slab carries its own axis direction, so a
 *    point on a vertebral boundary satisfies both neighbours' tests. `BD-C03`
 *    at the top of its level encoded as `BD-C02` at the bottom of its own.
 *
 * 2. Same, but break ties by smallest perpendicular distance. Still not a
 *    partition. At any bend, the two adjacent slabs' perpendicular regions
 *    overlap in a wedge on the convex side and leave a gap on the concave
 *    side. A point 42 mm out from the axis at a 3 degree bend projects back
 *    across the boundary by about 2 mm, which is more than a whole refinement
 *    cell. No tie-break rule fixes this, because the regions genuinely are not
 *    a partition of space.
 *
 * What works: cut space with the angle bisector plane at each node. Level i is
 * the region between bisector i and bisector i+1. Adjacent levels test the
 * same plane with opposite signs, so the levels tile space exactly, and the
 * slabs fan out on the convex side of a curve — which is also how a clinician
 * reads "the T7 level" on a curved spine.
 *
 * The axial fraction is then the relative distance between the two bounding
 * planes, and `bodyLocalToMm` solves the matching linear equation so the
 * forward and inverse maps are exact inverses rather than approximate ones.
 */
interface SpineGeometry {
  /** slabs.length + 1 nodes, cranial to caudal. */
  nodes: Vec3[];
  /** Unit direction of each segment, cranial -> caudal. */
  dirs: Vec3[];
  /** Length of each segment, mm. */
  lens: number[];
  /** slabs.length + 1 bisector plane normals, pointing caudal. */
  normals: Vec3[];
  /** Per-slab azimuth frame, re-orthogonalised against that segment's direction. */
  anterior: Vec3[];
  left: Vec3[];
}

const GEOMETRY_CACHE = new WeakMap<BodyTemplate, SpineGeometry>();

export function spineGeometry(template: BodyTemplate): SpineGeometry {
  const cached = GEOMETRY_CACHE.get(template);
  if (cached) return cached;
  const { slabs } = template;
  if (slabs.length === 0) throw new AlcError(`template ${template.id} has no slabs`, 'empty_template');

  const cranialFace = slabs.map((s) => add(s.origin, s.axial, -s.heightMm / 2));
  const caudalFace = slabs.map((s) => add(s.origin, s.axial, s.heightMm / 2));

  const nodes: Vec3[] = [cranialFace[0]];
  for (let i = 1; i < slabs.length; i += 1) {
    nodes.push([
      (caudalFace[i - 1][0] + cranialFace[i][0]) / 2,
      (caudalFace[i - 1][1] + cranialFace[i][1]) / 2,
      (caudalFace[i - 1][2] + cranialFace[i][2]) / 2,
    ]);
  }
  nodes.push(caudalFace[slabs.length - 1]);

  const dirs: Vec3[] = [];
  const lens: number[] = [];
  const anterior: Vec3[] = [];
  const left: Vec3[] = [];
  for (let i = 0; i < slabs.length; i += 1) {
    const d = sub(nodes[i + 1], nodes[i]);
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len <= 0) {
      throw new AlcError(`template ${template.id} has a zero-length level at ${slabs[i].label}`, 'bad_template');
    }
    const dir = unit(d);
    // Re-orthogonalise the stored anterior against the actual segment axis so
    // the forward and inverse maps use exactly the same triad.
    const k = dot(slabs[i].anterior, dir);
    const ant = unit(sub(slabs[i].anterior, [dir[0] * k, dir[1] * k, dir[2] * k]));
    dirs.push(dir);
    lens.push(len);
    anterior.push(ant);
    left.push(unit(cross(dir, ant)));
  }

  // Bisector normals. The ends use their single adjacent direction, so the
  // first and last planes are simply perpendicular to the column.
  const normals: Vec3[] = [dirs[0]];
  for (let i = 1; i < dirs.length; i += 1) {
    normals.push(unit([dirs[i - 1][0] + dirs[i][0], dirs[i - 1][1] + dirs[i][1], dirs[i - 1][2] + dirs[i][2]]));
  }
  normals.push(dirs[dirs.length - 1]);

  const geometry: SpineGeometry = { nodes, dirs, lens, normals, anterior, left };
  GEOMETRY_CACHE.set(template, geometry);
  return geometry;
}

export interface SlabLookup {
  slab: VertebralSlab;
  index: number;
}

export function findSlab(template: BodyTemplate, level: string): SlabLookup | null {
  const index = template.slabs.findIndex((s) => s.label === level);
  return index < 0 ? null : { slab: template.slabs[index], index };
}

/** Unit radial direction for an azimuth, in the plane perpendicular to the axis. */
function radialDirection(g: SpineGeometry, i: number, t: number): Vec3 {
  const angle = t * 2 * Math.PI;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    g.anterior[i][0] * c + g.left[i][0] * s,
    g.anterior[i][1] * c + g.left[i][1] * s,
    g.anterior[i][2] * c + g.left[i][2] * s,
  ];
}

/**
 * Dimensionless local coordinates -> template millimetres.
 *
 * `u` is the fraction of the way between the two bisector planes, which for an
 * off-axis point is not the same as the fraction along the segment. Solving for
 * the axial offset `a` that reproduces the requested `u`:
 *
 *   sigma_i     = a * c_i + rho * e_i
 *   sigma_(i+1) = (a - len) * c_(i+1) + rho * e_(i+1)
 *   u           = sigma_i / (sigma_i - sigma_(i+1))
 *
 * gives one linear equation in `a`. That is what makes this the exact inverse
 * of `bodyMmToLocal` rather than an approximation that drifts at bends.
 */
export function bodyLocalToMm(template: BodyTemplate, local: LocalBodyCoords): Vec3 {
  const found = findSlab(template, local.level);
  if (!found) throw new AlcError(`level ${local.level} absent from template ${template.id}`, 'absent_level');
  const g = spineGeometry(template);
  const i = found.index;
  const dirT = radialDirection(g, i, local.t);
  const rho = radiusAt(found.slab, local.t) * local.r;

  const ci = dot(g.dirs[i], g.normals[i]);
  const ci1 = dot(g.dirs[i], g.normals[i + 1]);
  const ei = dot(dirT, g.normals[i]);
  const ei1 = dot(dirT, g.normals[i + 1]);
  const u = local.u;
  const denom = (1 - u) * ci + u * ci1;
  if (Math.abs(denom) < 1e-9) {
    throw new AlcError(
      `template ${template.id} bends too sharply at ${local.level} for the spine frame to invert`,
      'degenerate_template',
    );
  }
  const a = (u * g.lens[i] * ci1 - rho * ((1 - u) * ei + u * ei1)) / denom;
  return add(add(g.nodes[i], g.dirs[i], a), dirT, rho);
}

/**
 * Template millimetres -> dimensionless local coordinates.
 *
 * Segment choice: prefer segments that bracket the point (axial fraction in
 * [0,1)); among those take the smallest perpendicular distance, breaking ties
 * toward the more cranial level. If no segment brackets the point — it is
 * beyond either end of the column — fall back to the nearest segment and flag
 * the result as clamped.
 */
export function bodyMmToLocal(
  template: BodyTemplate,
  p: Vec3,
): { local: LocalBodyCoords; flags: LocateFlags } {
  const g = spineGeometry(template);
  const n = g.dirs.length;
  const flags: LocateFlags = {};
  const notes: string[] = [];

  // sigma[k] is the signed distance to bisector plane k, positive caudal.
  // Level i owns { sigma[i] >= 0 and sigma[i+1] < 0 }, which tiles space.
  const sigma = (k: number): number => dot(sub(p, g.nodes[k]), g.normals[k]);

  let index = -1;
  for (let i = 0; i < n; i += 1) {
    if (sigma(i) >= 0 && sigma(i + 1) < 0) {
      index = i;
      break;
    }
  }

  let u: number;
  if (index >= 0) {
    const s0 = sigma(index);
    const s1 = sigma(index + 1);
    u = s0 / (s0 - s1);
  } else if (sigma(0) < 0) {
    index = 0;
    u = 0;
    flags.clamped = true;
    notes.push('point lies above the cranial end of the vertebral column');
  } else if (sigma(n) >= 0) {
    index = n - 1;
    u = 1 - 1e-12;
    flags.clamped = true;
    notes.push('point lies below the caudal end of the vertebral column');
  } else {
    // Bisector planes crossed inside the body: the template is inadmissible
    // here. Fall back to the nearest level and say so rather than guess.
    let nearest = { i: 0, d: Infinity };
    for (let i = 0; i < n; i += 1) {
      const rel = sub(p, g.nodes[i]);
      const along = Math.min(g.lens[i], Math.max(0, dot(rel, g.dirs[i])));
      const axis = add(g.nodes[i], g.dirs[i], along);
      const d = Math.hypot(p[0] - axis[0], p[1] - axis[1], p[2] - axis[2]);
      if (d < nearest.d) nearest = { i, d };
    }
    index = nearest.i;
    const s0 = sigma(index);
    const s1 = sigma(index + 1);
    u = Math.min(1 - 1e-12, Math.max(0, s0 - s1 !== 0 ? s0 / (s0 - s1) : 0));
    flags.clamped = true;
    notes.push(
      `template ${template.id} is inadmissible near ${template.slabs[index].label}: its bisector planes cross inside the body, so the level assignment here is deterministic but not reliable`,
    );
  }

  const slab = template.slabs[index];
  const rel = sub(p, g.nodes[index]);
  const along = dot(rel, g.dirs[index]);
  const perp: Vec3 = [
    rel[0] - g.dirs[index][0] * along,
    rel[1] - g.dirs[index][1] * along,
    rel[2] - g.dirs[index][2] * along,
  ];
  const ca = dot(perp, g.anterior[index]);
  const sa = dot(perp, g.left[index]);
  let t = Math.atan2(sa, ca) / (2 * Math.PI);
  if (t < 0) t += 1;
  if (t >= 1) t = 0;
  const surface = radiusAt(slab, t);
  let r = surface > 0 ? Math.hypot(ca, sa) / surface : 0;
  if (r > 1) {
    r = 1 - 1e-12;
    flags.clamped = true;
    notes.push('point is outside the modelled body surface');
  }
  if (notes.length) flags.notes = notes;
  return { local: { level: slab.label, u, t, r }, flags };
}

/**
 * Template admissibility.
 *
 * The spine-relative frame is a tubular neighbourhood of a curve. Such a
 * neighbourhood is only non-self-intersecting while its radius stays below the
 * curve's radius of curvature. Where the body radius exceeds the local
 * curvature radius — plausible at the lumbar lordosis, where the trunk is at
 * its widest and the curve at its tightest — distinct dimensionless
 * coordinates can map to the same millimetre point, and `encode(locate(a))`
 * is no longer guaranteed to return `a`.
 *
 * Addresses stay well defined in that situation (the forward map is still a
 * function), but the inverse becomes ambiguous and the library resolves it
 * deterministically rather than correctly. Templates must therefore be
 * checked, and the violating levels published, not discovered in production.
 */
export interface TemplateAudit {
  templateId: string;
  admissible: boolean;
  violations: Array<{ level: string; maxRadiusMm: number; curvatureRadiusMm: number }>;
}

export function auditBodyTemplate(template: BodyTemplate): TemplateAudit {
  const g = spineGeometry(template);
  const violations: TemplateAudit['violations'] = [];
  for (let i = 0; i < template.slabs.length; i += 1) {
    const maxRadiusMm = Math.max(...template.slabs[i].surfaceRadiiMm);
    // Discrete curvature from the turn angle between adjacent segments:
    // R = (chord length) / (2 sin(turn / 2)).
    let curvatureRadiusMm = Infinity;
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= g.dirs.length) continue;
      const c = Math.max(-1, Math.min(1, dot(g.dirs[i], g.dirs[j])));
      const turn = Math.acos(c);
      if (turn > 1e-9) {
        const chord = (g.lens[i] + g.lens[j]) / 2;
        curvatureRadiusMm = Math.min(curvatureRadiusMm, chord / (2 * Math.sin(turn / 2)));
      }
    }
    if (maxRadiusMm >= curvatureRadiusMm) {
      violations.push({ level: template.slabs[i].label, maxRadiusMm, curvatureRadiusMm });
    }
  }
  return { templateId: template.id, admissible: violations.length === 0, violations };
}

/** Cell centre and extent in template millimetres. */
export function bodyLocate(template: BodyTemplate, box: BodyCellBox, digitCount: number): Located {
  const mid: LocalBodyCoords = {
    level: box.level,
    u: (box.u[0] + box.u[1]) / 2,
    t: (box.t[0] + box.t[1]) / 2,
    r: (box.r[0] + box.r[1]) / 2,
  };
  const found = findSlab(template, box.level);
  const flags: LocateFlags = {};
  if (!found) {
    flags.homology = 'absent';
    flags.notes = [
      `level ${box.level} is not present in template ${template.id}; a registration-supplied level mapping is required`,
    ];
    return { pointMm: [NaN, NaN, NaN], extentMm: [NaN, NaN, NaN], flags };
  }
  flags.homology = 'exact';
  if (digitCount > template.maxUsefulDigits) {
    flags.overPrecise = true;
    flags.notes = [
      `address carries ${digitCount} refinement digits but template ${template.id} only justifies ${template.maxUsefulDigits}`,
    ];
  }
  const { slab } = found;
  const surface = radiusAt(slab, mid.t);
  // Axial extent comes from the shared polyline segment, not the stored slab
  // height, so it matches the coordinate the address is actually measured in.
  const segmentLengthMm = spineGeometry(template).lens[found.index];
  const extentMm: Vec3 = [
    (box.u[1] - box.u[0]) * segmentLengthMm,
    (box.t[1] - box.t[0]) * 2 * Math.PI * surface * mid.r, // arc length at the cell's own depth
    (box.r[1] - box.r[0]) * surface,
  ];
  return { pointMm: bodyLocalToMm(template, mid), extentMm, flags };
}
