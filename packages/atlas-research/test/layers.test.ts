import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  buildNameIndex,
  contains,
  covering,
  coveringIntersect,
  coveringMeasure,
  coveringUnion,
  parse,
  type Covering,
} from '../../alc/src/index.ts';
import {
  assignPaperColours,
  buildResearchIndex,
  browseByResearch,
  COLOUR_ONLY_DISTINCT,
  hatchedExtent,
  loadDataset,
  MAX_COLOURED_PAPERS,
  nextColours,
  PAPER_PALETTE,
  pairOverlap,
  refine,
  solidColourLayers,
} from '../src/index.ts';
import { fixtureIndex } from './helpers.ts';

const index = fixtureIndex();

const GLASSER = 'paper:glasser-2016-mmp1';
const BRODMANN = 'paper:brodmann-1909-localisation';
const AMUNTS = 'paper:amunts-1999-broca';
const ICBM = 'paper:mazziotta-2001-icbm';
const BODYPARTS = 'paper:mitsuhashi-2009-bodyparts3d';

// ---------------------------------------------------------------------------
// A tiny purpose-built dataset, so a case can be constructed exactly
// ---------------------------------------------------------------------------

/**
 * Build a one-finding-per-paper index from `paperId -> cells`.
 *
 * Everything goes through `loadDataset`, so a case that could not be curated
 * cannot be tested either.
 */
function cellIndex(spec: Record<string, string[]>) {
  const slug = (id: string) => id.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const prov = {
    assertedBy: 'test',
    assertedOn: '2026-10-09',
    basis: 'published-coordinates',
    confidence: 'high',
  };
  const names = buildNameIndex({
    version: 'test-names-1',
    structures: Object.entries(spec).map(([id, cells]) => ({
      id: `TEST:${slug(id)}`,
      name: `structure for ${id}`,
      cells,
    })),
  });
  const dataset = loadDataset({
    schema: 'research/1',
    version: 'test-1',
    structureIdSources: ['TEST'],
    authoredAgainst: { nameIndexVersion: 'test-names-1', status: 'fixture' },
    curation: {
      curatedBy: 'test',
      curatedOn: '2026-10-09',
      method: 'constructed in test/layers.test.ts',
      citationCheck: 'not applicable',
      notRecorded: [],
    },
    papers: Object.keys(spec).map((id) => ({
      id: `paper:${slug(id)}`,
      title: `paper ${id}`,
      authors: ['Test A'],
      year: 2026,
      venue: 'Test',
      identifier: { kind: 'none', value: null },
      sourceUrl: null,
      provenance: prov,
    })),
    findings: Object.entries(spec).map(([id, cells]) => ({
      id: `finding:${slug(id)}`,
      paperId: `paper:${slug(id)}`,
      statement: `finding for ${id}`,
      topics: ['test'],
      provenance: prov,
      mappings: [
        {
          id: `map:${slug(id)}`,
          structureId: `TEST:${slug(id)}`,
          structureIdSource: 'TEST',
          structureLabel: `structure for ${id}`,
          spatial: {
            kind: 'cells',
            cells,
            method: 'constructed',
            digits: Math.max(...cells.map((c) => parse(c).digits.length)),
          },
          evidence: {
            summary: 'constructed',
            kind: 'abstract',
            locator: null,
            locatorStatus: 'not-recorded',
          },
          provenance: prov,
        },
      ],
    })),
  });
  return {
    index: buildResearchIndex({ dataset, names }),
    paperIds: Object.keys(spec).map((id) => `paper:${slug(id)}`),
  };
}

// ---------------------------------------------------------------------------
// Refinement
// ---------------------------------------------------------------------------

/** True when no cell of the set contains another. The disjointness invariant. */
function pairwiseDisjoint(cells: readonly string[]): boolean {
  for (const a of cells) {
    for (const b of cells) {
      if (a !== b && contains(a, b)) return false;
    }
  }
  return true;
}

