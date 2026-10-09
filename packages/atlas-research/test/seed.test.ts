import { strict as assert } from 'node:assert';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { buildNameIndex, type NameIndex } from '../../alc/src/index.ts';
import { BRAIN_ADULT, buildBrainTemplate } from '../../alc/src/testing/syntheticTemplates.ts';
import { browseByAnatomy, browseByResearch, buildResearchIndex, loadDataset } from '../src/index.ts';
import { PKG_DIR, readJson, renameStructure } from './helpers.ts';

const RAW_NAMES = readJson('data/names-seed.json') as { version: string; structures: [] };
const seedNames: NameIndex = buildNameIndex({ version: RAW_NAMES.version, structures: RAW_NAMES.structures });
const seed = loadDataset(readJson('data/research-seed.json'));
const index = buildResearchIndex({ dataset: seed, names: seedNames });

// ---------------------------------------------------------------------------
// The dataset the issue asked for
// ---------------------------------------------------------------------------

test('the seed set is the size the plan asked for', () => {
  // §2 of the plan: "a small curated seed set (~30 papers, ~120 findings)".
  assert.equal(seed.papers.length, 30);
  assert.equal(seed.findings.length, 120);
  assert.equal(index.mappings.length, 170);
});

test('every paper has findings and every finding has mappings', () => {
  // The loader enforces both; asserted here so the committed dataset is pinned
  // and not merely loadable.
  for (const p of seed.papers) {
    const fs = index.findingsOf(p.id);
    assert.ok(fs.length > 0, `${p.id} has no findings`);
    for (const f of fs) assert.ok(f.mappings.length > 0, `${f.id} has no mappings`);
  }
});

test('the dataset says, per structure, which index should name it', () => {
  // The fields that would turn an honest partly-placeholder dataset into a
  // false claim in either direction: whole-dataset `fixture` understates the
  // crosswalked body structures, whole-dataset `real` overstates the brain.
  assert.equal(seed.authoredAgainst.status, 'partitioned');
  assert.equal(
    seed.authoredAgainst.nameIndexVersion,
    undefined,
    'no single index names this dataset, so no single version may be pinned as if one did',
  );
  const parts = seed.authoredAgainst.partitions ?? [];
  assert.equal(parts.length, 3);

  const body = parts.find((p) => p.id === 'body-bd');
  assert.ok(body);
  assert.equal(body.status, 'real');
  assert.equal(body.structureIds.length, 14);
  assert.ok(
    body.structureIds.every((id) => /^FMA\d+$/.test(id)),
    'the crosswalked ids are bare FMA concept ids, which is the form the BD index is keyed on',
  );
  assert.ok(body.nameIndexVersion.startsWith('bp3d-4.0+uberon-'), body.nameIndexVersion);
  assert.equal(body.reason, undefined, 'a resolvable partition has nothing to excuse');

  // The two placeholder partitions are a pass, and what makes them one is that
  // each records WHY, in the words of the decision that made it so. They are
  // kept apart because the reasons are different in kind: one is a licence
  // refusal that will not change, the other a coverage gap that might.
  for (const id of ['brain-parcellation', 'body-not-in-index']) {
    const part = parts.find((p) => p.id === id);
    assert.ok(part, id);
    assert.equal(part.status, 'placeholder');
    assert.ok((part.reason ?? '').length > 80, `${id} must record why, not gesture at it`);
  }
  assert.match(parts.find((p) => p.id === 'brain-parcellation').reason, /NOT CLEARED/);
  assert.match(parts.find((p) => p.id === 'brain-parcellation').reason, /no BV name index/i);
  assert.match(parts.find((p) => p.id === 'body-not-in-index').reason, /coverage gap/);

  assert.ok(seed.curation.notRecorded.length >= 3, 'the gaps are listed, not implied');
});

test('the synthetic index says it is synthetic', () => {
  const raw = readJson('data/names-seed.json') as { synthetic?: boolean; $comment?: string[] };
  assert.equal(raw.synthetic, true);
  assert.ok((raw.$comment ?? []).join(' ').includes('SYNTHETIC'));
});

// ---------------------------------------------------------------------------
// Citation honesty
// ---------------------------------------------------------------------------

test('a paper without a DOI carries its full citation instead', () => {
  // The curation policy, asserted rather than described. Every identifier here
  // was resolved against Crossref or PubMed (DOG-50, data/citation-report.json),
  // and a paper keeps `kind: "none"` only when no source returned a match —
  // both remaining cases are monographs. Such a paper must still be findable by
  // hand, which is what this asserts.
  const withoutDoi = seed.papers.filter((p) => p.identifier.kind === 'none');
  assert.ok(withoutDoi.length > 0, 'the policy is exercised');
  for (const p of withoutDoi) {
    assert.equal(p.identifier.value, null);
    assert.equal(p.sourceUrl, null, `${p.id} has no identifier but does have a URL`);
    assert.ok(p.authors.length > 0 && p.venue.length > 0 && p.year > 1800, `${p.id} is not resolvable by hand`);
  }
});

