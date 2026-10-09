/**
 * The two browse modes, over a resolved research index.
 *
 * DOG-1 §3 asks for two directions over one dataset: pick a region and see the
 * research, or pick research and see the regions. They are not symmetric, and
 * the asymmetry is the whole acceptance criterion:
 *
 *   browse-by-anatomy   region  -> papers        narrowing is the question
 *   browse-by-research  paper   -> ALL regions   narrowing is forbidden
 *
 * ## How the filter is kept out of a selection
 *
 * "Selecting a paper found through area 44 must show all of that paper's mapped
 * regions, including areas 10 and 13" is easy to state and easy to lose: both
 * halves of the screen are driven by one filter variable, somebody passes it
 * down one level too far, and a paper's own mappings quietly get intersected
 * with the current region. The test would still pass, because the regions that
 * disappear are the ones nobody is looking at.
 *
 * So the filter is kept out structurally rather than by care. `paperSelection`
 * — the function that produces a selected paper's mappings — **takes no filter
 * argument**. There is no parameter to thread, so threading it is a compile
 * error rather than a judgement call. `browseByResearch` applies the filter to
 * the paper *list* and then calls `paperSelection` with the selection only.
 * `test/browse.test.ts` pins the behaviour from the outside as well, by
 * asserting that a selection is byte-identical under every filter including
 * ones that exclude the paper entirely.
 *
 * ## The scan path
 *
 * The anatomy-side query is a prefix range scan, because truncating an ALC
 * address yields its ancestor (`@gstack/alc`'s `query.ts`). Both the in-memory
 * scan and the rendered SQL come from one `ScanPlan`, so a caller with a
 * database and a caller with a static JSON file run the same bounds. Every
 * rendered query binds its addresses as parameters; no address is ever
 * interpolated into SQL text.
 */

import {
  AlcError,
  covering,
  coveringIntersect,
  coveringMeasure,
  coveringOverlapsAddress,
  coveringScan,
  coveringsOverlap,
  EMPTY_COVERING,
  isCovering,
  overlapScan,
  parse,
  renderScan,
  scanSorted,
  type Covering,
  type ParameterisedQuery,
  type ScanPlan,
  type SqlDialect,
} from '../../alc/src/index.ts';

import type { ResearchIndex, ResolvedMapping } from './dataset.ts';
import { solidColourLayers, type PaperColour, type SolidColourLayers } from './layers.ts';
import type { Finding, Paper } from './types.ts';

/** A finding and the resolved mappings of it that are in play. */
export interface FindingHit {
  readonly finding: Finding;
  readonly mappings: readonly ResolvedMapping[];
  /** True when every mapping here is region-level: the marker is required. */
  readonly regionLevelOnly: boolean;
}

export interface PaperHit {
  readonly paper: Paper;
  readonly findings: readonly FindingHit[];
  readonly mappingCount: number;
  /**
   * Measure of the paper's overlap with the query, in frame-root units. A
   * ranking hint for the list, not a score: it is exact frame measure, so a
   * caller may also show it.
   */
  readonly overlapMeasure: number;
}

export interface AnatomyBrowse {
  /** Canonical form of what was asked about. */
  readonly query: { readonly address: string | null; readonly cells: readonly string[] };
  readonly datasetVersion: string;
  readonly nameIndexVersion: string;
  /** Papers with at least one mapping overlapping the query, ranked. */
  readonly papers: readonly PaperHit[];
  /** Every overlapping mapping, flat. Each one is a complete provenance trail. */
  readonly mappings: readonly ResolvedMapping[];
  /** The scan the hits came from. Exposed so a caller can run it elsewhere. */
  readonly scan: ScanPlan;
  readonly notes: readonly string[];
}

function isCoveringArg(v: unknown): v is Covering {
  return isCovering(v);
}

/**
 * Browse by anatomy: which papers say something about this place?
 *
 * Accepts a single address (a clicked cell) or a covering (a whole structure).
 * Candidates come from the prefix scan and are then confirmed by covering
 * overlap — the scan is sound but not exact for the ancestor half of the plan,
 * and reporting an unconfirmed candidate would mean listing a paper that says
 * nothing about the place the user clicked.
 */