const REFINEMENT_CASES: { name: string; input: string[][] }[] = [
  { name: 'identical', input: [['BV-L-1'], ['BV-L-1']] },
  { name: 'disjoint siblings', input: [['BV-L-1'], ['BV-L-2']] },
  { name: 'parent and child', input: [['BV-L-1'], ['BV-L-12']] },
  { name: 'parent and grandchild', input: [['BV-L-1'], ['BV-L-123']] },
  { name: 'three nested', input: [['BV-L-1'], ['BV-L-12'], ['BV-L-123']] },
  { name: 'two frames', input: [['BV-L-1', 'BD-T07-02O'], ['BV-L-12', 'BD-T07-02O-5']] },
  { name: 'partial sibling cover', input: [['BV-L-10', 'BV-L-11'], ['BV-L-100']] },
  { name: 'body anchors', input: [['BD-T07-02O'], ['BD-T07-02O-53'], ['BD-T07-03O']] },
];

for (const c of REFINEMENT_CASES) {
  test(`refine: atoms partition the union (${c.name})`, () => {
    const coverings = c.input.map((cells) => covering(cells));
    const { atoms, owners } = refine(coverings);

    assert.ok(pairwiseDisjoint(atoms), `atoms overlap: ${atoms.join(', ')}`);

    // Nothing gained, nothing lost: the atoms measure exactly the union.
    const union = coveringUnion(...coverings);
    const atomCovering = covering([...atoms]);
    assert.ok(
      Math.abs(coveringMeasure(atomCovering) - coveringMeasure(union)) < 1e-12,
      `measure drifted: atoms ${coveringMeasure(atomCovering)} vs union ${coveringMeasure(union)}`,
    );

    // An atom's owner set is exactly the inputs that contain it.
    atoms.forEach((atom, i) => {
      const expected = coverings
        .map((cov, j) => (cov.cells.some((cell) => contains(cell, atom)) ? j : -1))
        .filter((j) => j >= 0);
      assert.deepEqual([...owners[i]], expected, `wrong owners for ${atom}`);
      assert.ok(owners[i].length > 0, `${atom} belongs to nothing`);
    });
  });
}

test('refine: an empty input refines to nothing', () => {
  const r = refine([]);
  assert.equal(r.atoms.length, 0);
  assert.equal(r.owners.length, 0);
});

test('refine: the cell budget is enforced and named', () => {
  // A deep cut forces a split at every rung on the way down. With a budget of
  // one cell it must refuse rather than grind.
  assert.throws(
    () => refine([covering(['BV-L-1']), covering(['BV-L-12345'])], 1),
    (e: Error & { code?: string }) => e.code === 'refinement_too_large',
  );
});

// ---------------------------------------------------------------------------
// Overlap is covering intersection, never string equality
// ---------------------------------------------------------------------------

test('overlap is found between a parent and a child, where string equality finds none', () => {
  // The case the whole rule exists for. Two papers, one filing BV-L-1 and one
  // filing BV-L-12. The strings are different and the places overlap.
  const { index: ix, paperIds } = cellIndex({ coarse: ['BV-L-1'], fine: ['BV-L-12'] });
  const [coarse, fine] = paperIds;

  const coarseCells = new Set(ix.paperCovering(coarse).cells);
  const fineCells = new Set(ix.paperCovering(fine).cells);
  const sharedByString = [...coarseCells].filter((c) => fineCells.has(c));
  assert.deepEqual(sharedByString, [], 'string equality must find nothing here');

  const byIntersection = pairOverlap(ix, coarse, fine);
  assert.deepEqual([...byIntersection.cells], ['BV-L-12'], 'covering intersection finds the finer cell');

  const result = solidColourLayers(ix, paperIds);
  const overlapLayers = result.layers.filter((l) => l.paperIds.length === 2);
  assert.equal(overlapLayers.length, 1, 'the overlap must be one hatched layer');
  assert.deepEqual([...overlapLayers[0].covering.cells], ['BV-L-12']);
  assert.deepEqual([...hatchedExtent(result).cells], ['BV-L-12']);
});

test('loose and canonical spellings of one cell are one place, not two papers apart', () => {
  // `covering()` canonicalises, so a curator writing lower case does not create
  // a phantom non-overlap. Pinned because it is the other way string equality
  // goes wrong.
  const { index: ix, paperIds } = cellIndex({ upper: ['BV-L-12'], lower: ['bv-l-12'] });
  const overlap = pairOverlap(ix, paperIds[0], paperIds[1]);
  assert.deepEqual([...overlap.cells], ['BV-L-12']);
});

