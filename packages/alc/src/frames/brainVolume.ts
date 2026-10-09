/**
 * Frame `BV` — brain volume, AC-PC proportional.
 *
 *   BV-L-4721
 *   │  │  └── octree refinement digits (octal), optional
 *   │  └───── hemisphere half-box, L or R
 *   └──────── frame id
 *
 * Coordinates are Talairach's proportional grid, not millimetres:
 *   a  lateral fraction, 0 at the midsagittal plane, 1 at the lateral edge
 *   b  0 at the posterior edge, 0.5 at the AC coronal plane, 1 at the anterior edge
 *   c  0 at the inferior edge, 0.5 at the AC-PC axial plane, 1 at the superior edge
 *
 * b and c are PIECEWISE proportional about the AC/AC-PC planes rather than a
 * single affine stretch. That is deliberate: it is the classical Talairach
 * normalisation, and it keeps deep landmarks aligned across brains whose
 * anterior and posterior extents differ by different ratios — which is exactly
 * the age and population variation we have to absorb.
 *
 * x == 0 (exactly on the midsagittal plane) is assigned to L by convention.
 * Midline structures therefore have coverings that span both BV-L and BV-R;
 * that is expected and handled by the covering algorithm, not by a special case.
 */

import { AlcError, OCTAL, digitsToValues, rejectNaNCoordinates } from '../codec.ts';
import type { FrameDescriptor, Hemisphere, Located, LocateFlags, Vec3 } from '../types.ts';

export const BV: FrameDescriptor = {
  id: 'BV',
  anchorSegments: 1,
  digitAlphabet: OCTAL,
  maxDigits: 12,
  minDigits: 0,
  summary: 'Brain volume in AC-PC proportional coordinates, covering cortex and deep structures alike.',
};

export function parseHemisphere(seg: string): Hemisphere {
  if (seg === 'L' || seg === 'R') return seg;
  throw new AlcError(`hemisphere must be L or R, got ${JSON.stringify(seg)}`, 'bad_hemisphere');
}

export interface BvCellBox {
  hemisphere: Hemisphere;
  a: [number, number];
  b: [number, number];
  c: [number, number];
}

export function bvCellBox(hemisphere: Hemisphere, digits: string): BvCellBox {
  let a: [number, number] = [0, 1];
  let b: [number, number] = [0, 1];
  let c: [number, number] = [0, 1];
  for (const v of digitsToValues(digits, OCTAL, 'brain-volume octree')) {
    const am = (a[0] + a[1]) / 2;
    const bm = (b[0] + b[1]) / 2;
    const cm = (c[0] + c[1]) / 2;
    a = v & 4 ? [am, a[1]] : [a[0], am];
    b = v & 2 ? [bm, b[1]] : [b[0], bm];
    c = v & 1 ? [cm, c[1]] : [c[0], cm];
  }
  return { hemisphere, a, b, c };
}

export function bvEncodeLocal(
  hemisphere: Hemisphere,
  local: { a: number; b: number; c: number },
  digitCount: number,
): string {
  if (digitCount < 0 || digitCount > BV.maxDigits) {
    throw new AlcError(`digit count out of range: ${digitCount}`, 'bad_precision');
  }
  let a: [number, number] = [0, 1];
  let b: [number, number] = [0, 1];
  let c: [number, number] = [0, 1];
  const out: number[] = [];
  for (let i = 0; i < digitCount; i += 1) {
    const am = (a[0] + a[1]) / 2;
    const bm = (b[0] + b[1]) / 2;
    const cm = (c[0] + c[1]) / 2;
    const ab = local.a >= am ? 1 : 0;
    const bb = local.b >= bm ? 1 : 0;
    const cb = local.c >= cm ? 1 : 0;
    out.push(ab * 4 + bb * 2 + cb);
    a = ab ? [am, a[1]] : [a[0], am];
    b = bb ? [bm, b[1]] : [b[0], bm];
    c = cb ? [cm, c[1]] : [c[0], cm];
  }
  return out.map((v) => OCTAL[v]).join('');
}

// ---------------------------------------------------------------------------
// Template geometry
// ---------------------------------------------------------------------------

export interface BrainVolumeTemplate {
  id: string;
  /** Anterior commissure, template mm. Origin of the proportional grid. */
  acMm: Vec3;
  /** Unit vector toward the subject's left. */
  left: Vec3;
  /** Unit vector toward anterior, along the AC-PC line. */
  anterior: Vec3;
  /** Unit vector toward superior. */
  superior: Vec3;
  /** Distances from AC to the bounding extremes, mm. */
  extents: {
    left: number;
    right: number;
    anterior: number;
    posterior: number;
    superior: number;
    inferior: number;
  };
  maxUsefulDigits: number;
}

/** Piecewise-proportional fraction -> signed millimetres about the AC plane. */
function unsplit(frac: number, negExtent: number, posExtent: number): number {
  return frac < 0.5 ? (frac - 0.5) * 2 * negExtent : (frac - 0.5) * 2 * posExtent;
}

