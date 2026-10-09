/**
 * Address parser fuzz suite.
 *
 * Attacks `parse()` and everything downstream of it with the corpus documented
 * in test/fuzz/corpus.ts, and checks the invariants in test/fuzz/invariants.ts.
 * Bounded for CI; widen with ALC_FUZZ_ITERATIONS / ALC_FUZZ_SEED.
 *
 * The target, from spec section 10 and from the `BD-T07-02O-9` regression, is
 * an input that `parse()` accepts and a later stage rejects or mis-handles, or
 * an input that drives unbounded work. Findings are in
 * docs/alc-1-attack-report.md; the open ones are pinned in KNOWN_DEFECTS so a
 * new one cannot hide among them.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { AlcError, format, isValid, normalizeCovering, parse } from '../src/index.ts';
import {
  ADULT_MALE,
  BRAIN_ADULT,
  buildBodyTemplate,
  buildBrainTemplate,
} from '../src/testing/syntheticTemplates.ts';
import {
  CONFUSABLES,
  FUZZ_ITERATIONS,
  FUZZ_SEED,
  SEEDS,
  curatedCorpus,
  fullCorpus,
  mutatedCorpus,
  wellFormedCorpus,
} from './fuzz/corpus.ts';
import { KNOWN_DEFECTS, sweep } from './fuzz/invariants.ts';

const templates = {
  body: buildBodyTemplate(ADULT_MALE),
  brainVolume: buildBrainTemplate(BRAIN_ADULT),
};

const replay = `ALC_FUZZ_SEED=${FUZZ_SEED} ALC_FUZZ_ITERATIONS=${FUZZ_ITERATIONS}`;

/**
 * One sweep, shared by the two ledger tests. The sweep is the expensive part of
 * this file, and running it twice bought nothing but CI seconds.
 */
let swept: ReturnType<typeof sweep> | undefined;
const sweepOnce = () => (swept ??= sweep(fullCorpus(FUZZ_SEED, FUZZ_ITERATIONS), templates));

// ---------------------------------------------------------------------------
test('fuzz: no accepted input breaks an invariant that is not a filed defect', () => {
  const result = sweepOnce();

  assert.ok(result.inputs > 5000, `corpus collapsed to ${result.inputs} inputs`);
  assert.ok(result.accepted > 500, `only ${result.accepted} inputs were accepted; the corpus is all noise`);

  const lines = result.unexpected.map(
    (v) => `  ${v.invariant}  input=${JSON.stringify(v.input)}  ${v.detail}`,
  );
  assert.equal(
    result.unexpected.length,
    0,
    `${result.unexpected.length} unfiled invariant violation(s). Replay with:\n`
      + `  ${replay}\n${lines.join('\n')}`,
  );
});

test('fuzz: every filed defect still reproduces, and none has quietly expanded', () => {
  // The other half of the ledger. If a defect is fixed this test fails, which
  // is the prompt to delete the entry and let the invariant stand unqualified.
  const result = sweepOnce();
  for (const defect of KNOWN_DEFECTS) {
    const hit = result.hits.get(defect.invariant);
    assert.ok(
      hit && hit.count >= defect.expectHits,
      `${defect.defectId} (${defect.invariant}) no longer reproduces over the corpus.\n`
        + `  ${defect.summary}\n`
        + '  If it is fixed: delete the KNOWN_DEFECTS entry and update docs/alc-1-attack-report.md.\n'
        + `  If the corpus stopped covering it: restore the vector. Replay with ${replay}`,
    );
  }
  // And nothing in the ledger is a duplicate invariant, which would mask a hit.
  const invariants = KNOWN_DEFECTS.map((d) => d.invariant);
  assert.equal(new Set(invariants).size, invariants.length, 'duplicate invariant in KNOWN_DEFECTS');
});

