/**
 * Does `@gstack/alc` still say what the matrix pinned?
 *
 * Every address, flag and message in `matrix.ts` was measured against the
 * library before it was written down. That makes the matrix a record of a
 * measurement, and a record of a measurement goes stale. This file re-derives
 * every `oracle` claim on every run, so a library or template change reports
 * the matrix as stale instead of letting it quietly assert history.
 *
 * The direction matters. These tests do NOT assert the library is right — it
 * has its own 167-test conformance suite for that. They assert that the matrix
 * and the library still agree, so that when they diverge somebody decides which
 * one moved, rather than discovering it as a mystery red during task 7.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  AlcError,
  ENABLED_FRAMES,
  FRAMES,
  encodeBody,
  locate,
  parse,
  withCheck,
  type BodyTemplate,
} from '../../alc/src/index.ts';
import { DEEP_LINK_MATRIX, type OracleClaim } from '../src/matrix.ts';
import { bodyDigitLimit, digitCounts, bodyAddressWithDigits, templateSet } from '../src/templates.ts';

const claims: Array<{ row: string; claim: OracleClaim }> = DEEP_LINK_MATRIX.flatMap((r) =>
  (r.oracle ?? []).map((claim) => ({ row: r.id, claim })),
);

test('the matrix carries oracle claims at all', () => {
  assert.ok(claims.length >= 20, `only ${claims.length} oracle claims; the matrix is drifting unpinned`);
});

test('every `locate` claim still holds', () => {
  for (const { row, claim } of claims) {
    if (claim.kind !== 'locate') continue;
    const located = locate(claim.address, templateSet(claim.template));
    const flags = located.flags;
    const where = `row ${row}, ${claim.address} in ${claim.template}`;
    if (claim.flags.homology !== undefined) {
      assert.equal(flags.homology, claim.flags.homology, `${where}: homology`);
    }
    if (claim.flags.overPrecise !== undefined) {
      assert.equal(flags.overPrecise ?? false, claim.flags.overPrecise, `${where}: overPrecise`);
    }
    if (claim.flags.folded !== undefined) {
      assert.equal(flags.folded ?? false, claim.flags.folded, `${where}: folded`);
    }
    if (claim.flags.clamped !== undefined) {
      assert.equal(flags.clamped ?? false, claim.flags.clamped, `${where}: clamped`);
    }
    if (claim.pointIsNaN !== undefined) {
      assert.equal(
        located.pointMm.some((x) => Number.isNaN(x)),
        claim.pointIsNaN,
        `${where}: pointMm NaN-ness. A variant or absent level must never be given millimetres.`,
      );
    }
  }
});

test('every `reject` claim still rejects, with the same code', () => {
  for (const { row, claim } of claims) {
    if (claim.kind !== 'reject') continue;
    const where = `row ${row}, ${JSON.stringify(claim.input.slice(0, 40))} in ${claim.template ?? 'body'}`;
    let thrown: AlcError | null = null;
    try {
      // Rejection may come from the grammar or from the template layer, and the
      // row does not care which — only that it is refused before anything is
      // drawn, with the code its message is derived from.
      locate(claim.input, templateSet(claim.template ?? 'body'));
    } catch (error) {
      thrown = error as AlcError;
    }
    assert.ok(thrown, `${where}: expected a rejection, got none`);
    assert.equal(thrown.code, claim.code, `${where}: rejection code`);
    for (const needle of claim.messageContains ?? []) {
      assert.ok(
        thrown.message.includes(needle),
        `${where}: message must contain ${JSON.stringify(needle)}; got ${JSON.stringify(thrown.message)}`,
      );
    }
  }
});

test('every `encode` claim still produces the same address and clamp', () => {
  for (const { row, claim } of claims) {
    if (claim.kind !== 'encode') continue;
    const templates = templateSet(claim.template);
    assert.ok(templates.body, `row ${row}: no body template`);
    const result = encodeBody(templates.body, claim.pointMm, claim.digits);
    assert.equal(result.address, claim.address, `row ${row}: encoded address`);
    assert.equal(result.flags.clamped ?? false, claim.clamped, `row ${row}: clamped`);
  }
});

test('every `canonicalises` claim still canonicalises the same way', () => {
  for (const { row, claim } of claims) {
    if (claim.kind !== 'canonicalises') continue;
    assert.equal(parse(claim.input).canonical, claim.canonical, `row ${row}: canonical form`);
  }
});

// ---------------------------------------------------------------------------
// The precision boundary, which must hold for ANY bound template
// ---------------------------------------------------------------------------

test('the derived precision boundary brackets the template limit, whatever it is', () => {
  // The invariant, rather than the number. These three hold for a template
  // justifying 5 digits and for one justifying 2, which is the whole point of
  // deriving them: `overPrecise` is raised relative to the BOUND template's
  // maxUsefulDigits, so a row pinning the boundary as a literal asserts a
  // property of one template against whichever one is loaded.
  const d = digitCounts('body');
  const templates = templateSet('body');

  assert.equal(
    locate(bodyAddressWithDigits(d.ordinary), templates).flags.overPrecise ?? false,
    false,
    'the ordinary address must be within the template\'s precision, or every round-trip row is '
    + 'silently testing the truncating display path instead',
  );
  assert.equal(
    locate(bodyAddressWithDigits(d.atLimit), templates).flags.overPrecise ?? false,
    false,
    'an address at exactly the template limit must NOT be over-precise',
  );
  assert.equal(
    locate(bodyAddressWithDigits(d.overLimit), templates).flags.overPrecise,
    true,
    'an address one digit past the limit must be over-precise',
  );
  assert.ok(d.ordinary <= d.atLimit, 'the ordinary digit count must never exceed the limit');
});

test('the boundary still brackets correctly against a template justifying only 2 digits', () => {
  // The real asset. DOG-35's `bp3d-4.0-adult-body-centroid` declares
  // `maxUsefulDigits: 2`, because it is a 99%-decimated mesh with a ~6.25 mm
  // mean edge. This test is the proof that the derivation survives it rather
  // than a promise that it will: it rebinds the limit and re-checks the same
  // three facts.
  //
  // Hard-pinning 5 — which this matrix did until the CTO caught it — inverts
  // three families of row the moment that template is bound, and silently:
  // once `overPrecise` is set the viewer takes the truncating display path, the
  // address displays shorter than the one in the URL, and the rows asserting
  // `urlAddress === selectionAddress` fail against a CORRECT viewer.
  const base = templateSet('body').body as BodyTemplate;
  const decimated = { ...base, id: 'oracle-limit-2', maxUsefulDigits: 2 } as BodyTemplate;
  const templates = { body: decimated };

  assert.equal(locate(bodyAddressWithDigits(2), templates).flags.overPrecise ?? false, false);
  assert.equal(locate(bodyAddressWithDigits(3), templates).flags.overPrecise, true);
  // And the thing that would have bitten: the matrix's own ordinary address is
  // over-precise against this template, which is exactly why the digit count
  // is derived rather than written down.
  const ordinaryAgainstReal = locate(
    bodyAddressWithDigits(digitCounts('body').ordinary),
    templates,
  ).flags.overPrecise ?? false;
  assert.equal(
    ordinaryAgainstReal,
    digitCounts('body').ordinary > 2,
    'with a 2-digit limit, a 3-digit address IS over-precise — the inversion the derivation avoids',
  );
});

test('the bound body template declares an integer digit limit', () => {
  const limit = bodyDigitLimit('body');
  assert.ok(Number.isInteger(limit) && limit >= 0, `maxUsefulDigits is ${limit}`);
  // Not asserted to be 5. Asserted to exist, because a template that does not
  // declare one leaves the matrix with no boundary to derive.
});

// ---------------------------------------------------------------------------
// Pins that are not arithmetic, and so stay literal
// ---------------------------------------------------------------------------

test('C08 is still rejected with the correction named, not resolved as an anomaly', () => {
  let thrown: AlcError | null = null;
  try {
    parse('BD-C08-03O');
  } catch (error) {
    thrown = error as AlcError;
  }
  assert.ok(thrown, 'BD-C08-03O parsed, which it must not');
  assert.equal(thrown.code, 'bad_level');
  for (const needle of ['no eighth cervical vertebra', 'nerve root', 'C07 or T01']) {
    assert.ok(thrown.message.includes(needle), `the correction must name ${JSON.stringify(needle)}`);
  }
});

test('no legal address can reach the 64-character cap', () => {
  // The premise under the two length rows. If a future frame makes a 64-char
  // address legal, `length-at-the-64-character-cap` stops being a rejection
  // case and has to be rewritten — this is what says so, rather than the row
  // silently asserting the wrong thing.
  const longest = Math.max(
    ...Object.values(FRAMES).map((f) => {
      // frame id + one dash and at most 3 characters per anchor segment + the
      // digit segment + the check symbol.
      const anchors = f.anchorSegments * 4;
      return f.id.length + anchors + 1 + f.maxDigits + 2;
    }),
  );
  assert.ok(
    longest < 64,
    `a legal address can now be ${longest} characters, at or past the 64-character cap. The length rows `
    + 'assume no legal address reaches it, so they need rewriting.',
  );
});

test('a 64-character input is refused for its digits, and a 65-character one for length', () => {
  const atCap = `BD-T07-03O-${'5'.repeat(53)}`;
  const overCap = `BD-T07-03O-${'5'.repeat(54)}`;
  assert.equal(atCap.length, 64);
  assert.equal(overCap.length, 65);
  assert.throws(
    () => parse(atCap),
    (e: AlcError) => e.code === 'bad_precision',
    'at the cap the digit bound is what bites, not the length',
  );
  assert.throws(
    () => parse(overCap),
    (e: AlcError) => e.code === 'too_long',
    'past the cap the length check runs before the frame registry',
  );
});

test('the check symbol the matrix derives is still the one the library computes', () => {
  const d = digitCounts('body');
  const address = bodyAddressWithDigits(d.ordinary);
  const checked = withCheck(address);
  assert.equal(parse(checked).canonical, address, 'the checked form must canonicalise to the bare one');
  const damaged = `${checked.slice(0, -1)}${checked.slice(-1) === 'T' ? 'S' : 'T'}`;
  assert.throws(() => parse(damaged), (e: AlcError) => e.code === 'check_failed');
});

test('BR is still disabled and BD/BV still enabled', () => {
  // The `frame_disabled` row stops meaning anything the day BR is enabled, and
  // that is a deliberate v1 boundary rather than an accident.
  assert.ok(!ENABLED_FRAMES.has('BR'), 'BR is enabled now; the frame_disabled row needs rewriting');
  assert.ok(ENABLED_FRAMES.has('BV'), 'BV must be enabled for the brain rows to mean anything');
  assert.ok(ENABLED_FRAMES.has('BD'), 'BD must be enabled');
});

test('the folding fixture still folds where the matrix pinned, and the sound template does not', () => {
  // The fold row's whole argument is that the SAME address behaves differently
  // in two templates. If the fixture stopped folding, the row would pass
  // vacuously against any build; if the sound template started folding, the
  // pair would stop distinguishing anything.
  const folded = locate('BD-T06-12O-311', templateSet('fold-fixture'));
  assert.equal(folded.flags.folded, true, 'the fold fixture no longer folds at BD-T06-12O-311');
  assert.ok(
    (folded.flags.notes ?? []).join(' ').includes('T01'),
    'the fold note no longer names T01 as a competing level, which the matrix row asserts by text',
  );
  const sound = locate('BD-T06-12O-311', templateSet('body'));
  assert.notEqual(sound.flags.folded, true, 'the sound template now folds, which invalidates the pair');
});

test('the three declared anomalies and the reserved sacral range still behave as the matrix says', () => {
  const templates = templateSet('body');
  for (const level of ['T13', 'L06', 'S06']) {
    const l = locate(`BD-${level}-03O`, templates);
    assert.equal(l.flags.homology, 'variant', `${level} must be a variant`);
    assert.ok(l.pointMm.some(Number.isNaN), `${level} must not be given millimetres`);
  }
  for (const level of ['S02', 'S03', 'S04', 'S05']) {
    const l = locate(`BD-${level}-03O`, templates);
    assert.equal(l.flags.homology, 'absent', `${level} must be absent, not a variant`);
    assert.ok(l.pointMm.some(Number.isNaN), `${level} must not be given millimetres`);
  }
  // And the one sacral level that IS realised, so the four rows above cannot
  // have been implemented as "anything sacral is absent".
  assert.equal(locate('BD-S01-03O', templates).flags.homology, 'exact');
});
