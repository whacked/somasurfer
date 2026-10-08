/**
 * Coverings: the set of addresses a structure or a finding occupies.
 *
 * A single address is a cell. Almost nothing in anatomy is a cell. A structure,
 * a lesion, a region of interest — each occupies a *set* of cells, and the
 * useful representation is the shortest set of address prefixes whose union is
 * that set. `normalizeCovering` in `address.ts` computes that reduction; this
 * module makes it a type with operations, because once coverings are the unit
 * of comparison the set algebra has to be exact.
 *
 * Why a type rather than `string[]`:
 *
 *  - The invariants are load-bearing. Cells must be canonical, disjoint, and
 *    maximally rolled up, or `coveringMeasureWithin` double-counts and
 *    `coveringIntersect` returns redundant cells. A bare array carries no
 *    promise that anyone normalised it.
 *  - Prefix range scans are the query primitive (see `query.ts`), and a scan
 *    plan is only correct over a disjoint cell set.
 *  - It is the place to put the comparison rule the spec insists on: across
 *    subjects, sameness is covering overlap with a stated tolerance, never
 *    string equality. `coveringsSamePlace` below makes the caller state it.
 *
 * Measure note, stated once and relied on throughout: `relativeMeasure` and
 * `coveringMeasureWithin` are measures in the *frame*, the dimensionless
 * domain, not in template millimetres. A cell's children are exactly equal
 * fractions of it by construction, so frame measure is exact, template
 * independent, and sums to 1 over any partition — which is what makes
 * `resolve()`'s fractions add up. Millimetre volume is a different quantity:
 * the `BD` radial coordinate is normalised, so the mm volume of a cell grows
 * with depth even though its frame measure does not. Anything that needs mm
 * volume must integrate against a template and must say which template.
 */

import { children, contains, normalizeCovering, parent, parse, type Address } from './address.ts';
import { AlcError } from './codec.ts';
import { samePlace, type SamePlaceResult } from './compare.ts';
import { encodeBody, encodeBrainVolume, locate, type TemplateSet } from './locate.ts';
import type { Vec3 } from './types.ts';

/**
 * A real runtime symbol, not a `declare const unique symbol`. The brand has to
 * survive type stripping, because `isCovering` is a runtime guard that the
 * database query path depends on — a type-only brand would strip to
 * `undefined` and the guard would reject everything.
 */
const COVERING_BRAND: unique symbol = Symbol('alc.covering');

/**
 * A normalised set of ALC cells.
 *
 * Invariants, established by the constructors and relied on by every operation:
 *  - every entry is a canonical address string;
 *  - no entry contains another (so the cells are pairwise disjoint);
 *  - no complete sibling group is present (it would have rolled up);
 *  - `cells` is sorted, so two equal coverings serialise identically.
 *
 * Construct one with `covering()` or a `coveringFrom*` helper. The brand exists
 * so a hand-built object literal cannot be passed in place of a normalised one.
 */
export interface Covering {
  readonly cells: readonly string[];
  /** Distinct frame ids present, sorted. A midline structure stays one frame; a structure addressed in both `BV` and `BR` spans two. */
  readonly frames: readonly string[];
  readonly [COVERING_BRAND]: true;
}

function makeCovering(cells: readonly string[]): Covering {
  const frames = [...new Set(cells.map((c) => c.slice(0, c.indexOf('-'))))].sort();
  return Object.freeze({
    cells: Object.freeze([...cells]),
    frames: Object.freeze(frames),
    [COVERING_BRAND]: true as const,
  });
}

export const EMPTY_COVERING: Covering = makeCovering([]);

/**
 * Build a covering from addresses, normalising as it goes.
 *
 * Input may be loose (`bd-t7-2o`), redundant, or overlapping; the result is
 * canonical, disjoint and rolled up. Invalid input throws rather than being
 * dropped: a silently shrunk covering is a silently wrong query.
 */
export function covering(inputs: readonly string[]): Covering {
  if (!Array.isArray(inputs)) throw new AlcError('covering() takes an array of addresses', 'bad_type');
  if (inputs.length === 0) return EMPTY_COVERING;
  return makeCovering(normalizeCovering(inputs));
}

