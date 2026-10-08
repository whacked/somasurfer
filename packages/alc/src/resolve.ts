/**
 * Name resolution: address to ranked structure names, and back.
 *
 * The addressing scheme is purely geometric, and names are a separate,
 * separately versioned lookup layer. That separation is the point, not an
 * implementation detail:
 *
 *  - **An address never contains a parcellation name.** Nothing in `address.ts`
 *    or `codec.ts` can even see a name index — those modules do not import this
 *    one, and `test/surface.test.ts` asserts that they never will. So revising
 *    a parcellation, renaming a structure, or swapping HCP-MMP1 for AAL cannot
 *    invalidate an address that has already been issued, printed on a report or
 *    pasted into a URL.
 *  - **Resolution returns a ranked list with fractions, never a single name.** A
 *    cell generally overlaps several structures; `BD-T07-03O-531` is mostly
 *    lower lobe of left lung, partly 7th rib, partly intercostal muscle.
 *    Collapsing that to one winner is how an atlas starts lying.
 *  - **Every result pins the index version it came from.** Addresses are
 *    stable, names are not, so a stored resolution without a version is not
 *    reproducible.
 *
 * Fractions are frame measure — see the header of `covering.ts`. They are
 * exact, template independent, and sum to 1 over a partition of the queried
 * cell, which is what makes `unclaimedFraction` meaningful rather than
 * decorative.
 */

import { ancestors, contains, parse } from './address.ts';
import { AlcError } from './codec.ts';
import {
  covering,
  coveringIntersect,
  coveringMeasureWithin,
  coveringUnion,
  isCovering,
  relativeMeasure,
  EMPTY_COVERING,
  type Covering,
} from './covering.ts';
import { overlapScan, scanSorted } from './query.ts';

/** What a resolution names. The id is the ontology's, and never appears in an address. */
export interface StructureRef {
  readonly id: string;
  readonly name: string;
  /** Source ontology or parcellation, e.g. `UBERON`, `HCP-MMP1`. Informational. */
  readonly source?: string;
}

export interface NameIndexEntry extends StructureRef {
  /** Addresses this structure occupies. Normalised on index construction. */
  readonly cells: readonly string[];
}

export interface NameIndexInput {
  /**
   * Version of this name index. Opaque to the library and echoed into every
   * result. Required: an unversioned index produces unreproducible resolutions.
   */
  readonly version: string;
  readonly structures: readonly NameIndexEntry[];
}

export interface NameIndex {
  readonly version: string;
  readonly structures: readonly StructureRef[];
  /** Normalised covering per structure, parallel to `structures`. */
  readonly coverings: readonly Covering[];
}

interface IndexInternals {
  /** Every cell of every covering, sorted, so lookups are prefix range scans. */
  keys: string[];
  /** Owning structure index per entry of `keys`. */
  owners: number[];
  byId: Map<string, number>;
}

const INTERNALS = new WeakMap<NameIndex, IndexInternals>();

/**
 * Build a queryable name index.
 *
 * Validates every address up front and normalises every covering, because a
 * malformed cell discovered at query time is a wrong answer rather than an
 * error: the structure would quietly resolve as smaller than it is.
 */
