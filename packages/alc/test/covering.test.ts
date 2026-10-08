import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  AlcError,
  ballRegion,
  bodyFrameRoots,
  brainVolumeFrameRoots,
  children,
  contains,
  covering,
  coveringContains,
  coveringFromPointsMm,
  coveringFromRegion,
  coveringIntersect,
  coveringMeasureWithin,
  coveringRollUp,
  coveringUnion,
  coveringsOverlap,
  coveringsSamePlace,
  encodeBody,
  encodeBrainVolume,
  isCovering,
  isEmptyCovering,
  locate,
  parse,
  relativeMeasure,
  EMPTY_COVERING,
  FRAMES,
} from '../src/index.ts';
import { bodyLocalToMm } from '../src/frames/bodySpine.ts';
import { bvLocalToMm } from '../src/frames/brainVolume.ts';
import {
  ADULT_MALE,
  BRAIN_ADULT,
  CHILD,
  buildBodyTemplate,
  buildBrainTemplate,
  rng,
} from '../src/testing/syntheticTemplates.ts';

const adult = buildBodyTemplate(ADULT_MALE);
const child = buildBodyTemplate(CHILD);
const brainAdult = buildBrainTemplate(BRAIN_ADULT);
const brain = { brainVolume: brainAdult };

// ---------------------------------------------------------------------------
test('covering: the type carries its invariants', () => {
  const c = covering(['bv-l-471', 'BV-L-47', 'BV-L-4']);
  assert.ok(isCovering(c));
  assert.deepEqual([...c.cells], ['BV-L-4'], 'redundant descendants are dropped');
  assert.deepEqual([...c.frames], ['BV']);
  assert.ok(Object.isFrozen(c));
  assert.ok(isEmptyCovering(EMPTY_COVERING));
  assert.ok(isEmptyCovering(covering([])));

  // A bare array is not a Covering, so nothing can skip normalisation.
  assert.equal(isCovering(['BV-L-4']), false);
  assert.equal(isCovering({ cells: ['BV-L-4'], frames: ['BV'] }), false);
  assert.throws(
    () => coveringsOverlap({ cells: ['BV-L-4'], frames: ['BV'] } as never, covering(['BV-L-4'])),
    (e: unknown) => (e as AlcError).code === 'bad_covering',
  );

  // Invalid input throws rather than being silently dropped: a quietly shrunk
  // covering is a quietly wrong query.
  assert.throws(() => covering(['BV-L-4', 'BV-L-48']), AlcError);
  assert.throws(() => covering(['BD-T07-02O-9']), AlcError);
});

test('covering: a normalised covering is pairwise disjoint and maximally rolled up', () => {
  const r = rng(101);
  for (let trial = 0; trial < 200; trial += 1) {
    const cells: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const digits = Array.from({ length: 1 + Math.floor(r() * 4) }, () => '01234567'[Math.floor(r() * 8)]).join('');
      cells.push(`BV-${r() < 0.5 ? 'L' : 'R'}-${digits}`);
    }
    const c = covering(cells);
    for (const x of c.cells) {
      for (const y of c.cells) {
        if (x === y) continue;
        assert.equal(contains(x, y), false, `${x} should not contain ${y} in a normalised covering`);
      }
    }
    // No complete sibling group survives: it would have rolled up.
    const byParent = new Map<string, number>();
    for (const x of c.cells) {
      const p = parse(x).level > 0 ? x.slice(0, -1) : null;
      if (p) byParent.set(p, (byParent.get(p) ?? 0) + 1);
    }
    for (const [, n] of byParent) assert.ok(n < 8, 'a complete sibling group should have rolled up');
  }
});

