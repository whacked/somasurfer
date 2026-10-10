/**
 * The curated 30-paper corpus, resolved against the real name index.
 *
 * A separate file from `research.test.js` for the reason `real-assets.test.js`
 * is separate from `honesty.test.js`: the subject differs. `research.test.js`
 * asserts the viewer's corpus-independent behaviour — what the filter narrows,
 * what a reveal returns — against the fixture. This file asserts what the join
 * actually yields when the real dataset meets the real index, which is a
 * measurement and not a behaviour.
 *
 * ## Why the counts are asserted as literals
 *
 * Because the failure they guard against is silent. Every one of these numbers
 * could go to zero through a join bug — a changed id namespace, a version
 * mismatch, partitions drifting from the mappings — and the page would render a
 * paper list with nothing painted, which is exactly what the page is SUPPOSED
 * to look like for the 139 that genuinely cannot be placed. There is no visual
 * difference between "20 papers legitimately have no geometry" and "the join
 * broke". A number is the only thing that tells them apart, so the number is
 * pinned and a regression reports as arithmetic.
 *
 * They are measurements, not targets. If the cleared index grows, these go up,
 * and raising them is the correct response — after checking that the new
 * resolutions are ones the index really made.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CURATED_CORPUS_RESOLUTION } from '../catalogue/asset-templates.mjs';
import { curatedModel } from '../src/viewer/corpus.js';
import { papersOverlapping, revealPaper } from '../src/viewer/research.js';
import { realAssets, realTemplates } from './real-assets.js';
import { curatedSeed } from './support.js';

/** The index version every count below is relative to. */
const NAME_INDEX_VERSION =
  'bp3d-4.0+uberon-uberon/releases/2026-10-01/uberon-basic.owl+8772477294da';

let cached = null;
/** Resolved once: the name index build in front of the join costs ~2.5 s. */
function corpus() {
  if (!cached) {
    cached = curatedModel(curatedSeed(), {
      names: realAssets().nameIndex,
      templates: realTemplates(),
    });
  }
  return cached;
}

const allMappings = (model) => model.papers.flatMap((p) => p.findings.flatMap((f) => f.mappings));

describe('the curated corpus resolves against the index the page binds', () => {
  it('is the curated dataset, and says so', () => {
    const model = corpus();
    assert.equal(model.role, 'curated');
    assert.equal(model.version, 'research-seed-2026.10.1');
    assert.equal(model.papers.length, 30);
    assert.equal(model.papers.reduce((n, p) => n + p.findings.length, 0), 120);
    // The resolution is only true relative to an index, so the index it was
    // resolved against travels with it — boundary 2 in the plan's §3, applied
    // to a research result rather than to a name list.
    assert.equal(model.nameIndexVersion, NAME_INDEX_VERSION);
  });

  it('places 31 of 170 mappings, across 10 of 30 papers and 24 of 120 findings', () => {
    const { resolution } = corpus();
    assert.deepEqual(resolution.mappings, { resolved: 31, total: 170 });
    assert.deepEqual(resolution.papers, { withGeometry: 10, total: 30 });
    assert.deepEqual(resolution.findings, { withGeometry: 24, total: 120 });
  });

  it('counts the same mappings in the model as in the summary', () => {
    // The summary is read off the resolver and the model is built from it, so
    // the two could disagree only through a bug in this module. Checked because
    // `atlas-index.json` publishes the summary and the panel renders the model,
    // and a reader comparing them has no way to know which one to believe.
    const model = corpus();
    const mappings = allMappings(model);
    assert.equal(mappings.length, model.resolution.mappings.total);
    assert.equal(
      mappings.filter((m) => m.placed).length,
      model.resolution.mappings.resolved,
    );
  });

  it('without templates, loses the three coordinate mappings and says so in the count', () => {
    // The argument for passing the templates, as a measurement rather than an
    // assertion. Resolved separately because this is the one case the memoised
    // corpus cannot show.
    const without = curatedModel(curatedSeed(), { names: realAssets().nameIndex });
    assert.deepEqual(without.resolution.mappings, { resolved: 28, total: 170 });
    assert.deepEqual(without.resolution.papers, { withGeometry: 8, total: 30 });
    const noTemplate = allMappings(without).filter((m) => m.unresolved?.reason === 'no-template');
    assert.equal(noTemplate.length, 3);
    // The resolver's own sentence, forwarded rather than partition-washed: the
    // structure was found, the geometry was the problem, and a partition has
    // nothing to say about that.
    for (const m of noTemplate) {
      assert.match(m.unresolved.headline, /no BV template is loaded|no BD template is loaded/);
      assert.equal(m.unresolved.partitionStatus, 'placeholder');
    }
  });
});