export function buildNameIndex(input: NameIndexInput): NameIndex {
  if (typeof input?.version !== 'string' || input.version.trim() === '') {
    throw new AlcError('a name index must declare a non-empty version', 'bad_index_version');
  }
  if (!Array.isArray(input.structures)) {
    throw new AlcError('a name index needs a structures array', 'bad_name_index');
  }

  const structures: StructureRef[] = [];
  const coverings: Covering[] = [];
  const byId = new Map<string, number>();
  const keys: string[] = [];
  const owners: number[] = [];

  for (const entry of input.structures) {
    if (typeof entry?.id !== 'string' || entry.id === '') {
      throw new AlcError('every indexed structure needs a non-empty id', 'bad_structure');
    }
    if (byId.has(entry.id)) {
      throw new AlcError(`duplicate structure id ${JSON.stringify(entry.id)} in the name index`, 'duplicate_structure');
    }
    if (typeof entry.name !== 'string' || entry.name === '') {
      throw new AlcError(`structure ${entry.id} needs a non-empty name`, 'bad_structure');
    }
    // Throws on anything that is not a valid address, naming the structure.
    let c: Covering;
    try {
      c = covering(entry.cells ?? []);
    } catch (e) {
      throw new AlcError(
        `structure ${entry.id} has an invalid covering: ${(e as Error).message}`,
        'bad_structure_covering',
      );
    }
    const index = structures.length;
    byId.set(entry.id, index);
    structures.push(
      Object.freeze(entry.source === undefined
        ? { id: entry.id, name: entry.name }
        : { id: entry.id, name: entry.name, source: entry.source }),
    );
    coverings.push(c);
    for (const cell of c.cells) {
      keys.push(cell);
      owners.push(index);
    }
  }

  // Sort the flat cell list once; every lookup is then a binary search plus a
  // walk, which is the same shape as the database prefix scan in `query.ts`.
  const order = keys.map((_, i) => i).sort((x, y) => (keys[x] < keys[y] ? -1 : keys[x] > keys[y] ? 1 : 0));
  const sortedKeys = order.map((i) => keys[i]);
  const sortedOwners = order.map((i) => owners[i]);

  const index: NameIndex = Object.freeze({
    version: input.version,
    structures: Object.freeze(structures),
    coverings: Object.freeze(coverings),
  });
  INTERNALS.set(index, { keys: sortedKeys, owners: sortedOwners, byId });
  return index;
}

/**
 * The lookup tables for an index, keyed by identity in a `WeakMap`.
 *
 * This is also the guard: an object that merely has the right shape has no
 * entry here, so a hand-built literal is rejected rather than silently
 * resolving to nothing.
 */
function internals(index: NameIndex): IndexInternals {
  const got = INTERNALS.get(index);
  if (!got) throw new AlcError('not a name index built by buildNameIndex()', 'bad_name_index');
  return got;
}

export interface ResolvedStructure {
  readonly structure: StructureRef;
  /**
   * Fraction of the queried cell this structure occupies, in frame measure.
   * `1` means the structure wholly contains the cell.
   */
  readonly fraction: number;
}

export interface Resolution {
  /** Canonical form of the address that was asked about. */
  readonly address: string;
  /** The name index these names came from. Addresses outlive it. */
  readonly indexVersion: string;
  /** `frame`: dimensionless frame measure, not template millimetres. */
  readonly measure: 'frame';
  /** Structures overlapping the cell, ranked by fraction descending, then by id. */
  readonly matches: readonly ResolvedStructure[];
  /** Fraction of the cell no indexed structure claims. Zero when the index tiles it. */
  readonly unclaimedFraction: number;
  readonly notes: readonly string[];
}

export interface ResolveOptions {
  /** Drop matches below this fraction. Default 0, i.e. report everything that overlaps. */
  minFraction?: number;
  /** Keep at most this many matches after ranking. Default unlimited. */
  limit?: number;
}

/**
 * `address -> [{ structure, fraction }]`, ranked by containment fraction.
 *
 * Never a single name, and never without a version. A cell smaller than the
 * index's own resolution resolves to the containing structures at fraction 1;
 * a cell larger than them resolves to several partial fractions that sum to the
 * share of the cell the index accounts for.
 */