// ---------------------------------------------------------------------------
test('covering: relative measure agrees with the real branching factor', () => {
  // The branching table is derived from children() rather than tabulated, so
  // assert the agreement for every frame and every rung it can reach.
  for (const seed of ['BD-T07', 'BV-L', 'BR-L-7']) {
    let cur = parse(seed);
    for (let rung = 0; rung < 4; rung += 1) {
      const kids = children(cur.canonical);
      if (kids.length === 0) break;
      for (const k of kids) {
        assert.ok(
          Math.abs(relativeMeasure(cur.canonical, k.canonical) - 1 / kids.length) < 1e-12,
          `${cur.canonical} -> ${k.canonical} should be 1/${kids.length}`,
        );
      }
      // Children of a cell partition it exactly.
      const total = kids.reduce((s, k) => s + relativeMeasure(cur.canonical, k.canonical), 0);
      assert.ok(Math.abs(total - 1) < 1e-12, `children of ${cur.canonical} summed to ${total}`);
      cur = kids[Math.floor(kids.length / 2)];
    }
  }
  // BD branches 24 ways at the azimuth rung and 8 per octree digit.
  assert.ok(Math.abs(relativeMeasure('BD-T07', 'BD-T07-02O') - 1 / 24) < 1e-12);
  assert.ok(Math.abs(relativeMeasure('BD-T07', 'BD-T07-02O-5') - 1 / 192) < 1e-12);
  assert.equal(relativeMeasure('BD-T07', 'BD-T07'), 1);
  assert.equal(relativeMeasure('BD-T07-02O', 'BD-T07'), 0, 'not containment, so no measure');
  assert.equal(relativeMeasure('BD-T07', 'BD-T08-02O'), 0);
  assert.equal(relativeMeasure('BV-L-4', 'BR-L-7'), 0, 'across frames there is no shared measure');
});

test('covering: measure within a cell is exact and sums to one over a partition', () => {
  const kids = children('BV-L-4').map((c) => c.canonical);
  for (let take = 0; take <= 8; take += 1) {
    const c = covering(kids.slice(0, take));
    assert.ok(
      Math.abs(coveringMeasureWithin(c, 'BV-L-4') - take / 8) < 1e-12,
      `${take}/8 of the cell`,
    );
  }
  // A cell swallowed whole by the covering measures 1, however coarse the covering.
  assert.equal(coveringMeasureWithin(covering(['BV-L']), 'BV-L-4710'), 1);
  assert.equal(coveringMeasureWithin(covering(['BV-R']), 'BV-L-4710'), 0);
  // Mixed depths still sum exactly.
  const mixed = covering(['BV-L-40', 'BV-L-410', 'BV-L-4110']);
  assert.ok(Math.abs(coveringMeasureWithin(mixed, 'BV-L-4') - (1 / 8 + 1 / 64 + 1 / 512)) < 1e-12);
});

// ---------------------------------------------------------------------------
test('covering: union and intersection are exact set algebra over cells', () => {
  const r = rng(202);
  const randomCells = (n: number): string[] =>
    Array.from({ length: n }, () => {
      const depth = 1 + Math.floor(r() * 4);
      const digits = Array.from({ length: depth }, () => '01234567'[Math.floor(r() * 8)]).join('');
      return `BV-L-${digits}`;
    });

  for (let trial = 0; trial < 300; trial += 1) {
    const A = covering(randomCells(6));
    const B = covering(randomCells(6));
    const I = coveringIntersect(A, B);
    const U = coveringUnion(A, B);

    // Membership agreement at a depth finer than anything in either covering.
    for (let probe = 0; probe < 12; probe += 1) {
      const digits = Array.from({ length: 5 }, () => '01234567'[Math.floor(r() * 8)]).join('');
      const x = `BV-L-${digits}`;
      const inA = coveringContains(A, x);
      const inB = coveringContains(B, x);
      assert.equal(coveringContains(I, x), inA && inB, `${x} in intersection of ${A.cells} and ${B.cells}`);
      assert.equal(coveringContains(U, x), inA || inB, `${x} in union`);
    }
    assert.equal(coveringsOverlap(A, B), !isEmptyCovering(I));
    assert.ok(coveringIntersect(A, EMPTY_COVERING).cells.length === 0);
  }
});