/** True for a value produced by this module's constructors. */
export function isCovering(value: unknown): value is Covering {
  return typeof value === 'object' && value !== null && (value as Covering)[COVERING_BRAND] === true;
}

function requireCovering(c: Covering, what: string): Covering {
  if (!isCovering(c)) {
    throw new AlcError(
      `${what} must be a Covering built by covering() or a coveringFrom* helper, not a bare array`,
      'bad_covering',
    );
  }
  return c;
}

export function isEmptyCovering(c: Covering): boolean {
  return requireCovering(c, 'covering').cells.length === 0;
}

// ---------------------------------------------------------------------------
// Set algebra
// ---------------------------------------------------------------------------

export function coveringUnion(...parts: readonly Covering[]): Covering {
  const cells: string[] = [];
  for (const p of parts) cells.push(...requireCovering(p, 'covering').cells);
  return covering(cells);
}

/**
 * Exact intersection.
 *
 * Cells in a hierarchy are nested or disjoint, never partially overlapping, so
 * the intersection of two cells is the finer of the two when one contains the
 * other and empty otherwise. That makes the intersection of two unions exact
 * rather than approximate — the property `test/covering.test.ts` checks against
 * geometric overlap.
 */
export function coveringIntersect(a: Covering, b: Covering): Covering {
  requireCovering(a, 'first covering');
  requireCovering(b, 'second covering');
  if (a.cells.length === 0 || b.cells.length === 0) return EMPTY_COVERING;
  const out: string[] = [];
  for (const x of a.cells) {
    for (const y of b.cells) {
      if (contains(x, y)) out.push(y);
      else if (contains(y, x)) out.push(x);
    }
  }
  return covering(out);
}

/** True when the two coverings share any volume. Exact, and valid within one template. */
export function coveringsOverlap(a: Covering, b: Covering): boolean {
  requireCovering(a, 'first covering');
  requireCovering(b, 'second covering');
  for (const x of a.cells) {
    for (const y of b.cells) {
      if (contains(x, y) || contains(y, x)) return true;
    }
  }
  return false;
}

/** True when `address` lies inside the covering: some cell contains it, or it contains some cell. */
export function coveringOverlapsAddress(c: Covering, address: string): boolean {
  const canonical = parse(address).canonical;
  return requireCovering(c, 'covering').cells.some((x) => contains(x, canonical) || contains(canonical, x));
}

/** True when the covering wholly contains `address`: some single cell is an ancestor of it. */
export function coveringContains(c: Covering, address: string): boolean {
  const canonical = parse(address).canonical;
  return requireCovering(c, 'covering').cells.some((x) => contains(x, canonical));
}

// ---------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------

/**
 * Children per cell at each rung, memoised per frame and rung.
 *
 * Derived from `children()` rather than tabulated, so it cannot drift from the
 * hierarchy it is supposed to describe — `BD` branches 24 ways at the azimuth
 * rung and 8 ways per octree digit, `BV` 8, `BR` 16, and this reads those
 * numbers off the real implementation. `test/covering.test.ts` asserts the
 * agreement for every frame and rung.
 */
const BRANCHING = new Map<string, number>();

function branchingBelow(p: Address): number {
  const key = `${p.frame}:${p.level}`;
  const hit = BRANCHING.get(key);
  if (hit !== undefined) return hit;
  const n = children(p.canonical).length;
  BRANCHING.set(key, n);
  return n;
}

/**
 * Fraction of `outer`'s frame measure occupied by `inner`, exactly.
 *
 * Zero when `outer` does not contain `inner`. One when they are equal. See the
 * module header for why this is frame measure and not millimetres.
 */
export function relativeMeasure(outer: string, inner: string): number {
  const o = parse(outer);
  const i = parse(inner);
  if (!contains(o.canonical, i.canonical)) return 0;
  let m = 1;
  let cur: Address = i;
  // Bounded by the global digit cap, so this cannot spin on hostile input.
  for (let guard = 0; cur.canonical !== o.canonical; guard += 1) {
    if (guard > 64) throw new AlcError('address hierarchy deeper than the digit cap', 'bad_precision');
    const p = parent(cur.canonical);
    if (!p) return 0;
    const n = branchingBelow(p);
    if (n <= 0) throw new AlcError(`frame ${p.frame} reports no children below ${p.canonical}`, 'bad_frame');
    m /= n;
    cur = p;
  }
  return m;
}

