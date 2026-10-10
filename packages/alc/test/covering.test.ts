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
  parent,
  parse,
  relativeMeasure,
  EMPTY_COVERING,
  FRAMES,
} from '../src/index.ts';
import { MIN_BRANCHING, containingKeys, parentKey } from '../src/address.ts';
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

// ---------------------------------------------------------------------------
// DOG-80: the cost of normalisation, and the equivalences the fast path rests on
//
// `normalizeCovering` used to prune by asking `kept.some(contains)` once per
// cell, which is O(n^2) `contains()` calls, and `contains()` parses both of its
// arguments. The real 57-structure name index cost ~2.6 s to build on the
// critical path at load. It is now linear in the cell count.
//
// The tests below are in two groups. The scale case pins the complexity claim.
// The three equivalence cases pin the reasons the linear version is allowed to
// be correct — each one is a claim the fast path makes that nothing else in the
// suite would notice going wrong, because getting any of them wrong produces a
// covering that is still well-formed, just quietly different.
// ---------------------------------------------------------------------------

/**
 * `n` pairwise-disjoint cells that cannot roll up, so the prune sees every one.
 *
 * Depth-4 `BV` octree cells, omitting one child of every parent: a sibling
 * group is complete only when all eight are present, so no group rolls up and
 * normalisation has to keep all `n`. That is the worst case for the old prune
 * and the case a quadratic implementation is slowest on, which is what makes it
 * the right shape to measure.
 */
function disjointCells(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i += 1) {
    const d = [(i >> 9) & 7, (i >> 6) & 7, (i >> 3) & 7, i & 7];
    if (d[3] === 7) continue; // omit one child per parent, so nothing completes
    out.push(`BV-L-${d.join('')}`);
    if (i > 1 << 14) throw new Error(`ran out of cells before reaching ${n}`);
  }
  return out;
}