test('covering: intersection agrees with geometric overlap on a generated test set', () => {
  // Two balls in the brain template, each turned into a covering by recursive
  // subdivision, then intersected. The claim under test is that the cell
  // algebra and the millimetre geometry agree.
  const r = rng(303);
  let overlappingPairs = 0;
  let disjointPairs = 0;

  for (let trial = 0; trial < 14; trial += 1) {
    // Keep the balls well inside the bounding box so nothing clamps.
    const centre = (): [number, number, number] => [
      (r() * 2 - 1) * 30,
      (r() * 2 - 1) * 30,
      (r() * 2 - 1) * 20,
    ];
    const c1 = centre();
    const c2 = centre();
    const r1 = 10 + r() * 20;
    const r2 = 10 + r() * 20;
    const maxDigits = 4;

    const A = coveringFromRegion(ballRegion(brain, c1, r1), {
      roots: brainVolumeFrameRoots(),
      maxDigits,
    });
    const B = coveringFromRegion(ballRegion(brain, c2, r2), {
      roots: brainVolumeFrameRoots(),
      maxDigits,
    });
    const I = coveringIntersect(A, B);

    const gap = Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
    if (gap < r1 + r2) overlappingPairs += 1;
    else disjointPairs += 1;

    // 1. No false negatives. Any millimetre point inside both balls must be
    //    inside both coverings and inside their intersection. This is the
    //    direction that loses findings if it fails.
    let probed = 0;
    for (let i = 0; i < 4000 && probed < 60; i += 1) {
      const p: [number, number, number] = [
        c1[0] + (r() * 2 - 1) * r1,
        c1[1] + (r() * 2 - 1) * r1,
        c1[2] + (r() * 2 - 1) * r1,
      ];
      const d1 = Math.hypot(p[0] - c1[0], p[1] - c1[1], p[2] - c1[2]);
      const d2 = Math.hypot(p[0] - c2[0], p[1] - c2[1], p[2] - c2[2]);
      if (d1 > r1 || d2 > r2) continue;
      probed += 1;
      const { address, flags } = encodeBrainVolume(brainAdult, p, maxDigits);
      assert.ok(!flags.clamped);
      assert.ok(coveringContains(A, address), `${address} is in ball 1 but not covering A`);
      assert.ok(coveringContains(B, address), `${address} is in ball 2 but not covering B`);
      assert.ok(coveringContains(I, address), `${address} is in both balls but not the intersection`);
    }

    // 2. Bounded false positives. A cell in the intersection must lie within
    //    each ball widened by that cell's own radius — the most a discrete
    //    cover can promise, and the same slack `samePlace` applies.
    for (const cell of I.cells) {
      const l = locate(cell, brain);
      const cellRadius = Math.hypot(l.extentMm[0], l.extentMm[1], l.extentMm[2]) / 2;
      const d1 = Math.hypot(l.pointMm[0] - c1[0], l.pointMm[1] - c1[1], l.pointMm[2] - c1[2]);
      const d2 = Math.hypot(l.pointMm[0] - c2[0], l.pointMm[1] - c2[1], l.pointMm[2] - c2[2]);
      assert.ok(d1 <= r1 + cellRadius + 1e-9, `${cell} is ${d1} mm from ball 1 of radius ${r1}`);
      assert.ok(d2 <= r2 + cellRadius + 1e-9, `${cell} is ${d2} mm from ball 2 of radius ${r2}`);
    }

    // 3. Well-separated balls must not intersect at all.
    if (gap > r1 + r2 + 40) {
      assert.ok(isEmptyCovering(I), `balls ${gap} mm apart should not share cells`);
    }
  }
  assert.ok(overlappingPairs > 2 && disjointPairs > 2, 'the generated set should contain both cases');
});

// ---------------------------------------------------------------------------
test('covering: construction from geometry is conservative in the safe direction', () => {
  const centre = bvLocalToMm(brainAdult, 'L', { a: 0.4, b: 0.55, c: 0.55 });
  const inside = coveringFromRegion(ballRegion(brain, centre, 18), {
    roots: brainVolumeFrameRoots(),
    maxDigits: 3,
    onPartial: 'exclude',
  });
  const outside = coveringFromRegion(ballRegion(brain, centre, 18), {
    roots: brainVolumeFrameRoots(),
    maxDigits: 3,
    onPartial: 'include',
  });
  // "Certainly inside" is a subset of "might be inside".
  for (const cell of inside.cells) {
    assert.ok(
      coveringContains(outside, cell) || coveringsOverlap(covering([cell]), outside),
      `${cell} should also appear in the inclusive covering`,
    );
  }
  assert.ok(
    coveringMeasureWithin(outside, 'BV-L') >= coveringMeasureWithin(inside, 'BV-L'),
    'the inclusive covering must be at least as large',
  );

  // The work cap is a real cap, not advice.
  assert.throws(
    () => coveringFromRegion(ballRegion(brain, centre, 18), {
      roots: brainVolumeFrameRoots(),
      maxDigits: 6,
      maxCells: 50,
    }),
    (e: unknown) => (e as AlcError).code === 'covering_too_large',
  );
  assert.throws(
    () => coveringFromRegion(ballRegion(brain, centre, 18), { roots: brainVolumeFrameRoots(), maxDigits: -1 }),
    (e: unknown) => (e as AlcError).code === 'bad_precision',
  );
  assert.throws(() => ballRegion(brain, centre, -5), (e: unknown) => (e as AlcError).code === 'bad_radius');
});