test('every recorded DOI is shaped like one and is the paper\'s own source URL', () => {
  const withDoi = seed.papers.filter((p) => p.identifier.kind === 'doi');
  assert.ok(withDoi.length >= 10, 'enough DOIs to be worth checking');
  for (const p of withDoi) {
    assert.match(p.identifier.value!, /^10\.\d{4,9}\/\S+$/, p.id);
    assert.equal(p.sourceUrl, `https://doi.org/${p.identifier.value}`, `${p.id}: URL and DOI disagree`);
  }
});

test('every curator inference says what was inferred', () => {
  const inferred = index.mappings.filter((m) => m.provenance.basis === 'curator-inference');
  assert.ok(inferred.length > 20, `the seed set leans on inference; found ${inferred.length}`);
  for (const m of inferred) {
    assert.ok(m.provenance.note && m.provenance.note.length > 20, `${m.mappingId} infers without saying what`);
  }
});

test('no mapping claims an evidence locator it did not record', () => {
  for (const m of index.mappings) {
    if (m.evidence.locatorStatus === 'not-recorded') assert.equal(m.evidence.locator, null, m.mappingId);
    else assert.ok(m.evidence.locator, m.mappingId);
  }
  // And the honest answer about this dataset: most locators are absent.
  const recorded = index.mappings.filter((m) => m.evidence.locatorStatus === 'recorded').length;
  assert.ok(
    recorded < index.mappings.length,
    'if every locator were recorded, the curation record would be overstating its gaps',
  );
});

// ---------------------------------------------------------------------------
// Resolution against the synthetic index — the stage-B rehearsal
// ---------------------------------------------------------------------------

test('against the index shipped here, every structure is NAMED and nothing is unknown', () => {
  // The one-sided bound that survives the crosswalk, and it is the reason the
  // crosswalked ids are in this index with no cells rather than absent from it.
  //
  // Three outcomes, and the distinction between the first two is the whole
  // point: `empty-covering` is "named here, painted elsewhere" — the cells of a
  // crosswalked body structure live in the asset package under a share-alike
  // licence. `unknown-structure` would be "nothing knows this id", which is
  // what a mistyped accession looks like. So a typo is still caught on a branch
  // where the asset index is absent, which is most branches.
  const byReason: Record<string, number> = {};
  for (const m of index.unresolved) byReason[m.unresolvedReason ?? '?'] = (byReason[m.unresolvedReason ?? '?'] ?? 0) + 1;
  assert.deepEqual(byReason, { 'empty-covering': 25, 'no-template': 3 }, JSON.stringify(byReason));

  assert.equal(
    index.mappings.filter((m) => m.unresolvedReason === 'unknown-structure').length,
    0,
    'every structure id this dataset uses is in the index shipped beside it, including the FMA ones',
  );
  for (const m of index.mappings) {
    assert.ok(m.structureLabelFromIndex, `${m.mappingId} fell back to the curated label`);
    if (m.resolution === 'resolved') assert.ok(m.covering.cells.length > 0, `${m.mappingId} resolved to nothing`);
  }

  // And the geometry claim is NOT made here: a body structure resolves to no
  // cells against this index, and paints only once the real one is joined in.
  const bodyIds = new Set(
    (seed.authoredAgainst.partitions ?? []).find((p) => p.status === 'real')?.structureIds ?? [],
  );
  const bodyRegionLevel = index.mappings.filter((m) => bodyIds.has(m.structureId) && m.precision === 'region-level');
  assert.equal(bodyRegionLevel.length, 25);
  for (const m of bodyRegionLevel) {
    assert.equal(m.resolution, 'unresolved', `${m.mappingId} claims geometry this package does not hold`);
  }
});

test('the resolution check can fail: an unknown structure is reported, not swallowed', () => {
  // The must-pass case for the test above. A gate that cannot go red is not a
  // gate, so this builds the failure it is supposed to catch and asserts it is
  // visible rather than silently resolving to something.
  const broken = renameStructure(readJson('data/research-seed.json'), 'HCP-MMP1:44', 'HCP-MMP1:not-a-real-structure');
  const brokenIndex = buildResearchIndex({ dataset: loadDataset(broken), names: seedNames });
  const hit = brokenIndex.unresolved.find((m) => m.structureId === 'HCP-MMP1:not-a-real-structure');
  assert.ok(hit, 'an unknown structure must surface as unresolved');
  assert.equal(hit.unresolvedReason, 'unknown-structure');
  assert.equal(hit.covering.cells.length, 0, 'and must paint nothing');
  assert.ok(hit.notes.some((n) => n.includes('not in name index')));
});

