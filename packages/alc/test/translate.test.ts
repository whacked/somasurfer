import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  AlcError,
  FRAMES,
  VERTEBRAL_LEVELS,
  describe as describeAddress,
  frameSummaries,
  frameSummary,
  fromReadable,
  isReadable,
  parse,
  toReadable,
  toSpoken,
} from '../src/index.ts';
import { rng } from '../src/testing/syntheticTemplates.ts';

/**
 * A systematic sweep of addresses: every vertebral level, every clock sector
 * and depth half, both hemispheres, and digit runs from empty to the per-frame
 * cap, plus random deep runs.
 */
function addressSweep(): string[] {
  const out = new Set<string>();
  const r = rng(1414);

  for (const level of VERTEBRAL_LEVELS) {
    out.add(`BD-${level}`);
    for (let clock = 1; clock <= 12; clock += 1) {
      for (const depth of ['I', 'O']) {
        const anchor = `${String(clock).padStart(2, '0')}${depth}`;
        out.add(`BD-${level}-${anchor}`);
        for (const d of '01234567') out.add(`BD-${level}-${anchor}-${d}`);
      }
    }
  }
  // Digit runs at every length up to the BD cap, including the cap itself.
  for (let n = 1; n <= FRAMES.BD.maxDigits; n += 1) {
    for (let k = 0; k < 20; k += 1) {
      const digits = Array.from({ length: n }, () => '01234567'[Math.floor(r() * 8)]).join('');
      out.add(`BD-T07-03O-${digits}`);
      out.add(`BD-S01-12I-${digits}`);
    }
  }
  for (const h of ['L', 'R']) {
    out.add(`BV-${h}`);
    for (let n = 1; n <= FRAMES.BV.maxDigits; n += 1) {
      for (let k = 0; k < 20; k += 1) {
        const digits = Array.from({ length: n }, () => '01234567'[Math.floor(r() * 8)]).join('');
        out.add(`BV-${h}-${digits}`);
      }
    }
    for (let n = 1; n <= FRAMES.BR.maxDigits; n += 1) {
      for (let k = 0; k < 20; k += 1) {
        const digits = Array.from({ length: n }, (_, i) =>
          i === 0 ? '0123456789AB'[Math.floor(r() * 12)] : '0123456789ABCDEF'[Math.floor(r() * 16)],
        ).join('');
        out.add(`BR-${h}-${digits}`);
      }
    }
  }
  return [...out].map((a) => parse(a).canonical);
}

const SWEEP = [...new Set(addressSweep())];

// ---------------------------------------------------------------------------
test('translator: the spec examples read exactly as documented', () => {
  assert.equal(toReadable('BD-T07-03O-531'), "body, T7 level, three o'clock, outer, cell 531");
  assert.equal(toReadable('BV-L-471025'), 'brain, left hemisphere, cell 471025');
  assert.equal(toReadable('BR-L-7A3F'), 'left cortical surface, cell 7A3F');
  assert.equal(toReadable('BD-T07'), 'body, T7 level');
  assert.equal(toReadable('BD-T07-12I'), "body, T7 level, twelve o'clock, inner");
  assert.equal(toReadable('BV-R'), 'brain, right hemisphere');

  assert.equal(toSpoken('BD-T07-03O-531'), "body, T7 level, three o'clock, outer, cell five three one");
  assert.equal(toSpoken('BR-L-7A3F'), 'left cortical surface, cell seven alpha three foxtrot');
  assert.equal(toSpoken('BV-L-471025'), 'brain, left hemisphere, cell four seven one zero two five');

  // And the documented pairing in the other direction.
  assert.equal(fromReadable("body, T7 level, three o'clock, outer, cell 531").canonical, 'BD-T07-03O-531');
});

test('translator: every address round-trips through both text forms', () => {
  assert.ok(SWEEP.length > 2000, `sweep too small to be meaningful: ${SWEEP.length}`);
  for (const address of SWEEP) {
    const readable = toReadable(address);
    assert.equal(fromReadable(readable).canonical, address, `readable round-trip failed: ${readable}`);
    const spoken = toSpoken(address);
    assert.equal(fromReadable(spoken).canonical, address, `spoken round-trip failed: ${spoken}`);
  }
});

