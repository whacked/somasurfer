/**
 * Research papers over addresses: the filter, the reveal, and the comparison.
 *
 * Stage A loaded the research document and exposed it on `window.__atlas`
 * without doing anything with it — the highlight seam, named as such. This is
 * the behaviour the §7 journey's middle three steps ask for: find papers that
 * mapped a region, reveal one paper's mappings, compare two papers.
 *
 * ## The filter narrows the LIST, never a selected paper's own mappings
 *
 * This is the rule with the most tempting wrong implementation, so it is
 * structural rather than a convention, in the same way `select()` structurally
 * cannot change the atlas:
 *
 *   `papersOverlapping()` takes a filter and returns papers.
 *   `revealPaper()`       takes NO filter and returns every mapping.
 *
 * There is no filter argument to pass to `revealPaper`, so a caller cannot
 * accidentally narrow a reveal, and a future caller cannot be talked into it
 * by a convenient parameter. A paper that mapped five regions mapped five
 * regions; showing three of them because the user had a thoracic filter on
 * would misrepresent the paper, and it is exactly the sort of helpfulness that
 * turns a citation into a false claim about what somebody published.
 *
 * Revealed cells are *annotated* with whether they fell inside the active
 * filter — `withinFilter` — so the UI can draw attention without withholding
 * anything. Annotating is not filtering: the row is there either way.
 *
 * ## Overlap, never string equality
 *
 * A paper maps `BD-T07-06O`; the user has `BD-T07` selected. Those are not the
 * same string and they are not unrelated — one contains the other — and the
 * only correct test is the library's. Every comparison here goes through
 * `overlaps()`, which is also what the standing address-equality guard over
 * this package exists to enforce.
 *
 * ## A finding that was never placed is shown, not dropped
 *
 * `FXP-5` reports "thoracic spine" with no level and no side, so it has no
 * cells at all. Silently omitting it would let the atlas imply the literature
 * is more spatially precise than it is. It carries `placed: false` and its own
 * `regionOnly` sentence, and it is counted in the paper's finding total.
 */

import { overlaps, parse } from '../alc.js';
import { hasAddress } from './deeplink.js';
import { atlasForFrame } from './state.js';

/** Thrown by `researchModel`. The shell turns it into a degraded-research notice. */
export class ResearchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResearchError';
  }
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function requireString(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResearchError(`${what} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Validate and normalise a research document.
 *
 * Every mapped cell goes through `parse()` here, at load, rather than at draw
 * time. The research document is fetched, so it is untrusted like any other
 * input, and a malformed address discovered while assembling a highlight would
 * be a thrown error inside a render loop. Parsing up front also means every
 * downstream consumer can rely on `frame` and `atlas` being present.
 */
export function researchModel(doc) {
  if (!isObject(doc)) throw new ResearchError('the research document is not an object');
  const version = requireString(doc.version, 'research `version`');
  if (!Array.isArray(doc.papers)) throw new ResearchError('research `papers` must be an array');

  const seen = new Set();
  const papers = doc.papers.map((paper, i) => {
    if (!isObject(paper)) throw new ResearchError(`research \`papers[${i}]\` is not an object`);
    const id = requireString(paper.id, `research \`papers[${i}].id\``);
    if (seen.has(id)) throw new ResearchError(`research document lists paper ${JSON.stringify(id)} twice`);
    seen.add(id);
    const title = requireString(paper.title, `paper ${id} \`title\``);
    if (!Array.isArray(paper.findings)) {
      throw new ResearchError(`paper ${id} \`findings\` must be an array`);
    }

    const findings = paper.findings.map((finding, j) => {
      if (!isObject(finding)) throw new ResearchError(`paper ${id} \`findings[${j}]\` is not an object`);
      const findingId = requireString(finding.id, `paper ${id} \`findings[${j}].id\``);
      const label = requireString(finding.label, `finding ${findingId} \`label\``);
      const rawCells = finding.cells ?? [];
      if (!Array.isArray(rawCells)) {
        throw new ResearchError(`finding ${findingId} \`cells\` must be an array`);
      }
      const cells = rawCells.map((cell) => {
        let parsed;
        try {
          parsed = parse(cell);
        } catch (error) {
          throw new ResearchError(
            `finding ${findingId} maps ${JSON.stringify(cell)}, which is not a valid address: `
            + `${error.message}`,
          );
        }
        return Object.freeze({
          address: parsed.canonical,
          frame: parsed.frame,
          atlas: atlasForFrame(parsed.frame),
        });
      });
      // An unplaced finding must say why. A finding with no cells and no
      // explanation is indistinguishable from one whose mappings were lost.
      const regionOnly = typeof finding.regionOnly === 'string' ? finding.regionOnly : null;
      if (cells.length === 0 && regionOnly === null) {
        throw new ResearchError(
          `finding ${findingId} maps no cells and gives no \`regionOnly\` reason, so the viewer `
          + 'cannot tell an unplaceable report from a lost mapping.',
        );
      }
      return Object.freeze({
        id: findingId,
        label,
        cells: Object.freeze(cells),
        placed: cells.length > 0,
        regionOnly,
      });
    });

    return Object.freeze({
      id,
      title,
      year: Number.isInteger(paper.year) ? paper.year : null,
      venue: typeof paper.venue === 'string' ? paper.venue : null,
      url: typeof paper.url === 'string' ? paper.url : null,
      findings: Object.freeze(findings),
      /** Every placed cell of the paper, flattened. The reveal set. */
      cells: Object.freeze(findings.flatMap((f) => f.cells)),
      /** Atlases this paper has mappings in, so a reader knows before clicking. */
      atlases: Object.freeze([...new Set(findings.flatMap((f) => f.cells.map((c) => c.atlas)))].sort()),
    });
  });

  return Object.freeze({ version, papers: Object.freeze(papers) });
}