export function resolve(address: string, index: NameIndex, options: ResolveOptions = {}): Resolution {
  const a = parse(address);
  const { keys, owners } = internals(index);
  const minFraction = options.minFraction ?? 0;
  if (!Number.isFinite(minFraction) || minFraction < 0 || minFraction > 1) {
    throw new AlcError(`minFraction must be between 0 and 1, got ${minFraction}`, 'bad_fraction');
  }

  // Candidate structures come from the prefix range scan: cells at or below the
  // query, plus the ancestor keys above it.
  const candidates = new Set<number>();
  for (const i of scanSorted(keys, overlapScan(a.canonical))) candidates.add(owners[i]);

  const queryCovering = covering([a.canonical]);
  const matches: ResolvedStructure[] = [];
  const claimedParts: Covering[] = [];

  for (const s of candidates) {
    const overlap = coveringIntersect(index.coverings[s], queryCovering);
    if (overlap.cells.length === 0) continue;
    const fraction = coveringMeasureWithin(overlap, a.canonical);
    if (fraction <= 0) continue;
    claimedParts.push(overlap);
    if (fraction >= minFraction) matches.push({ structure: index.structures[s], fraction });
  }

  matches.sort((x, y) =>
    y.fraction - x.fraction || (x.structure.id < y.structure.id ? -1 : x.structure.id > y.structure.id ? 1 : 0),
  );
  const limited = options.limit === undefined ? matches : matches.slice(0, Math.max(0, options.limit));

  // Union before measuring, so structures that overlap each other are not
  // double-counted and `unclaimedFraction` cannot go negative.
  const claimed = claimedParts.length === 0 ? EMPTY_COVERING : coveringUnion(...claimedParts);
  const claimedFraction = claimedParts.length === 0 ? 0 : coveringMeasureWithin(claimed, a.canonical);

  const notes: string[] = [];
  if (candidates.size === 0) {
    notes.push(`no structure in name index ${index.version} overlaps ${a.canonical}`);
  }
  if (a.experimental) {
    notes.push(`frame ${a.frame} is experimental in v1; its name coverage is incomplete by construction`);
  }

  return Object.freeze({
    address: a.canonical,
    indexVersion: index.version,
    measure: 'frame' as const,
    matches: Object.freeze(limited),
    unclaimedFraction: Math.max(0, 1 - claimedFraction),
    notes: Object.freeze(notes),
  });
}

/**
 * The frame root of an address: its coarsest valid ancestor. `BD-T07-02O-5316`
 * roots at `BD-T07`, `BV-L-471` at `BV-L`. Used as the denominator when a
 * covering spans cells at different depths.
 */
export function frameRootOf(address: string): string {
  const chain = ancestors(address);
  return chain.length > 0 ? chain[0].canonical : parse(address).canonical;
}

/**
 * Total measure of a covering, in units of frame roots.
 *
 * Each cell contributes its measure relative to its own frame root, so a
 * covering of two whole `BD` levels measures 2 and a covering of one `BV`
 * hemisphere measures 1. This is the denominator `resolveCovering` divides by.
 */
export function coveringMeasure(c: Covering): number {
  if (!isCovering(c)) throw new AlcError('coveringMeasure takes a Covering', 'bad_covering');
  let total = 0;
  for (const cell of c.cells) total += relativeMeasure(frameRootOf(cell), cell);
  return total;
}

export interface CoveringResolution extends Omit<Resolution, 'address'> {
  /** The covering that was asked about. */
  readonly cells: readonly string[];
}

/**
 * `covering -> [{ structure, fraction }]`: the same question for a finding that
 * occupies more than one cell.
 *
 * Fractions are measure-weighted over the covering, so a structure filling a
 * large cell of the covering outranks one filling a small cell. They sum to the
 * share of the covering the index accounts for, exactly as in `resolve`.
 */