test('covering: body-frame roots cover exactly the levels a template realises', () => {
  const roots = bodyFrameRoots(adult);
  assert.equal(roots.length, adult.slabs.length);
  assert.ok(roots.includes('BD-T07'));
  for (const root of roots) {
    assert.equal(locate(root, { body: adult }).flags.homology, 'exact');
  }
  // A region scan of the body frame only visits levels that exist.
  const p = bodyLocalToMm(adult, { level: 'T07', u: 0.5, t: 0.25, r: 0.6 });
  const c = coveringFromRegion(ballRegion({ body: adult }, p, 25), { roots, maxDigits: 2 });
  assert.ok(c.cells.length > 0);
  for (const cell of c.cells) {
    assert.equal(locate(cell, { body: adult }).flags.homology, 'exact');
  }
});

test('covering: points in millimetres become a covering, with clamps counted not hidden', () => {
  const r = rng(404);
  const points: Array<[number, number, number]> = [];
  for (let i = 0; i < 400; i += 1) {
    points.push(bodyLocalToMm(adult, { level: 'T07', u: 0.3 + r() * 0.4, t: 0.2 + r() * 0.1, r: 0.5 + r() * 0.3 }));
  }
  const good = coveringFromPointsMm({ body: adult }, 'BD', points, 4);
  assert.equal(good.clampedPoints, 0);
  assert.deepEqual(good.notes, []);
  assert.ok(good.covering.cells.length > 0);
  for (const p of points) {
    const { address } = encodeBody(adult, p, 4);
    assert.ok(coveringContains(good.covering, address), `${address} should be covered by its own points`);
  }

  // A point outside the modelled surface is reported, not silently projected.
  const outside = bodyLocalToMm(adult, { level: 'T07', u: 0.5, t: 0.25, r: 1.8 });
  const flagged = coveringFromPointsMm({ body: adult }, 'BD', [...points, outside], 4);
  assert.equal(flagged.clampedPoints, 1);
  assert.ok(flagged.notes.some((n) => n.includes('outside the modelled body surface')));

  assert.throws(
    () => coveringFromPointsMm({}, 'BD', points, 4),
    (e: unknown) => (e as AlcError).code === 'no_template',
  );
  assert.throws(
    () => coveringFromPointsMm({ body: adult }, 'BD', points, 1.5),
    (e: unknown) => (e as AlcError).code === 'bad_precision',
  );
});

// ---------------------------------------------------------------------------
test('covering: roll-up coarsens to a stated precision and can only grow', () => {
  const r = rng(505);
  const cells = Array.from({ length: 30 }, () => {
    const digits = Array.from({ length: 5 }, () => '01234567'[Math.floor(r() * 8)]).join('');
    return `BV-L-${digits}`;
  });
  const fine = covering(cells);
  for (const maxDigits of [4, 3, 2, 1, 0]) {
    const coarse = coveringRollUp(fine, maxDigits);
    for (const cell of coarse.cells) {
      assert.ok(parse(cell).digits.length <= maxDigits, `${cell} exceeds ${maxDigits} digits`);
    }
    // Coarsening is a superset: every original cell is still covered.
    for (const cell of fine.cells) {
      assert.ok(coveringContains(coarse, cell), `${cell} was lost rolling up to ${maxDigits}`);
    }
    assert.ok(coveringMeasureWithin(coarse, 'BV-L') >= coveringMeasureWithin(fine, 'BV-L') - 1e-12);
  }
  assert.deepEqual([...coveringRollUp(fine, 0).cells], ['BV-L']);
  // BD stops at its level anchor rather than inventing a frame-wide root.
  assert.deepEqual([...coveringRollUp(covering(['BD-T07-02O-531']), 0).cells], ['BD-T07-02O']);
  assert.throws(
    () => coveringRollUp(fine, -1),
    (e: unknown) => (e as AlcError).code === 'bad_precision',
  );
});

