/**
 * Body templates built from *clinical* parameters.
 *
 * `syntheticTemplates.ts` exists to exercise the frame mathematics over a
 * controlled family of shapes. This file exists for a different purpose: to
 * ask whether a body with the proportions and curvature of a real person is
 * an admissible `BD` template at all, before any licensed mesh lands.
 *
 * So the knobs here are quantities a radiologist would recognise — Cobb angles
 * for each spinal curve, and separate anterior / posterior / lateral radii
 * from the spinal canal to the skin — rather than an abstract `curvature`
 * scalar.
 *
 * HONESTY NOTE. The numbers in `LEVELS` and in the presets are typical adult
 * proportions, not measurements drawn from a specific published cohort. They
 * are good to perhaps 10-15%. That is deliberately good enough, because the
 * question being asked is not "what is the exact margin for a p50 male" but
 * "which *direction* does the admissibility constraint bind in, and is a
 * physiological body anywhere near the boundary". A 15% error in a radius does
 * not move the answer to either of those; see docs/alc-1-admissibility.md.
 * A real template's audit is still run on the real geometry, in CI.
 *
 * Template space convention: +x left, +y anterior, +z superior, millimetres.
 */

import type { BodyTemplate, VertebralSlab } from '../frames/bodySpine.ts';
import type { Vec3 } from '../types.ts';

export interface LevelSpec {
  label: string;
  /** Vertebral body + its caudal disc, mm. */
  heightMm: number;
  /** Spinal canal to skin, straight anterior, mm. */
  anteriorMm: number;
  /** Spinal canal to skin, straight posterior, mm. */
  posteriorMm: number;
  /** Spinal canal to skin, lateral (both sides before asymmetry), mm. */
  lateralMm: number;
}

/**
 * Typical adult proportions, cranial to caudal.
 *
 * Radii are measured from the spinal canal, which sits far posterior in the
 * trunk — that asymmetry is the whole point, and it is exactly what the
 * single `max(radius)` admissibility test used to throw away. At the waist
 * there is ~165 mm of tissue in front of the canal and ~65 mm behind it.
 */
export const LEVELS: readonly LevelSpec[] = [
  { label: 'C01', heightMm: 14, anteriorMm: 42, posteriorMm: 30, lateralMm: 46 },
  { label: 'C02', heightMm: 20, anteriorMm: 48, posteriorMm: 32, lateralMm: 50 },
  { label: 'C03', heightMm: 18, anteriorMm: 54, posteriorMm: 34, lateralMm: 54 },
  { label: 'C04', heightMm: 18, anteriorMm: 58, posteriorMm: 35, lateralMm: 56 },
  { label: 'C05', heightMm: 18, anteriorMm: 60, posteriorMm: 36, lateralMm: 58 },
  { label: 'C06', heightMm: 18, anteriorMm: 62, posteriorMm: 37, lateralMm: 60 },
  { label: 'C07', heightMm: 19, anteriorMm: 66, posteriorMm: 38, lateralMm: 66 },
  { label: 'T01', heightMm: 22, anteriorMm: 92, posteriorMm: 40, lateralMm: 104 },
  { label: 'T02', heightMm: 23, anteriorMm: 108, posteriorMm: 42, lateralMm: 124 },
  { label: 'T03', heightMm: 23, anteriorMm: 120, posteriorMm: 44, lateralMm: 136 },
  { label: 'T04', heightMm: 24, anteriorMm: 130, posteriorMm: 46, lateralMm: 142 },
  { label: 'T05', heightMm: 25, anteriorMm: 138, posteriorMm: 48, lateralMm: 146 },
  { label: 'T06', heightMm: 26, anteriorMm: 144, posteriorMm: 50, lateralMm: 148 },
  { label: 'T07', heightMm: 27, anteriorMm: 148, posteriorMm: 52, lateralMm: 150 },
  { label: 'T08', heightMm: 28, anteriorMm: 150, posteriorMm: 54, lateralMm: 150 },
  { label: 'T09', heightMm: 28, anteriorMm: 152, posteriorMm: 56, lateralMm: 148 },
  { label: 'T10', heightMm: 29, anteriorMm: 155, posteriorMm: 58, lateralMm: 146 },
  { label: 'T11', heightMm: 30, anteriorMm: 158, posteriorMm: 60, lateralMm: 150 },
  { label: 'T12', heightMm: 31, anteriorMm: 162, posteriorMm: 62, lateralMm: 156 },
  { label: 'L01', heightMm: 34, anteriorMm: 164, posteriorMm: 63, lateralMm: 160 },
  { label: 'L02', heightMm: 34, anteriorMm: 165, posteriorMm: 64, lateralMm: 164 },
  { label: 'L03', heightMm: 35, anteriorMm: 166, posteriorMm: 65, lateralMm: 166 },
  { label: 'L04', heightMm: 35, anteriorMm: 164, posteriorMm: 66, lateralMm: 170 },
  { label: 'L05', heightMm: 34, anteriorMm: 158, posteriorMm: 68, lateralMm: 176 },
  // The sacrum is a single fused bone. Addressing it as five 20 mm levels is a
  // choice, not anatomy, and `sacralLevels` below lets us test the alternative.
  { label: 'S01', heightMm: 28, anteriorMm: 148, posteriorMm: 70, lateralMm: 180 },
  { label: 'S02', heightMm: 25, anteriorMm: 136, posteriorMm: 74, lateralMm: 178 },
  { label: 'S03', heightMm: 22, anteriorMm: 124, posteriorMm: 78, lateralMm: 172 },
  { label: 'S04', heightMm: 19, anteriorMm: 110, posteriorMm: 82, lateralMm: 164 },
  { label: 'S05', heightMm: 16, anteriorMm: 96, posteriorMm: 84, lateralMm: 154 },
];