test('translator: output is single-valued, so the round-trip is a function', () => {
  // One address, one readable string. Anything else makes the round-trip
  // ambiguous in the direction that matters for storage.
  for (const address of SWEEP.slice(0, 200)) {
    assert.equal(toReadable(address), toReadable(parse(address).canonical));
    assert.equal(toReadable(address), toReadable(address.toLowerCase()));
  }
});

test('translator: input is permissive about everything a transcriber varies', () => {
  const equivalent = [
    "body, T7 level, three o'clock, outer, cell 531",
    'body, T7, three oclock, outer, cell 531',
    'body, T07 level, 3 o clock, outer, cell 531',
    'body, thoracic 7 level, three o’clock, outer, cell 5 3 1'.replace('’', "'"),
    'Body, Thoracic 7, Three O\'Clock, Outer, Cell five-three-one',
    "body, t7 level, three o'clock, o, cell 531",
    '  body ,  T7  level ,  three   o\'clock ,  outer ,  cell  531  ',
    "body. T7 level. three o'clock. outer. cell 531",
  ];
  for (const text of equivalent) {
    assert.equal(fromReadable(text).canonical, 'BD-T07-03O-531', `failed to read ${JSON.stringify(text)}`);
  }

  // Radio habits for the digits.
  assert.equal(fromReadable('brain, left hemisphere, cell four seven one oh two five').canonical, 'BV-L-471025');
  assert.equal(fromReadable('brain, l, cell 4 7 1').canonical, 'BV-L-471');
  assert.equal(fromReadable('left cortex, cell seven alpha three foxtrot').canonical, 'BR-L-7A3F');
  assert.equal(fromReadable('right cortical surface, cell 7a3f').canonical, 'BR-R-7A3F');
  assert.ok(isReadable('body, T7 level'));
});

test('translator: mistranscription fails loudly rather than guessing', () => {
  const bad: Array<[string, string]> = [
    ['', 'empty'],
    ['abdomen, T7 level', 'unknown_frame'],
    ['body', 'missing_anchor'],
    ['body, elbow', 'bad_level'],
    ['body, T14 level', 'bad_level'],
    ['body, T0 level', 'bad_level'],
    ["body, T7 level, thirteen o'clock, outer", 'bad_azimuth'],
    ["body, T7 level, zero o'clock, outer", 'bad_azimuth'],
    ['body, T7 level, outer', 'bad_azimuth'],
    ["body, T7 level, three o'clock", 'missing_anchor'],
    ["body, T7 level, three o'clock, sideways", 'bad_azimuth'],
    ["body, T7 level, three o'clock, outer, cell 591", 'bad_digit'],
    ["body, T7 level, three o'clock, outer, cell 531, extra, more", 'too_many_segments'],
    ['brain', 'missing_anchor'],
    ['brain, middle hemisphere', 'bad_hemisphere'],
    ['brain, left hemisphere, cell 48', 'bad_digit'],
    ['brain, left hemisphere, cell 471, cell 472', 'too_many_segments'],
    ['left cortical surface', 'missing_digits'],
    ['left cortical surface, cell C000', 'bad_base_face'],
    ['body, T7 level, three o\'clock, outer, cell 0000000000000', 'bad_precision'],
    ['x'.repeat(600), 'too_long'],
  ];
  for (const [text, code] of bad) {
    assert.equal(isReadable(text), false, `${JSON.stringify(text)} should not be readable`);
    assert.throws(
      () => fromReadable(text),
      (e: unknown) => {
        assert.ok(e instanceof AlcError, `expected AlcError for ${JSON.stringify(text)}, got ${e}`);
        assert.equal((e as AlcError).code, code, `${JSON.stringify(text)}: expected ${code}, got ${(e as AlcError).code}`);
        return true;
      },
    );
  }
  assert.throws(() => fromReadable(42 as never), (e: unknown) => (e as AlcError).code === 'bad_type');
  assert.throws(() => toReadable('BD-T07-02X'), AlcError);
});