// ---------------------------------------------------------------------------
test('coveringsSamePlace: the caller must name the regime', () => {
  const A = covering(['BV-L-471']);
  const B = covering(['BV-L-4710']);

  const exact = coveringsSamePlace(A, B, { within: 'template' });
  assert.equal(exact.same, true);
  assert.equal(exact.basis, 'exact');
  assert.deepEqual([...exact.shared.cells], ['BV-L-4710']);

  // No regime, no answer.
  assert.throws(
    () => coveringsSamePlace(A, B, {} as never),
    (e: unknown) => (e as AlcError).code === 'bad_regime',
  );
  // Cross-subject regime with no tolerance, or a nonsense one, is refused.
  for (const toleranceMm of [undefined, null, NaN, Infinity, -1, '5'] as never[]) {
    assert.throws(
      () => coveringsSamePlace(A, B, { across: 'subjects', toleranceMm, templatesA: brain, templatesB: brain }),
      (e: unknown) => (e as AlcError).code === 'bad_tolerance',
      `toleranceMm ${String(toleranceMm)} should be refused`,
    );
  }
});

test('coveringsSamePlace: cross-subject overlap uses geometry, not strings', () => {
  // Two findings a 5 mm residual apart. Their coverings share no cell at all,
  // so the exact regime says no — correctly, within one template. Across
  // subjects with a 5 mm tolerance, they are the same place.
  const r = rng(606);
  let sharedCells = 0;
  let sameWithTolerance = 0;
  const trials = 400;
  for (let i = 0; i < trials; i += 1) {
    const p = bvLocalToMm(brainAdult, 'L', { a: 0.2 + r() * 0.5, b: 0.2 + r() * 0.5, c: 0.2 + r() * 0.5 });
    const n = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const q: [number, number, number] = [p[0] + (n[0] / len) * 5, p[1] + (n[1] / len) * 5, p[2] + (n[2] / len) * 5];
    const A = covering([encodeBrainVolume(brainAdult, p, 5).address]);
    const B = covering([encodeBrainVolume(brainAdult, q, 5).address]);
    if (coveringsSamePlace(A, B, { within: 'template' }).same) sharedCells += 1;
    const across = coveringsSamePlace(A, B, {
      across: 'subjects',
      toleranceMm: 5,
      templatesA: brain,
      templatesB: brain,
    });
    if (across.same) sameWithTolerance += 1;
    assert.equal(across.basis, 'tolerance');
    assert.ok(across.closest, 'the cross-subject regime reports the closest pair');
  }
  assert.ok(sharedCells / trials < 0.2, `cell sharing should be unreliable at 5 mm, got ${sharedCells / trials}`);
  assert.ok(
    sameWithTolerance / trials > 0.95,
    `a stated 5 mm tolerance should recognise these, got ${sameWithTolerance / trials}`,
  );
});

test('coveringsSamePlace: reports rather than answers when the frames or levels do not line up', () => {
  const across = { across: 'subjects', toleranceMm: 5, templatesA: { body: adult }, templatesB: { body: child } } as const;
  // Different frames in the two coverings: no comparable pair.
  const r1 = coveringsSamePlace(covering(['BD-T07-02O']), covering(['BV-L-471']), across);
  assert.equal(r1.same, false);
  assert.ok(r1.notes.some((n) => n.includes('share no frame')));

  // A level absent from the template is surfaced, not guessed around.
  const r2 = coveringsSamePlace(covering(['BD-L06-12O-531']), covering(['BD-L05-12O-531']), across);
  assert.equal(r2.same, false);
  assert.ok(r2.notes.some((n) => n.includes('absent from its template')));
});

test('covering: frames are tracked, and mixed-frame coverings stay disjoint by frame', () => {
  const mixed = covering(['BD-T07-02O', 'BV-L-4', 'BR-L-7A']);
  assert.deepEqual([...mixed.frames], ['BD', 'BR', 'BV']);
  assert.equal(coveringsOverlap(mixed, covering(['BV-L-47'])), true);
  assert.equal(coveringsOverlap(mixed, covering(['BV-R-47'])), false);
  assert.deepEqual([...coveringIntersect(mixed, covering(['BR-L-7A3F'])).cells], ['BR-L-7A3F']);
  assert.equal(Object.keys(FRAMES).length, 3);
});