export interface AnatomicalBodyParams {
  id: string;
  /** C2-C7 Cobb angle. Typical 10-30; 0 is a straight ("military") neck. */
  cervicalLordosisDeg: number;
  /** T1-T12 Cobb angle. Typical 20-45; hyperkyphosis of ageing reaches 60+. */
  thoracicKyphosisDeg: number;
  /** L1-S1 Cobb angle. Typical 40-65; hyperlordosis reaches 85+. */
  lumbarLordosisDeg: number;
  /** Total tangent turn across the sacrum. Typical 60-80. */
  sacralCurveDeg: number;
  /** Multiplies every level height. Stature proxy. */
  axialScale: number;
  /** Multiplies every surface radius. Girth proxy. */
  radialScale: number;
  /** Extra fraction of girth on the subject's left. */
  asymmetry: number;
  /** How many addressable levels the fused sacrum is cut into, 1..5. */
  sacralLevels: number;
  /**
   * Where along its own curve a collapsed sacral level takes its axis
   * direction, as a fraction of that level's total tangent turn. 0.5 is the
   * chord of the whole sacrum, which is the obvious choice and the wrong one:
   * it puts a ~30 degree kink at L5/S1 and that kink, not the sacrum, is what
   * limits the frame. 0 follows the S1 endplate.
   */
  sacralTangentFraction: number;
  maxUsefulDigits: number;
}

const BASE: AnatomicalBodyParams = {
  id: 'anat-adult-p50',
  cervicalLordosisDeg: 18,
  thoracicKyphosisDeg: 35,
  lumbarLordosisDeg: 52,
  sacralCurveDeg: 70,
  axialScale: 1,
  radialScale: 1,
  asymmetry: 0,
  // One addressable level for the whole fused sacrum. This is the recommended
  // convention and the reason is measured, not aesthetic: five short sacral
  // levels put 1.2-3.2% of body volume (all of it pelvis) inside a fold of the
  // frame. See docs/alc-1-admissibility.md.
  sacralLevels: 1,
  sacralTangentFraction: 0.25,
  maxUsefulDigits: 5,
};

/** Mid-range adult. The template the real pipeline should most resemble. */
export const ADULT_P50: AnatomicalBodyParams = { ...BASE };

/** High-but-physiological lumbar lordosis with a wide waist. */
export const ADULT_HYPERLORDOTIC: AnatomicalBodyParams = {
  ...BASE,
  id: 'anat-adult-hyperlordotic',
  lumbarLordosisDeg: 85,
  sacralCurveDeg: 80,
  radialScale: 1.15,
};

/** Large girth, average curvature: the case the old audit feared most. */
export const ADULT_LARGE_GIRTH: AnatomicalBodyParams = {
  ...BASE,
  id: 'anat-adult-large-girth',
  radialScale: 1.45,
};

/** Hyperkyphotic older adult, reduced stature. */
export const ADULT_HYPERKYPHOTIC: AnatomicalBodyParams = {
  ...BASE,
  id: 'anat-adult-hyperkyphotic',
  thoracicKyphosisDeg: 62,
  lumbarLordosisDeg: 38,
  axialScale: 0.94,
  radialScale: 1.05,
};

/** Seven-year-old: shorter, rounder, straighter. */
export const CHILD_7Y: AnatomicalBodyParams = {
  ...BASE,
  id: 'anat-child-7y',
  cervicalLordosisDeg: 12,
  thoracicKyphosisDeg: 28,
  lumbarLordosisDeg: 40,
  sacralCurveDeg: 55,
  axialScale: 0.56,
  radialScale: 0.6,
  maxUsefulDigits: 4,
};

/**
 * The rejected design: the fused sacrum cut into five addressable levels.
 * Kept as a preset so the regression that motivated the rule stays testable.
 */