export function resolveCovering(
  c: Covering,
  index: NameIndex,
  options: ResolveOptions = {},
): CoveringResolution {
  if (!isCovering(c)) throw new AlcError('resolveCovering takes a Covering', 'bad_covering');
  const minFraction = options.minFraction ?? 0;
  const total = coveringMeasure(c);
  if (total <= 0) {
    return Object.freeze({
      cells: Object.freeze([]),
      indexVersion: index.version,
      measure: 'frame' as const,
      matches: Object.freeze([]),
      unclaimedFraction: 0,
      notes: Object.freeze(['empty covering']),
    });
  }

  const weighted = new Map<number, number>();
  const claimedParts: Covering[] = [];
  const { keys, owners } = internals(index);

  for (const cell of c.cells) {
    const weight = relativeMeasure(frameRootOf(cell), cell) / total;
    const cellCovering = covering([cell]);
    const candidates = new Set<number>();
    for (const i of scanSorted(keys, overlapScan(cell))) candidates.add(owners[i]);
    for (const s of candidates) {
      const overlap = coveringIntersect(index.coverings[s], cellCovering);
      if (overlap.cells.length === 0) continue;
      const within = coveringMeasureWithin(overlap, cell);
      if (within <= 0) continue;
      claimedParts.push(overlap);
      weighted.set(s, (weighted.get(s) ?? 0) + within * weight);
    }
  }

  const matches: ResolvedStructure[] = [];
  for (const [s, fraction] of weighted) {
    if (fraction >= minFraction) matches.push({ structure: index.structures[s], fraction });
  }
  matches.sort((x, y) =>
    y.fraction - x.fraction || (x.structure.id < y.structure.id ? -1 : x.structure.id > y.structure.id ? 1 : 0),
  );
  const limited = options.limit === undefined ? matches : matches.slice(0, Math.max(0, options.limit));

  let claimedFraction = 0;
  if (claimedParts.length > 0) {
    const claimed = coveringUnion(...claimedParts);
    for (const cell of c.cells) {
      const weight = relativeMeasure(frameRootOf(cell), cell) / total;
      claimedFraction += coveringMeasureWithin(claimed, cell) * weight;
    }
  }

  return Object.freeze({
    cells: c.cells,
    indexVersion: index.version,
    measure: 'frame' as const,
    matches: Object.freeze(limited),
    unclaimedFraction: Math.max(0, 1 - claimedFraction),
    notes: Object.freeze([]),
  });
}

/**
 * `name -> covering`: the reverse direction, by structure id.
 *
 * Returns the minimal prefix set whose union is the structure, which is what
 * makes the database query a prefix range scan rather than a point-in-mesh test.
 */
export function structureCovering(structureId: string, index: NameIndex): Covering {
  const { byId } = internals(index);
  const i = byId.get(structureId);
  if (i === undefined) {
    throw new AlcError(
      `structure ${JSON.stringify(structureId)} is not in name index ${index.version}`,
      'unknown_structure',
    );
  }
  return index.coverings[i];
}

/** Case-insensitive substring search over structure names, for a name box in a UI. */
export function findStructures(query: string, index: NameIndex, limit = 20): StructureRef[] {
  const needle = String(query).trim().toLowerCase();
  if (needle === '') return [];
  const out: StructureRef[] = [];
  for (const s of index.structures) {
    if (s.name.toLowerCase().includes(needle) || s.id.toLowerCase() === needle) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Structures whose covering wholly contains the address, coarsest first.
 *
 * The hierarchical reading of a location: "this cell is in the lower lobe,
 * which is in the left lung, which is in the thorax" — but only for structures
 * that actually contain it, so nothing here is inferred from a fraction.
 */
export function containingStructures(address: string, index: NameIndex): StructureRef[] {
  const canonical = parse(address).canonical;
  const { keys, owners } = internals(index);
  const found = new Map<string, { ref: StructureRef; depth: number }>();
  for (const i of scanSorted(keys, overlapScan(canonical))) {
    if (!contains(keys[i], canonical)) continue;
    const ref = index.structures[owners[i]];
    const depth = parse(keys[i]).level;
    const prev = found.get(ref.id);
    if (!prev || depth < prev.depth) found.set(ref.id, { ref, depth });
  }
  return [...found.values()].sort((a, b) => a.depth - b.depth || (a.ref.id < b.ref.id ? -1 : 1)).map((x) => x.ref);
}
