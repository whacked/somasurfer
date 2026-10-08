/**
 * Prefix range scans: the query primitive for coverings.
 *
 * Truncating an ALC address yields its ancestor, so containment is a string
 * prefix test, so "everything inside this cell" is one half-open range scan on
 * an ordinary B-tree index over the address column. That is the whole reason
 * the grammar is fixed-width and canonical-uppercase. No recursive CTE, no
 * materialised path table, no GiST index.
 *
 * Two rules, both of which this module enforces rather than documents.
 *
 * **1. Scans are parameterised, never interpolated.** Addresses arrive from
 * URLs, pasted text and imported datasets (spec §10). `renderScan` emits only
 * placeholders and returns the values separately; the column name is validated
 * as an identifier against a strict pattern because it is the one part of a
 * query that cannot be a bind parameter. `test/query.test.ts` asserts that no
 * value reaches the SQL text, and scans this package's own source for an
 * interpolated query path.
 *
 * **2. The range scan needs binary collation.** This is the bug that survives
 * CI. A prefix range depends on `-` (0x2D) sorting below every alphanumeric
 * character, which is true of C/byte ordering and *not* true of ICU or most
 * locale collations, which treat punctuation as ignorable at the primary
 * level. Under `en_US.UTF-8`, `BD-T07-02O` and `BDT0702O` compare equal at the
 * first level and the bounds stop meaning what they say — a scan that returns
 * subtly wrong rows and never errors. So every rendered comparison carries an
 * explicit binary collation for its dialect, and the stored column should be
 * declared that way too.
 */

import { ancestors, parse } from './address.ts';
import { AlcError, CHECK_ALPHABET } from './codec.ts';
import { isCovering, type Covering } from './covering.ts';

/** A half-open range `[lower, upperExclusive)` over canonical address strings. */
export interface PrefixRange {
  readonly lower: string;
  readonly upperExclusive: string;
}

/**
 * The half-open range containing exactly an address and its descendants.
 *
 * The upper bound increments the last character of the canonical form. That is
 * sound because of three facts about the grammar, not by luck:
 *
 *  - every descendant is the canonical form plus a suffix beginning with `-`,
 *    so it sorts above the lower bound;
 *  - a descendant differs from the upper bound at the last position of the
 *    prefix, where it is one lower, so it sorts below it;
 *  - nothing else can land in between: a canonical address inside the range
 *    must agree with the prefix on every character of it, and the only
 *    canonical strings that extend a canonical address are its descendants.
 *
 * `BD-T07` therefore scans as `[BD-T07, BD-T08)`, which contains `BD-T07`,
 * `BD-T07-02O` and `BD-T07-02O-5316` but not `BD-T08` or `BD-T070` — the
 * latter not being a canonical address at all, since a level anchor is always
 * a letter and exactly two digits.
 */
export function prefixRange(address: string): PrefixRange {
  const lower = parse(address).canonical;
  const last = lower.charCodeAt(lower.length - 1);
  // Defence in depth: the bound arithmetic assumes a single-byte ASCII tail
  // drawn from the canonical alphabet. parse() guarantees that today; assert it
  // so extending the alphabet (which already requires a spec version bump)
  // cannot quietly break the scan bounds.
  if (!CHECK_ALPHABET.includes(lower[lower.length - 1]) || last >= 0x7e) {
    throw new AlcError(
      `cannot build a prefix range for ${JSON.stringify(lower)}: it ends outside the canonical ASCII alphabet`,
      'bad_range',
    );
  }
  return Object.freeze({
    lower,
    upperExclusive: lower.slice(0, -1) + String.fromCharCode(last + 1),
  });
}

/**
 * A scan to run against an address column.
 *
 * `ranges` are half-open prefix ranges; `exact` are individual keys to match.
 * A row matches the plan when it falls in any range or equals any exact key.
 */
export interface ScanPlan {
  readonly ranges: readonly PrefixRange[];
  readonly exact: readonly string[];
}

function makePlan(ranges: readonly PrefixRange[], exact: readonly string[]): ScanPlan {
  return Object.freeze({
    ranges: Object.freeze([...ranges]),
    exact: Object.freeze([...new Set(exact)].sort()),
  });
}

export const EMPTY_SCAN: ScanPlan = makePlan([], []);

/** Rows at or below `address`: one range scan. */
export function descendantScan(address: string): ScanPlan {
  return makePlan([prefixRange(address)], []);
}

/**
 * Rows strictly above `address`: its ancestors, as exact keys.
 *
 * Ancestors are a short, enumerable chain — at most the digit cap plus the
 * anchor rungs — so they are exact keys rather than a range. There is no range
 * that selects ancestors without also selecting unrelated cells.
 */
export function ancestorScan(address: string): ScanPlan {
  return makePlan([], ancestors(address).map((a) => a.canonical));
}

/**
 * Every stored row whose cell overlaps `address`, in either direction.
 *
 * This is the containment query: a finding filed at `BD-T07-02O-5316` must be
 * found by a search for `BD-T07`, and a structure covering filed at `BD-T07`
 * must be found by a search for `BD-T07-02O-5316`. Hierarchy cells are nested
 * or disjoint, so "overlaps" is exactly "is an ancestor or a descendant".
 */
export function overlapScan(address: string): ScanPlan {
  return makePlan([prefixRange(address)], ancestors(address).map((a) => a.canonical));
}

