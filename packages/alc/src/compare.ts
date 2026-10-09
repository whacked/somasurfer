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

import { FRAMES, contains, parse } from './address.ts';
import { AlcError, MAX_DIGITS } from './codec.ts';
import { locate, type TemplateSet } from './locate.ts';
import type { Located, Vec3 } from './types.ts';

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

/**
 * True when any cell of one covering overlaps any cell of the other.
 *
 * **Superseded by `coveringsOverlap` in `covering.ts`.** This version takes bare
 * string arrays, so it cannot promise its inputs were normalised — overlapping
 * or redundant cells in either argument still give the right boolean here, but
 * the same arrays passed to a measure or a scan would double-count. Prefer the
 * `Covering` type, which carries that guarantee.
 *
 * Note the one-character gap between this name and `coveringIntersect`, the
 * `Covering`-typed intersection. Renaming these is a small mechanical change
 * but touches the conformance suite, so it is left for whoever next edits that
 * suite deliberately.
 */
export function coveringsIntersect(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => overlaps(x, y)));
}

/**
 * Cells of `a` that overlap something in `b`.
 *
 * **Superseded by `coveringIntersect` in `covering.ts`**, which normalises its
 * result. This one can return a cell alongside its own ancestor when `a`
 * contains both, because a bare array was never required to be disjoint.
 */
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

/**
 * Half the diagonal of a cell: how far its centre can be from any point in it,
 * in the worst direction.
 *
 * Reported as a cell size, which is all it is good for. It is NOT a budget: the
 * diagonal is the cell's reach along its *longest* axis, and a cell is
 * anisotropic — 3.4x between longest and shortest in `BV`, up to 5.3x in `BD`
 * at five digits. Charging a diagonal against a gap measured along one
 * direction overstates the reach by that factor, which is how two disjoint
 * cells came to compare equal (QA-12). Use `cellReachMm`.
 */
