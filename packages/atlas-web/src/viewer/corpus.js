/** The curated corpus, resolved in the browser, against the real name index. (docs/viewer-shell.md) */

import { parse } from '../alc.js';
import { buildResearchIndex, formatCitation, loadDataset, sourceLink } from '../atlas-research.js';
import { ResearchError } from './research.js';
import { atlasForFrame } from './state.js';

/**
 * A paper's source link, for either corpus. A curated paper carries one; a
 * fixture paper is checked here under its title, so the panel never builds an
 * href itself and never imports the research layer to do it.
 */
export function paperSource(paper) {
  return paper.source ?? sourceLink(paper.title, paper.url ?? null);
}

/**
 * A mapping's cause, as something a panel can render without re-deriving it.
 *
 * `headline` is one sentence, always safe to show inline. `detail` is the
 * authority behind it — a partition's recorded reason, or the resolver's own
 * note — and is long on purpose; the brain partition's reason is a paragraph
 * because the licence position is a paragraph. `partitionId` is what lets the
 * panel group 135 mappings under one explanation instead of repeating it.
 */
function explainUnresolved(mapping, partition, nameIndexVersion) {
  const id = mapping.structureId;

  // Everything except `unknown-structure` already arrives with a complete
  // sentence from the resolver — `no-template` in particular is carefully
  // worded ("a locus we cannot place is not the same claim as a region") and
  // must not be restated here. Partitions have nothing to add to those: the
  // structure was found, the geometry was the problem.
  if (mapping.unresolvedReason !== 'unknown-structure') {
    return Object.freeze({
      reason: mapping.unresolvedReason,
      partitionId: partition?.id ?? null,
      partitionStatus: partition?.status ?? null,
      headline: mapping.notes.at(-1) ?? `${id} could not be placed.`,
      detail: null,
      authoredAgainst: partition?.nameIndexVersion ?? null,
    });
  }

  // No partition claims the id. `validate.ts` requires the partitions to cover
  // the dataset exhaustively, so a loaded dataset cannot reach this — but a
  // dataset assembled in a test can, and guessing on its behalf is how a
  // missing declaration becomes invisible.
  if (!partition) {
    return Object.freeze({
      reason: 'undeclared-structure',
      partitionId: null,
      partitionStatus: null,
      headline: `The name index ${nameIndexVersion} does not carry ${id}, and the dataset does not `
        + 'say which index was supposed to. Without a partition declaring it, there is no way to '
        + 'tell a licence-blocked structure from a mistyped one.',
      detail: null,
      authoredAgainst: null,
    });
  }

  // Declared against THIS index, and it still did not resolve. The one case
  // DOG-46 reserved the words for: the id is wrong, or the index regressed.
  if (partition.status === 'real') {
    return Object.freeze({
      reason: 'unknown-structure',
      partitionId: partition.id,
      partitionStatus: 'real',
      headline: `Unknown structure: ${id} is declared against ${partition.nameIndexVersion}, which `
        + 'is the index this page loaded, so it should have resolved. Either the identifier is '
        + 'wrong or the index no longer carries it.',
      detail: null,
      authoredAgainst: partition.nameIndexVersion,
    });
  }

  // Predicted. The dataset said in advance that no cleared index would name
  // this, and recorded the cause. Say that, and hand over the cause as given.
  return Object.freeze({
    reason: 'placeholder-partition',
    partitionId: partition.id,
    partitionStatus: 'placeholder',
    headline: `Not placed, and not a mistake: ${id} belongs to the declared placeholder partition `
      + `"${partition.id}", authored against ${partition.nameIndexVersion} rather than the index `
      + `this page loaded (${nameIndexVersion}). No cleared index names it, so there is no extent `
      + 'to show.',
    detail: partition.reason ?? null,
    authoredAgainst: partition.nameIndexVersion,
  });
}