// ---------------------------------------------------------------------------
test('fuzz: the corpus is reproducible from its seed', () => {
  // Without this the suite cannot honestly claim a failure reproduces.
  assert.deepEqual(mutatedCorpus(4242, 200), mutatedCorpus(4242, 200));
  assert.deepEqual(wellFormedCorpus(4242, 200), wellFormedCorpus(4242, 200));
  assert.notDeepEqual(mutatedCorpus(4242, 200), mutatedCorpus(4243, 200));
  assert.deepEqual(curatedCorpus(), curatedCorpus());
  // Every seed address is itself valid, or the mutation layer starts from junk.
  for (const s of SEEDS) assert.equal(isValid(s), true, `seed ${s} is not a valid address`);
});

test('fuzz: nothing in the corpus throws anything but an AlcError', () => {
  // A TypeError or a RangeError escaping the parser means a missing guard, not
  // a rejection. This is the check that a hostile URL cannot crash a request.
  const offenders: string[] = [];
  for (const input of fullCorpus(FUZZ_SEED, FUZZ_ITERATIONS)) {
    try {
      const a = parse(input);
      format(a.canonical, { check: true });
      normalizeCovering([a.canonical]);
    } catch (e) {
      if (!(e instanceof AlcError) && offenders.length < 10) {
        offenders.push(`${JSON.stringify(input)} -> ${(e as Error).name}: ${(e as Error).message}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `non-AlcError escaped the parser. Replay with ${replay}`);
});

test('fuzz: non-string and exotic inputs are rejected, not coerced', () => {
  for (const bad of [undefined, null, 0, 1, NaN, {}, [], ['BD-T07'], true, Symbol('x'), 123n, () => 'BD-T07']) {
    assert.throws(
      () => parse(bad as unknown as string),
      (e: unknown) => e instanceof AlcError,
      `parse(${String(bad)}) should raise an AlcError`,
    );
  }
  // An object that stringifies to a valid address must still be refused: the
  // trust boundary is "a string arrived", not "something address-shaped did".
  assert.throws(() => parse({ toString: () => 'BD-T07' } as unknown as string), AlcError);
});

// ---------------------------------------------------------------------------
test('fuzz: the documented caps actually bound the work', () => {
  // Spec section 10: "Length capped at 64 characters; refinement digits capped
  // per frame and globally at 16, so no input can drive unbounded subdivision."
  assert.throws(() => parse('A'.repeat(65)), (e: unknown) => (e as AlcError).code === 'too_long');
  assert.throws(
    () => parse(`BD-T07-03O-${'0'.repeat(13)}`),
    (e: unknown) => (e as AlcError).code === 'bad_precision',
  );
  assert.throws(
    () => parse(`BV-L-${'0'.repeat(13)}`),
    (e: unknown) => (e as AlcError).code === 'bad_precision',
  );
  assert.throws(
    () => parse(`BR-L-${'0'.repeat(8)}`),
    (e: unknown) => (e as AlcError).code === 'bad_precision',
  );
  // No single address, however hostile, may cost more than a trivial amount.
  // Measured at ~4 microseconds per parse; two orders of magnitude of headroom
  // keeps this from being a flaky timing test on a loaded CI runner.
  const worst = [
    `BD-T07-03O-${'7'.repeat(12)}`,
    `BV-L-${'7'.repeat(12)}`,
    'BR-L-BFFFFFF',
    `BD-${'T07-'.repeat(15)}03O`,
    'A'.repeat(64),
    '-'.repeat(64),
    `${'BD-T07-03O~'.repeat(5)}K`,
  ];
  const rounds = 5000;
  const started = process.hrtime.bigint();
  for (let i = 0; i < rounds; i += 1) for (const s of worst) isValid(s);
  const perCall = Number(process.hrtime.bigint() - started) / 1e6 / (rounds * worst.length);
  assert.ok(perCall < 0.4, `${perCall.toFixed(4)} ms per parse is too slow to be a bounded guard`);
});

test('fuzz: refinement depth cannot be smuggled past the cap', () => {
  // Every route to extra digits: extra segments, an extra separator, a check
  // symbol used as padding, and the frame caps against the global cap of 16.
  for (const bad of [
    'BD-T07-03O-0000000000000',       // 13 > BD cap of 12
    'BD-T07-03O-00000000-0000',       // split across segments
    'BD-T07-03O-531-531',             // extra segment
    'BV-L-0000000000000',             // 13 > BV cap of 12
    'BV-L-000000-000000',
    'BR-L-00000000',                  // 8 > BR cap of 7
    'BR-L-0000-0000',
  ]) {
    assert.equal(isValid(bad), false, `${bad} should be rejected`);
  }
  // And the caps are the ones the frames advertise, not larger.
  assert.equal(isValid(`BD-T07-03O-${'0'.repeat(12)}`), true);
  assert.equal(isValid(`BV-L-${'0'.repeat(12)}`), true);
  assert.equal(isValid(`BR-L-${'0'.repeat(7)}`), true);
});

// ---------------------------------------------------------------------------
test('fuzz: digit-alphabet validation happens once, in parse, for every frame', () => {
  // The BD-T07-02O-9 regression: digit validation was left to each frame's
  // decoder, so an illegal digit parsed cleanly and failed later. Assert the
  // error comes from the parser, with the parser's code, for all three frames.
  for (const [input, code] of [
    ['BD-T07-02O-9', 'bad_digit'],
    ['BD-T07-02O-8', 'bad_digit'],
    ['BD-T07-02O-53A', 'bad_digit'],
    ['BV-L-48', 'bad_digit'],
    ['BV-L-9', 'bad_digit'],
    ['BR-L-7G3F', 'bad_digit'],
    ['BR-L-7A3Z', 'bad_digit'],
  ] as const) {
    assert.throws(
      () => parse(input),
      (e: unknown) => (e as AlcError).code === code,
      `${input} should fail in parse() with ${code}, not later`,
    );
  }
  // Exhaustive: no character outside a frame's digit alphabet is ever accepted
  // in the digit segment.
  const cases = [
    { frame: 'BD', alphabet: '01234567', build: (ch: string) => `BD-T07-02O-${ch}` },
    { frame: 'BV', alphabet: '01234567', build: (ch: string) => `BV-L-${ch}` },
    // The BR base face is restricted to 0-B, so probe the *second* digit, where
    // the whole hex alphabet is legal.
    { frame: 'BR', alphabet: '0123456789ABCDEF', build: (ch: string) => `BR-L-7${ch}` },
  ] as const;
  for (const { frame, alphabet, build } of cases) {
    for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const candidate = build(ch);
      assert.equal(
        isValid(candidate),
        alphabet.includes(ch),
        `${candidate}: expected ${alphabet.includes(ch) ? 'accept' : 'reject'} for digit ${ch} in ${frame}`,
      );
    }
  }
});

test('fuzz: a confusable never silently becomes a different legal address', () => {
  // QA-7 is that some confusables are accepted at all. This test is narrower
  // and holds regardless: whatever is accepted must canonicalise to the address
  // its ASCII reading denotes, never to a different one. If a fix makes these
  // reject outright, the test still passes.
  const pairs: Array<[string, string]> = [
    ['BD-T07-03ı', 'BD-T07-03I'],
    ['BD-ſ01-03O', 'BD-S01-03O'],
    ['bd-t07-03ı-531', 'BD-T07-03I-531'],
  ];
  for (const [weird, ascii] of pairs) {
    if (!isValid(weird)) continue; // rejected outright is the stronger outcome
    assert.equal(
      parse(weird).canonical,
      ascii,
      `${JSON.stringify(weird)} was accepted but denotes something other than ${ascii}`,
    );
  }
  // No confusable may ever produce an address that a different confusable, or
  // an unrelated ASCII string, also produces by a different route.
  const byCanonical = new Map<string, string[]>();
  for (const w of CONFUSABLES) {
    for (const probe of [`BD-T07-03${w}`, `BD-${w}01-03O`, `BV-L-47${w}`]) {
      if (!isValid(probe)) continue;
      const c = parse(probe).canonical;
      if (!byCanonical.has(c)) byCanonical.set(c, []);
      byCanonical.get(c)!.push(probe);
    }
  }
  // Record, not assert: the collisions are QA-7's blast radius, and the number
  // must not grow. One entry per distinct canonical form that >1 input reaches.
  const collisions = [...byCanonical.values()].filter((v) => v.length > 1);
  assert.ok(
    collisions.length <= 1,
    `confusable collisions grew to ${collisions.length}: ${JSON.stringify(collisions)}`,
  );
});
