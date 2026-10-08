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

// ---------------------------------------------------------------------------
// The level set
// ---------------------------------------------------------------------------

/**
 * The CANONICAL level set: ordinary adult anatomy, 7 + 12 + 5 cervical,
 * thoracic and lumbar levels, plus the sacrum.
 *
 * `S02`-`S05` are in the set because the spec reserves them — a finer sacral
 * frame can be added later without a breaking change — but no template
 * realises them, and `locate()` reports them `homology: 'absent'` rather than
 * guessing. See docs/alc-1-admissibility.md section 2 for why the shipping
 * convention is one fused sacral level.
 */
export const VERTEBRAL_LEVELS: readonly string[] = [
  ...Array.from({ length: 7 }, (_, i) => `C0${i + 1}`),
  ...Array.from({ length: 12 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 5 }, (_, i) => `L0${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `S0${i + 1}`),
];

/**
 * Recognised vertebral COUNT ANOMALIES. Addressable, and reported as
 * `homology: 'variant'` by any template that does not realise them.
 *
 * ---------------------------------------------------------------------------
 * DECISION (DOG-9, finding 3). This set exists, rather than keeping a flat
 * 1..12 bound on every prefix.
 *
 * The flat bound was incidental — a thoracic count applied to all four regions
 * — and it failed in both directions at once. It admitted 19 labels that exist
 * in no human (`C08`-`C12`, `L06`-`L12`, `S06`-`S12` all parsed, got a valid
 * check symbol and were URL-linkable), and it rejected `T13`, the
 * thirteenth-rib variant, which is about as common as the six lumbar vertebrae
 * the same bound happened to admit.
 *
 * The second-order damage was worse than the first. Every bogus label resolved
 * to `homology: 'absent'` with the note "a registration-supplied level mapping
 * is required" — the signal the plan reserves for a genuine count anomaly. So
 * a typo and a patient needing a level mapping produced the same flag and the
 * same sentence, which devalues the one flag the design leans on hardest for
 * anatomical honesty. Three outcomes need three answers, so there are three:
 *
 *   canonical level, realised       -> homology 'exact'
 *   canonical level, not realised   -> homology 'absent'
 *   anomaly, not realised           -> homology 'variant'   <- new
 *   anything else                   -> rejected, 'bad_level'
 *
 * Why these three labels and not the four the review proposed:
 *
 *   T13  a supernumerary thoracic level with a thirteenth rib. Real, and
 *        previously inexpressible, which is the defect that forced this.
 *   L06  six lumbar vertebrae (lumbarisation of S1). Real and common.
 *   S06  an extra sacral segment (sacralisation of L5). Real, and the
 *        counterpart of L06 at the other end of the same transition.
 *
 * `C08` is deliberately NOT here. There is no eighth cervical *vertebra*; what
 * exists is the C8 *nerve root*, which is universal and exits below C07. So
 * `BD-C08` from a real user is overwhelmingly a category error rather than a
 * variant, and admitting it as `variant` would silently accept the confusion
 * instead of correcting it. `canonicalLevel` rejects it with that correction
 * named. The asymmetry is intentional and safe in one direction only: adding a
 * label to this set later is additive, removing one breaks addresses already
 * issued. Reject now, widen if a registry ever produces the real thing.
 *
 * This is grammar, so it had to be settled before the asset pipeline issues a
 * first address — the same argument plan section 1.1 makes for the sacral
 * level count.
 */
export const ANOMALOUS_LEVELS: readonly string[] = ['T13', 'L06', 'S06'];

/** Every level an ALC-1 `BD` address may name. The grammar, as a value. */
export const ADDRESSABLE_LEVELS: readonly string[] = [...VERTEBRAL_LEVELS, ...ANOMALOUS_LEVELS];

const CANONICAL_LEVEL_SET: ReadonlySet<string> = new Set(VERTEBRAL_LEVELS);
const ANOMALOUS_LEVEL_SET: ReadonlySet<string> = new Set(ANOMALOUS_LEVELS);

/** Which part of the grammar a canonical label belongs to, or null if neither. */
export function levelClass(level: string): 'canonical' | 'anomaly' | null {
  if (CANONICAL_LEVEL_SET.has(level)) return 'canonical';
  if (ANOMALOUS_LEVEL_SET.has(level)) return 'anomaly';
  return null;
}

const LEVEL_RE = /^([CTLS])(\d{1,2})$/;

const REGION_NAME: Record<string, string> = { C: 'cervical', T: 'thoracic', L: 'lumbar', S: 'sacral' };

/**
 * Why a syntactically well-formed label is not in the grammar. The message is
 * the whole value of rejecting rather than resolving, so it names the
 * correction rather than restating the range.
 */
function explainRejectedLevel(prefix: string, label: string): string {
  if (label === 'C08') {
    return 'there is no eighth cervical vertebra. The C8 *nerve root* does exist and exits below C07, '
      + 'which is usually what is meant: address it as C07 or T01. (A supernumerary cervical vertebra '
      + 'is too rare to put in the anomaly set; widening the set later is additive if a registry needs it.)';
  }
  const region = REGION_NAME[prefix] ?? 'vertebral';
  const canonical = VERTEBRAL_LEVELS.filter((l) => l.startsWith(prefix));
  const anomalies = ANOMALOUS_LEVELS.filter((l) => l.startsWith(prefix));
  return `the ${region} region is addressable as ${canonical[0]}-${canonical[canonical.length - 1]}`
    + (anomalies.length ? ` plus ${anomalies.join(', ')} as a recognised count anomaly` : '')
    + '. This is rejected rather than resolved as an absent level, because '
    + "homology 'absent' means anatomy a template does not realise, and a label outside the grammar "
    + 'would be indistinguishable from a patient who needs a level mapping.';
}

/**
 * Accepts `T7`, `t07`, `T07`; returns the canonical `T07`.
 *
 * Validates against `ADDRESSABLE_LEVELS` — the declared level set — rather
 * than a numeric range. A label outside it is rejected here, at parse time,
 * and never reaches `locate()`.
 */
export function canonicalLevel(input: string): string {
  const m = LEVEL_RE.exec(input.toUpperCase());
  if (!m) throw new AlcError(`not a vertebral level: ${JSON.stringify(input)}`, 'bad_level');
  const n = Number(m[2]);
  if (!Number.isInteger(n)) throw new AlcError(`not a vertebral level: ${JSON.stringify(input)}`, 'bad_level');
  const label = `${m[1]}${String(n).padStart(2, '0')}`;
  if (levelClass(label) === null) {
    throw new AlcError(`${label} is not an addressable vertebral level: ${explainRejectedLevel(m[1], label)}`, 'bad_level');
  }
  return label;
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

/** Signed distance from `p` to every bisector plane, positive caudal. */
function planeDistances(g: SpineGeometry, p: Vec3): number[] {
  const out: number[] = [];
  for (let k = 0; k < g.nodes.length; k += 1) out.push(dot(sub(p, g.nodes[k]), g.normals[k]));
  return out;
}

/** Distance from `p` to level `i`'s axis segment, mm. */
function axisDistanceMm(g: SpineGeometry, i: number, p: Vec3): number {
  const rel = sub(p, g.nodes[i]);
  const along = Math.min(g.lens[i], Math.max(0, dot(rel, g.dirs[i])));
  const axis = add(g.nodes[i], g.dirs[i], along);
  return Math.hypot(p[0] - axis[0], p[1] - axis[1], p[2] - axis[2]);
}

/**
 * Every level whose bisector-plane region claims this millimetre point,
 * cranial to caudal.
 *
 * On an admissible template this returns exactly one level for every point
 * inside the body, which is what "the levels tile space" means. It is exported
 * because that is also the SOUND fold criterion — see `scanBodyTemplateFolds`
 * — and because the per-level audit below cannot express it.
 */
export function levelsClaiming(template: BodyTemplate, p: Vec3): string[] {
  const g = spineGeometry(template);
  const s = planeDistances(g, p);
  const out: string[] = [];
  for (let i = 0; i < g.dirs.length; i += 1) {
    if (s[i] >= 0 && s[i + 1] < 0) out.push(template.slabs[i].label);
  }
  return out;
}

/**
 * Template millimetres -> dimensionless local coordinates.
 *
 * Level choice. Level i owns { sigma_i >= 0 and sigma_(i+1) < 0 }. On an
 * admissible template those regions tile space, so exactly one level claims
 * any point and there is nothing to choose. Where the frame folds the regions
 * overlap, and this function must both choose and SAY SO:
 *
 *   exactly one claimant  the ordinary case; u is the relative distance
 *                         between the two bounding planes
 *   more than one         a fold. Take the NEAREST claimant by distance to its
 *                         own axis segment, and flag `folded` with a note
 *                         naming every competing level
 *   none, off either end  the point is beyond the column; clamp and say which
 *                         end
 *   none, mid-column      the concave-side gap of a fold. Nearest level,
 *                         flagged `folded` too
 *
 * This used to scan cranial-to-caudal and `break` on the first claimant, which
 * is where two defects came from at once (DOG-9, findings 1 and 2). The first
 * claimant is the most CRANIAL one, so a point could come back silently
 * assigned to a level five away — measured: 268 points with `flags: {}` on a
 * known-folding template. And the fold note lived only in the no-claimant
 * branch, which a fold does not produce: folding makes points DOUBLY claimed,
 * not unclaimed. So the note was unreachable, the only thing the user saw was
 * the radius clamp firing against the wrong level's surface, and they were
 * told their point was outside the body when the truth was that the
 * coordinate system had folded.
 */
export function bodyMmToLocal(
  template: BodyTemplate,
  p: Vec3,
): { local: LocalBodyCoords; flags: LocateFlags } {
  const g = spineGeometry(template);
  const n = g.dirs.length;
  const flags: LocateFlags = {};
  const notes: string[] = [];

  // Computed once for the whole column: every claimant has to be found, so
  // there is no early exit to preserve, and this is fewer dot products than
  // the two-per-iteration version it replaces.
  const sigma = planeDistances(g, p);

  const claimants: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (sigma[i] >= 0 && sigma[i + 1] < 0) claimants.push(i);
  }

  /** Nearest by distance to its own axis segment; ties to the more cranial. */
  const nearestOf = (candidates: number[]): number => {
    let best = candidates[0];
    let bestD = Infinity;
    for (const i of candidates) {
      const d = axisDistanceMm(g, i, p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  let index: number;
  let u: number;

  if (claimants.length === 1) {
    index = claimants[0];
    u = sigma[index] / (sigma[index] - sigma[index + 1]);
  } else if (claimants.length > 1) {
    index = nearestOf(claimants);
    u = sigma[index] / (sigma[index] - sigma[index + 1]);
    flags.folded = true;
    const competing = claimants.map((i) => template.slabs[i].label);
    notes.push(
      `template ${template.id} is inadmissible here: the BD frame folds, and this point is claimed by `
      + `${competing.length} vertebral levels (${competing.join(', ')}). Resolved to the nearest, `
      + `${template.slabs[index].label}, which is deterministic but not reliable — the address is `
      + 'genuinely ambiguous at this point.',
    );
  } else if (sigma[0] < 0) {
    index = 0;
    u = 0;
    flags.clamped = true;
    notes.push('point lies above the cranial end of the vertebral column');
  } else if (sigma[n] >= 0) {
    index = n - 1;
    u = 1 - 1e-12;
    flags.clamped = true;
    notes.push('point lies below the caudal end of the vertebral column');
  } else {
    // Mid-column with no claimant: the other half of a fold. Where regions
    // overlap on the convex side of a bend they leave a gap on the concave
    // side, and this is a point in that gap.
    index = nearestOf(Array.from({ length: n }, (_, i) => i));
    const s0 = sigma[index];
    const s1 = sigma[index + 1];
    u = Math.min(1 - 1e-12, Math.max(0, s0 - s1 !== 0 ? s0 / (s0 - s1) : 0));
    flags.folded = true;
    flags.clamped = true;
    notes.push(
      `template ${template.id} is inadmissible near ${template.slabs[index].label}: the BD frame folds, `
      + 'and this point falls in the gap no level claims, so its axial coordinate is clamped. The level '
      + 'assignment here is deterministic but not reliable.',
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
    // Attributing the right cause matters. Inside a fold the radius overflows
    // because it is being measured against the surface of a level that is not
    // really this point's level, so saying "outside the body" would name the
    // wrong reason for data that is in fact inside the body.
    notes.push(
      flags.folded
        ? `the depth here exceeds ${slab.label}'s surface radius, but that follows from the fold above `
          + '— the radius is being measured against a level this point may not belong to — not from the '
          + 'point lying outside the body'
        : 'point is outside the modelled body surface',
    );
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
 *
 * ---------------------------------------------------------------------------
 * The criterion is DIRECTIONAL, and getting that wrong costs real templates.
 *
 * The forward map is p(u, t, r) = axis(u) + rho(t) * r * e(t). Its Jacobian
 * determinant carries the factor
 *
 *     1 - kappa * rho * cos(psi)
 *
 * where kappa is the local curvature and psi is the angle between the radial
 * direction e(t) and the curvature normal — the direction the tangent turns
 * *toward*, i.e. the concave side. So the map folds at radius
 * R_curv / cos(psi) on the concave side, and never folds at all on the convex
 * side, where cos(psi) < 0 and adjacent normal rays diverge forever.
 *
 * An earlier version of this audit compared `max(surfaceRadiiMm)` against
 * R_curv, which silently assumes the widest tissue faces the concave side. In
 * a trunk it faces the opposite way: the spinal canal sits far posterior, so
 * at the lumbar lordosis — concave *posteriorly* — there is ~65 mm of tissue
 * on the binding side and ~165 mm on the harmless anterior side. The
 * worst-case test therefore rejected ordinary adult bodies that round-trip
 * perfectly, and it would have sent the asset pipeline hunting for a fix to a
 * problem that does not exist. Measured in `test/admissibility.test.ts`:
 * worst-case flags physiological templates that have zero round-trip failures;
 * the directional test flags exactly the ones that fail.
 *
 * Where the constraint does bind is the sacrum, because that is the one place
 * the curve is tight AND its concavity faces the deep pelvis. See
 * docs/alc-1-admissibility.md.
 */
export interface LevelAudit {
  level: string;
  /** Largest radius at this level, any direction. Informational only. */
  maxRadiusMm: number;
  /** Continuous local radius of curvature, mm. Informational; see below. */
  curvatureRadiusMm: number;
  /**
   * Exact radius at which this level's two bounding bisector planes meet,
   * along the worst azimuth. The frame folds beyond it.
   */
  foldRadiusMm: number;
  /** Body radius at that same azimuth, mm. */
  radiusAtWorstMm: number;
  /** foldRadiusMm - radiusAtWorstMm. Zero or negative is a violation. */
  marginMm: number;
  /** radiusAtWorstMm / foldRadiusMm. 1 or more is a violation. */
  utilisation: number;
  /** Azimuth in turns where the margin is worst, for the audit report. */
  worstAzimuthTurns: number;
}

export interface TemplateAudit {
  templateId: string;
  /**
   * No level violates its OWN two bisector planes. Necessary, NOT sufficient:
   * this does not mean the template is free of folds.
   *
   * Named `locallyAdmissible` rather than `admissible` deliberately (DOG-9,
   * finding 1). A point is lost to the frame as soon as ANY level claims it,
   * and this criterion only ever looks at the two planes either side of a
   * level. Across the physiological parameter box `anatomicalTemplates.ts`
   * defines, 162 of 3,228 templates — 5.0% — satisfy this and still fold:
   * with a tight kyphosis the planes fan out enormously on the convex side, so
   * an upper-thoracic level's region sweeps down and swallows anterior skin
   * five levels below it. The confirmed case has T06's own margin at +7.8 mm
   * and its anterior skin decoding as T01.
   *
   * The old name read as a gate and could be used as one. Use
   * `scanBodyTemplateFolds()` or `measureRoundTrip()` to gate; use this to
   * LOCALISE a fold once one is known to exist, which is what the per-level
   * margins are genuinely good at.
   */
  locallyAdmissible: boolean;
  violations: LevelAudit[];
  /** Every level, for the published audit report. */
  levels: LevelAudit[];
  /** Smallest margin anywhere in the template, mm. */
  worstMarginMm: number;
}

// ---------------------------------------------------------------------------
// The sound fold criterion
// ---------------------------------------------------------------------------

/**
 * How a level lost one of its own points.
 *
 *   ambiguous  more than one level claims it, so two addresses denote it and
 *              `bodyMmToLocal` has to choose. Flagged at runtime as `folded`
 *   lost       exactly one level claims it and it is the WRONG one, so this
 *              level's address for the point decodes into another level.
 *              Invisible at runtime: a decoder handed the millimetres alone
 *              sees a single unambiguous claimant and has no way to know a
 *              different level's address pointed here. Only a template-level
 *              scan can see it, which is why templates are gated at build time
 *   unclaimed  no level claims it — the concave-side gap of a fold
 */
export type FoldKind = 'ambiguous' | 'lost' | 'unclaimed';

/** One place the frame was found not to be injective. */
export interface FoldSite {
  /** The level whose own coordinates generated the point. */
  level: string;
  kind: FoldKind;
  /** Its dimensionless coordinates in that level. */
  at: { u: number; t: number; r: number };
  /** Every level claiming the resulting millimetre point. */
  claimedBy: string[];
  /** What `bodyMmToLocal` actually returns for it. */
  decodesAs: string;
  /** Distance from the point to `level`'s own axis segment, mm. */
  radiusMm: number;
}

export interface FoldScan {
  templateId: string;
  /** Millimetre points examined. */
  probed: number;
  /** Points claimed by a number of levels other than exactly one. */
  foldedPoints: number;
  /** True when every probed point is claimed by exactly one level. */
  sound: boolean;
  /** Per level, how many of its own points were lost. Worst first. */
  foldsByLevel: Array<{ level: string; folds: number }>;
  /** One representative site per (level, claimant set). Shallowest first. */
  sites: FoldSite[];
}

export interface FoldScanOptions {
  /**
   * Azimuths per level. Rounded UP to a whole multiple of the template's own
   * `surfaceRadiiMm.length`, and always sampled ON those knots: the radii are
   * linearly interpolated, so a knot is the only place a local maximum can
   * sit, and a coarser grid of its own choosing can miss every one of them.
   */
  azimuths?: number;
  /** Axial fractions to probe within each level. */
  axialFractions?: readonly number[];
  /** Normalised depths to probe. Must reach the skin to be a skin scan. */
  radialFractions?: readonly number[];
  /** Cap on recorded sites; the scan always counts everything. */
  maxSites?: number;
}

const FOLD_SCAN_DEFAULTS: Required<FoldScanOptions> = {
  azimuths: 240,
  axialFractions: [0.02, 0.5, 0.98],
  radialFractions: [0.5, 0.9, 1],
  maxSites: 24,
};

/**
 * The SOUND fold test: walk each level's own skin and assert that every
 * millimetre point it generates is claimed by exactly that level.
 *
 * This is the criterion `auditBodyTemplate` cannot express, and it is cheap —
 * a fold is a failure of the partition the frame actually uses, which needs no
 * curvature argument at all. It catches non-local folds by construction,
 * because it asks about every level rather than about a level and its two
 * neighbours.
 *
 * The condition is `levelsClaiming(bodyLocalToMm(L, u, t, r)) === [L]`, and
 * BOTH halves are load bearing. "Claimed by exactly one level" alone is not
 * enough: past its own fold radius a level's planes stop bracketing its own
 * points, and the point can then be claimed solely by a NEIGHBOUR. One
 * claimant, no ambiguity to detect at runtime, and the first level's address
 * for that point is silently lost anyway. Measured on the split-sacrum preset:
 * `S02` at 1.05x its predicted fold radius is claimed only by `S01`. An
 * earlier version of this scan counted claimants and missed exactly that case.
 *
 * Why the skin: `r` scales the radius linearly and the fold condition is
 * monotone in it, so if the frame survives at the skin it survives everywhere
 * inside. The skin is the extremal surface, not merely a convenient one.
 *
 * `measureRoundTrip()` in `testing/admissibilityProbe.ts` is the end-to-end
 * gate, through the real encode and decode. Note it is NOT a superset of this:
 * it samples each level's own coordinates and checks they come back, so it
 * cannot see that some OTHER level's address also denotes the point. Its
 * `inadmissibleNotes` counter covers the ambiguous case; this scan covers all
 * three. Run both — they fail on different templates.
 */
export function scanBodyTemplateFolds(template: BodyTemplate, options: FoldScanOptions = {}): FoldScan {
  const opts: Required<FoldScanOptions> = { ...FOLD_SCAN_DEFAULTS, ...options };
  const g = spineGeometry(template);
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const sites: FoldSite[] = [];
  let probed = 0;
  let foldedPoints = 0;

  for (let i = 0; i < template.slabs.length; i += 1) {
    const slab = template.slabs[i];
    const knots = slab.surfaceRadiiMm.length;
    const perKnot = Math.max(1, Math.ceil(opts.azimuths / knots));

    for (let k = 0; k < knots; k += 1) {
      for (let e = 0; e < perKnot; e += 1) {
        const t = (k + e / perKnot) / knots;
        for (const u of opts.axialFractions) {
          for (const r of opts.radialFractions) {
            let mm: Vec3;
            try {
              mm = bodyLocalToMm(template, { level: slab.label, u, t, r });
            } catch {
              continue; // degenerate geometry; STRUCTURE-class problem, not a fold
            }
            probed += 1;
            const claimedBy = levelsClaiming(template, mm);
            if (claimedBy.length === 1 && claimedBy[0] === slab.label) continue;
            const kind: FoldKind = claimedBy.length > 1
              ? 'ambiguous'
              : claimedBy.length === 0 ? 'unclaimed' : 'lost';
            foldedPoints += 1;
            counts.set(slab.label, (counts.get(slab.label) ?? 0) + 1);
            const key = `${slab.label}|${kind}|${claimedBy.join(',')}`;
            if (!seen.has(key) && sites.length < opts.maxSites) {
              seen.add(key);
              sites.push({
                level: slab.label,
                kind,
                at: { u, t, r },
                claimedBy,
                decodesAs: bodyMmToLocal(template, mm).local.level,
                radiusMm: axisDistanceMm(g, i, mm),
              });
            }
          }
        }
      }
    }
  }

  return {
    templateId: template.id,
    probed,
    foldedPoints,
    sound: foldedPoints === 0,
    foldsByLevel: [...counts.entries()]
      .map(([level, folds]) => ({ level, folds }))
      .sort((a, b) => b.folds - a.folds),
    sites: sites.sort((a, b) => a.radiusMm - b.radiusMm),
  };
}

/** A fold scan a human can act on, and that CI can print. */
export function formatFoldScan(scan: FoldScan): string {
  if (scan.sound) {
    return `template ${scan.templateId}: SOUND, ${scan.probed} skin points each claimed by exactly one level`;
  }
  const lines = [
    `template ${scan.templateId}: FOLDS at ${scan.foldedPoints}/${scan.probed} skin points`,
    `  by level: ${scan.foldsByLevel.map((f) => `${f.level} x${f.folds}`).join(', ')}`,
  ];
  for (const s of scan.sites) {
    lines.push(
      `  [${s.kind}] ${s.level} at u=${s.at.u} t=${s.at.t.toFixed(4)} r=${s.at.r} `
      + `(${s.radiusMm.toFixed(0)} mm out) is claimed by `
      + `[${s.claimedBy.length ? s.claimedBy.join(', ') : 'nothing'}] and decodes as ${s.decodesAs}`,
    );
  }
  return lines.join('\n');
}

/** Azimuth resolution of the audit scan; finer than any plausible mesh sampling. */
const AUDIT_AZIMUTH_SAMPLES = 360;

/**
 * Local curvature radius from the turn between adjacent segments. Reported for
 * context only: it is a continuous-geometry estimate, and at a junction of very
 * unequal segment lengths — L5 against a single fused sacral level — it is too
 * pessimistic by tens of millimetres. The gate below uses the exact discrete
 * condition instead.
 */
function curvatureRadiusAt(g: SpineGeometry, i: number): number {
  let r = Infinity;
  for (const j of [i - 1, i + 1]) {
    if (j < 0 || j >= g.dirs.length) continue;
    const c = Math.max(-1, Math.min(1, dot(g.dirs[i], g.dirs[j])));
    const turn = Math.acos(c);
    if (turn > 1e-9) {
      const chord = (g.lens[i] + g.lens[j]) / 2;
      r = Math.min(r, chord / (2 * Math.sin(turn / 2)));
    }
  }
  return r;
}

export function auditBodyTemplate(template: BodyTemplate): TemplateAudit {
  const g = spineGeometry(template);
  const levels: LevelAudit[] = [];

  for (let i = 0; i < template.slabs.length; i += 1) {
    const slab = template.slabs[i];
    const maxRadiusMm = Math.max(...slab.surfaceRadiiMm);
    const curvatureRadiusMm = curvatureRadiusAt(g, i);

    // Exact discrete fold condition, derived from the partition this frame
    // actually uses. Level i owns the axial offsets a (along dirs[i], from
    // node i) satisfying
    //
    //     sigma_i     = c_i * a + rho * e_i        >= 0
    //     sigma_(i+1) = c_(i+1) * (a - len) + rho * e_(i+1) < 0
    //
    // which is a non-empty interval in a exactly while
    //
    //     rho * (e_(i+1)/c_(i+1) - e_i/c_i) < len.
    //
    // So along azimuth t the level survives out to
    //
    //     foldRadius(t) = len / (e_(i+1)/c_(i+1) - e_i/c_i)
    //
    // when that denominator is positive, and out to infinity when it is not —
    // the convex side, where adjacent normal rays diverge forever. In the
    // symmetric small-angle limit this reduces to R_curv / cos(psi), the
    // continuous criterion, but it stays exact at unequal segment lengths and
    // needs no special case for the end levels (there e_i = 0 identically,
    // because the end planes are perpendicular to the column).
    const ci = dot(g.dirs[i], g.normals[i]);
    const ci1 = dot(g.dirs[i], g.normals[i + 1]);

    let worst: LevelAudit = {
      level: slab.label,
      maxRadiusMm,
      curvatureRadiusMm,
      foldRadiusMm: Infinity,
      radiusAtWorstMm: maxRadiusMm,
      marginMm: Infinity,
      utilisation: 0,
      worstAzimuthTurns: 0,
    };

    if (Math.abs(ci) > 1e-9 && Math.abs(ci1) > 1e-9) {
      for (let k = 0; k < AUDIT_AZIMUTH_SAMPLES; k += 1) {
        const t = k / AUDIT_AZIMUTH_SAMPLES;
        const e = radialDirection(g, i, t);
        const denom = dot(e, g.normals[i + 1]) / ci1 - dot(e, g.normals[i]) / ci;
        if (denom <= 1e-12) continue; // convex side: never folds
        const foldRadiusMm = g.lens[i] / denom;
        const radiusAtWorstMm = radiusAt(slab, t);
        const utilisation = radiusAtWorstMm / foldRadiusMm;
        if (utilisation > worst.utilisation) {
          worst = {
            level: slab.label,
            maxRadiusMm,
            curvatureRadiusMm,
            foldRadiusMm,
            radiusAtWorstMm,
            marginMm: foldRadiusMm - radiusAtWorstMm,
            utilisation,
            worstAzimuthTurns: t,
          };
        }
      }
    }
    levels.push(worst);
  }

  const violations = levels.filter((l) => l.marginMm <= 0);
  const worstMarginMm = levels.reduce((m, l) => Math.min(m, l.marginMm), Infinity);
  return { templateId: template.id, locallyAdmissible: violations.length === 0, violations, levels, worstMarginMm };
}

/**
 * The superseded worst-case criterion, kept so the comparison in
 * `test/admissibility.test.ts` stays honest and so the regression cannot
 * quietly come back. Do not use it to gate a template.
 */
export function auditBodyTemplateWorstCase(template: BodyTemplate): TemplateAudit {
  const directional = auditBodyTemplate(template);
  const levels = directional.levels.map((l) => ({ ...l, marginMm: l.curvatureRadiusMm - l.maxRadiusMm }));
  const violations = levels.filter((l) => l.marginMm <= 0);
  return {
    templateId: template.id,
    locallyAdmissible: violations.length === 0,
    violations,
    levels,
    worstMarginMm: levels.reduce((m, l) => Math.min(m, l.marginMm), Infinity),
  };
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
    // Two different facts, two different flags. `variant` says the subject's
    // anatomy differs from the template's in a way a registration can map;
    // `absent` says the template simply does not realise a canonical level.
    // Both return NaN millimetres: neither is ever guessed.
    const anomaly = levelClass(box.level) === 'anomaly';
    flags.homology = anomaly ? 'variant' : 'absent';
    flags.notes = [
      anomaly
        ? `level ${box.level} is a recognised vertebral count anomaly and is not present in template `
          + `${template.id}; this is real anatomy rather than a mistyped level, and a `
          + 'registration-supplied level mapping is required to place it'
        : `level ${box.level} is not present in template ${template.id}; a registration-supplied level mapping is required`,
    ];
    return {
      pointMm: [NaN, NaN, NaN],
      extentMm: [NaN, NaN, NaN],
      // No slab, so no triad. NaN rather than a plausible-looking identity: a
      // consumer that projects onto these gets NaN, not a confident number.
      axesMm: [[NaN, NaN, NaN], [NaN, NaN, NaN], [NaN, NaN, NaN]],
      templateId: template.id,
      flags,
    };
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
  const g = spineGeometry(template);
  const segmentLengthMm = g.lens[found.index];
  const extentMm: Vec3 = [
    (box.u[1] - box.u[0]) * segmentLengthMm,
    (box.t[1] - box.t[0]) * 2 * Math.PI * surface * mid.r, // arc length at the cell's own depth
    (box.r[1] - box.r[0]) * surface,
  ];
  // The triad the three extents are measured along, at the cell's centre and in
  // the same order: down the column, around it, out from it. Quarter of a turn
  // past the cell's own azimuth is the tangent to the arc, which is the
  // direction the second extent is an arc length of.
  const axesMm: readonly [Vec3, Vec3, Vec3] = [
    g.dirs[found.index],
    radialDirection(g, found.index, mid.t + 0.25),
    radialDirection(g, found.index, mid.t),
  ];
  const pointMm = bodyLocalToMm(template, mid);

  // Is this cell's own centre actually in this cell's own level?
  //
  // `locate()` knows something `bodyMmToLocal` does not: the level the caller
  // ASKED for. So it can check the one thing a bare millimetre point can never
  // reveal — that the address denotes a point some other level also owns, or
  // owns outright. Without this the only honest signal is at template build
  // time, and a consumer resolving a stored address has no way to learn that
  // the answer is ambiguous (DOG-9, finding 2; previously filed as QA-1).
  const claimedBy = levelsClaiming(template, pointMm);
  if (!(claimedBy.length === 1 && claimedBy[0] === box.level)) {
    flags.folded = true;
    const notes = flags.notes ?? [];
    notes.push(
      claimedBy.length > 1
        ? `template ${template.id} is inadmissible at this cell: the BD frame folds here and the point is `
          + `claimed by ${claimedBy.length} levels (${claimedBy.join(', ')}), so this address and an `
          + 'address in the other level(s) denote the same place. The millimetres are deterministic but '
          + 'the cell is genuinely ambiguous.'
        : claimedBy.length === 0
          ? `template ${template.id} is inadmissible at this cell: the BD frame folds here and no level `
            + `claims the point, so it falls in a gap between ${box.level} and its neighbours.`
          : `template ${template.id} is inadmissible at this cell: the BD frame folds here, and the point `
            + `this ${box.level} address denotes actually lies in ${claimedBy[0]} — decoding these `
            + `millimetres returns ${claimedBy[0]}, so the address does not survive a round trip.`,
    );
    flags.notes = notes;
  }

  return { pointMm, extentMm, axesMm, templateId: template.id, flags };
}