/** Signed millimetres about the AC plane -> piecewise-proportional fraction. */
function split(mm: number, negExtent: number, posExtent: number): number {
  if (mm < 0) return negExtent > 0 ? 0.5 + mm / (2 * negExtent) : 0;
  return posExtent > 0 ? 0.5 + mm / (2 * posExtent) : 1;
}

export function bvLocalToMm(
  template: BrainVolumeTemplate,
  hemisphere: Hemisphere,
  local: { a: number; b: number; c: number },
): Vec3 {
  const lateral = template.extents[hemisphere === 'L' ? 'left' : 'right'] * local.a;
  const sign = hemisphere === 'L' ? 1 : -1;
  const y = unsplit(local.b, template.extents.posterior, template.extents.anterior);
  const z = unsplit(local.c, template.extents.inferior, template.extents.superior);
  const { acMm, left, anterior, superior } = template;
  return [
    acMm[0] + left[0] * lateral * sign + anterior[0] * y + superior[0] * z,
    acMm[1] + left[1] * lateral * sign + anterior[1] * y + superior[1] * z,
    acMm[2] + left[2] * lateral * sign + anterior[2] * y + superior[2] * z,
  ];
}

export function bvMmToLocal(
  template: BrainVolumeTemplate,
  p: Vec3,
): { hemisphere: Hemisphere; local: { a: number; b: number; c: number }; flags: LocateFlags } {
  // Before any arithmetic: a NaN coordinate would pass `clampUnit`'s range test
  // unflagged and then take the zero branch of every octree comparison, which
  // fabricates a specific hemisphere and a specific cell out of nothing.
  rejectNaNCoordinates(p, `BV encode in template ${template.id}`);
  const rel: Vec3 = [p[0] - template.acMm[0], p[1] - template.acMm[1], p[2] - template.acMm[2]];
  const dot = (v: Vec3) => rel[0] * v[0] + rel[1] * v[1] + rel[2] * v[2];
  const lateralSigned = dot(template.left);
  const hemisphere: Hemisphere = lateralSigned >= 0 ? 'L' : 'R';
  const extent = template.extents[hemisphere === 'L' ? 'left' : 'right'];
  const flags: LocateFlags = {};
  const notes: string[] = [];

  let a = extent > 0 ? Math.abs(lateralSigned) / extent : 0;
  let b = split(dot(template.anterior), template.extents.posterior, template.extents.anterior);
  let c = split(dot(template.superior), template.extents.inferior, template.extents.superior);
  const clampUnit = (v: number, name: string): number => {
    if (v < 0 || v >= 1) {
      flags.clamped = true;
      notes.push(`${name} fell outside the template bounding box`);
      return Math.min(1 - 1e-12, Math.max(0, v));
    }
    return v;
  };
  a = clampUnit(a, 'lateral fraction');
  b = clampUnit(b, 'anterior-posterior fraction');
  c = clampUnit(c, 'superior-inferior fraction');
  if (notes.length) flags.notes = notes;
  return { hemisphere, local: { a, b, c }, flags };
}

export function bvLocate(
  template: BrainVolumeTemplate,
  box: BvCellBox,
  digitCount: number,
): Located {
  const mid = {
    a: (box.a[0] + box.a[1]) / 2,
    b: (box.b[0] + box.b[1]) / 2,
    c: (box.c[0] + box.c[1]) / 2,
  };
  const flags: LocateFlags = { homology: 'exact' };
  if (digitCount > template.maxUsefulDigits) {
    flags.overPrecise = true;
    flags.notes = [
      `address carries ${digitCount} refinement digits but template ${template.id} only justifies ${template.maxUsefulDigits}`,
    ];
  }
  const lateralExtent = template.extents[box.hemisphere === 'L' ? 'left' : 'right'];
  // b and c are piecewise, so measure the cell's own span rather than assuming
  // a uniform scale. A cell straddling the AC plane uses both scales.
  const bSpan = Math.abs(
    unsplit(box.b[1], template.extents.posterior, template.extents.anterior) -
      unsplit(box.b[0], template.extents.posterior, template.extents.anterior),
  );
  const cSpan = Math.abs(
    unsplit(box.c[1], template.extents.inferior, template.extents.superior) -
      unsplit(box.c[0], template.extents.inferior, template.extents.superior),
  );
  return {
    pointMm: bvLocalToMm(template, box.hemisphere, mid),
    extentMm: [(box.a[1] - box.a[0]) * lateralExtent, bSpan, cSpan],
    // The three extents are measured along the template's own orthonormal
    // triad, in this order, so a BV cell is a true axis-aligned box in
    // millimetres — including across the midline, where only the sign of the
    // lateral offset changes.
    axesMm: [template.left, template.anterior, template.superior],
    templateId: template.id,
    flags,
  };
}