describe('the residue says what is true, and never "unknown structure"', () => {
  it('explains all 139 from the partition that predicted them', () => {
    const unresolved = allMappings(corpus()).filter((m) => !m.placed);
    assert.equal(unresolved.length, 139);
    for (const m of unresolved) {
      assert.equal(m.unresolved.reason, 'placeholder-partition');
      assert.equal(m.unresolved.partitionStatus, 'placeholder');
    }
  });

  it('never tells a reader the structure is unknown', () => {
    // DOG-46 reserved those words for a mistyped accession. The resolver still
    // reports `unknown-structure` as its mechanism for all 139 — asserted here,
    // so this test cannot pass by the mechanism having quietly changed — and
    // not one of them reaches a reader saying so.
    const unresolved = allMappings(corpus()).filter((m) => !m.placed);
    assert.ok(unresolved.every((m) => m.notes.some((n) => /is not in name index/.test(n))));
    for (const m of unresolved) {
      assert.doesNotMatch(m.unresolved.headline, /unknown structure/i);
      assert.notEqual(m.unresolved.reason, 'unknown-structure');
    }
  });

  it('splits the 139 by cause, because 4 of them are not about licensing', () => {
    // The brain partition and the coverage-gap partition are separate in the
    // dataset on purpose. One sentence over both would say "not licence-cleared"
    // about a rib.
    const unresolved = allMappings(corpus()).filter((m) => !m.placed);
    const byPartition = new Map();
    for (const m of unresolved) {
      byPartition.set(
        m.unresolved.partitionId,
        (byPartition.get(m.unresolved.partitionId) ?? 0) + 1,
      );
    }
    assert.deepEqual(
      Object.fromEntries(byPartition),
      { 'brain-parcellation': 135, 'body-not-in-index': 4 },
    );

    const detailOf = (partitionId) =>
      unresolved.find((m) => m.unresolved.partitionId === partitionId).unresolved.detail;
    // Each cause is the partition's own recorded reason, verbatim. The licence
    // verdict is quoted rather than paraphrased because a paraphrase of a
    // licence verdict is a new claim about a licence.
    assert.match(detailOf('brain-parcellation'), /VERDICT: NOT CLEARED/);
    assert.match(detailOf('body-not-in-index'), /coverage gap in the index rather than a licence refusal/);
    assert.doesNotMatch(detailOf('body-not-in-index'), /NOT CLEARED/);
  });

  it('would say "unknown structure" for an id declared against this very index', () => {
    // The must-pass case. Without it, "never says unknown structure" is
    // satisfied by a module that has deleted the words entirely, and the
    // genuine mistyped-accession case — the one DOG-46 reserved them for —
    // would be reported as a licence problem.
    const seed = curatedSeed();
    const partitions = seed.authoredAgainst.partitions.map((p) =>
      p.id === 'brain-parcellation'
        ? { ...p, status: 'real', nameIndexVersion: NAME_INDEX_VERSION, reason: undefined }
        : p);
    const planted = curatedModel(
      { ...seed, authoredAgainst: { ...seed.authoredAgainst, partitions } },
      { names: realAssets().nameIndex, templates: realTemplates() },
    );
    const moved = allMappings(planted)
      .filter((m) => !m.placed && m.unresolved.partitionId === 'brain-parcellation');
    assert.equal(moved.length, 135);
    for (const m of moved) {
      assert.equal(m.unresolved.reason, 'unknown-structure');
      assert.match(m.unresolved.headline, /^Unknown structure: /);
    }
    // And the coverage-gap partition is untouched by that edit, so the two
    // really are keyed independently rather than sharing one branch.
    const gap = allMappings(planted).filter((m) => m.unresolved?.partitionId === 'body-not-in-index');
    assert.equal(gap.length, 4);
    assert.ok(gap.every((m) => m.unresolved.reason === 'placeholder-partition'));
  });
});