export function browseByAnatomy(index: ResearchIndex, target: string | Covering): AnatomyBrowse {
  let plan: ScanPlan;
  let address: string | null = null;
  let queryCovering: Covering;

  if (typeof target === 'string') {
    address = parse(target).canonical;
    plan = overlapScan(address);
    queryCovering = covering([address]);
  } else if (isCoveringArg(target)) {
    queryCovering = target;
    plan = coveringScan(target);
  } else {
    throw new AlcError('browseByAnatomy takes an address string or a Covering', 'bad_query');
  }

  const candidates = new Set<number>();
  for (const i of scanSorted(index.cellKeys, plan)) candidates.add(index.cellOwners[i]);

  const hits: ResolvedMapping[] = [];
  for (const i of [...candidates].sort((a, b) => a - b)) {
    const m = index.mappings[i];
    // Confirmation, not decoration. `overlapScan` includes every ancestor key
    // as an exact match, which is correct and over-broad in the other
    // direction only when a stored cell equals an ancestor of the query — so
    // the check below is cheap and the scan stays sound.
    const overlaps =
      address !== null ? coveringOverlapsAddress(m.covering, address) : coveringsOverlap(m.covering, queryCovering);
    if (overlaps) hits.push(m);
  }

  const byPaper = new Map<string, ResolvedMapping[]>();
  for (const m of hits) {
    const list = byPaper.get(m.paperId);
    if (list) list.push(m);
    else byPaper.set(m.paperId, [m]);
  }

  const papers: PaperHit[] = [...byPaper.entries()]
    .map(([paperId, ms]) => {
      const byFinding = new Map<string, ResolvedMapping[]>();
      for (const m of ms) {
        const list = byFinding.get(m.findingId);
        if (list) list.push(m);
        else byFinding.set(m.findingId, [m]);
      }
      const findings: FindingHit[] = [...byFinding.entries()].map(([findingId, fms]) => ({
        finding: index.finding(findingId)!,
        mappings: Object.freeze(fms),
        regionLevelOnly: fms.every((m) => m.regionLevelOnly),
      }));
      const overlap = ms
        .map((m) => coveringIntersect(m.covering, queryCovering))
        .filter((c) => c.cells.length > 0);
      return Object.freeze({
        paper: index.paper(paperId)!,
        findings: Object.freeze(findings),
        mappingCount: ms.length,
        overlapMeasure: overlap.length === 0 ? 0 : coveringMeasure(overlap.reduce((a, b) => unionOf(a, b))),
      });
    })
    .sort(
      (a, b) =>
        b.overlapMeasure - a.overlapMeasure ||
        b.mappingCount - a.mappingCount ||
        (a.paper.id < b.paper.id ? -1 : 1),
    );

  const notes: string[] = [];
  if (hits.length === 0) {
    notes.push(
      `no curated finding in dataset ${index.dataset.version} overlaps ${address ?? 'this covering'}`,
    );
  }
  if (index.unresolved.length > 0) {
    // Said on every anatomy query, because an unresolved mapping is invisible
    // to this query by construction: it has no cells to scan. A user looking
    // at an empty panel is entitled to know the dataset has rows that could
    // not be placed.
    notes.push(
      `${index.unresolved.length} curated mapping(s) in this dataset are unresolved and cannot appear in an anatomy query`,
    );
  }

  return Object.freeze({
    query: Object.freeze({ address, cells: queryCovering.cells }),
    datasetVersion: index.dataset.version,
    nameIndexVersion: index.nameIndexVersion,
    papers: Object.freeze(papers),
    mappings: Object.freeze(hits),
    scan: plan,
    notes: Object.freeze(notes),
  });
}

function unionOf(a: Covering, b: Covering): Covering {
  return covering([...a.cells, ...b.cells]);
}

// ---------------------------------------------------------------------------
// Browse by research
// ---------------------------------------------------------------------------