test('two-paper layers agree exactly with coveringIntersect', () => {
  const pairs: [string, string][] = [
    [GLASSER, BRODMANN],
    [GLASSER, AMUNTS],
    [GLASSER, ICBM],
    [BRODMANN, ICBM],
    [AMUNTS, BRODMANN],
    [GLASSER, BODYPARTS],
  ];
  for (const [a, b] of pairs) {
    const result = solidColourLayers(index, [a, b]);
    const hatched = hatchedExtent(result);
    const expected = pairOverlap(index, a, b);
    assert.deepEqual(
      [...hatched.cells],
      [...expected.cells],
      `the hatched extent of ${a} + ${b} disagrees with coveringIntersect`,
    );
  }
});

test('layers are disjoint and cover each paper exactly', () => {
  const selection = [GLASSER, BRODMANN, AMUNTS, ICBM];
  const result = solidColourLayers(index, selection);

  const allCells = result.layers.flatMap((l) => [...l.covering.cells]);
  assert.ok(pairwiseDisjoint(allCells), 'layers must not overlap each other');

  // Each paper's own covering is exactly the union of the layers it owns.
  for (const paperId of selection) {
    const mine = result.layers.filter((l) => l.paperIds.includes(paperId)).map((l) => l.covering);
    const reassembled: Covering = mine.length === 0 ? covering([]) : coveringUnion(...mine);
    const expected = index.paperCovering(paperId);
    assert.ok(
      Math.abs(coveringMeasure(reassembled) - coveringMeasure(expected)) < 1e-12,
      `${paperId}: layers reassemble to a different extent`,
    );
    assert.deepEqual([...reassembled.cells], [...expected.cells], `${paperId}: layers do not reassemble`);
  }
});

test('a three-paper overlap names all three and hatches at the three-plus angle', () => {
  const result = solidColourLayers(index, [GLASSER, BRODMANN, ICBM]);
  const triple = result.layers.find((l) => l.paperIds.length === 3);
  assert.ok(triple, 'V1 is mapped by all three papers');
  assert.deepEqual([...triple.covering.cells], ['BV-L-600', 'BV-R-600']);
  assert.equal(triple.hatchAngle, 135);
  assert.equal(triple.fill, null, 'an overlap is hatched, never filled with one paper\'s colour');
  assert.equal(triple.hatch.length, 3);
  for (const id of [GLASSER, BRODMANN, ICBM]) {
    assert.ok(triple.label.includes(index.paper(id)!.title), 'the label names every owner');
  }
});

test('a two-paper overlap hatches at 45 degrees and names both', () => {
  const result = solidColourLayers(index, [GLASSER, BRODMANN]);
  const pair = result.layers.find((l) => l.paperIds.length === 2);
  assert.ok(pair);
  assert.equal(pair.hatchAngle, 45);
  assert.equal(pair.hatch.length, 2);
});

test('a single-owner layer is filled, not hatched', () => {
  const result = solidColourLayers(index, [BODYPARTS]);
  assert.equal(result.layers.length, 1);
  assert.equal(result.layers[0].paperIds.length, 1);
  assert.equal(result.layers[0].hatchAngle, null);
  assert.deepEqual(result.layers[0].hatch, []);
  assert.equal(result.layers[0].fill?.slot, 1);
});

test('an unresolved mapping contributes no geometry and is reported', () => {
  const result = solidColourLayers(index, [ICBM]);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].unresolvedReason, 'no-template');
  const cells = result.layers.flatMap((l) => [...l.covering.cells]);
  assert.ok(!cells.includes('BV-L-300'), 'A1 is not painted from a coordinate we cannot place');
});

test('a paper with no resolved mapping is named rather than silently absent', () => {
  const { index: ix } = cellIndex({ only: ['BV-L-1'] });
  const result = solidColourLayers(ix, ['paper:missing']);
  assert.equal(result.layers.length, 0);
  assert.ok(result.notes.some((n) => n.includes('no resolved mapping')));
});

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