/**
 * Papers with at least one mapping overlapping `filterAddress`.
 *
 * Returns the matching *cells* alongside each paper, because "this paper is
 * relevant" and "this is the part of it that is relevant" are different facts
 * and the second is the one worth showing next to a list entry.
 *
 * A null or unparseable filter returns every paper rather than none: no filter
 * is not an empty filter, and a list that empties itself because the user has
 * nothing selected reads as a broken index.
 */
export function papersOverlapping(model, filterAddress) {
  if (!model) return [];
  let filter = null;
  if (hasAddress(filterAddress)) {
    try {
      filter = parse(filterAddress).canonical;
    } catch {
      filter = null;
    }
  }
  if (filter === null) {
    return model.papers.map((paper) => ({ paper, matching: [], filtered: false }));
  }

  const out = [];
  for (const paper of model.papers) {
    // `overlaps` either way round: a paper cell inside the filter and a filter
    // inside a paper cell are both relevance, and testing one direction only
    // loses every paper mapped more coarsely than the selection.
    const matching = paper.cells.filter((c) => overlaps(c.address, filter));
    if (matching.length > 0) out.push({ paper, matching, filtered: true });
  }
  return out;
}

/**
 * Every mapping of one paper. Takes no filter, by design — see the header.
 *
 * `activeFilter` is accepted only to ANNOTATE each cell with `withinFilter`,
 * and it cannot remove a row: the returned finding and cell lists are the
 * paper's own, complete, in document order. `outsideFilter` counts the ones a
 * filtered list would have hidden, so the UI can say "3 of these 5 are outside
 * your current filter" instead of quietly showing two.
 */
export function revealPaper(model, paperId, activeFilter = null) {
  const paper = model?.papers.find((p) => p.id === paperId);
  if (!paper) return null;

  let filter = null;
  if (hasAddress(activeFilter)) {
    try {
      filter = parse(activeFilter).canonical;
    } catch {
      filter = null;
    }
  }
  const within = (address) => (filter === null ? null : overlaps(address, filter));

  const findings = paper.findings.map((finding) => ({
    ...finding,
    cells: finding.cells.map((cell) => ({ ...cell, withinFilter: within(cell.address) })),
  }));
  const cells = findings.flatMap((f) => f.cells);

  return {
    paper,
    findings,
    cells,
    /** Atlases these mappings span. More than one is the cross-atlas case. */
    atlases: [...new Set(cells.map((c) => c.atlas))].sort(),
    outsideFilter: filter === null ? 0 : cells.filter((c) => c.withinFilter === false).length,
    unplaced: findings.filter((f) => !f.placed).length,
  };
}

/**
 * Two papers, and where their mappings meet.
 *
 * Comparison is by overlap, not by identity, and that is the whole point: two
 * groups reporting the same anatomy at different precisions have no address in
 * common and are talking about the same place. `shared` therefore holds PAIRS
 * — which cell of A overlaps which cell of B — rather than a set of addresses,
 * because with unequal precision there is no single address that is "the"
 * overlap, and inventing one would be a claim neither paper made.
 */
export function comparePapers(model, aId, bId) {
  const a = revealPaper(model, aId);
  const b = revealPaper(model, bId);
  if (!a || !b) return null;

  const shared = [];
  for (const left of a.cells) {
    for (const right of b.cells) {
      if (overlaps(left.address, right.address)) shared.push({ a: left, b: right });
    }
  }

  // Derived with the same predicate `shared` is built from, rather than by
  // asking which addresses ended up in it. Collecting the shared addresses
  // into a set and testing membership would be a string-identity comparison
  // between two addresses -- the shape the standing equality guard exists to
  // keep out of this package, and it would also quietly dedupe a cell that two
  // findings of the same paper both map. "Only in A" means "nothing in B
  // overlaps it", so that is what it asks.
  const unmatched = (cells, others) =>
    cells.filter((cell) => !others.some((other) => overlaps(cell.address, other.address)));

  return {
    a: a.paper,
    b: b.paper,
    shared,
    /** Cells of each paper that nothing in the other overlaps. */
    onlyA: unmatched(a.cells, b.cells),
    onlyB: unmatched(b.cells, a.cells),
    /** Said plainly, because "no overlap" and "not compared" look alike. */
    disjoint: shared.length === 0,
  };
}