test('translator: readable input goes through the same validation as an address string', () => {
  // Nothing reaches geometry without passing parse(), so the digit cap, the
  // anchor ranges and the digit alphabets are enforced once, in one place.
  const overCap = `brain, left hemisphere, cell ${'0'.repeat(FRAMES.BV.maxDigits + 1)}`;
  assert.throws(() => fromReadable(overCap), (e: unknown) => (e as AlcError).code === 'bad_precision');
  const atCap = `brain, left hemisphere, cell ${'0'.repeat(FRAMES.BV.maxDigits)}`;
  assert.equal(fromReadable(atCap).digits.length, FRAMES.BV.maxDigits);
});

// ---------------------------------------------------------------------------
test('frame summaries: one sentence per frame, for a frame picker', () => {
  assert.equal(frameSummary('BD'), FRAMES.BD.summary);
  assert.equal(frameSummary('bv'), FRAMES.BV.summary);
  assert.ok(frameSummary('BR').includes('Experimental'));
  const all = frameSummaries();
  assert.deepEqual(Object.keys(all).sort(), ['BD', 'BR', 'BV']);
  for (const [id, summary] of Object.entries(all)) {
    assert.ok(summary.length > 20, `${id} needs a real summary`);
    assert.equal(summary, FRAMES[id].summary);
  }
  assert.throws(() => frameSummary('XX'), (e: unknown) => (e as AlcError).code === 'unknown_frame');
});

test('describe: a labelled breakdown with no template and no name index', () => {
  const d = describeAddress('bd-t7-3o-531');
  assert.equal(d.address, 'BD-T07-03O-531');
  assert.equal(d.withCheck, parse('BD-T07-03O-531').withCheck);
  assert.equal(d.frame, 'BD');
  assert.equal(d.frameSummary, FRAMES.BD.summary);
  assert.equal(d.experimental, false);
  assert.equal(d.readable, toReadable('BD-T07-03O-531'));
  assert.equal(d.spoken, toSpoken('BD-T07-03O-531'));
  assert.deepEqual(d.parts.map((p) => p.kind), ['frame', 'level', 'azimuth', 'refinement']);
  assert.deepEqual(d.parts.map((p) => p.segment), ['BD', 'T07', '03O', '531']);
  assert.deepEqual([...d.ancestors], ['BD-T07', 'BD-T07-03O', 'BD-T07-03O-5', 'BD-T07-03O-53']);
  for (const p of d.parts) assert.ok(p.detail.length > 20, `${p.kind} needs a real detail string`);

  const bv = describeAddress('BV-L');
  assert.deepEqual(bv.parts.map((p) => p.kind), ['frame', 'hemisphere']);
  assert.deepEqual([...bv.ancestors], []);
  assert.ok(bv.parts[1].detail.includes('midsagittal'));

  const br = describeAddress('BR-R-7A');
  assert.equal(br.experimental, true);
  assert.deepEqual(br.parts.map((p) => p.kind), ['frame', 'hemisphere', 'refinement']);
  assert.ok(br.parts[2].detail.includes('HEALPix'));

  // Every address in the sweep describes without throwing, and every
  // description's own readable form round-trips.
  for (const address of SWEEP.slice(0, 400)) {
    const got = describeAddress(address);
    assert.equal(fromReadable(got.readable).canonical, address);
    assert.equal(got.parts[0].kind, 'frame');
  }
});

test('describe: the ancestor chain is the breadcrumb, coarsest first', () => {
  for (const address of SWEEP.slice(0, 150)) {
    const chain = describeAddress(address).ancestors;
    for (let i = 0; i + 1 < chain.length; i += 1) {
      assert.ok(parse(chain[i]).level < parse(chain[i + 1]).level, `${chain[i]} should be coarser`);
    }
    if (chain.length > 0) {
      assert.equal(describeAddress(chain[0]).ancestors.length, 0, 'the first link is the frame root');
    }
  }
});