test('a curated sub-region stays inside the structure it is filed under', () => {
  // Against THIS index, two of the three are checked and the third cannot be:
  // FMA9968 has no cells here, so there is nothing to be inside of. That one is
  // checked against the real covering by tools/check-research-dataset.mjs,
  // which fails the `body-bd` partition if the cell is not a descendant — see
  // the `real-index-subregion-strays` case in tools/verify-gates.mjs. Said
  // plainly because a test that looks like it checks three and checks two is
  // worse than one that checks two.
  const subRegions = index.mappings.filter((m) => m.precision === 'cells');
  assert.equal(subRegions.length, 3);
  assert.equal(
    subRegions.filter((m) => index.dataset.authoredAgainst.partitions?.some(
      (p) => p.status === 'real' && p.structureIds.includes(m.structureId),
    )).length,
    1,
    'exactly one sub-region belongs to the partition whose containment the gate checks',
  );
  for (const m of subRegions) {
    // No disagreement note means the cells sit wholly inside the structure's
    // covering. A note here would be a curation defect worth seeing, which is
    // why it is a note rather than a silent intersection.
    assert.ok(
      !m.notes.some((n) => n.includes('lie inside') || n.includes('entirely outside')),
      `${m.mappingId}: ${m.notes.join(' | ')}`,
    );
  }
});

test('coordinates resolve once a template is supplied, and report clamping', () => {
  // The other half of the no-template state: the path works, it is the
  // template that is missing. Proven with a synthetic brain template rather
  // than asserted.
  const templates = { brainVolume: buildBrainTemplate(BRAIN_ADULT) };
  const withTemplate = buildResearchIndex({ dataset: seed, names: seedNames, templates });
  const coords = withTemplate.mappings.filter((m) => m.precision === 'coordinates');
  assert.equal(coords.length, 3);
  for (const m of coords) {
    assert.equal(m.resolution, 'resolved', `${m.mappingId}: ${m.notes.join(' | ')}`);
    assert.ok(m.covering.cells.length > 0);
    assert.equal(m.regionLevelOnly, false, 'a placed coordinate is not a region-level claim');
  }
});

// ---------------------------------------------------------------------------
// Both browse modes, over the seed set
// ---------------------------------------------------------------------------

test('browse-by-anatomy over the seed set finds the papers that share a region', () => {
  // Area 44's cell. Nine papers in the seed set say something about it, which
  // is the kind of pile-up the ranking and the overlap layers exist for.
  const r = browseByAnatomy(index, 'BV-L-000');
  assert.ok(r.papers.length >= 5, `expected several papers, got ${r.papers.length}`);
  for (const p of r.papers) assert.ok(p.mappingCount > 0);
  // Ranked by overlap measure descending.
  const measures = r.papers.map((p) => p.overlapMeasure);
  assert.deepEqual(measures, [...measures].sort((a, b) => b - a));
});

test('browse-by-anatomy reaches the body frame too', () => {
  const r = browseByAnatomy(index, 'BD-T07-03O');
  const ids = r.papers.map((p) => p.paper.id);
  assert.ok(ids.includes('paper:mitsuhashi-2009-bodyparts3d'), 'the whole-body paper maps the lung');
});

test('browse-by-research over the seed set narrows the list and never the selection', () => {
  const selected = ['paper:mazziotta-2001-icbm'];
  const unfiltered = browseByResearch(index, { selected });
  const filtered = browseByResearch(index, { selected, filter: index.paperCovering('paper:glasser-2016-mmp1') });
  assert.ok(filtered.list.length < unfiltered.list.length, 'the filter narrowed the list');
  assert.deepEqual(
    filtered.selection.map((s) => [...s.covering.cells]),
    unfiltered.selection.map((s) => [...s.covering.cells]),
    'the selection is unchanged',
  );
});

test('a topic filter narrows the list over the seed set', () => {
  const r = browseByResearch(index, { topics: ['spine'] });
  const ids = r.list.map((e) => e.paper.id);
  assert.ok(ids.includes('paper:bogduk-2012-lumbar-anatomy'));
  assert.ok(!ids.includes('paper:kanwisher-1997-fusiform-face-area'));
});

test('multi-paper selection over the seed set produces disjoint layers', () => {
  const selected = [
    'paper:glasser-2016-mmp1',
    'paper:brodmann-1909-localisation',
    'paper:amunts-1999-broca',
    'paper:eickhoff-2005-anatomy-toolbox',
  ];
  const r = browseByResearch(index, { selected });
  assert.ok(r.layers.layers.length > 0);
  assert.equal(r.layers.requiresSecondaryEncoding, true, 'four papers is past colour-alone');
  const all = r.layers.layers.flatMap((l) => [...l.covering.cells]);
  assert.equal(new Set(all).size, all.length, 'a cell appears in exactly one layer');
  assert.ok(r.layers.layers.some((l) => l.paperIds.length > 1), 'these four papers overlap');
});

// ---------------------------------------------------------------------------
// The data and its curation source do not drift
// ---------------------------------------------------------------------------

test('the committed data matches its curation source', () => {
  // Same shape as the audit-report drift check: if the JSON were edited by hand
  // the next regeneration would silently revert it, so the two are pinned to
  // each other.
  const run = spawnSync(process.execPath, [join(PKG_DIR, 'scripts', 'author-seed.mjs'), '--check'], {
    cwd: PKG_DIR,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `${run.stdout ?? ''}${run.stderr ?? ''}`);
});
