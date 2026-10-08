import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  AlcError,
  coveringIntersection,
  coveringsIntersect,
  encodeBody,
  encodeBrainVolume,
  overlaps,
  recommendedDigits,
  samePlace,
} from '../src/index.ts';
import { bodyLocalToMm } from '../src/frames/bodySpine.ts';
import { bvLocalToMm } from '../src/frames/brainVolume.ts';
import {
  ADULT_MALE,
  BRAIN_ADULT,
  BRAIN_CHILD,
  CHILD,
  buildBodyTemplate,
  buildBrainTemplate,
  rng,
} from '../src/testing/syntheticTemplates.ts';

const adult = buildBodyTemplate(ADULT_MALE);
const child = buildBodyTemplate(CHILD);
const brainAdult = buildBrainTemplate(BRAIN_ADULT);
const brainChild = buildBrainTemplate(BRAIN_CHILD, [3, -2, 1]);

test('overlaps: hierarchy cells are nested or disjoint, never partial', () => {
  assert.equal(overlaps('BV-L-47', 'BV-L-471'), true);
  assert.equal(overlaps('BV-L-471', 'BV-L-47'), true);
  assert.equal(overlaps('BV-L-471', 'BV-L-472'), false);
  assert.equal(overlaps('BV-L-47', 'BV-R-47'), false);
  assert.equal(overlaps('BD-T07-02O-5', 'BD-T07-02O-53'), true);
  assert.equal(overlaps('BD-T07-02O', 'BD-T08-02O'), false);
});

test('coverings: intersection returns the finer cell of each overlapping pair', () => {
  assert.equal(coveringsIntersect(['BV-L-47', 'BV-R-1'], ['BV-L-4710']), true);
  assert.equal(coveringsIntersect(['BV-L-47'], ['BV-L-46', 'BV-R-47']), false);
  assert.deepEqual(coveringIntersection(['BV-L-47', 'BV-L-5'], ['BV-L-4710', 'BV-L-50']), [
    'BV-L-4710',
    'BV-L-50',
  ]);
  assert.deepEqual(coveringIntersection(['BV-L-47'], ['BV-L-46']), []);
});

test('samePlace: demands an explicit tolerance', () => {
  assert.throws(
    () => samePlace('BV-L-471', 'BV-L-471', { brainVolume: brainAdult }, { toleranceMm: -1 }),
    (e: unknown) => (e as AlcError).code === 'bad_tolerance',
  );
});

test('samePlace: refuses to compare across frames', () => {
  assert.throws(
    () =>
      samePlace('BV-L-471', 'BD-T07-02O-531', { brainVolume: brainAdult, body: adult }, { toleranceMm: 5 }),
    (e: unknown) => (e as AlcError).code === 'frame_mismatch',
  );
});

test('samePlace: catches what string equality misses', () => {
  // The case from the spec: a 5 mm residual makes the strings disagree while
  // the addresses still denote the same place.
  const r = rng(555);
  let stringAgreements = 0;
  let samePlaceAgreements = 0;
  const trials = 4000;
  for (let i = 0; i < trials; i += 1) {
    const p = bvLocalToMm(brainAdult, r() < 0.5 ? 'L' : 'R', {
      a: r() * 0.9,
      b: 0.1 + r() * 0.8,
      c: 0.1 + r() * 0.8,
    });
    let x = r() * 2 - 1;
    let y = r() * 2 - 1;
    let z = r() * 2 - 1;
    const n = Math.hypot(x, y, z) || 1;
    const q: [number, number, number] = [p[0] + (x / n) * 5, p[1] + (y / n) * 5, p[2] + (z / n) * 5];

    const a = encodeBrainVolume(brainAdult, p, 5).address;
    const b = encodeBrainVolume(brainAdult, q, 5).address;
    if (a === b) stringAgreements += 1;
    if (samePlace(a, b, { brainVolume: brainAdult }, { toleranceMm: 5 }).same) samePlaceAgreements += 1;
  }
  const stringRate = stringAgreements / trials;
  const samePlaceRate = samePlaceAgreements / trials;
  assert.ok(stringRate < 0.1, `string equality should be unreliable here, got ${stringRate}`);
  assert.ok(samePlaceRate > 0.99, `samePlace should recognise these, got ${samePlaceRate}`);
});

test('samePlace: compares across two different templates', () => {
  // A finding mapped on an adult brain versus the same place on a child's.
  const r = rng(777);
  let agreed = 0;
  const trials = 2000;
  for (let i = 0; i < trials; i += 1) {
    const hemisphere = r() < 0.5 ? 'L' : 'R';
    const local = { a: r() * 0.9, b: 0.1 + r() * 0.8, c: 0.1 + r() * 0.8 };
    const a = encodeBrainVolume(brainAdult, bvLocalToMm(brainAdult, hemisphere, local), 5).address;
    const b = encodeBrainVolume(brainChild, bvLocalToMm(brainChild, hemisphere, local), 5).address;
    // Homologous points, so the addresses are identical; resolving each in its
    // own template must agree about the place to within the tolerance.
    assert.equal(a, b);
    const result = samePlace(a, b, {}, {
      toleranceMm: 1,
      templatesA: { brainVolume: brainAdult },
      templatesB: { brainVolume: brainChild },
    });
    if (result.same) agreed += 1;
  }
  // Templates have different millimetre extents and a shifted AC, so the same
  // address lands in different absolute coordinates. samePlace reports that
  // honestly rather than pretending the millimetres are interchangeable.
  assert.ok(agreed < trials, 'different templates should not be assumed coregistered');
});

test('samePlace: reports which of precision or residual dominates', () => {
  const p = bodyLocalToMm(adult, { level: 'T07', u: 0.5, t: 0.25, r: 0.6 });
  const coarse = encodeBody(adult, p, 1).address;
  const fine = encodeBody(adult, p, 5).address;
  const r1 = samePlace(coarse, fine, { body: adult }, { toleranceMm: 0 });
  assert.equal(r1.same, true, 'a cell and its own ancestor are the same place');
  assert.ok(r1.cellRadiiMm[0] > r1.cellRadiiMm[1], 'the coarse cell should have the larger radius');
  assert.ok(r1.budgetMm > r1.gapMm);
});

test('samePlace: surfaces an absent anatomical level instead of answering', () => {
  const result = samePlace('BD-L06-12O-531', 'BD-L05-12O-531', { body: adult }, { toleranceMm: 5 });
  assert.equal(result.same, false);
  assert.ok(Number.isNaN(result.gapMm));
  assert.ok(result.notes.some((n) => n.includes('absent from its template')));
});

test('recommendedDigits: scales with the residual and the template', () => {
  const fine = recommendedDigits('BV-L-471025', { brainVolume: brainAdult }, 1);
  const coarse = recommendedDigits('BV-L-471025', { brainVolume: brainAdult }, 10);
  assert.ok(fine > coarse, `expected more digits at 1mm (${fine}) than at 10mm (${coarse})`);

  // At a 10 mm residual the recommended cell must not be smaller than 10 mm.
  assert.ok(coarse >= 1 && coarse <= 4, `unexpected recommendation ${coarse}`);

  // A lower-resolution template justifies no more digits than a better one.
  const adultDigits = recommendedDigits('BD-T07-03O-53165', { body: adult }, 2);
  const childDigits = recommendedDigits('BD-T07-03O-53165', { body: child }, 2);
  assert.ok(childDigits <= adultDigits + 1, 'child template should not justify much more precision');
});
