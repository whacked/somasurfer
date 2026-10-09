import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  AlcError,
  children,
  coveringIntersection,
  coveringsIntersect,
  encodeBody,
  encodeBrainVolume,
  overlaps,
  parse,
  recommendedDigits,
  samePlace,
} from '../src/index.ts';
import { bodyLocalToMm } from '../src/frames/bodySpine.ts';
import { bvCellBox, bvLocalToMm } from '../src/frames/brainVolume.ts';
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

test('samePlace: the separation it compares against the tolerance is the true one', () => {
  // The other half of the QA-12 fix, and the half the zero-tolerance invariant
  // in equality-guard.test.ts cannot see: at zero tolerance the structural
  // short-circuit answers disjoint cells of one template whatever the geometry
  // says, so a regression in the geometry would leave that test green and only
  // show up at a *stated* tolerance — the direction a caller actually uses.
  //
  // What is pinned here is that `separationMm` is the real distance between the
  // two cells. Two measured failures it rules out, both permissive:
  //
  //   the half-diagonal      BV-L-44 vs BV-R: budget 117.4 mm against a 124.9 mm
  //                          centre gap, so "same place" at a 7.5 mm tolerance
  //   one direction only     the same pair: separation 7.4 mm, so "same place"
  //                          at any tolerance over that, against a true 51.0 mm
  //
  // The expected value is re-derived here from the cell boxes rather than taken
  // from the library, so this is a check and not a restatement.
  const boxMm = (address: string): Array<[number, number]> => {
    const a = parse(address);
    const box = bvCellBox(a.anchors[0] as 'L' | 'R', a.digits);
    const { extents } = brainAdult;
    const sign = a.anchors[0] === 'L' ? 1 : -1;
    const lateral = extents[sign > 0 ? 'left' : 'right'];
    // The piecewise-proportional fraction -> millimetre map, spelled out again.
    const unsplit = (f: number, neg: number, pos: number): number =>
      (f < 0.5 ? (f - 0.5) * 2 * neg : (f - 0.5) * 2 * pos);
    const span = (lo: number, hi: number): [number, number] => [Math.min(lo, hi), Math.max(lo, hi)];
    return [
      span(box.a[0] * lateral * sign, box.a[1] * lateral * sign),
      span(unsplit(box.b[0], extents.posterior, extents.anterior), unsplit(box.b[1], extents.posterior, extents.anterior)),
      span(unsplit(box.c[0], extents.inferior, extents.superior), unsplit(box.c[1], extents.inferior, extents.superior)),
    ];
  };
  // Two axis-aligned boxes: per-axis gaps, combined in quadrature.
  const trueSeparationMm = (a: string, b: string): number => {
    const [A, B] = [boxMm(a), boxMm(b)];
    let sumOfSquares = 0;
    for (let k = 0; k < 3; k += 1) {
      const gap = Math.max(A[k][0] - B[k][1], B[k][0] - A[k][1], 0);
      sumOfSquares += gap * gap;
    }
    return Math.sqrt(sumOfSquares);
  };

  const brain = { brainVolume: brainAdult };
  let cells = ['BV-L', 'BV-R'];
  const sweep = [...cells];
  for (let depth = 0; depth < 3; depth += 1) {
    cells = cells.flatMap((c) => children(c).map((x) => x.canonical)).slice(0, 40);
    sweep.push(...cells);
  }

  let pairs = 0;
  let worst = 0;
  let worstPair = '';
  for (let i = 0; i < sweep.length; i += 1) {
    for (let j = i + 1; j < sweep.length; j += 1) {
      const [a, b] = [sweep[i], sweep[j]];
      if (overlaps(a, b)) continue;
      pairs += 1;
      const error = Math.abs(
        samePlace(a, b, brain, { toleranceMm: 0 }).separationMm - trueSeparationMm(a, b),
      );
      if (error > worst) {
        worst = error;
        worstPair = `${a} vs ${b}`;
      }
    }
  }
  assert.ok(pairs > 2000, `expected a wide sweep, got ${pairs} disjoint pairs`);
  // Exactly, not approximately: a BV cell is a true axis-aligned box in
  // millimetres, so there is nothing here to approximate.
  assert.ok(
    worst < 1e-9,
    `separationMm is off by ${worst.toFixed(3)} mm at ${worstPair}, over ${pairs} pairs.\n`
      + 'It must be the distance between the two cells. Measuring only along the line between\n'
      + 'the centres understates it — that is QA-12 again, one tolerance up.',
  );

  // The quoted case, as a number a reader can check by hand.
  assert.ok(Math.abs(trueSeparationMm('BV-L-44', 'BV-R') - 51) < 0.5);
  assert.equal(samePlace('BV-L-44', 'BV-R', brain, { toleranceMm: 50 }).same, false);
  assert.equal(samePlace('BV-L-44', 'BV-R', brain, { toleranceMm: 52 }).same, true);
  // And the two superseded measures would both have said yes at 50 mm: the
  // half-diagonal because the budget covers the centre gap, the one-direction
  // projection because it puts these 7.4 mm apart.
  const r = samePlace('BV-L-44', 'BV-R', brain, { toleranceMm: 50 });
  assert.ok(r.gapMm < 50 + r.cellRadiiMm[0] + r.cellRadiiMm[1], 'the half-diagonal budget would have matched');
  assert.ok(r.gapMm - r.reachMm[0] - r.reachMm[1] < 50, 'the one-direction projection would have matched');
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