/**
 * Fraction of the cell `outer` that the covering occupies, in frame measure.
 *
 * Exact, because a normalised covering's cells are disjoint: a cell of the
 * covering either swallows `outer` whole (fraction 1), sits inside it
 * (contributing its own relative measure), or misses it entirely.
 */
export function coveringMeasureWithin(c: Covering, outer: string): number {
  requireCovering(c, 'covering');
  const canonical = parse(outer).canonical;
  let total = 0;
  for (const cell of c.cells) {
    if (contains(cell, canonical)) return 1;
    total += relativeMeasure(canonical, cell);
  }
  // Disjoint cells cannot exceed the whole; clamp only to absorb float drift.
  return total > 1 ? 1 : total;
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

/**
 * Coarsen a covering to at most `maxDigits` refinement digits per cell.
 *
 * This is the display and aggregation primitive: a thousand 1 mm findings
 * become a handful of cells at the precision the registration residual
 * actually justifies (`recommendedDigits` picks that number). The result is a
 * superset of the input — coarsening can only add volume, never lose a cell —
 * and it is re-normalised, so complete sibling groups collapse further.
 */
export function coveringRollUp(c: Covering, maxDigits: number): Covering {
  requireCovering(c, 'covering');
  if (!Number.isInteger(maxDigits) || maxDigits < 0) {
    throw new AlcError(`coveringRollUp needs a non-negative integer digit count, got ${maxDigits}`, 'bad_precision');
  }
  const out: string[] = [];
  for (const cell of c.cells) {
    let cur = parse(cell);
    while (cur.digits.length > maxDigits) {
      const p = parent(cur.canonical);
      if (!p) break;
      cur = p;
    }
    out.push(cur.canonical);
  }
  return covering(out);
}

// ---------------------------------------------------------------------------
// Construction from geometry
// ---------------------------------------------------------------------------

/** How a cell sits relative to a geometric region. */
export type CellClassification = 'inside' | 'outside' | 'partial';

/**
 * A geometric region, expressed as a test on whole cells.
 *
 * `classify` must be conservative: return `partial` whenever it cannot prove
 * `inside` or `outside`. Claiming `outside` for a cell that does overlap loses
 * data silently, which is the one failure mode a covering must not have.
 */
export interface CellRegion {
  classify(address: string): CellClassification;
}

export interface RegionCoveringOptions {
  /** Cells to start the subdivision from. Use `bodyFrameRoots` / `brainVolumeFrameRoots`. */
  roots: readonly string[];
  /** Deepest refinement to subdivide to. */
  maxDigits: number;
  /**
   * What to do with a cell still `partial` at `maxDigits`.
   *
   * `include` (the default) keeps it, so the covering is a superset of the
   * region — the right choice for "what might be here?", and the only choice
   * that cannot lose a finding. `exclude` keeps only cells proven inside, for
   * the rarer "what is certainly here?".
   */
  onPartial?: 'include' | 'exclude';
  /** Hard cap on cells examined. Bounds the work an unlucky region can cause. */
  maxCells?: number;
}

/**
 * Build a covering by recursive subdivision against a geometric region.
 *
 * This is the path from a mesh, a segmentation mask or a sphere of interest to
 * an address set: classify the frame roots, keep what is wholly inside, discard
 * what is wholly outside, and subdivide the boundary until the refinement limit.
 * The output is normalised, so an exhausted boundary that happens to fill a
 * parent rolls back up.
 */
export function coveringFromRegion(region: CellRegion, options: RegionCoveringOptions): Covering {
  const { roots, maxDigits } = options;
  const onPartial = options.onPartial ?? 'include';
  const maxCells = options.maxCells ?? 200_000;
  if (!Number.isInteger(maxDigits) || maxDigits < 0) {
    throw new AlcError(`coveringFromRegion needs a non-negative integer maxDigits, got ${maxDigits}`, 'bad_precision');
  }
  const kept: string[] = [];
  const stack: string[] = roots.map((r) => parse(r).canonical);
  let examined = 0;

  while (stack.length > 0) {
    const cell = stack.pop()!;
    examined += 1;
    if (examined > maxCells) {
      throw new AlcError(
        `coveringFromRegion examined more than ${maxCells} cells; raise maxCells or lower maxDigits`,
        'covering_too_large',
      );
    }
    const verdict = region.classify(cell);
    if (verdict === 'outside') continue;
    if (verdict === 'inside') {
      kept.push(cell);
      continue;
    }
    const a = parse(cell);
    if (a.digits.length >= maxDigits) {
      if (onPartial === 'include') kept.push(cell);
      continue;
    }
    const kids = children(cell);
    if (kids.length === 0) {
      if (onPartial === 'include') kept.push(cell);
      continue;
    }
    for (const k of kids) stack.push(k.canonical);
  }
  return covering(kept);
}

/** Every `BD` level root a template actually realises. The starting point for a body-frame region scan. */
export function bodyFrameRoots(template: { slabs: readonly { label: string }[] }): string[] {
  return template.slabs.map((s) => parse(`BD-${s.label}`).canonical);
}

/** Both `BV` hemisphere roots. `x == 0` belongs to `L`, so a midline region legitimately spans both. */
export function brainVolumeFrameRoots(): string[] {
  return ['BV-L', 'BV-R'];
}

/**
 * A ball in template millimetres, as a cell region.
 *
 * A cell is approximated by its decoded centre and its own extent, which is
 * what `locate` reports. The classification is deliberately conservative: a
 * cell counts as `inside` only when centre distance plus the cell's own radius
 * fits inside the ball, and as `outside` only when centre distance minus that
 * radius clears it. `BD` cells are curved wedges rather than boxes, so the
 * bound is loose there and more cells land in `partial` — loose in the safe
 * direction.
 */
export function ballRegion(templates: TemplateSet, centreMm: Vec3, radiusMm: number): CellRegion {
  if (!Number.isFinite(radiusMm) || radiusMm < 0) {
    throw new AlcError(`ballRegion needs a non-negative finite radius, got ${radiusMm}`, 'bad_radius');
  }
  return {
    classify(address: string): CellClassification {
      const l = locate(address, templates);
      if (!Number.isFinite(l.pointMm[0])) return 'outside'; // level absent from this template
      const d = Math.hypot(
        l.pointMm[0] - centreMm[0],
        l.pointMm[1] - centreMm[1],
        l.pointMm[2] - centreMm[2],
      );
      const cellRadius = Math.hypot(l.extentMm[0], l.extentMm[1], l.extentMm[2]) / 2;
      if (d + cellRadius <= radiusMm) return 'inside';
      if (d - cellRadius >= radiusMm) return 'outside';
      return 'partial';
    },
  };
}

export interface PointCoveringResult {
  covering: Covering;
  /** Points whose encoding had to clamp — outside the modelled surface, or past an end of the column. */
  clampedPoints: number;
  /** Notes from the underlying encoders, deduplicated. */
  notes: string[];
}

/**
 * Build a covering from millimetre points in a template: the path from a voxel
 * mask or a point cloud.
 *
 * Clamped points are counted rather than dropped or silently accepted. A
 * segmentation that reaches outside the modelled body surface is a real
 * condition the caller needs to see, not something for this function to decide.
 */
export function coveringFromPointsMm(
  templates: TemplateSet,
  frame: 'BD' | 'BV',
  pointsMm: readonly Vec3[],
  digits: number,
): PointCoveringResult {
  if (!Number.isInteger(digits) || digits < 0) {
    throw new AlcError(`coveringFromPointsMm needs a non-negative integer digit count, got ${digits}`, 'bad_precision');
  }
  const cells: string[] = [];
  const notes = new Set<string>();
  let clampedPoints = 0;

  for (const p of pointsMm) {
    let address: string;
    let flags: { clamped?: boolean; notes?: string[] };
    if (frame === 'BD') {
      if (!templates.body) throw new AlcError('no body template supplied', 'no_template');
      ({ address, flags } = encodeBody(templates.body, p, digits));
    } else if (frame === 'BV') {
      if (!templates.brainVolume) throw new AlcError('no brain volume template supplied', 'no_template');
      ({ address, flags } = encodeBrainVolume(templates.brainVolume, p, digits));
    } else {
      throw new AlcError(`frame ${frame} cannot encode millimetre points`, 'unknown_frame');
    }
    if (flags.clamped) clampedPoints += 1;
    for (const n of flags.notes ?? []) notes.add(n);
    cells.push(address);
  }
  return { covering: covering(cells), clampedPoints, notes: [...notes] };
}

// ---------------------------------------------------------------------------
// The sanctioned cross-subject comparison, at covering scale
// ---------------------------------------------------------------------------

/**
 * Which regime a sameness question is being asked in. The caller has to pick,
 * and neither option has a default tolerance.
 *
 * Within one template, cells are nested or disjoint and overlap is exact, so no
 * tolerance exists to state. Across subjects or templates, a registration
 * residual stands between the two coverings and the caller must say how big it
 * is — because the measured answer is that at a 5 mm residual and 3 digits,
 * address strings agree only 4% of the time while the decoded cells stay 5.9 mm
 * apart, i.e. exactly the residual. The strings disagree; the places do not.
 * Any API that let a caller skip that number would be inviting the 4% answer.
 */
export type SamenessRegime =
  | { readonly within: 'template' }
  | {
      readonly across: 'subjects';
      /** Registration residual between the two coverings, mm. No default, on purpose. */
      readonly toleranceMm: number;
      readonly templatesA: TemplateSet;
      readonly templatesB: TemplateSet;
    };

export interface CoveringSamePlaceResult {
  same: boolean;
  /** `exact` for the within-template regime, `tolerance` for the cross-subject one. */
  basis: 'exact' | 'tolerance';
  /** Cells shared outright. Non-empty only when the two coverings literally overlap. */
  shared: Covering;
  /** Closest pair found in the cross-subject regime, for a caller that wants to show the margin. */
  closest?: SamePlaceResult & { a: string; b: string };
  notes: string[];
}

/**
 * Do these two coverings refer to the same place?
 *
 * The only sanctioned way to ask across subjects. There is no exported
 * equality predicate on addresses and no tolerance default anywhere: a caller
 * reaches an answer by naming the regime, and in the cross-subject regime by
 * naming the residual.
 */
export function coveringsSamePlace(
  a: Covering,
  b: Covering,
  regime: SamenessRegime,
): CoveringSamePlaceResult {
  requireCovering(a, 'first covering');
  requireCovering(b, 'second covering');

  if ('within' in regime) {
    const shared = coveringIntersect(a, b);
    return {
      same: shared.cells.length > 0,
      basis: 'exact',
      shared,
      notes: shared.cells.length > 0
        ? []
        : ['no shared cells; within one template that is a definitive no, across subjects it is not'],
    };
  }

  if (!('across' in regime) || regime.across !== 'subjects') {
    throw new AlcError(
      'coveringsSamePlace needs a regime: { within: "template" } or { across: "subjects", toleranceMm, templatesA, templatesB }',
      'bad_regime',
    );
  }
  if (typeof regime.toleranceMm !== 'number' || !Number.isFinite(regime.toleranceMm) || regime.toleranceMm < 0) {
    throw new AlcError(
      'comparing coverings across subjects requires an explicit non-negative finite toleranceMm',
      'bad_tolerance',
    );
  }

  const shared = coveringIntersect(a, b);
  const notes: string[] = [];
  let closest: (SamePlaceResult & { a: string; b: string }) | undefined;

  for (const x of a.cells) {
    for (const y of b.cells) {
      if (parse(x).frame !== parse(y).frame) continue;
      const r = samePlace(x, y, regime.templatesA, {
        toleranceMm: regime.toleranceMm,
        templatesA: regime.templatesA,
        templatesB: regime.templatesB,
      });
      for (const n of r.notes) if (!notes.includes(n)) notes.push(n);
      if (!Number.isFinite(r.gapMm)) continue;
      if (!closest || r.gapMm < closest.gapMm) closest = { ...r, a: x, b: y };
    }
  }

  if (!closest) {
    return {
      same: false,
      basis: 'tolerance',
      shared,
      notes: [...notes, 'no comparable cell pair: the coverings share no frame, or their levels are absent from these templates'],
    };
  }
  return { same: closest.same, basis: 'tolerance', shared, closest, notes };
}