/** Every stored row overlapping any cell of a covering. */
export function coveringScan(c: Covering): ScanPlan {
  if (!isCovering(c)) {
    throw new AlcError('coveringScan takes a Covering built by covering()', 'bad_covering');
  }
  const ranges: PrefixRange[] = [];
  const exact: string[] = [];
  for (const cell of c.cells) {
    ranges.push(prefixRange(cell));
    for (const a of ancestors(cell)) exact.push(a.canonical);
  }
  // A cell's own range already covers any ancestor key that is itself inside
  // another cell of the covering; harmless duplication, and cheaper to leave.
  return makePlan(ranges, exact);
}

// ---------------------------------------------------------------------------
// Rendering to a parameterised query
// ---------------------------------------------------------------------------

export type SqlDialect = 'postgres' | 'sqlite' | 'mysql';

const DIALECTS: Record<SqlDialect, { placeholder: (i: number) => string; collate: string; quote: (id: string) => string }> = {
  postgres: { placeholder: (i) => `$${i + 1}`, collate: ' COLLATE "C"', quote: (id) => `"${id}"` },
  sqlite: { placeholder: () => '?', collate: ' COLLATE BINARY', quote: (id) => `"${id}"` },
  mysql: { placeholder: () => '?', collate: ' COLLATE utf8mb4_bin', quote: (id) => `\`${id}\`` },
};

/**
 * A column reference: an unqualified name, or `table.column`. Validated against
 * this pattern and nothing else, because a column name is the one part of a
 * query that cannot be a bind parameter. Anything that is not plainly an
 * identifier is rejected rather than escaped.
 */
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}(\.[A-Za-z_][A-Za-z0-9_]{0,62})?$/;

export interface RenderOptions {
  /** Address column to scan. Must be a plain identifier or `table.column`. */
  column: string;
  dialect?: SqlDialect;
  /**
   * Omit the explicit binary collation. Only safe when the column is already
   * declared with a byte-ordered collation, which is the recommended schema.
   * Leaving the collation in costs nothing and removes a whole class of silent
   * wrong-answer bug, so the default is to emit it.
   */
  omitCollate?: boolean;
}

/** SQL text plus the values it binds. The text never contains a value. */
export interface ParameterisedQuery {
  readonly text: string;
  readonly params: readonly string[];
}

/**
 * Render a scan plan as a parameterised predicate.
 *
 * Returns a bare boolean expression — not a whole statement — so it composes
 * into whatever query the caller already has. Every address value is a bind
 * parameter; the only caller-supplied text that reaches the SQL is the column
 * name, and that is validated as an identifier first.
 *
 * An empty plan renders as `FALSE`, not as the empty string: a predicate that
 * disappears turns "nothing matches" into "everything matches", which is how
 * an empty covering becomes a full table scan with the wrong result.
 */
export function renderScan(plan: ScanPlan, options: RenderOptions): ParameterisedQuery {
  const dialect = options.dialect ?? 'postgres';
  const spec = DIALECTS[dialect];
  if (!spec) throw new AlcError(`unknown SQL dialect ${JSON.stringify(dialect)}`, 'bad_dialect');
  if (typeof options.column !== 'string' || !COLUMN_RE.test(options.column)) {
    throw new AlcError(
      `column must be a plain SQL identifier or table.column, got ${JSON.stringify(options.column)}`,
      'bad_column',
    );
  }
  const col = options.column
    .split('.')
    .map((part) => spec.quote(part))
    .join('.');
  const collate = options.omitCollate ? '' : spec.collate;
  const ref = `${col}${collate}`;

  const params: string[] = [];
  const clauses: string[] = [];
  const bind = (value: string): string => {
    const text = spec.placeholder(params.length);
    params.push(value);
    return text;
  };

  for (const r of plan.ranges) {
    clauses.push(`(${ref} >= ${bind(r.lower)} AND ${ref} < ${bind(r.upperExclusive)})`);
  }
  if (plan.exact.length > 0) {
    const keys = plan.exact.map((k) => bind(k)).join(', ');
    clauses.push(`${ref} IN (${keys})`);
  }
  if (clauses.length === 0) return Object.freeze({ text: 'FALSE', params: Object.freeze([]) });
  return Object.freeze({
    text: clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`,
    params: Object.freeze(params),
  });
}

// ---------------------------------------------------------------------------
// The same primitive, in memory
// ---------------------------------------------------------------------------

/** Index of the first element of a sorted array that is >= `value`. */
function lowerBound(sorted: readonly string[], value: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Run a scan plan against a sorted array of canonical addresses.
 *
 * The in-memory analogue of the database scan, using the same bounds, so the
 * name index below queries the way callers' databases will. Returns matching
 * indices into `sorted`, ascending and deduplicated.
 */
export function scanSorted(sorted: readonly string[], plan: ScanPlan): number[] {
  const hits = new Set<number>();
  for (const r of plan.ranges) {
    for (let i = lowerBound(sorted, r.lower); i < sorted.length && sorted[i] < r.upperExclusive; i += 1) {
      hits.add(i);
    }
  }
  for (const key of plan.exact) {
    for (let i = lowerBound(sorted, key); i < sorted.length && sorted[i] === key; i += 1) hits.add(i);
  }
  return [...hits].sort((a, b) => a - b);
}
