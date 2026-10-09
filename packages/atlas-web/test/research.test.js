/**
 * The research layer: the filter, the reveal, and the comparison.
 *
 * The §7 journey's middle three steps — region research, a paper revealing all
 * its regions, comparing papers — plus the rule they exist to protect: an
 * anatomical filter narrows the paper LIST and never a selected paper's own
 * mappings.
 *
 * Driven against the 5-paper fixture corpus, which is what v1 ships today.
 * DOG-37's curated 30-paper set is a different branch and a different issue;
 * what is asserted here is the viewer's behaviour, which is corpus
 * independent, and the fixture is deliberately shaped to reach the hard cases
 * the real corpus will also contain: FXP-4 maps findings in two atlases, and
 * FXP-5 reports a region with no level and no side and so has no mappings at
 * all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { overlaps } from '../src/alc.js';
import {
  ResearchError,
  comparePapers,
  papersOverlapping,
  researchModel,
  revealPaper,
} from '../src/viewer/research.js';
import { createViewer } from '../src/viewer/state.js';
import { realAssets, realTemplates } from './real-assets.js';
import { research } from './support.js';

const model = () => researchModel(research());

describe('the research document is validated at load, not at draw time', () => {
  it('accepts the shipped fixture and parses every mapped address', () => {
    const m = model();
    assert.equal(m.papers.length, 5);
    for (const paper of m.papers) {
      for (const cell of paper.cells) {
        assert.ok(['BD', 'BV'].includes(cell.frame), cell.address);
        assert.ok(['body', 'brain'].includes(cell.atlas), cell.address);
      }
    }
  });

  it('rejects a mapping that is not a valid address', () => {
    const doc = research();
    doc.papers[0].findings[0].cells = ['BD-C08-03O'];
    assert.throws(
      () => researchModel(doc),
      (e) => e instanceof ResearchError && /not a valid address/.test(e.message),
    );
  });

  it('rejects an unplaced finding that gives no reason for being unplaced', () => {
    // Otherwise an unplaceable report and a lost mapping look identical.
    const doc = research();
    doc.papers[0].findings[0].cells = [];
    assert.throws(
      () => researchModel(doc),
      (e) => e instanceof ResearchError && /unplaceable report from a lost mapping/.test(e.message),
    );
  });

  it('keeps an unplaced finding that does explain itself', () => {
    const paper = model().papers.find((p) => p.id === 'FXP-5');
    assert.equal(paper.findings.length, 1);
    assert.equal(paper.findings[0].placed, false);
    assert.match(paper.findings[0].regionOnly, /no level or side/);
    assert.deepEqual(paper.cells, []);
  });

  it('rejects a duplicated paper id', () => {
    const doc = research();
    doc.papers.push({ ...doc.papers[0] });
    assert.throws(() => researchModel(doc), ResearchError);
  });
});

describe('the filter narrows the paper list by overlap, not by string equality', () => {
  it('finds a paper that mapped a cell inside the selection', () => {
    // FXP-1 maps BD-T07-06O. Selecting the whole level must find it, and the
    // two addresses are not equal as strings.
    const found = papersOverlapping(model(), 'BD-T07');
    const ids = found.map((f) => f.paper.id);
    assert.ok(ids.includes('FXP-1'));
    assert.ok(!ids.includes('FXP-3'), 'a lumbar paper is not a thoracic result');
    const fxp1 = found.find((f) => f.paper.id === 'FXP-1');
    assert.ok(fxp1.matching.length > 0);
    assert.ok(fxp1.matching.every((c) => overlaps(c.address, 'BD-T07')));
    assert.ok(fxp1.matching.every((c) => c.address !== 'BD-T07'), 'matched by overlap, not equality');
  });

  it('finds a paper that mapped a cell CONTAINING the selection', () => {
    // The other direction: FXP-4 maps BD-T04-12O; selecting a cell inside it
    // must still find the paper. Testing one direction only loses every paper
    // mapped more coarsely than the selection.
    const found = papersOverlapping(model(), 'BD-T04-12O-531');
    assert.ok(found.map((f) => f.paper.id).includes('FXP-4'));
  });

  it('narrows to nothing where no paper mapped anything', () => {
    assert.deepEqual(papersOverlapping(model(), 'BD-C03-06O'), []);
  });

  it('treats no filter as no narrowing, rather than as an empty filter', () => {
    const all = papersOverlapping(model(), null);
    assert.equal(all.length, 5);
    assert.ok(all.every((f) => f.filtered === false));
    // An unparseable filter is also not a filter that excludes everything.
    assert.equal(papersOverlapping(model(), 'not an address').length, 5);
  });

  it('filters a brain selection to the brain paper', () => {
    const found = papersOverlapping(model(), 'BV-L-47');
    assert.deepEqual(found.map((f) => f.paper.id), ['FXP-4']);
  });
});

describe('a selected paper reveals ALL its mappings, never the filtered subset', () => {
  it('reveals every cell of a paper whose mappings span two atlases', () => {
    const m = model();
    const revealed = revealPaper(m, 'FXP-4');
    const paper = m.papers.find((p) => p.id === 'FXP-4');
    assert.equal(revealed.cells.length, paper.cells.length);
    assert.deepEqual(revealed.atlases, ['body', 'brain']);
    assert.equal(revealed.findings.length, 2);
  });

  it('reveals the same set regardless of the active filter', () => {
    const m = model();
    // A thoracic filter that matches exactly one of FXP-4's three cells.
    const unfiltered = revealPaper(m, 'FXP-4');
    const filtered = revealPaper(m, 'FXP-4', 'BD-T04');
    assert.deepEqual(
      filtered.cells.map((c) => c.address),
      unfiltered.cells.map((c) => c.address),
      'the filter must not remove a single mapping',
    );
    // What the filter may do is annotate.
    assert.ok(filtered.outsideFilter > 0, 'and it says how many fall outside');
    assert.equal(filtered.cells.filter((c) => c.withinFilter === true).length, 1);
    assert.equal(unfiltered.outsideFilter, 0, 'no filter means nothing is outside it');
    assert.ok(unfiltered.cells.every((c) => c.withinFilter === null));
  });

  it('keeps the brain mapping of a body-filtered paper visible', () => {
    // The concrete version of the rule: filtering to the thorax must not hide
    // the fact that this paper also reported a thalamic lesion.
    const revealed = revealPaper(model(), 'FXP-4', 'BD-T04');
    const brain = revealed.cells.filter((c) => c.atlas === 'brain');
    assert.ok(brain.length > 0, 'a brain mapping survives a body filter');
    assert.ok(brain.every((c) => c.withinFilter === false));
  });

  it('counts an unplaced finding rather than dropping it', () => {
    const revealed = revealPaper(model(), 'FXP-5', 'BD-T07');
    assert.equal(revealed.findings.length, 1);
    assert.equal(revealed.unplaced, 1);
    assert.deepEqual(revealed.cells, []);
  });

  it('returns null for a paper that is not in the corpus', () => {
    assert.equal(revealPaper(model(), 'FXP-nope'), null);
  });

  it('cannot be asked to filter: revealPaper takes no filter that removes rows', () => {
    // The structural half of the rule. `activeFilter` only annotates, so even
    // a caller that passes a filter matching nothing gets everything.
    const revealed = revealPaper(model(), 'FXP-2', 'BV-L-47');
    const paper = model().papers.find((p) => p.id === 'FXP-2');
    assert.equal(revealed.cells.length, paper.cells.length);
    assert.equal(revealed.outsideFilter, paper.cells.length);
  });
});

describe('comparing two papers meets them by overlap', () => {
  it('finds the place two papers both reported, at different precisions', () => {
    // FXP-1 maps BD-T07-05O/07O; FXP-2 maps BD-T07-02O/03O. Disjoint azimuths.
    const disjoint = comparePapers(model(), 'FXP-1', 'FXP-2');
    assert.equal(disjoint.disjoint, true);
    assert.deepEqual(disjoint.shared, []);
    assert.ok(disjoint.onlyA.length > 0 && disjoint.onlyB.length > 0);
  });

  it('pairs the overlapping cells rather than inventing one address for them', () => {
    // Compare a paper with itself: every cell overlaps its twin, and the
    // result is pairs, because with unequal precision there is no single
    // address that is "the" overlap.
    const same = comparePapers(model(), 'FXP-3', 'FXP-3');
    assert.equal(same.disjoint, false);
    assert.ok(same.shared.length > 0);
    assert.deepEqual(same.onlyA, []);
    assert.deepEqual(same.onlyB, []);
    for (const pair of same.shared) {
      assert.ok(overlaps(pair.a.address, pair.b.address));
    }
  });

  it('says disjoint plainly, so "no overlap" is not read as "not compared"', () => {
    const across = comparePapers(model(), 'FXP-3', 'FXP-4');
    assert.equal(across.disjoint, true);
    assert.equal(across.shared.length, 0);
  });

  it('returns null when either paper is missing', () => {
    assert.equal(comparePapers(model(), 'FXP-1', 'nope'), null);
  });
});

describe('research runs against the real templates without moving the atlas', () => {
  it('reveals a cross-atlas paper and every revealed cell still resolves', () => {
    const t = realTemplates();
    const { nameIndex } = realAssets();
    const v = createViewer({ templates: t, nameIndex });
    const revealed = revealPaper(model(), 'FXP-4', 'BD-T04');

    // Selecting each revealed cell resolves on the real templates, and none of
    // them moves the atlas — including the brain ones.
    for (const cell of revealed.cells) {
      const selected = v.select(cell.address);
      assert.ok(selected.ok, cell.address);
      assert.equal(v.atlas, 'body', `${cell.address} must not switch the atlas`);
      assert.ok(selected.pointMm.every(Number.isFinite), cell.address);
      if (cell.atlas === 'brain') {
        assert.equal(selected.elsewhere, 'brain', 'it offers, rather than teleports');
        assert.equal(selected.names.covered, false, 'and BV still has no names');
      } else {
        assert.equal(selected.names.covered, true);
      }
    }
  });

  it('finds the papers that mapped a region of the real body', () => {
    const found = papersOverlapping(model(), 'BD-T07-03O');
    // FXP-2 maps BD-T07-03O exactly; the cell also resolves to real anatomy.
    assert.ok(found.map((f) => f.paper.id).includes('FXP-2'));
    const model2 = selectFor('BD-T07-03O');
    assert.ok(model2.names.matches.length > 0);
  });
});

/** One selection on the real templates, for the assertion above. */
function selectFor(address) {
  const v = createViewer({ templates: realTemplates(), nameIndex: realAssets().nameIndex });
  return v.select(address);
}