function cellRadiusMm(extent: Vec3): number {
  return Math.hypot(extent[0], extent[1], extent[2]) / 2;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * How far a cell reaches from its own centre along `direction`: its half-extent
 * projected onto that direction, axis by axis.
 *
 * This is the support function of the cell's box, so `gap - reachA - reachB` is
 * how far apart the two boxes are along that one direction — the
 * box-against-box test, rather than two spheres big enough to contain the
 * boxes. Exact for `BV`, where a cell really is an axis-aligned box in
 * millimetres; for `BD` the azimuthal axis turns across the cell, so it is an
 * approximation there and `samePlace` does not rely on it for the one answer
 * that has to be exact.
 */
function cellReachMm(cell: Located, direction: Vec3): number {
  let reach = 0;
  for (let i = 0; i < 3; i += 1) {
    reach += (cell.extentMm[i] / 2) * Math.abs(dot(cell.axesMm[i], direction));
  }
  return reach;
}

/**
 * How far apart two cells are along one orthonormal triad: the per-axis gaps
 * between their projections, combined in quadrature.
 *
 * This is a true lower bound on the distance between the cells whatever the
 * triad, because for any points p and q of the two cells and any unit axis u,
 * |(p-q)·u| is at least that axis' gap, and the triad is orthonormal — so the
 * squares add. When both cells are boxes aligned to the triad it is not a bound
 * but the distance itself. Two cells of one `BV` template always are; two `BD`
 * cells in the same level and sector are.
 */
function separationAlongTriadMm(
  a: Located,
  b: Located,
  delta: Vec3,
  triad: readonly [Vec3, Vec3, Vec3],
): number {
  let sumOfSquares = 0;
  for (const axis of triad) {
    const gap = Math.abs(dot(delta, axis)) - cellReachMm(a, axis) - cellReachMm(b, axis);
    if (gap > 0) sumOfSquares += gap * gap;
  }
  return Math.sqrt(sumOfSquares);
}

export interface SamePlaceResult {
  same: boolean;
  /** Distance between the two decoded cell centres, mm. */
  gapMm: number;
  /**
   * The centre gap the tolerance had to cover: the caller's tolerance plus what
   * each cell's own extent reaches along the line between the two centres.
   *
   * This is the one-direction view, and it is what to show a user next to
   * `gapMm`. It is not the whole test: `separationMm` also measures the cells
   * along their own axes, which can only ever find them further apart, so
   * `gapMm <= budgetMm` is necessary for `same` but not sufficient.
   */
  budgetMm: number;
  /**
   * How far apart the two cells themselves are, mm — not their centres. Zero
   * when they touch or overlap. This is the quantity the tolerance is compared
   * against: `same` is `separationMm <= toleranceMm`, except that two disjoint
   * cells of one template are never the same place at a tolerance of zero.
   */
  separationMm: number;
  /**
   * What each cell contributed to `budgetMm`: its half-extent projected onto
   * the direction the two centres are separated along.
   */
  reachMm: [number, number];
  /**
   * Cell radii — half-diagonals — so a caller can see whether precision or
   * residual dominates. A cell size, not the budget; see `cellReachMm`.
   */
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
 * Decodes both addresses to cells in their own templates and asks whether the
 * two cells come within `toleranceMm` of each other — each widened by its own
 * extent along the direction they are separated along, so that a coarse address
 * is not penalised for being coarse and a fine one is not credited with reach
 * it does not have.
 *
 * At `toleranceMm: 0` within one template this is exactly "do these two cells
 * share a millimetre point", so two disjoint cells are never the same place
 * however coarse they are.
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
  // 'variant' is as unlocatable as 'absent' — both return NaN millimetres —
  // so both must stop this answering rather than produce a gap of NaN.
  const unplaced = (h?: string): boolean => h === 'absent' || h === 'variant';
  if (unplaced(la.flags.homology) || unplaced(lb.flags.homology)) {
    return {
      same: false,
      gapMm: NaN,
      budgetMm: NaN,
      separationMm: NaN,
      reachMm: [NaN, NaN],
      cellRadiiMm: [NaN, NaN],
      notes: [...notes, 'at least one address names an anatomical level absent from its template'],
    };
  }

  const delta: Vec3 = [
    la.pointMm[0] - lb.pointMm[0],
    la.pointMm[1] - lb.pointMm[1],
    la.pointMm[2] - lb.pointMm[2],
  ];
  const gapMm = Math.hypot(delta[0], delta[1], delta[2]);
  // Coincident centres have no separation direction, and need none: nothing has
  // to be widened to bridge a gap of zero.
  const direction: Vec3 = gapMm > 0
    ? [delta[0] / gapMm, delta[1] / gapMm, delta[2] / gapMm]
    : [0, 0, 0];
  const reachA = cellReachMm(la, direction);
  const reachB = cellReachMm(lb, direction);
  const budgetMm = options.toleranceMm + reachA + reachB;
  // Three valid lower bounds on the distance between the two cells; the largest
  // is the tightest, and every one of them beats the half-diagonal the budget
  // used to be built from. The first is the separation along the line between
  // the centres, which is the direction a caller sees; the other two measure
  // the cells along their own axes, which is what finds two cells that are far
  // apart along one axis while their centre-to-centre line runs diagonally
  // through both — `BV-L-44` and `BV-R` are 51.0 mm apart, and the
  // centre-direction test alone would have called it 7.4 mm.
  const separationMm = Math.max(
    Math.max(0, gapMm - reachA - reachB),
    separationAlongTriadMm(la, lb, delta, la.axesMm),
    separationAlongTriadMm(la, lb, delta, lb.axesMm),
  );

  // Where the two addresses resolve in the same template, the frame answers
  // this exactly and no millimetre arithmetic can improve on it: hierarchy
  // cells are nested or disjoint, so two disjoint cells share no point at all
  // and only a positive tolerance can bridge them. That case is not a corner —
  // adjacent siblings have a gap that equals their reaches to the last bit
  // (`BV-L` and `BV-R` are 68.0 mm apart and reach 34.0 mm each), so leaving it
  // to `<=` on two floats would decide the commonest comparison in the library
  // by rounding.
  //
  // One exception, and it is the honest one: a folded template is not a
  // partition where it folds, so two disjoint cells there really can denote the
  // same millimetres. `locate` has already said so, and the geometry stands on
  // its own.
  const folded = la.flags.folded === true || lb.flags.folded === true;
  const disjointCells = la.templateId === lb.templateId && !folded && !overlaps(a, b);
  let same = separationMm <= options.toleranceMm;
  if (same && disjointCells && options.toleranceMm === 0) {
    same = false;
    notes.push(
      'these are disjoint cells of one template, so they share no millimetre point: '
        + 'at toleranceMm 0 that is a definitive no, however close their millimetres come',
    );
  }
  return {
    same,
    gapMm,
    budgetMm,
    separationMm,
    reachMm: [reachA, reachB],
    cellRadiiMm: [cellRadiusMm(la.extentMm), cellRadiusMm(lb.extentMm)],
    notes,
  };
}

/** Which of the three ceilings on a recommended precision is the binding one. */
export type PrecisionLimit = 'residual' | 'template' | 'frame';

/**
 * The answer to "how many digits should I display?", with the reason attached.
 *
 * The reason is not decoration. A UI that is told 4 digits and nothing else
 * cannot tell "collect better data and you may print more" from "this template
 * will never justify more, whatever you measure" — and those call for opposite
 * things from the user.
 */
export interface RecommendedPrecision {
  /**
   * Refinement digits to display. Always a precision this frame can express and
   * this template can justify, so `locate()` on the truncated address never
   * raises `flags.overPrecise`.
   */
  readonly digits: number;
  /** Which ceiling bound `digits`: the caller's residual, the template, or the frame. */
  readonly limitedBy: PrecisionLimit;
  /** The template that answered. */
  readonly templateId: string;
  /** That template's own ceiling, for display next to the recommendation. */
  readonly maxUsefulDigits: number;
  /** The frame's hard ceiling, from its descriptor rather than a local constant. */
  readonly frameMaxDigits: number;
  /** One sentence naming the binding constraint, safe to show a user. */
  readonly notes: readonly string[];
}

/** The template that answers for a frame, or undefined for a frame with none. */
function templateFor(frame: string, templates: TemplateSet): { maxUsefulDigits: number } | undefined {
  if (frame === 'BD') return templates.body;
  if (frame === 'BV') return templates.brainVolume;
  return undefined;
}

/**
 * The deepest precision at which an address is worth displaying, given a
 * residual, and what stops it going deeper.
 *
 * Three ceilings apply, and the recommendation is the lowest of them:
 *
 *   residual  one cell should be at least as large as the uncertainty it stands
 *             in for; finer digits advertise precision the data does not have
 *   template  `maxUsefulDigits` — past it `locate()` raises `flags.overPrecise`,
 *             so recommending it would be recommending a flag
 *   frame     the frame descriptor's own digit range, floor as well as ceiling
 *
 * Only the first was applied before (QA-3). The function compared cell extent
 * against the residual and never consulted the template, so it answered 8 for a
 * template justifying 5 — the one API a UI would ask was the one that routed
 * around spec §9's honesty flag, 32 552 times over the fuzz corpus. The frame
 * floor was missing too (QA-11): `BR` needs at least one digit, and a `BR`
 * address got the recommendation 0, which is not an address.
 *
 * A frame or template that cannot be located at the frame's *minimum* precision
 * raises rather than returning a number: `locate()`'s own `no_template` or
 * `frame_disabled`. There is no honest recommendation to make about a frame the
 * library cannot place in millimetres, and 0 was being read as one.
 */
export function recommendedPrecision(
  address: string,
  templates: TemplateSet,
  residualMm: number,
): RecommendedPrecision {
  const a = parse(address);
  const descriptor = FRAMES[a.frame];
  // A NaN residual would make every "is the cell smaller than the residual?"
  // test false and so recommend the deepest precision the template allows —
  // the maximum confidence, from the absence of information.
  if (typeof residualMm !== 'number' || !(residualMm >= 0) || residualMm === Infinity) {
    throw new AlcError(
      `residualMm must be a finite, non-negative number of millimetres, got ${residualMm}`,
      'bad_residual',
    );
  }

  const frameMaxDigits = Math.min(MAX_DIGITS, descriptor.maxDigits);
  const floor = descriptor.minDigits;
  const stem = `${a.frame}-${a.anchors.join('-')}`;
  const at = (d: number): string =>
    (d === 0 ? stem : `${stem}-${(a.digits + '0'.repeat(frameMaxDigits)).slice(0, d)}`);

  // Deliberately unguarded: if the frame's minimum precision cannot be located,
  // the caller gets locate()'s error rather than a number they cannot use.
  const atFloor = locate(at(floor), templates);
  const maxUsefulDigits = templateFor(a.frame, templates)?.maxUsefulDigits ?? frameMaxDigits;

  const notes: string[] = [];
  let digits = floor;
  let limitedBy: PrecisionLimit = 'frame';
  let bound = false;

  for (let d = floor; d <= frameMaxDigits && !bound; d += 1) {
    let l: Located;
    try {
      l = d === floor ? atFloor : locate(at(d), templates);
    } catch (e) {
      // The grammar will not carry digits at this depth — a `BD` address with
      // no azimuth segment, for instance, has to gain one before it can refine.
      limitedBy = 'frame';
      notes.push(
        `frame ${a.frame} cannot express ${d} refinement digits on ${a.canonical}: ${(e as Error).message}`,
      );
      bound = true;
      break;
    }

    // The template's ceiling, read from the flag the library itself raises, so
    // the two cannot drift: whatever `locate()` calls over-precise is not
    // something this function may recommend.
    if (l.flags.overPrecise) {
      limitedBy = 'template';
      notes.push(
        `template ${l.templateId} justifies at most ${maxUsefulDigits} refinement digits, and `
        + `locate() flags anything finer as over-precise, so the recommendation is clamped there `
        + `and not to what a ${residualMm} mm residual alone would allow`,
      );
      bound = true;
      break;
    }

    const smallestMm = Math.min(l.extentMm[0], l.extentMm[1], l.extentMm[2]);
    if (!Number.isFinite(smallestMm)) {
      // An anchor this template does not realise has no millimetre extent, so
      // no precision is justified in it at all. The template binds, and the
      // note says what would change that.
      limitedBy = 'template';
      notes.push(
        `template ${l.templateId} does not realise ${a.anchors.join('-')} (homology `
        + `'${l.flags.homology ?? 'unknown'}'), so this cell has no millimetre extent and no `
        + 'refinement is justified; a registration-supplied level mapping is what would change that',
      );
      bound = true;
      break;
    }

    if (smallestMm < residualMm) {
      if (d === floor) {
        // Both ceilings bind at once, and the frame's is the one the caller
        // cannot do anything about, so it is the one reported.
        limitedBy = 'frame';
        notes.push(
          `${floor} digit${floor === 1 ? '' : 's'} is the coarsest precision frame ${a.frame} can `
          + `express, and that cell is already ${smallestMm.toFixed(2)} mm across its smallest axis `
          + `— finer than the ${residualMm} mm residual, which no legal address here can respect`,
        );
      } else {
        limitedBy = 'residual';
        notes.push(
          `a ${residualMm} mm residual is larger than a cell at ${d} digits `
          + `(${smallestMm.toFixed(2)} mm across its smallest axis), so ${digits} digits is the `
          + `deepest precision the data supports; template ${l.templateId} would justify `
          + `${maxUsefulDigits}`,
        );
      }
      bound = true;
      break;
    }
    digits = d;
  }

  if (!bound) {
    limitedBy = 'frame';
    notes.push(
      `frame ${a.frame}'s ceiling of ${frameMaxDigits} refinement digits binds before the `
      + `${residualMm} mm residual or template ${atFloor.templateId} does`,
    );
  }

  return Object.freeze({
    digits,
    limitedBy,
    templateId: atFloor.templateId,
    maxUsefulDigits,
    frameMaxDigits,
    notes: Object.freeze(notes),
  });
}

/**
 * The deepest precision at which an address is worth displaying, given a
 * residual, as a bare number.
 *
 * Identical to `recommendedPrecision(...).digits`. Use that one where the
 * reason matters — which is most places a UI makes this call.
 */
export function recommendedDigits(
  address: string,
  templates: TemplateSet,
  residualMm: number,
): number {
  return recommendedPrecision(address, templates, residualMm).digits;
}
