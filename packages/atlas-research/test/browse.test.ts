import { strict as assert } from 'node:assert';
import test from 'node:test';

import { covering, coveringIntersect, coveringsOverlap } from '../../alc/src/index.ts';
import {
  browseByAnatomy,
  browseByResearch,
  paperSelection,
  selectionExtent,
} from '../src/index.ts';
import { fixtureIndex } from './helpers.ts';

const index = fixtureIndex();

const GLASSER = 'paper:glasser-2016-mmp1';
const BRODMANN = 'paper:brodmann-1909-localisation';
const AMUNTS = 'paper:amunts-1999-broca';
const BODYPARTS = 'paper:mitsuhashi-2009-bodyparts3d';
const ICBM = 'paper:mazziotta-2001-icbm';

/** The fixture's area-44 cell. The "found through area 44" entry point of DOG-1 §3. */
const AREA_44_CELL = 'BV-L-040';
/** A filter that admits only the inferior frontal gyrus: areas 44, 45 and 55b. */
const IFG_FILTER = covering(['BV-L-04']);
/** A filter that admits nothing any paper maps. */
const DISJOINT_FILTER = covering(['BV-R-777']);

// ---------------------------------------------------------------------------
// Browse by anatomy
// ---------------------------------------------------------------------------

test('browse-by-anatomy: a cell returns the papers whose findings cover it', () => {
  const r = browseByAnatomy(index, AREA_44_CELL);
  const ids = r.papers.map((p) => p.paper.id).sort();
  // Glasser and Brodmann both map area 44; Amunts reaches the cell twice over —
  // through the gyrus (an ancestor cell) and through its own sub-region.
  assert.deepEqual(ids, [AMUNTS, BRODMANN, GLASSER]);
  assert.equal(r.query.address, AREA_44_CELL);
  assert.equal(r.nameIndexVersion, 'fixture-names-2026.10.1');
  assert.equal(r.datasetVersion, index.dataset.version);
});

test('browse-by-anatomy: a coarse query finds a finding filed on a finer cell', () => {
  // The containment query in the direction that a naive equality lookup misses:
  // nothing is filed at BV-L-04 itself except the gyrus, yet the parcels inside
  // it must be returned.
  const r = browseByAnatomy(index, covering(['BV-L-04']));
  const ids = r.papers.map((p) => p.paper.id).sort();
  assert.deepEqual(ids, [AMUNTS, BRODMANN, GLASSER]);
  const cells = new Set(r.mappings.flatMap((m) => [...m.covering.cells]));
  assert.ok(cells.has('BV-L-043'), 'area 55b, filed three digits deep, is inside the query');
});

test('browse-by-anatomy: a fine query finds a finding filed on a coarser cell', () => {
  // The other direction: the gyrus is filed at BV-L-04 and must be returned for
  // a click five digits down. Prefix truncation is what makes this one scan.
  const r = browseByAnatomy(index, 'BV-L-0410');
  const ids = r.papers.map((p) => p.paper.id);
  assert.ok(ids.includes(AMUNTS));
  const gyrus = r.mappings.find((m) => m.structureId === 'ATLAS-LABEL:inferior-frontal-gyrus');
  assert.ok(gyrus, 'the gyrus-level mapping is reachable from a cell inside it');
});

test('browse-by-anatomy: a place no paper maps returns nothing, and says so', () => {
  const r = browseByAnatomy(index, 'BV-R-777');
  assert.equal(r.papers.length, 0);
  assert.equal(r.mappings.length, 0);
  assert.ok(r.notes.some((n) => n.includes('no curated finding')));
});

test('browse-by-anatomy: every hit is confirmed by covering overlap, not just by the scan', () => {
  for (const cell of ['BV-L-040', 'BV-L-600', 'BD-T07-03O-5', 'BD-C05-12I']) {
    const r = browseByAnatomy(index, cell);
    for (const m of r.mappings) {
      assert.ok(
        coveringsOverlap(m.covering, covering([cell])),
        `${m.mappingId} was returned for ${cell} without overlapping it`,
      );
    }
  }
});

test('browse-by-anatomy: an unresolved mapping is reported, never silently absent', () => {
  // The coordinates mapping has no cells, so it cannot be found by any anatomy
  // query. A panel that simply showed nothing would be hiding a curated row.
  const r = browseByAnatomy(index, 'BV-L-300');
  assert.ok(r.notes.some((n) => n.includes('unresolved')));
  assert.ok(!r.mappings.some((m) => m.resolution === 'unresolved'));
});

// ---------------------------------------------------------------------------
// Browse by research: the filter must narrow the list and nothing else
// ---------------------------------------------------------------------------

