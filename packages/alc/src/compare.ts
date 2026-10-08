/**
 * How to ask "are these two addresses the same place?"
 *
 * This module exists because the obvious answer is wrong. See §6 of the spec:
 * displace a point by a 5 mm registration residual and re-encode, and the two
 * address strings agree only 4% of the time — while the median distance
 * between the two decoded cells stays at 5.9 mm, the residual itself. The
 * addresses localise correctly; only the strings differ. Every discrete
 * geocode behaves this way, Open Location Code included.
 *
 * So:
 *   - `overlaps` is exact and cheap, and is the right question WITHIN one
 *     template: hierarchy cells are either nested or disjoint, never partial.
 *   - `samePlace` is the right question ACROSS subjects or templates. It
 *     compares geometry with an explicit tolerance and accounts for the cells'
 *     own extents, so the caller has to state what "same" means.
 *
 * Nothing here lets a caller compare addresses across subjects by equality
 * without having typed a tolerance.
 */

import { contains, parse } from './address.ts';
import { AlcError } from './codec.ts';
import { locate, type TemplateSet } from './locate.ts';
import type { Vec3 } from './types.ts';

/**
 * True when the two cells share any volume.
 *
 * Exact, and exact cheaply: in a hierarchy two cells are either nested or
 * disjoint, so overlap is containment in one direction or the other. Valid
 * within a single template. Across subjects, use `samePlace`.
 */
export function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

/** True when any cell of one covering overlaps any cell of the other. */
export function coveringsIntersect(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => overlaps(x, y)));
}

/** Cells of `a` that overlap something in `b`. */
export function coveringIntersection(a: readonly string[], b: readonly string[]): string[] {
  const out = new Set<string>();
  for (const x of a) {
    for (const y of b) {
      // The finer of two overlapping cells is the intersection.
      if (contains(x, y)) out.add(parse(y).canonical);
      else if (contains(y, x)) out.add(parse(x).canonical);
    }
  }
  return [...out].sort();
}

/** Half the diagonal of a cell: how far its centre can be from any point in it. */
function cellRadiusMm(extent: Vec3): number {
  return Math.hypot(extent[0], extent[1], extent[2]) / 2;
}

export interface SamePlaceResult {
  same: boolean;
  /** Distance between the two decoded cell centres, mm. */
  gapMm: number;
  /** Tolerance actually applied: the caller's tolerance plus both cell radii. */
  budgetMm: number;
  /** Cell radii, so a caller can see whether precision or residual dominates. */
  cellRadiiMm: [number, number];
  /** Anything the underlying `locate` calls flagged, e.g. over-precision. */
  notes: string[];
}

export interface SamePlaceOptions {
  /**
   * Expected registration residual between the two things being compared, mm.
   * There is no default on purpose: the right value depends on how the two
   * addresses were produced, and guessing it is how this gets used wrongly.
   */
  toleranceMm: number;
  /** Template for `a`. Defaults to `templates`. */
  templatesA?: TemplateSet;
  /** Template for `b`. Defaults to `templates`. */
  templatesB?: TemplateSet;
}

/**
 * The sanctioned cross-subject comparison.
 *
 * Decodes both addresses to cell centres in their own templates and asks
 * whether they are within `toleranceMm`, widened by each cell's own radius so
 * that a coarse address is not penalised for being coarse.
 *
 * The two addresses may come from different templates, which is the point:
 * this is how a finding mapped on an adult brain is compared with one mapped
 * on a child's.
 */
export function samePlace(
  a: string,
  b: string,
  templates: TemplateSet,
  options: SamePlaceOptions,
): SamePlaceResult {
  if (!Number.isFinite(options.toleranceMm) || options.toleranceMm < 0) {
    throw new AlcError('samePlace requires a non-negative toleranceMm', 'bad_tolerance');
  }
  const pa = parse(a);
  const pb = parse(b);
  if (pa.frame !== pb.frame) {
    throw new AlcError(
      `cannot compare across frames: ${pa.frame} and ${pb.frame} are different coordinate systems and their millimetres are not interchangeable`,
      'frame_mismatch',
    );
  }

  const la = locate(a, options.templatesA ?? templates);
  const lb = locate(b, options.templatesB ?? templates);

  const notes = [...(la.flags.notes ?? []), ...(lb.flags.notes ?? [])];
  if (la.flags.homology === 'absent' || lb.flags.homology === 'absent') {
    return {
      same: false,
      gapMm: NaN,
      budgetMm: NaN,
      cellRadiiMm: [NaN, NaN],
      notes: [...notes, 'at least one address names an anatomical level absent from its template'],
    };
  }

  const ra = cellRadiusMm(la.extentMm);
  const rb = cellRadiusMm(lb.extentMm);
  const gapMm = Math.hypot(
    la.pointMm[0] - lb.pointMm[0],
    la.pointMm[1] - lb.pointMm[1],
    la.pointMm[2] - lb.pointMm[2],
  );
  const budgetMm = options.toleranceMm + ra + rb;
  return { same: gapMm <= budgetMm, gapMm, budgetMm, cellRadiiMm: [ra, rb], notes };
}

/**
 * The deepest precision at which an address is worth displaying, given a
 * residual. One cell should be at least as large as the uncertainty it is
 * standing in for; printing finer digits than that advertises precision the
 * data does not have.
 */
export function recommendedDigits(
  address: string,
  templates: TemplateSet,
  residualMm: number,
): number {
  const a = parse(address);
  const maxDigits = a.frame === 'BR' ? 6 : 12;
  let best = 0;
  for (let d = 0; d <= maxDigits; d += 1) {
    const candidate = d === 0
      ? `${a.frame}-${a.anchors.join('-')}`
      : `${a.frame}-${a.anchors.join('-')}-${(a.digits + '0'.repeat(maxDigits)).slice(0, d)}`;
    let extent: Vec3;
    try {
      extent = locate(candidate, templates).extentMm;
    } catch {
      break;
    }
    const smallest = Math.min(extent[0], extent[1], extent[2]);
    if (!Number.isFinite(smallest) || smallest < residualMm) break;
    best = d;
  }
  return best;
}
