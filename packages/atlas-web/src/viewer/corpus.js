/**
 * The curated corpus, resolved in the browser, against the real name index.
 *
 * `research.js` validates a document whose geometry is already decided: each
 * finding arrives carrying cells. That shape is all a build can honestly emit,
 * because deciding the cells means resolving a structure id against the name
 * index, the name index is an asset payload, and rule 6 of
 * `tools/check-licence-separation.mjs` holds `dist/data/` to deriving nothing
 * from asset content. So `dist/data/research.json` ships the curated dataset as
 * TEXT — papers, findings, structure ids, provenance — and the join happens
 * here, at load, where the index has already been fetched.
 *
 * That is the whole architectural point of R2, and it is also what makes the
 * numbers below possible to state at all: they are measurements against the
 * index the page actually binds, not estimates.
 *
 * ## What the join actually yields, measured
 *
 * Against `bp3d-4.0+uberon-uberon/releases/2026-10-01/uberon-basic.owl+8772477294da`
 * with both shipped templates bound, `research-seed-2026.10.1` resolves **31 of
 * its 170 mappings**, across **10 of 30 papers** and **24 of 120 findings**.
 * 139 mappings resolve to nothing at all.
 *
 * Those are not disappointing numbers to be smoothed over. They are the
 * honest extent of what v1 can place, and the entire job of this module is to
 * carry them to the screen intact:
 *
 *   - **Nothing is placed that the index did not place.** There is no fallback
 *     to a structure's covering, no synthetic index, no inferred position. An
 *     unresolved mapping contributes zero cells, and `buildResearchIndex()`
 *     already guarantees that by giving it `EMPTY_COVERING`; this module must
 *     simply not invent one.
 *   - **The residue is listed, described, and painted nowhere.** A paper with
 *     no placed geometry is still a paper. It stays in the list, stays
 *     selectable, and reveals all of its mappings — each one saying why it has
 *     no extent.
 *
 * ## Why the unresolved reason is NOT "unknown structure"
 *
 * All 139 come back from the resolver with `unresolvedReason:
 * 'unknown-structure'`, and that string is correct about the mechanism and
 * badly wrong as a sentence to show a reader. DOG-46 reserved those words
 * deliberately, to mean *a mistyped accession* — an id that should have
 * resolved and did not. Printing them 139 times would accuse the curator of
 * 139 typos, when in fact the dataset predicted every one of them in advance.
 *
 * It did so in `authoredAgainst.partitions`, which exists for exactly this.
 * Each partition states, per structure id, which index was supposed to name it
 * and whether that index is real or a declared placeholder. Joining against it
 * turns a mechanism into a cause, and the measured split is:
 *
 *   brain-parcellation  placeholder, 46 ids   135 unresolved,  5 resolved
 *   body-bd             real,        14 ids     0 unresolved, 26 resolved
 *   body-not-in-index   placeholder,  3 ids     4 unresolved,  0 resolved
 *
 * **The 139 do not share one cause, so they do not share one sentence.** 135
 * are blocked by licensing — no brain parcellation cleared redistribution, and
 * `docs/asset-licensing.md` §4 is final for v1. The other 4 are a coverage gap:
 * the cleared BodyParts3D subset has a generic rib but no individual rib, and
 * carries neither the coronary artery nor the quadratus lumborum. The dataset
 * separates those two partitions on purpose and says why in each `reason`
 * ("a coverage gap in the index rather than a licence refusal, and it is
 * recorded separately for that reason"), so collapsing them into one message
 * about licensing would introduce a fresh conflation while fixing another — the
 * same error as conflating `folded` with `clamped`.
 *
 * So the explanation is keyed off each mapping's OWN partition, and the cause
 * shown is the partition's own recorded `reason`, verbatim. Verbatim rather
 * than paraphrased because that text is the decision, written by whoever made
 * it; a paraphrase of a licence verdict is a new claim about a licence.
 *
 * And `unknown-structure` keeps its DOG-46 meaning, now exclusively: it is
 * said only when the id belongs to a partition declared `real` against the
 * very index that just failed to name it. That case is a genuine data error,
 * and today it happens zero times — which is a fact worth being able to see
 * change.
 *
 * ## Resolved does not imply named
 *
 * 5 of the 31 resolved mappings sit in the `placeholder` brain partition, and
 * that is not a contradiction. Only `region-level` precision needs the index to
 * name anything — `cells` and `coordinates` mappings carry their own geometry.
 * Those 5 are therefore **placed but unnameable**: real extent, with a label
 * that came from the curator rather than from any index. They keep
 * `labelFromIndex: false` so the panel can say so, because a curated label
 * rendered identically to an index name is a quiet upgrade of one to the other.
 *
 * Three states, then, not two: placed and named (26), placed but unnameable
 * (5), not placed (139).
 */

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