test('browse-by-research: the filter narrows the paper list', () => {
  const all = browseByResearch(index, {});
  const filtered = browseByResearch(index, { filter: IFG_FILTER });
  assert.equal(all.list.length, 5, 'every paper is listed with no filter');
  const filteredIds = filtered.list.map((e) => e.paper.id).sort();
  // The gyrus filter admits the three papers that map parcels inside it, and
  // excludes the whole-body paper and the reference-system paper.
  assert.deepEqual(filteredIds, [AMUNTS, BRODMANN, GLASSER]);
  assert.ok(!filteredIds.includes(BODYPARTS));
});

test('browse-by-research: selecting a paper reveals ALL of its mapped regions', () => {
  // DOG-1 §3, stated as the test it asks for. ICBM maps the brainstem, V1, an
  // unresolvable coordinate and -- in the other frame entirely -- the spinal
  // cord. A filter on the inferior frontal gyrus admits none of them.
  const r = browseByResearch(index, { selected: [ICBM], filter: IFG_FILTER });
  const selected = r.selection.find((s) => s.paper.id === ICBM);
  assert.ok(selected);

  const structures = selected.findings
    .flatMap((f) => f.mappings.map((m) => m.structureId))
    .sort();
  assert.deepEqual(structures, ['ATLAS-LABEL:brainstem', 'ATLAS-LABEL:spinal-cord', 'HCP-MMP1:A1', 'HCP-MMP1:V1']);

  // Including the body-frame one, which the brain filter would have removed.
  assert.ok(selected.covering.frames.includes('BD'), 'the BD mapping survived a BV-only filter');
  assert.ok(selected.covering.frames.includes('BV'));
  assert.ok(
    !coveringsOverlap(selected.covering, IFG_FILTER),
    'none of this paper\'s regions are inside the filter, and all of them are still here',
  );
});

test('browse-by-research: a selection is identical under every filter', () => {
  const filters = [null, IFG_FILTER, DISJOINT_FILTER, covering(['BD-T07-03O']), covering(['BV-L', 'BD-T07'])];
  const baseline = JSON.stringify(summarise(browseByResearch(index, { selected: [ICBM, GLASSER] })));
  for (const filter of filters) {
    const r = browseByResearch(index, { selected: [ICBM, GLASSER], filter });
    assert.equal(
      JSON.stringify(summarise(r)),
      baseline,
      `the selection changed under filter ${filter ? filter.cells.join(',') : 'none'}`,
    );
  }
});

test('browse-by-research: the leak detector would catch a leak', () => {
  // A must-pass case for the test above. If `summarise` compared something a
  // filter cannot touch, the previous test would pass against an
  // implementation that did intersect a selection with the filter. So build
  // that leak by hand and assert the comparison sees it.
  const honest = browseByResearch(index, { selected: [ICBM], filter: IFG_FILTER });
  const leaked = {
    ...summarise(honest),
    selection: honest.selection.map((s) => ({
      paperId: s.paper.id,
      cells: coveringIntersect(s.covering, IFG_FILTER).cells,
      mappingIds: s.findings
        .flatMap((f) => f.mappings)
        .filter((m) => coveringsOverlap(m.covering, IFG_FILTER))
        .map((m) => m.mappingId),
    })),
  };
  assert.notEqual(
    JSON.stringify(leaked),
    JSON.stringify(summarise(honest)),
    'the comparison used by the filter-leak test cannot distinguish a leaked selection',
  );
});

test('browse-by-research: a selected paper stays in the list even when filtered out', () => {
  const r = browseByResearch(index, { selected: [BODYPARTS], filter: IFG_FILTER });
  const entry = r.list.find((e) => e.paper.id === BODYPARTS);
  assert.ok(entry, 'a selected paper is never dropped: its deselect control lives on that row');
  assert.equal(entry.matchesFilter, false);
  assert.equal(entry.selected, true);
  assert.ok(r.notes.some((n) => n.includes('do not match the current anatomical filter')));
});

test('paperSelection takes no filter parameter', () => {
  // The structural half of the guarantee. An optional third parameter here
  // would satisfy every behavioural test above and reopen the leak.
  assert.equal(paperSelection.length, 2, 'paperSelection(index, paperIds) and nothing else');
});

test('browse-by-research: search and topic filters narrow the list only', () => {
  const r = browseByResearch(index, { selected: [BODYPARTS], search: 'parcellation', topics: ['vision'] });
  const ids = r.list.map((e) => e.paper.id);
  assert.ok(ids.includes(BODYPARTS), 'the selected paper survives a search that excludes it');
  const selected = r.selection.find((s) => s.paper.id === BODYPARTS);
  assert.equal(selected?.findings.length, 2, 'its findings are all present');
});

// ---------------------------------------------------------------------------
// Provenance reachable from every highlight
// ---------------------------------------------------------------------------