describe('nothing is placed that the index did not place', () => {
  it('gives an unresolved mapping no cells at all', () => {
    for (const m of allMappings(corpus())) {
      if (!m.placed) assert.deepEqual(m.cells, []);
    }
  });

  it('paints no cell outside the coverings the index supplied', () => {
    // The strong form: every cell the model would paint is traceable to the
    // name index or to a template, and there are 1741 of them. A fallback to a
    // structure's covering, a synthetic index, or an inferred position would
    // all show up here as a cell with no source.
    const { nameIndex } = realAssets();
    // Set membership on a cell key, and deliberately not `overlaps()`. The
    // question is provenance, not geometry: did this exact cell come OUT of
    // the index. An overlap test would accept a fabricated cell that merely
    // fell inside a real structure, which is the fallback being ruled out.
    const fromIndex = new Set(nameIndex.coverings.flatMap((c) => c.cells));
    const model = corpus();
    const painted = model.papers.flatMap((p) => p.cells.map((c) => c.address));
    assert.equal(painted.length, 1741);

    // Curated `cells` and `coordinates` mappings carry their own geometry, so
    // they are legitimately outside the index's coverings. Everything resolved
    // at `region-level` must come from the index and nowhere else: 31 resolved,
    // less 3 `coordinates` and 3 `cells`, is 25. Note that this is not the same
    // split as the per-partition one — `body-bd` resolves 26, one of which is
    // Panjabi 1991's curated cells rather than a region-level covering.
    const regionLevel = allMappings(model).filter((m) => m.placed && m.regionLevelOnly);
    assert.equal(regionLevel.length, 25);
    for (const m of regionLevel) {
      for (const cell of m.cells) {
        assert.ok(
          fromIndex.has(cell.address),
          `${m.id} paints ${cell.address}, which is in no covering of ${NAME_INDEX_VERSION}`,
        );
      }
    }
  });

  it('distinguishes placed-and-named from placed-but-unnameable', () => {
    // 5 of the 31 resolve in the placeholder brain partition, because `cells`
    // and `coordinates` mappings never needed the index to name anything. Real
    // extent, curated label. Shown as such, or a curated label is silently
    // promoted to an index name.
    const model = corpus();
    assert.equal(model.resolution.placedUnnameable, 5);
    const unnameable = allMappings(model).filter((m) => m.placed && !m.labelFromIndex);
    assert.equal(unnameable.length, 5);
    for (const m of unnameable) {
      assert.ok(m.cells.length > 0);
      assert.equal(m.structureLabel, m.structureLabelCurated);
      assert.ok(m.precision === 'cells' || m.precision === 'coordinates');
    }
  });
});

describe('a paper with no placed geometry is still a paper', () => {
  it('lists all 30 when nothing is selected, geometry or not', () => {
    const model = corpus();
    assert.equal(papersOverlapping(model, null).length, 30);
    const empty = model.papers.filter((p) => p.cells.length === 0);
    assert.equal(empty.length, 20);
    assert.ok(empty.every((p) => papersOverlapping(model, null).some((e) => e.paper.id === p.id)));
  });

  it('reveals Brodmann 1909: 6 of 6 mappings, none of them painted', () => {
    const revealed = revealPaper(corpus(), 'paper:brodmann-1909-localisation');
    assert.equal(revealed.mappings.length, 6);
    assert.equal(revealed.unresolvedMappings, 6);
    assert.deepEqual(revealed.cells, []);
    // Still described, one by one, rather than collapsed into a single notice.
    assert.ok(revealed.mappings.every((m) => m.unresolved.headline.length > 0));
    // And every finding says why it has no extent, which is what stops the
    // panel reading as a load failure.
    assert.ok(revealed.findings.every((f) => !f.placed && f.regionOnly !== null));
  });

  it('reveals Mitsuhashi 2009: 9 of 9 mappings, 7 of them painted', () => {
    const revealed = revealPaper(corpus(), 'paper:mitsuhashi-2009-bodyparts3d');
    assert.equal(revealed.mappings.length, 9);
    assert.equal(revealed.mappings.filter((m) => m.placed).length, 7);
    assert.equal(revealed.unresolvedMappings, 2);
    assert.ok(revealed.cells.length > 0);
  });

  it('reveals the same mappings under every filter, including one that excludes the paper', () => {
    // The §3 guarantee, measured on the corpus that makes it matter: 20 of
    // these 30 papers have no geometry, so a filter-leaked reveal would empty
    // the panel for two thirds of the corpus and look like correct behaviour.
    const model = corpus();
    const strip = (r) => r.mappings.map((m) => ({ id: m.id, placed: m.placed, n: m.cells.length }));
    for (const paperId of ['paper:brodmann-1909-localisation', 'paper:mitsuhashi-2009-bodyparts3d']) {
      const baseline = strip(revealPaper(model, paperId, null));
      for (const filter of ['BD-T07', 'BD-L03-05O', 'BV-L-0000', 'BD-C01', 'not-an-address']) {
        assert.deepEqual(
          strip(revealPaper(model, paperId, filter)),
          baseline,
          `${paperId} revealed a different mapping set under filter ${filter}`,
        );
      }
    }
  });

  it('annotates revealed cells with the filter instead of removing them', () => {
    const model = corpus();
    const revealed = revealPaper(model, 'paper:mitsuhashi-2009-bodyparts3d', 'BD-T07');
    assert.equal(revealed.mappings.length, 9);
    assert.ok(revealed.outsideFilter > 0, 'the filter should exclude some of this paper');
    assert.ok(revealed.cells.some((c) => c.withinFilter === true));
    assert.ok(revealed.cells.some((c) => c.withinFilter === false));
    // An unresolved mapping has no cells, so it never acquires a withinFilter.
    for (const m of revealed.mappings) {
      if (!m.placed) assert.deepEqual(m.cells, []);
    }
  });
});