/** Structure id → the partition that claims it. Empty when unpartitioned. */
function partitionsByStructure(dataset) {
  const out = new Map();
  for (const partition of dataset.authoredAgainst?.partitions ?? []) {
    for (const id of partition.structureIds) out.set(id, partition);
  }
  return out;
}

/**
 * One covering cell as the viewer's cell record.
 *
 * Through `parse()`, never by reading the first two characters: the frame of an
 * address is the library's answer, and a substring is a second implementation
 * of a grammar that already has one.
 */
const toCell = (address) => {
  const parsed = parse(address);
  return Object.freeze({
    address: parsed.canonical,
    frame: parsed.frame,
    atlas: atlasForFrame(parsed.frame),
  });
};

/**
 * Resolve a `research/1` dataset into the model the viewer's research panel
 * reads.
 *
 * `names` is required and `templates` is not, but absent templates are a
 * measurable loss rather than a neutral default: the three `coordinates`
 * mappings then resolve `no-template`, and the corpus drops from 31 mappings
 * across 10 papers to 28 across 8. The caller passes both.
 */
export function curatedModel(doc, { names, templates } = {}) {
  if (!names) {
    throw new ResearchError(
      'the curated corpus is resolved against the name index at load, and no name index was '
      + 'loaded. Nothing would be placed, and a corpus showing 170 unplaceable mappings because '
      + 'the index failed to fetch is indistinguishable from one the index genuinely cannot name.',
    );
  }

  let dataset;
  try {
    dataset = loadDataset(doc);
  } catch (error) {
    // `ResearchDataError` carries a problem list; the shell shows one line.
    throw new ResearchError(`the curated research dataset was refused: ${error.message}`);
  }

  const index = buildResearchIndex({ dataset, names, templates });
  const owners = partitionsByStructure(dataset);

  const papers = dataset.papers.map((paper) => {
    const findings = index.findingsOf(paper.id).map((finding) => {
      const mappings = index.mappingsOfFinding(finding.id).map((m) => {
        const placed = m.resolution === 'resolved';
        return Object.freeze({
          id: m.mappingId,
          structureId: m.structureId,
          /** From the index when it knew the id, from the curator otherwise. */
          structureLabel: m.structureLabel,
          structureLabelCurated: m.structureLabelCurated,
          labelFromIndex: m.structureLabelFromIndex,
          precision: m.precision,
          regionLevelOnly: m.regionLevelOnly,
          placed,
          // `EMPTY_COVERING` for every unresolved mapping, from the resolver.
          // Not re-derived, not substituted, not back-filled.
          cells: Object.freeze(placed ? m.covering.cells.map(toCell) : []),
          unresolved: placed
            ? null
            : explainUnresolved(m, owners.get(m.structureId), index.nameIndexVersion),
          /** Conditions the resolver reported. Shown, never swallowed. */
          notes: Object.freeze([...m.notes]),
          evidence: m.evidence,
          provenance: m.provenance,
          citation: m.citation,
          link: m.link,
        });
      });

      const cells = mappings.flatMap((m) => m.cells);
      const unplaced = mappings.filter((m) => !m.placed);
      return Object.freeze({
        id: finding.id,
        /** The curator's one-sentence rendering of the claim. */
        label: finding.statement,
        topics: Object.freeze([...finding.topics]),
        mappings: Object.freeze(mappings),
        cells: Object.freeze(cells),
        placed: cells.length > 0,
        /**
         * Why a finding has no extent, in the field `research.js` already
         * requires of an unplaced finding. Counted in the paper's total either
         * way: a finding omitted because it could not be placed would make the
         * literature look more locatable than it is.
         */
        regionOnly: cells.length > 0
          ? null
          : `None of this finding's ${unplaced.length} mapping(s) could be placed against `
            + `${index.nameIndexVersion}. Each one says why below; none of them is painted.`,
      });
    });

    const cells = findings.flatMap((f) => f.cells);
    const mappings = findings.flatMap((f) => f.mappings);
    const citation = formatCitation(paper);
    return Object.freeze({
      id: paper.id,
      title: paper.title,
      year: paper.year,
      venue: paper.venue,
      url: paper.sourceUrl,
      authors: Object.freeze([...paper.authors]),
      identifier: paper.identifier,
      // From the library, not from the paper's first mapping: a paper with no
      // mappings at all would otherwise lose its citation, and a corpus where
      // two thirds of the papers have no geometry is not the place to make a
      // citation depend on having some.
      citation,
      /**
       * The citation with its href, or with the reason it has none. Built by
       * the library's `sourceLink`, which re-checks the URL at render as well
       * as at load, so a paper with no recorded link says so instead of
       * looking like one whose link was never drawn (DOG-117).
       */
      source: sourceLink(citation, paper.sourceUrl),
      findings: Object.freeze(findings),
      cells: Object.freeze(cells),
      atlases: Object.freeze([...new Set(cells.map((c) => c.atlas))].sort()),
      /**
       * Stated per paper so the list can show "9 mappings, 7 placed" rather
       * than implying the two are the same number.
       */
      mappingCount: mappings.length,
      placedMappingCount: mappings.filter((m) => m.placed).length,
    });
  });

  return Object.freeze({
    version: dataset.version,
    role: 'curated',
    // A curated corpus needs no invented-papers caveat; what it needs is the
    // resolution summary below, which is the equivalent honesty for a corpus
    // whose papers are real and whose geometry is mostly missing.
    caveat: null,
    nameIndexVersion: index.nameIndexVersion,
    papers: Object.freeze(papers),
    resolution: Object.freeze(summarise(index, owners, dataset)),
    partitions: Object.freeze(
      (dataset.authoredAgainst?.partitions ?? []).map((p) => Object.freeze({
        id: p.id,
        status: p.status,
        nameIndexVersion: p.nameIndexVersion,
        structureCount: p.structureIds.length,
        reason: p.reason ?? null,
      })),
    ),
  });
}