test('every highlight traces back to a finding, a paper, evidence and a source link', () => {
  // Checked over every cell of every mapping in the fixture, not a sample: the
  // claim is that there is no path to a painted cell without a trail.
  let cells = 0;
  for (const m of index.mappings) {
    if (m.resolution !== 'resolved') continue;
    cells += m.covering.cells.length;
    assert.ok(index.finding(m.findingId), `${m.mappingId} must name a real finding`);
    assert.ok(index.paper(m.paperId), `${m.mappingId} must name a real paper`);
    assert.equal(m.finding.id, m.findingId);
    assert.equal(m.paper.id, m.paperId);
    assert.ok(m.evidence.summary.length > 0);
    assert.ok(['recorded', 'not-recorded'].includes(m.evidence.locatorStatus));
    assert.ok(m.provenance.assertedBy.length > 0);
    assert.ok(m.provenance.basis.length > 0);
    assert.equal(m.link.rel, 'noopener noreferrer');
    assert.ok(m.citation.includes(String(m.paper.year)));
    assert.equal(m.datasetVersion, index.dataset.version);
    assert.equal(m.nameIndexVersion, index.nameIndexVersion);
  }
  assert.ok(cells > 20, `the fixture should cover enough cells to be worth checking, got ${cells}`);
});

test('a highlighted cell resolves back to its mapping through the index', () => {
  const r = browseByAnatomy(index, 'BV-L-043');
  assert.ok(r.mappings.length > 0);
  for (const m of r.mappings) {
    const roundTrip = index.mapping(m.mappingId);
    assert.ok(roundTrip, 'a mapping id from a highlight must resolve');
    assert.equal(roundTrip.findingId, m.findingId);
  }
});

// ---------------------------------------------------------------------------
// Region-level and unresolved markers
// ---------------------------------------------------------------------------

test('a finding with no spatial detail is flagged region-level, and still paintable', () => {
  const m = index.mapping('map:brodmann-1909-localisation/area-17/hcp-mmp1-v1');
  assert.ok(m);
  assert.equal(m.precision, 'region-level');
  assert.equal(m.regionLevelOnly, true);
  assert.equal(m.resolution, 'resolved');
  // The marker is required *and* the region is drawn: the missing thing is the
  // precision, not the region.
  assert.deepEqual([...m.covering.cells], ['BV-L-600', 'BV-R-600']);
});

test('a sub-region finding is not flagged region-level', () => {
  const m = index.mapping('map:amunts-1999-broca/area-44-variability/hcp-mmp1-44-posterior');
  assert.ok(m);
  assert.equal(m.precision, 'cells');
  assert.equal(m.regionLevelOnly, false);
  assert.deepEqual([...m.covering.cells], ['BV-L-041']);
});

test('coordinates with no template stay unresolved and do not become region-level', () => {
  // The fallback this must not do: show the structure's covering and let the
  // viewer render it as "region-level only". That would print a claim the data
  // does not make.
  const m = index.mapping('map:mazziotta-2001-icbm/peak-coordinates/hcp-mmp1-a1');
  assert.ok(m);
  assert.equal(m.resolution, 'unresolved');
  assert.equal(m.unresolvedReason, 'no-template');
  assert.equal(m.precision, 'coordinates');
  assert.equal(m.regionLevelOnly, false);
  assert.equal(m.covering.cells.length, 0, 'nothing is painted for a locus we cannot place');
  assert.ok(m.notes.some((n) => n.includes('no BV template')));
});

test('a selection reports its region-level and unresolved mappings separately', () => {
  const [selected] = paperSelection(index, [ICBM]);
  assert.equal(selected.unresolved.length, 1);
  assert.equal(selected.regionLevel.length, 3);
  // And the two sets do not overlap: an unresolved coordinate is not region-level.
  const ids = new Set(selected.regionLevel.map((m) => m.mappingId));
  for (const u of selected.unresolved) assert.ok(!ids.has(u.mappingId));
});

test('selectionExtent is the union of the selected papers coverings', () => {
  const sel = paperSelection(index, [GLASSER, ICBM]);
  const extent = selectionExtent(sel);
  for (const s of sel) {
    for (const cell of s.covering.cells) {
      assert.ok(
        extent.cells.some((c) => c === cell || cell.startsWith(`${c}-`) || c.startsWith(`${cell}-`)),
        `${cell} is missing from the selection extent`,
      );
    }
  }
});

/**
 * The parts of a research browse a filter must not be able to touch.
 *
 * Deliberately includes the mapping ids and the cells, because those are what a
 * leak would change. `test('the leak detector would catch a leak')` above is
 * the must-pass case proving this is sensitive enough.
 */
function summarise(r: ReturnType<typeof browseByResearch>) {
  return {
    selection: r.selection.map((s) => ({
      paperId: s.paper.id,
      cells: [...s.covering.cells],
      mappingIds: s.findings.flatMap((f) => f.mappings.map((m) => m.mappingId)),
    })),
  };
}