export interface PaperSelection {
  readonly paper: Paper;
  /** Every finding of the paper, with every mapping. Not filtered. Ever. */
  readonly findings: readonly FindingHit[];
  /** Union of the paper's resolved mappings. */
  readonly covering: Covering;
  /** Mappings with no geometry, shown as markers. */
  readonly unresolved: readonly ResolvedMapping[];
  /** Mappings whose precision is region-level: the explicit marker. */
  readonly regionLevel: readonly ResolvedMapping[];
}

/**
 * A selected paper's full extent.
 *
 * **This function takes no filter and must never acquire one.** It is the
 * single answer to "what does this paper map?", and the acceptance criterion is
 * that the answer does not depend on what else is on screen. Adding an optional
 * filter parameter here would satisfy every existing test and break the
 * guarantee.
 */
export function paperSelection(index: ResearchIndex, paperIds: readonly string[]): PaperSelection[] {
  const out: PaperSelection[] = [];
  const seen = new Set<string>();
  for (const paperId of paperIds) {
    if (seen.has(paperId)) continue;
    seen.add(paperId);
    const paper = index.paper(paperId);
    if (!paper) continue;
    const findings: FindingHit[] = index.findingsOf(paperId).map((f) => {
      const mappings = index.mappingsOfFinding(f.id);
      return Object.freeze({
        finding: f,
        mappings,
        regionLevelOnly: mappings.length > 0 && mappings.every((m) => m.regionLevelOnly),
      });
    });
    const all = index.mappingsOf(paperId);
    out.push(
      Object.freeze({
        paper,
        findings: Object.freeze(findings),
        covering: index.paperCovering(paperId),
        unresolved: Object.freeze(all.filter((m) => m.resolution === 'unresolved')),
        regionLevel: Object.freeze(all.filter((m) => m.regionLevelOnly)),
      }),
    );
  }
  return out;
}

export interface PaperListEntry {
  readonly paper: Paper;
  readonly findingCount: number;
  readonly mappingCount: number;
  /** True when the paper has a mapping overlapping the anatomical filter. */
  readonly matchesFilter: boolean;
  /** True when the paper is in the current selection. */
  readonly selected: boolean;
}

export interface ResearchBrowse {
  readonly datasetVersion: string;
  readonly nameIndexVersion: string;
  /**
   * The paper list. This is the **only** thing the anatomical filter narrows.
   * Selected papers are always present, even when the filter excludes them, so
   * a user cannot lose the handle on something they have selected.
   */
  readonly list: readonly PaperListEntry[];
  /** Full mappings for the selection. Independent of `filter` by construction. */
  readonly selection: readonly PaperSelection[];
  readonly layers: SolidColourLayers;
  /** Cells of the filter that was applied to the list, for display. */
  readonly filterCells: readonly string[];
  readonly notes: readonly string[];
}

export interface ResearchBrowseOptions {
  /** Papers the user has selected, in selection order. */
  readonly selected?: readonly string[];
  /** The current anatomical filter. Narrows the list only. */
  readonly filter?: Covering | null;
  /** Free-text filter over title, authors and topics. Narrows the list only. */
  readonly search?: string | null;
  /** Topic filter. Narrows the list only. */
  readonly topics?: readonly string[] | null;
  /** Previous colour assignment, so a selection change does not repaint survivors. */
  readonly colours?: readonly PaperColour[];
}

/**
 * Browse by research: a narrowable list of papers, and an un-narrowable view of
 * whatever is selected.
 */
