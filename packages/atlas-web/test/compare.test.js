// DOG-115: comparing two papers is drawn, not only described. The shell paints
// `comparisonLayers()` as-is, so its contents are the drawing's contents.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contains, overlaps } from '../src/alc.js';
import { comparePapers, comparisonLayers, researchModel } from '../src/viewer/research.js';

const model = researchModel({
  version: 'compare-test',
  role: 'fixture',
  caveat: 'invented',
  papers: [
    {
      id: 'p:a',
      title: 'A',
      findings: [
        { id: 'a1', label: 'coarse', cells: ['BD-T07'] },
        { id: 'a2', label: 'elsewhere', cells: ['BD-T03'] },
      ],
    },
    {
      id: 'p:b',
      title: 'B',
      findings: [
        { id: 'b1', label: 'fine', cells: ['BD-T07-03O'] },
        { id: 'b2', label: 'unshared', cells: ['BD-L02'] },
        { id: 'b3', label: 'nowhere', regionOnly: 'not placed' },
      ],
    },
  ],
});

test('both papers are layered whole, each cell naming its paper and finding', () => {
  const layers = comparisonLayers(model, 'p:a', 'p:b');
  assert.deepEqual(layers.cells.a.map((c) => [c.paperId, c.findingId]), [['p:a', 'a1'], ['p:a', 'a2']]);
  assert.deepEqual(layers.cells.b.map((c) => [c.paperId, c.findingId]), [['p:b', 'b1'], ['p:b', 'b2']]);
});

test('the overlap is the covering intersection: the finer cell, traced to both sides', () => {
  const layers = comparisonLayers(model, 'p:a', 'p:b');
  assert.equal(layers.overlap.length, 1);
  const [cell] = layers.overlap;
  assert.ok(contains('BD-T07', cell.address) && contains('BD-T07-03O', cell.address));
  assert.ok(contains(cell.address, 'BD-T07-03O'), 'the overlap is no coarser than the finer mapping');
  assert.deepEqual(cell.a.map((s) => s.findingId), ['a1']);
  assert.deepEqual(cell.b.map((s) => s.findingId), ['b1']);
  assert.equal(cell.atlas, 'body');
});

test('every overlap cell lies inside some cell of each paper, and agrees with comparePapers', () => {
  const layers = comparisonLayers(model, 'p:a', 'p:b');
  const compared = comparePapers(model, 'p:a', 'p:b');
  for (const cell of layers.overlap) {
    assert.ok(layers.cells.a.some((c) => overlaps(c.address, cell.address)));
    assert.ok(layers.cells.b.some((c) => overlaps(c.address, cell.address)));
  }
  assert.equal(compared.disjoint, layers.overlap.length === 0);
});

test('disjoint papers have an empty overlap, and an unknown paper is null', () => {
  const disjoint = researchModel({
    version: 'v', role: 'fixture', caveat: 'invented',
    papers: [
      { id: 'x', title: 'X', findings: [{ id: 'x1', label: 'x', cells: ['BD-T01'] }] },
      { id: 'y', title: 'Y', findings: [{ id: 'y1', label: 'y', cells: ['BD-L05'] }] },
    ],
  });
  assert.deepEqual(comparisonLayers(disjoint, 'x', 'y').overlap, []);
  assert.equal(comparisonLayers(disjoint, 'x', 'nope'), null);
});

test('the active filter annotates but never removes a compared cell', () => {
  const layers = comparisonLayers(model, 'p:a', 'p:b', 'BD-T07');
  assert.equal(layers.cells.a.length, 2);
  assert.equal(layers.cells.b.length, 2);
  assert.equal(layers.cells.a.find((c) => c.findingId === 'a2').withinFilter, false);
});