export const ADULT_P50_SPLIT_SACRUM: AnatomicalBodyParams = {
  ...BASE,
  id: 'anat-adult-p50-split-sacrum',
  sacralLevels: 5,
};

/** Every template a real pipeline should be able to produce. All admissible. */
export const PRESETS: readonly AnatomicalBodyParams[] = [
  ADULT_P50,
  ADULT_HYPERLORDOTIC,
  ADULT_LARGE_GIRTH,
  ADULT_HYPERKYPHOTIC,
  CHILD_7Y,
];

/**
 * The DOG-9 finding-1 counterexample: a template the PER-LEVEL audit clears
 * with +7.8 mm to spare, and which folds anyway.
 *
 * A short, round, hyperkyphotic torso — an elderly obese patient, not an
 * exotic shape, and inside the parameter box this file's own knobs describe.
 * With a tight kyphosis the bisector planes fan out enormously on the convex
 * (anterior) side, so an upper-thoracic level's region sweeps down and
 * swallows the anterior skin several levels below it: anterior skin at `T06`
 * is claimed by `T01`. `T06`'s own margin is +7.8 mm and entirely irrelevant,
 * because the fold is not between a level and its own two planes.
 *
 * It is a fixture rather than a preset because a pipeline must NOT produce it.
 * It exists so the soundness of the fold scan is asserted against a template
 * that actually defeats the cheap criterion — a gate is only as good as the
 * worst thing it has been shown to reject.
 */
export const ADULT_HYPERKYPHOTIC_SHORT_WIDE: AnatomicalBodyParams = {
  ...BASE,
  id: 'anat-hyperkyphotic-short-wide',
  cervicalLordosisDeg: 0,
  thoracicKyphosisDeg: 60, // "hyperkyphosis of ageing reaches 60+", above
  lumbarLordosisDeg: 30,
  sacralCurveDeg: 55,
  axialScale: 0.8, // short
  radialScale: 1.6, // large girth
  sacralLevels: 1,
  sacralTangentFraction: 0,
};

/**
 * Templates that MUST be rejected, each paired with how it is caught. Kept
 * together so a change to the gate has to confront all of them at once.
 *
 * `auditCatchesIt` is the interesting column: where it is false, the per-level
 * criterion clears the template and only the sound scan or the round-trip
 * probe sees the fold. Those are the rows that justify the scan existing.
 */
export const FOLD_REGRESSIONS: ReadonlyArray<{
  params: AnatomicalBodyParams;
  auditCatchesIt: boolean;
  why: string;
}> = [
  {
    params: ADULT_P50_SPLIT_SACRUM,
    auditCatchesIt: true,
    why: 'the fused sacrum cut into five short levels, concavity facing the deep pelvis',
  },
  {
    params: { ...ADULT_P50, id: 'anat-chord-axis-large', sacralTangentFraction: 0.5, radialScale: 1.45 },
    auditCatchesIt: true,
    why: 'a collapsed sacral level taking its axis from the sacrum chord, leaving a ~30 deg L5/S1 kink',
  },
  {
    params: ADULT_HYPERKYPHOTIC_SHORT_WIDE,
    auditCatchesIt: false,
    why: 'a NON-LOCAL fold: upper-thoracic planes fan out anteriorly and claim skin several levels below',
  },
];

const AZIMUTH_SAMPLES = 24;
const DEG = Math.PI / 180;

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Collapse the sacral levels into `count` addressable levels, summing heights
 * and taking the height-weighted mean radius. `S01` always survives, so an
 * address at `BD-S01` keeps meaning "the sacrum" at any setting.
 */
function sacralGrouping(count: number): LevelSpec[] {
  const sacral = LEVELS.filter((l) => l.label.startsWith('S'));
  const n = Math.max(1, Math.min(sacral.length, Math.round(count)));
  if (n === sacral.length) return [...sacral];
  const out: LevelSpec[] = [];
  for (let g = 0; g < n; g += 1) {
    const from = Math.floor((g * sacral.length) / n);
    const to = Math.floor(((g + 1) * sacral.length) / n);
    const group = sacral.slice(from, to);
    const h = group.reduce((s, l) => s + l.heightMm, 0);
    const mean = (pick: (l: LevelSpec) => number): number =>
      group.reduce((s, l) => s + pick(l) * l.heightMm, 0) / h;
    out.push({
      label: `S0${g + 1}`,
      heightMm: h,
      anteriorMm: mean((l) => l.anteriorMm),
      posteriorMm: mean((l) => l.posteriorMm),
      lateralMm: mean((l) => l.lateralMm),
    });
  }
  return out;
}