test('the palette is the validated set, in the validated order', () => {
  // This test exists to fail when somebody re-orders or re-steps the palette
  // without re-running the validator. The order is the colour-vision safety
  // mechanism, so changing it is a measurement, not a preference.
  assert.deepEqual(
    PAPER_PALETTE.map((s) => s.light),
    ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  );
  assert.deepEqual(
    PAPER_PALETTE.map((s) => s.slot),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(COLOUR_ONLY_DISTINCT, 3, 'measured: slot 4 fails the all-pairs normal-vision floor at 13.7');
  assert.equal(MAX_COLOURED_PAPERS, 8);
});

test('colours are assigned in slot order and never cycled', () => {
  const ids = Array.from({ length: 11 }, (_, i) => `paper:p${i}`);
  const colours = assignPaperColours(ids);
  assert.deepEqual(
    colours.slice(0, 8).map((c) => c.palette?.slot),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  for (const c of colours.slice(8)) {
    assert.equal(c.palette, null, 'a ninth series is never a generated hue');
  }
});

test('deselecting a paper does not repaint the survivors', () => {
  const first = assignPaperColours(['paper:a', 'paper:b', 'paper:c']);
  const after = nextColours(first, ['paper:a', 'paper:c']);
  assert.equal(after.find((c) => c.paperId === 'paper:a')?.palette?.slot, 1);
  assert.equal(after.find((c) => c.paperId === 'paper:c')?.palette?.slot, 3, 'c keeps slot 3, it does not slide to 2');

  // And the freed slot is reused by the next selection.
  const withD = nextColours(after, ['paper:a', 'paper:c', 'paper:d']);
  assert.equal(withD.find((c) => c.paperId === 'paper:d')?.palette?.slot, 2);
});

test('changing the anatomical filter does not repaint a selection', () => {
  // Colour follows the paper, not its rank in the list. The filter changes the
  // list; the selection's colours must be identical.
  const selected = [GLASSER, BRODMANN, ICBM];
  const unfiltered = browseByResearch(index, { selected });
  const filtered = browseByResearch(index, {
    selected,
    filter: covering(['BV-L-04']),
    colours: unfiltered.layers.colours,
  });
  assert.deepEqual(
    filtered.layers.colours.map((c) => [c.paperId, c.palette?.slot]),
    unfiltered.layers.colours.map((c) => [c.paperId, c.palette?.slot]),
  );
});

test('past three papers the result demands secondary encoding', () => {
  const three = solidColourLayers(index, [GLASSER, BRODMANN, AMUNTS]);
  assert.equal(three.requiresSecondaryEncoding, false);

  const four = solidColourLayers(index, [GLASSER, BRODMANN, AMUNTS, ICBM]);
  assert.equal(four.requiresSecondaryEncoding, true);
  assert.ok(four.notes.some((n) => n.includes('direct label')));
});

test('every layer carries a label, so identity is never colour alone', () => {
  const result = solidColourLayers(index, [GLASSER, BRODMANN, AMUNTS, ICBM, BODYPARTS]);
  for (const l of result.layers) {
    assert.ok(l.label.length > 0, 'a layer without a label is identifiable by colour alone');
  }
});

test('more selected papers than slots are listed as uncoloured, not given a new hue', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `paper:p${i}`);
  const { index: ix } = cellIndex({ only: ['BV-L-1'] });
  const result = solidColourLayers(ix, ids);
  assert.equal(result.uncoloured.length, 2);
  assert.ok(result.notes.some((n) => n.includes('fold them into "other"')));
});

test('the per-paper extent is the union of its resolved mappings', () => {
  for (const paperId of [GLASSER, BRODMANN, AMUNTS, ICBM, BODYPARTS]) {
    const parts = index
      .mappingsOf(paperId)
      .filter((m) => m.resolution === 'resolved')
      .map((m) => m.covering);
    const expected = parts.length === 0 ? covering([]) : coveringUnion(...parts);
    assert.deepEqual([...index.paperCovering(paperId).cells], [...expected.cells], paperId);
  }
});

test('an intersection of disjoint papers is empty, and produces no hatch', () => {
  const result = solidColourLayers(index, [GLASSER, BODYPARTS]);
  assert.equal(coveringIntersect(index.paperCovering(GLASSER), index.paperCovering(BODYPARTS)).cells.length, 0);
  assert.equal(result.layers.filter((l) => l.paperIds.length > 1).length, 0);
  assert.equal(hatchedExtent(result).cells.length, 0);
});