export function browseByResearch(index: ResearchIndex, options: ResearchBrowseOptions = {}): ResearchBrowse {
  const selected = options.selected ?? [];
  const selectedSet = new Set(selected);
  const filter = options.filter ?? null;
  if (filter !== null && !isCovering(filter)) {
    throw new AlcError('browseByResearch filter must be a Covering built by covering()', 'bad_covering');
  }
  const needle = (options.search ?? '').trim().toLowerCase();
  const topics = options.topics && options.topics.length > 0 ? new Set(options.topics) : null;

  const list: PaperListEntry[] = [];
  for (const paper of index.papers) {
    const findings = index.findingsOf(paper.id);
    const mappings = index.mappingsOf(paper.id);

    const matchesFilter =
      filter === null ? true : mappings.some((m) => m.covering.cells.length > 0 && coveringsOverlap(m.covering, filter));
    const matchesSearch =
      needle === '' ||
      paper.title.toLowerCase().includes(needle) ||
      paper.venue.toLowerCase().includes(needle) ||
      paper.authors.some((a) => a.toLowerCase().includes(needle)) ||
      findings.some(
        (f) => f.statement.toLowerCase().includes(needle) || f.topics.some((t) => t.toLowerCase().includes(needle)),
      );
    const matchesTopics = topics === null || findings.some((f) => f.topics.some((t) => topics.has(t)));

    // A selected paper is never dropped from the list. Losing the row that
    // carries the deselect control while its highlights are still painted is
    // how a user ends up unable to clear a selection.
    const keep = (matchesFilter && matchesSearch && matchesTopics) || selectedSet.has(paper.id);
    if (!keep) continue;

    list.push(
      Object.freeze({
        paper,
        findingCount: findings.length,
        mappingCount: mappings.length,
        matchesFilter,
        selected: selectedSet.has(paper.id),
      }),
    );
  }

  // Note the argument list: `selected` only. No filter in scope to pass.
  const selection = paperSelection(index, selected);
  const layers = solidColourLayers(index, selected, { colours: options.colours });

  const notes: string[] = [];
  const shownDespiteFilter = list.filter((e) => e.selected && !e.matchesFilter);
  if (shownDespiteFilter.length > 0) {
    notes.push(
      `${shownDespiteFilter.length} selected paper(s) do not match the current anatomical filter and are listed anyway; their mappings are shown in full`,
    );
  }
  const outsideFilter =
    filter === null
      ? 0
      : selection.filter((s) => s.covering.cells.length > 0 && !coveringsOverlap(s.covering, filter)).length;
  if (outsideFilter > 0) {
    notes.push(`${outsideFilter} selected paper(s) map only regions outside the current filter, and are shown in full`);
  }

  return Object.freeze({
    datasetVersion: index.dataset.version,
    nameIndexVersion: index.nameIndexVersion,
    list: Object.freeze(list),
    selection: Object.freeze(selection),
    layers,
    filterCells: filter === null ? Object.freeze([]) : filter.cells,
    notes: Object.freeze(notes),
  });
}

// ---------------------------------------------------------------------------
// The database path
// ---------------------------------------------------------------------------

/**
 * Render a scan plan as a parameterised predicate over a mapping-cell table.
 *
 * v1 ships no backend, so this is not on the hot path — but the schema is meant
 * to outlive the static site, and the moment a curator tool or a server-side
 * search appears it will issue exactly this query. Having one rendering, from
 * the library that owns the bounds and the collation, is the difference between
 * that happening correctly and happening with a template string.
 *
 * Every address binds as a parameter. The only caller-supplied text that
 * reaches the SQL is the column name, validated as an identifier by
 * `renderScan`. `test/trust.test.ts` asserts no value appears in the text.
 */
export function scanPredicate(
  plan: ScanPlan,
  options: { column?: string; dialect?: SqlDialect } = {},
): ParameterisedQuery {
  return renderScan(plan, { column: options.column ?? 'mapping_cells.cell', dialect: options.dialect ?? 'postgres' });
}

/** The scan plan for every mapping overlapping a place. The query half of browse-by-anatomy. */
export function anatomyScan(target: string | Covering): ScanPlan {
  if (typeof target === 'string') return overlapScan(target);
  if (!isCovering(target)) throw new AlcError('anatomyScan takes an address string or a Covering', 'bad_query');
  return coveringScan(target);
}

/** Union of a selection's coverings. The extent a camera should frame. */
export function selectionExtent(selection: readonly PaperSelection[]): Covering {
  const cells = selection.flatMap((s) => [...s.covering.cells]);
  return cells.length === 0 ? EMPTY_COVERING : covering(cells);
}