describe('the partitions reach the surface', () => {
  it('reports each partition with its structure count and its reason', () => {
    const { partitions } = corpus();
    assert.deepEqual(
      partitions.map((p) => [p.id, p.status, p.structureCount]),
      [
        ['body-bd', 'real', 14],
        ['brain-parcellation', 'placeholder', 46],
        ['body-not-in-index', 'placeholder', 3],
      ],
    );
    // A placeholder with no reason is a partition that refuses to say why, and
    // the schema forbids it; a `real` one carrying a reason would be a cause
    // for a failure that is not supposed to happen.
    for (const p of partitions) {
      if (p.status === 'placeholder') assert.ok(p.reason && p.reason.length > 0);
      else assert.equal(p.reason, null);
    }
  });

  it('measures the per-partition split the panel groups by', () => {
    assert.deepEqual(
      corpus().resolution.byPartition,
      [
        { partitionId: 'body-bd', resolved: 26, unresolved: 0 },
        { partitionId: 'brain-parcellation', resolved: 5, unresolved: 135 },
        { partitionId: 'body-not-in-index', resolved: 0, unresolved: 4 },
      ],
    );
  });

  it('refuses to resolve the corpus with no name index at all', () => {
    // Not "resolve everything to nothing". 170 unplaceable mappings because the
    // index failed to fetch is indistinguishable, on screen, from 170 the index
    // genuinely cannot name.
    assert.throws(() => curatedModel(curatedSeed(), { templates: realTemplates() }), {
      name: 'ResearchError',
      message: /no name index was loaded/,
    });
  });

  it('matches the resolution the catalogue declares and the index publishes', () => {
    // The declaration exists because the build cannot measure this — rule 6
    // keeps the name index out of `dist/data/`. A declared number that nobody
    // re-measures is the failure mode `maxUsefulDigits` was kept out of the
    // catalogue to avoid, so it is re-measured here, on the committed tree.
    const model = corpus();
    assert.equal(
      CURATED_CORPUS_RESOLUTION.againstNameIndexVersion,
      model.nameIndexVersion,
      'the catalogue declares a resolution against an index this page does not bind',
    );
    assert.equal(CURATED_CORPUS_RESOLUTION.resolvedMappings, model.resolution.mappings.resolved);
    assert.equal(
      CURATED_CORPUS_RESOLUTION.unresolvedMappings,
      model.resolution.mappings.total - model.resolution.mappings.resolved,
    );
    assert.equal(CURATED_CORPUS_RESOLUTION.papersWithGeometry, model.resolution.papers.withGeometry);
    assert.equal(
      CURATED_CORPUS_RESOLUTION.findingsWithGeometry,
      model.resolution.findings.withGeometry,
    );
    assert.equal(CURATED_CORPUS_RESOLUTION.placedUnnameable, model.resolution.placedUnnameable);
    assert.deepEqual(
      CURATED_CORPUS_RESOLUTION.byPartition.map((p) => ({ ...p })),
      model.resolution.byPartition.map((p) => ({ ...p })),
    );
  });

  it('refuses a dataset that is not research/1', () => {
    assert.throws(
      () => curatedModel({ role: 'curated', version: 'x', papers: [] }, {
        names: realAssets().nameIndex,
      }),
      { name: 'ResearchError', message: /curated research dataset was refused/ },
    );
  });
});