/**
 * The counts, measured from the join rather than declared beside it.
 *
 * `atlas-index.json` carries a declared copy so a regression shows up as a
 * number rather than an empty panel, and the page compares the two at load —
 * see `app.js`. Measuring here and declaring there is the point: one number
 * nobody measures is a number that goes stale.
 */
function summarise(index, owners, dataset) {
  const resolved = index.mappings.filter((m) => m.resolution === 'resolved');

  // Seeded in the dataset's own declaration order, so the rows come out in a
  // stable order that does not depend on which finding happened to be first.
  // A partition with no mappings at all still gets a row — a declared
  // partition that turns out to be unused is worth seeing, not hiding.
  const byPartition = new Map(
    (dataset.authoredAgainst?.partitions ?? []).map((p) => [
      p.id,
      { partitionId: p.id, resolved: 0, unresolved: 0 },
    ]),
  );
  for (const m of index.mappings) {
    const key = owners.get(m.structureId)?.id ?? null;
    const row = byPartition.get(key) ?? { partitionId: key, resolved: 0, unresolved: 0 };
    row[m.resolution === 'resolved' ? 'resolved' : 'unresolved'] += 1;
    byPartition.set(key, row);
  }
  return {
    mappings: { resolved: resolved.length, total: index.mappings.length },
    papers: {
      withGeometry: new Set(resolved.map((m) => m.paperId)).size,
      total: dataset.papers.length,
    },
    findings: {
      withGeometry: new Set(resolved.map((m) => m.findingId)).size,
      total: dataset.findings.length,
    },
    /**
     * Placed but unnameable: geometry the curator supplied for a structure no
     * cleared index names. Counted separately because it is neither a success
     * to report as named nor a failure to report as missing.
     */
    placedUnnameable: resolved.filter((m) => !m.structureLabelFromIndex).length,
    byPartition: Object.freeze([...byPartition.values()].map(Object.freeze)),
  };
}