/**
 * Per-level tangent turn, in radians, positive = the caudal direction tilts
 * anteriorly as we descend.
 *
 * A lordosis is convex anteriorly, so descending through it the tangent
 * rotates posteriorly: negative. A kyphosis and the sacral curve are convex
 * posteriorly: positive. `anatomicalShapeIsSane` in the test suite checks the
 * resulting apices land where a radiologist would put them, which is the real
 * guard on these signs.
 */
function turnPerLevel(specs: readonly LevelSpec[], p: AnatomicalBodyParams): number[] {
  const count = (prefix: string): number => specs.filter((s) => s.label.startsWith(prefix)).length;
  const share: Record<string, number> = {
    C: (-p.cervicalLordosisDeg * DEG) / Math.max(1, count('C')),
    T: (p.thoracicKyphosisDeg * DEG) / Math.max(1, count('T')),
    L: (-p.lumbarLordosisDeg * DEG) / Math.max(1, count('L')),
    S: (p.sacralCurveDeg * DEG) / Math.max(1, count('S')),
  };
  return specs.map((s) => share[s.label[0]] ?? 0);
}

export function buildAnatomicalBodyTemplate(p: AnatomicalBodyParams): BodyTemplate {
  const specs: LevelSpec[] = [
    ...LEVELS.filter((l) => !l.label.startsWith('S')),
    ...sacralGrouping(p.sacralLevels),
  ];
  const turns = turnPerLevel(specs, p);

  const heights = specs.map((s) => s.heightMm * p.axialScale);

  /**
   * Choose the column's overall tilt from the clinical constraint, not by
   * guessing: a standing spine is sagittally balanced, so the top of the
   * column sits above its bottom. That is one equation,
   *
   *     sum_i  h_i * sin(theta_0 + prefix_i + turn_i / 2)  =  0,
   *
   * in the single unknown theta_0. Without it the whole column leans and the
   * curves stop being recognisable — the lumbar segment ends up sloping
   * steadily backward instead of bulging forward. Monotone in theta_0 over the
   * range of interest, so bisection is enough.
   */
  // Fraction of its own turn at which each level takes its axis direction.
  // Mid-level everywhere except a collapsed sacrum; see sacralTangentFraction.
  const collapsedSacrum = specs.filter((l) => l.label.startsWith('S')).length === 1;
  const tangentAt = specs.map((s) =>
    collapsedSacrum && s.label.startsWith('S') ? p.sacralTangentFraction : 0.5,
  );

  const prefix: number[] = [];
  turns.reduce((acc, t, i) => {
    prefix[i] = acc;
    return acc + t;
  }, 0);
  const drift = (theta0: number): number =>
    heights.reduce((s, h, i) => s + h * Math.sin(theta0 + prefix[i] + turns[i] * tangentAt[i]), 0);

  let lo = -Math.PI / 3;
  let hi = Math.PI / 3;
  for (let k = 0; k < 80; k += 1) {
    const mid = (lo + hi) / 2;
    if (drift(mid) > 0) hi = mid;
    else lo = mid;
  }

  const slabs: VertebralSlab[] = [];
  // Running cranial face of the current level, and the running tangent tilt.
  let face: Vec3 = [0, 0, 0];
  let theta = (lo + hi) / 2;

  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const heightMm = spec.heightMm * p.axialScale;
    const mid = theta + turns[i] * tangentAt[i];
    const axial: Vec3 = [0, Math.sin(mid), -Math.cos(mid)];
    const anterior = unit(cross([1, 0, 0], axial));
    const left = unit(cross(axial, anterior));
    const origin: Vec3 = [
      face[0] + axial[0] * (heightMm / 2),
      face[1] + axial[1] * (heightMm / 2),
      face[2] + axial[2] * (heightMm / 2),
    ];

    const surfaceRadiiMm: number[] = [];
    for (let k = 0; k < AZIMUTH_SAMPLES; k += 1) {
      const ang = (k / AZIMUTH_SAMPLES) * 2 * Math.PI; // 0 = anterior, +ve toward left
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      // Two half-ellipses sharing the lateral semi-axis: anterior in front of
      // the canal, posterior behind it.
      const ap = c >= 0 ? spec.anteriorMm : spec.posteriorMm;
      const lat = spec.lateralMm;
      const r = 1 / Math.hypot(c / ap, s / lat);
      surfaceRadiiMm.push(r * p.radialScale * (1 + p.asymmetry * s));
    }

    slabs.push({ label: spec.label, origin, axial, anterior, left, heightMm, surfaceRadiiMm });
    face = [origin[0] + axial[0] * (heightMm / 2), origin[1] + axial[1] * (heightMm / 2), origin[2] + axial[2] * (heightMm / 2)];
    theta += turns[i];
  }

  return { id: p.id, slabs, maxUsefulDigits: p.maxUsefulDigits };
}