test('covering: normalisation is linear in cell count, not quadratic', () => {
  // Asserted on SCALE, not on milliseconds: a budget in ms is a flaky test on a
  // contended runner, but the ratio between two sizes on the same runner in the
  // same process is a property of the algorithm. Quadratic cost predicts 16x
  // for a 4x input; linear predicts 4x. The threshold is the geometric mean of
  // the two, so the test is equally far from both and a constant-factor
  // regression cannot drift it red.
  // 256 and 1024 rather than something larger: these are the smallest sizes at
  // which the linear path is still comfortably above the resolution floor
  // below, and the size matters in the other direction too. A quadratic
  // implementation has to run this case to fail it, and at 1024 cells it makes
  // ~524,000 contains() calls per run, which is seconds. Bigger sizes turn a
  // red build into a build that looks hung instead.
  const small = disjointCells(256);
  const large = disjointCells(1024);
  assert.equal(new Set(small).size, 256, 'the generated cells must be distinct');
  assert.equal(covering(large).cells.length, 1024, 'none of them may roll up or be pruned');

  const bestOf = (runs: number, f: () => void) => {
    let best = Infinity;
    for (let i = 0; i < runs; i += 1) {
      const t0 = performance.now();
      f();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  // Warm first: comparing a cold run against a warm one measures the JIT.
  covering(small);
  covering(large);
  const tSmall = bestOf(3, () => { covering(small); });
  const tLarge = bestOf(3, () => { covering(large); });

  // A ratio computed from a time too small to resolve is noise, not evidence,
  // so say so rather than asserting on it. This is the one-sided-bound rule the
  // performance gate uses: a case that cannot measure must not report a pass it
  // has not earned, and must not fail either.
  assert.ok(
    tSmall > 0.2,
    `the 256-cell normalisation took ${tSmall.toFixed(3)} ms, too little to resolve a ratio against. `
      + 'Raise the sizes rather than trusting this number.',
  );

  const ratio = tLarge / tSmall;
  assert.ok(
    ratio < 8,
    `normalising 4x the cells took ${ratio.toFixed(1)}x the time (${tSmall.toFixed(1)} ms -> `
      + `${tLarge.toFixed(1)} ms). Linear predicts 4x and quadratic predicts 16x, so this is the `
      + 'quadratic prune back in normalizeCovering(): something is asking the whole kept set a '
      + 'question per cell. See containingKeys() in src/address.ts.',
  );
});

test('covering: containingKeys() answers exactly what contains() answers', () => {
  // The prune no longer calls contains(). It asks whether any of a cell's
  // containing addresses is in the kept set, which is only the same question
  // while this equivalence holds. If it ever stops holding, coverings come back
  // silently too large or too small rather than throwing.
  const universe = new Set<string>();
  for (const c of [...disjointCells(64), 'BD-T07', 'BD-T07-02O', 'BD-T07-02O-5', 'BD-L03-12I-531',
    'BV-L', 'BV-L-4', 'BV-L-47', 'BV-R-47', 'BR-L-7A', 'BR-L-7A3F', 'BR-R-7A3F']) {
    universe.add(parse(c).canonical);
  }
  const all = [...universe];
  let pairs = 0;
  let agreed = 0;
  for (const inner of all) {
    const keys = containingKeys(parse(inner));
    for (const outer of all) {
      pairs += 1;
      assert.equal(
        keys.includes(outer),
        contains(outer, inner),
        `containingKeys(${inner}) and contains(${outer}, ${inner}) disagree`,
      );
      agreed += 1;
    }
  }
  assert.equal(pairs, agreed);
  assert.ok(pairs > 5000, `only ${pairs} pairs compared; the universe stopped being built`);

  // Non-vacuity: the comparison above is only evidence if both answers occur.
  // A containingKeys() that returned every address, or none, would otherwise
  // pass against a contains() that happened to agree on a lopsided sample.
  const trues = all.filter((inner) => containingKeys(parse(inner)).some((k) => k !== inner && universe.has(k)));
  assert.ok(trues.length > 10, `only ${trues.length} cells had a containing address in the set`);
  // And every cell is reported as containing itself, which is contains()' own
  // reflexive case and the one the prune relies on never firing early.
  for (const inner of all) assert.ok(containingKeys(parse(inner)).includes(inner), inner);
});

test('covering: parentKey() is the canonical parent, so grouping cannot drift from parent()', () => {
  // The rollup groups cells by parentKey() and parses that string only for a
  // group big enough to possibly be complete. Grouping stays sound as long as
  // the key identifies the parent; the stronger claim asserted here is that the
  // key IS the parent's canonical form, so a frame whose parent stops
  // round-tripping is caught here rather than by a covering that quietly stops
  // rolling up.
  const sample = [
    ...disjointCells(128),
    'BD-T07', 'BD-T07-02O', 'BD-T07-02O-5', 'BD-T07-02O-53', 'BD-L03-12I-531',
    'BV-L', 'BV-L-4', 'BV-L-47', 'BV-L-4712',
    'BR-L-7A', 'BR-L-7A3', 'BR-L-7A3F', 'BR-R-0',
  ];
  let withParent = 0;
  let roots = 0;
  for (const s of sample) {
    const a = parse(s);
    const key = parentKey(a);
    const p = parent(s);
    if (key === null) {
      assert.equal(p, null, `parentKey(${s}) is null but parent() is not`);
      roots += 1;
      continue;
    }
    assert.ok(p !== null, `parentKey(${s}) is ${key} but parent() is null`);
    assert.equal(p.canonical, key, `parent(${s}) and parentKey() disagree`);
    assert.equal(parse(key).canonical, key, `parentKey(${s}) = ${key} is not canonical`);
    assert.equal(contains(key, a.canonical), true, `${key} must contain its own child ${a.canonical}`);
    withParent += 1;
  }
  assert.ok(withParent > 100, `only ${withParent} cells had a parent; the sample stopped covering them`);
  assert.ok(roots > 0, 'no frame root in the sample, so the null branch was never taken');
});

test('covering: MIN_BRANCHING is a true lower bound on every frame and rung', () => {
  // The rollup skips any sibling group smaller than MIN_BRANCHING without
  // parsing its parent. If the bound were ever too HIGH, one frame's groups
  // would stop rolling up — and that failure is silent, because a covering that
  // did not roll up is still canonical, disjoint and correct, just larger. So
  // the bound is checked against children() directly, for every frame and every
  // rung that has children at all.
  // Walked from literal frame roots rather than from a template's realised
  // levels: the branching factor is a property of the addressing scheme, and a
  // template that realises fewer levels must not narrow what this checks.
  const roots: Record<string, readonly string[]> = {
    BD: ['BD-C01', 'BD-T07', 'BD-L03', 'BD-S02'],
    BV: ['BV-L', 'BV-R'],
    BR: ['BR-L-0', 'BR-R-B'],
  };
  assert.deepEqual(Object.keys(roots).sort(), Object.keys(FRAMES).sort(), 'every frame needs a root here');
  let rungs = 0;
  for (const frame of Object.keys(FRAMES)) {
    for (const root of roots[frame]) {
      let cur: string | null = parse(root).canonical;
      for (let depth = 0; cur !== null && depth < 14; depth += 1) {
        const kids = children(cur);
        if (kids.length === 0) break;
        rungs += 1;
        assert.ok(
          kids.length >= MIN_BRANCHING,
          `${cur} has ${kids.length} children, below MIN_BRANCHING ${MIN_BRANCHING}. `
            + 'normalizeCovering() would skip this rung\'s sibling groups without parsing their parent, '
            + 'so complete groups would stop rolling up and nothing would report an error.',
        );
        cur = kids[0].canonical;
      }
    }
  }
  assert.ok(rungs > 10, `only ${rungs} rungs checked; the walk stopped finding children`);
  assert.equal(MIN_BRANCHING > 0, true);
});

test('covering: the linear reduction agrees with the pre-DOG-80 quadratic one', () => {
  // The reference implementation is the reduction as it stood at 525b51a,
  // verbatim. It is O(n^2) and that is fine here: a slow oracle is exactly what
  // a fast implementation should be differentially tested against, and this is
  // the only thing in the suite that would catch the new prune and the new
  // rollup agreeing with each other but not with what shipped.
  const reference = (inputs: readonly string[]): string[] => {
    let current = [...new Set(inputs.map((s) => parse(s).canonical))];
    for (;;) {
      const byParent = new Map<string, Set<string>>();
      for (const c of current) {
        const p = parent(c);
        if (!p) continue;
        if (!byParent.has(p.canonical)) byParent.set(p.canonical, new Set());
        byParent.get(p.canonical)!.add(c);
      }
      let rolled = false;
      const promoted = new Set<string>();
      for (const [parentKeyString, group] of byParent) {
        const expected = children(parentKeyString).length;
        if (expected > 0 && group.size === expected) {
          promoted.add(parentKeyString);
          for (const g of group) promoted.add(`!${g}`);
          rolled = true;
        }
      }
      if (rolled) {
        const removed = new Set([...promoted].filter((x) => x.startsWith('!')).map((x) => x.slice(1)));
        const added = [...promoted].filter((x) => !x.startsWith('!'));
        current = [...new Set([...current.filter((c) => !removed.has(c)), ...added])];
        continue;
      }
      const sorted = [...current].sort((x, y) => parse(x).level - parse(y).level);
      const kept: string[] = [];
      for (const c of sorted) if (!kept.some((k) => contains(k, c))) kept.push(c);
      return kept.sort();
    }
  };

  const random = rng(0xd0_8000);
  const anchors = ['C01', 'C07', 'T07', 'L03', 'S02'];
  const clocks = ['01I', '01O', '06I', '12O', '09I'];
  const pickFrom = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
  const digits = (alphabet: string, n: number) =>
    Array.from({ length: n }, () => pickFrom([...alphabet])).join('');

  const cases: string[][] = [];
  for (let t = 0; t < 300; t += 1) {
    const cells: string[] = [];
    const size = 1 + Math.floor(random() * 20);
    for (let i = 0; i < size; i += 1) {
      const which = Math.floor(random() * 3);
      if (which === 0) {
        const d = digits('01234567', Math.floor(random() * 4));
        cells.push(d ? `BD-${pickFrom(anchors)}-${pickFrom(clocks)}-${d}` : `BD-${pickFrom(anchors)}-${pickFrom(clocks)}`);
      } else if (which === 1) {
        const d = digits('01234567', Math.floor(random() * 5));
        cells.push(d ? `BV-${pickFrom(['L', 'R'])}-${d}` : `BV-${pickFrom(['L', 'R'])}`);
      } else {
        cells.push(`BR-${pickFrom(['L', 'R'])}-${pickFrom([...'0123456789AB'])}${digits('0123456789ABCDEF', Math.floor(random() * 2))}`);
      }
    }
    // A complete sibling group, so the rollup path is reached on purpose rather
    // than by luck: these are the inputs where the MIN_BRANCHING shortcut and
    // the reference implementation could diverge.
    if (random() < 0.35) {
      const base = `BD-${pickFrom(anchors)}-${pickFrom(clocks)}`;
      for (const d of '01234567') cells.push(`${base}-${d}`);
    }
    if (random() < 0.3) {
      const base = `BV-${pickFrom(['L', 'R'])}`;
      for (const d of '01234567') cells.push(`${base}-${d}`);
    }
    // A cell together with its whole ancestor chain: the prune's own subject.
    if (random() < 0.3) {
      let cur: string | null = cells[0];
      for (let k = 0; k < 6 && cur; k += 1) {
        const p: ReturnType<typeof parent> = parent(cur);
        if (!p) break;
        cells.push(p.canonical);
        cur = p.canonical;
      }
    }
    if (random() < 0.25) cells.push(cells[0], cells[cells.length - 1]); // duplicates
    cases.push(cells);
  }

  let rolledUpSomewhere = 0;
  let prunedSomewhere = 0;
  for (const cells of cases) {
    const expected = reference(cells);
    assert.deepEqual(covering(cells).cells, expected, `diverged on ${JSON.stringify(cells)}`);
    const distinct = new Set(cells.map((c) => parse(c).canonical));
    if (expected.some((c) => !distinct.has(c))) rolledUpSomewhere += 1;
    if (expected.length < distinct.size) prunedSomewhere += 1;
  }
  // Non-vacuity. Agreeing on 300 inputs that all normalise to themselves would
  // say nothing about either the rollup or the prune, which are the two things
  // this rewrote.
  assert.ok(rolledUpSomewhere > 5, `only ${rolledUpSomewhere} cases rolled a sibling group up`);
  assert.ok(prunedSomewhere > 20, `only ${prunedSomewhere} cases dropped a contained cell`);
});
