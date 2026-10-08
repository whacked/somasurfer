import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  AlcError,
  ancestors,
  bodyLocalToMm,
  brDecodeSphere,
  brEncodeSphere,
  bvLocalToMm,
  cellAreaMm2,
  checkSymbol,
  children,
  contains,
  encodeBody,
  encodeBrainVolume,
  format,
  isValid,
  locate,
  normalizeCovering,
  parent,
  parse,
} from '../src/index.ts';
import {
  ADULT_MALE,
  ADULT_TALL,
  BRAIN_ADULT,
  BRAIN_CHILD,
  CHILD,
  SIX_LUMBAR,
  buildBodyTemplate,
  buildBrainTemplate,
  rng,
} from '../src/testing/syntheticTemplates.ts';

const adult = buildBodyTemplate(ADULT_MALE);
const child = buildBodyTemplate(CHILD);
const tall = buildBodyTemplate(ADULT_TALL);
const sixLumbar = buildBodyTemplate(SIX_LUMBAR);
const brainAdult = buildBrainTemplate(BRAIN_ADULT);
const brainChild = buildBrainTemplate(BRAIN_CHILD, [3, -2, 1]);

// ---------------------------------------------------------------------------
test('grammar: canonical forms and loose input', () => {
  assert.equal(format('bd-t7-2o-531'), 'BD-T07-02O-531');
  assert.equal(format('BD-T07-02O-531'), 'BD-T07-02O-531');
  assert.equal(format('bv-l-4721'), 'BV-L-4721');
  assert.equal(format('br-l-7a3f'), 'BR-L-7A3F');
  assert.equal(format('  bd-T07  '), 'BD-T07');
});

test('grammar: rejects malformed and hostile input', () => {
  const bad = [
    '',
    'BD',
    'XX-L-1',
    'BD-T13-02O',
    'BD-T00-02O',
    'BD-T07-13O',
    'BD-T07-00O',
    'BD-T07-02X',
    'BD-T07-02O-9', // 9 is not an octal digit
    'BD--T07',
    'BV-M-471',
    'BV-L-48', // 8 is not an octal digit
    'BR-L', // BR needs digits
    'BR-L-C', // base face must be 0..B
    'BD-T07-02O-00000000000000000000', // over the digit cap
    'BD-T07-02O-531~Z', // wrong check symbol
    'BD-T07-02O-531~AB', // check symbol must be one character
    'A'.repeat(200),
  ];
  for (const b of bad) {
    assert.equal(isValid(b), false, `expected ${JSON.stringify(b)} to be rejected`);
    assert.throws(() => parse(b), AlcError, `expected AlcError for ${JSON.stringify(b)}`);
  }
});

test('check symbol: round-trips and catches single-character damage', () => {
  const a = parse('BD-T07-02O-5316');
  assert.ok(a.withCheck.endsWith(`~${checkSymbol(a.canonical)}`));
  assert.equal(parse(a.withCheck).canonical, a.canonical);

  const alphabets: Record<string, string> = { BD: '01234567', BV: '01234567', BR: '0123456789ABCDEF' };
  let caught = 0;
  let total = 0;
  for (const base of ['BD-T07-02O-5316', 'BV-R-471025', 'BR-L-7A3F']) {
    const good = parse(base);
    const body = good.canonical;
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] === '-') continue;
      for (const ch of alphabets[good.frame] + 'LRIOCTS') {
        if (ch === body[i]) continue;
        const damaged = `${body.slice(0, i)}${ch}${body.slice(i + 1)}~${checkSymbol(body)}`;
        total += 1;
        // Either the grammar rejects it, or the check symbol does.
        if (!isValid(damaged)) caught += 1;
      }
    }
  }
  assert.ok(total > 100, `expected a meaningful number of mutations, got ${total}`);
  assert.equal(caught, total, `${total - caught}/${total} single-character mutations slipped through`);
});

// ---------------------------------------------------------------------------
test('hierarchy: truncation always yields a containing ancestor', () => {
  for (const addr of ['BD-T07-02O-5316', 'BV-R-471025', 'BR-L-7A3F']) {
    const chain = [...ancestors(addr), parse(addr)];
    for (let i = 0; i + 1 < chain.length; i += 1) {
      assert.ok(
        contains(chain[i].canonical, chain[i + 1].canonical),
        `${chain[i].canonical} should contain ${chain[i + 1].canonical}`,
      );
      assert.ok(chain[i].level < chain[i + 1].level, 'levels must strictly increase');
    }
    assert.equal(parent(chain[0].canonical), null, `${chain[0].canonical} should be a frame root`);
  }
  assert.deepEqual(
    ancestors('BD-T07-02O-53').map((a) => a.canonical),
    ['BD-T07', 'BD-T07-02O', 'BD-T07-02O-5'],
  );
});

test('hierarchy: children partition their parent and round-trip', () => {
  assert.equal(children('BD-T07').length, 24);
  assert.equal(children('BD-T07-02O').length, 8);
  assert.equal(children('BV-L').length, 8);
  assert.equal(children('BR-L-7').length, 16);
  for (const p of ['BD-T07-02O', 'BV-L-47', 'BR-L-7A']) {
    for (const c of children(p)) {
      assert.ok(contains(p, c.canonical), `${p} should contain its child ${c.canonical}`);
      assert.equal(parent(c.canonical)?.canonical, parse(p).canonical);
    }
  }
});

test('hierarchy: containment is frame-scoped and not merely string prefixing', () => {
  assert.equal(contains('BD-T07', 'BD-T08-02O'), false);
  assert.equal(contains('BD-T07-02O', 'BD-T07-03O'), false);
  assert.equal(contains('BV-L-47', 'BV-R-47'), false);
  assert.equal(contains('BV-L-47', 'BD-T07-02O'), false);
  assert.equal(contains('BD-T07-02O-5', 'BD-T07-02O-53'), true);
});

test('covering: complete sibling groups roll up to their parent', () => {
  const all = children('BV-L-4').map((c) => c.canonical);
  assert.deepEqual(normalizeCovering(all), ['BV-L-4']);

  const partial = all.slice(0, 5);
  assert.deepEqual(normalizeCovering(partial).sort(), partial.sort());

  // A redundant descendant is dropped in favour of its ancestor.
  assert.deepEqual(normalizeCovering(['BV-L-4', 'BV-L-471', 'BV-L-47']), ['BV-L-4']);

  // Recursive roll-up: all 64 grandchildren collapse to the grandparent.
  const grandchildren = children('BV-L-4').flatMap((c) => children(c.canonical).map((g) => g.canonical));
  assert.equal(grandchildren.length, 64);
  assert.deepEqual(normalizeCovering(grandchildren), ['BV-L-4']);
});

// ---------------------------------------------------------------------------
test('body frame: millimetre round-trip is stable within a template', () => {
  const r = rng(7);
  for (const template of [adult, child, tall]) {
    for (let i = 0; i < 4000; i += 1) {
      const slab = template.slabs[Math.floor(r() * template.slabs.length)];
      const local = { level: slab.label, u: r(), t: r(), r: r() * 0.999 };
      const p = bodyLocalToMm(template, local);
      const { address, flags } = encodeBody(template, p, 5);
      assert.ok(!flags.clamped, `unexpected clamp for ${address} in ${template.id}`);
      // Decoding the cell centre and re-encoding must land in the same cell.
      const back = locate(address, { body: template });
      const { address: again } = encodeBody(template, back.pointMm, 5);
      assert.equal(again, address, `re-encode drifted in ${template.id}`);
    }
  }
});

test('body frame: homologous points get identical addresses in every template', () => {
  // This is the cross-age / cross-population claim, stated as a test.
  // A "homologous point" is one at the same vertebral level, the same fraction
  // through that level, the same azimuth, and the same fraction of the distance
  // from the spine axis to the skin. The templates differ in spine curvature,
  // segment heights, girth, cross-sectional shape and left-right asymmetry.
  const r = rng(11);
  const pairs: Array<[typeof adult, typeof adult]> = [
    [adult, child],
    [adult, tall],
    [child, tall],
  ];
  for (const [a, b] of pairs) {
    for (let i = 0; i < 3000; i += 1) {
      const slab = a.slabs[Math.floor(r() * a.slabs.length)];
      const local = { level: slab.label, u: r(), t: r(), r: r() * 0.999 };
      const codeA = encodeBody(a, bodyLocalToMm(a, local), 6).address;
      const codeB = encodeBody(b, bodyLocalToMm(b, local), 6).address;
      assert.equal(codeB, codeA, `${a.id} vs ${b.id} disagreed for ${JSON.stringify(local)}`);
    }
  }
});

test('body frame: points outside the modelled surface are flagged, never silently wrong', () => {
  const slab = adult.slabs.find((s) => s.label === 'T07')!;
  const outside = bodyLocalToMm(adult, { level: 'T07', u: 0.5, t: 0.25, r: 1.6 });
  const { flags } = encodeBody(adult, outside, 4);
  assert.equal(flags.clamped, true);
  assert.ok(flags.notes?.some((n) => n.includes('outside the modelled body surface')));

  // Far above the most cranial slab.
  const aboveC1 = [0, 0, adult.slabs[0].origin[2] + 400] as const;
  assert.equal(encodeBody(adult, aboveC1, 4).flags.clamped, true);
  assert.ok(slab.heightMm > 0);
});

test('body frame: a vertebral count anomaly is reported, not guessed', () => {
  // L06 exists in the six-lumbar template and nowhere else.
  const p = bodyLocalToMm(sixLumbar, { level: 'L06', u: 0.5, t: 0, r: 0.5 });
  assert.equal(encodeBody(sixLumbar, p, 4).address.startsWith('BD-L06'), true);

  const located = locate('BD-L06-12O-531', { body: adult });
  assert.equal(located.flags.homology, 'absent');
  assert.ok(Number.isNaN(located.pointMm[0]));
  assert.ok(located.flags.notes?.some((n) => n.includes('level mapping')));

  // And the same address is exact in the template that has the level.
  assert.equal(locate('BD-L06-12O-531', { body: sixLumbar }).flags.homology, 'exact');
});

test('body frame: over-precision is declared rather than implied', () => {
  const coarse = locate('BD-T07-02O-531', { body: adult });
  assert.equal(coarse.flags.overPrecise, undefined);
  const fine = locate('BD-T07-02O-53165432', { body: adult });
  assert.equal(fine.flags.overPrecise, true);
  assert.ok(fine.flags.notes?.some((n) => n.includes('only justifies')));
  // The child template justifies less, so the same address trips it earlier.
  assert.equal(locate('BD-T07-02O-53165', { body: child }).flags.overPrecise, true);
  assert.equal(locate('BD-T07-02O-53165', { body: adult }).flags.overPrecise, undefined);
});

test('body frame: clock sector 12 is centred on the anterior midline', () => {
  const anterior = bodyLocalToMm(adult, { level: 'T07', u: 0.5, t: 0, r: 0.8 });
  assert.match(encodeBody(adult, anterior, 0).address, /^BD-T07-12O$/);
  const posterior = bodyLocalToMm(adult, { level: 'T07', u: 0.5, t: 0.5, r: 0.8 });
  assert.match(encodeBody(adult, posterior, 0).address, /^BD-T07-06O$/);
  const left = bodyLocalToMm(adult, { level: 'T07', u: 0.5, t: 0.25, r: 0.8 });
  assert.match(encodeBody(adult, left, 0).address, /^BD-T07-03O$/);
  const right = bodyLocalToMm(adult, { level: 'T07', u: 0.5, t: 0.75, r: 0.8 });
  assert.match(encodeBody(adult, right, 0).address, /^BD-T07-09O$/);
  // Inner vs outer half.
  const deep = bodyLocalToMm(adult, { level: 'T07', u: 0.5, t: 0, r: 0.2 });
  assert.match(encodeBody(adult, deep, 0).address, /^BD-T07-12I$/);
});

// ---------------------------------------------------------------------------
test('brain volume frame: millimetre round-trip is stable', () => {
  const r = rng(23);
  for (const template of [brainAdult, brainChild]) {
    for (let i = 0; i < 4000; i += 1) {
      const hemisphere = r() < 0.5 ? 'L' : 'R';
      const local = { a: r() * 0.999, b: r() * 0.999, c: r() * 0.999 };
      const p = bvLocalToMm(template, hemisphere, local);
      const { address, flags } = encodeBrainVolume(template, p, 6);
      assert.ok(!flags.clamped, `unexpected clamp for ${address}`);
      assert.equal(address.startsWith(`BV-${hemisphere}`), true);
      const back = locate(address, { brainVolume: template });
      assert.equal(encodeBrainVolume(template, back.pointMm, 6).address, address);
    }
  }
});

test('brain volume frame: homologous points agree across brain templates', () => {
  const r = rng(29);
  for (let i = 0; i < 4000; i += 1) {
    const hemisphere = r() < 0.5 ? 'L' : 'R';
    const local = { a: r() * 0.999, b: r() * 0.999, c: r() * 0.999 };
    const codeA = encodeBrainVolume(brainAdult, bvLocalToMm(brainAdult, hemisphere, local), 7).address;
    const codeB = encodeBrainVolume(brainChild, bvLocalToMm(brainChild, hemisphere, local), 7).address;
    assert.equal(codeB, codeA);
  }
});

test('brain volume frame: the AC-PC planes sit exactly at fraction 0.5', () => {
  // A point at the anterior commissure itself.
  const ac = bvLocalToMm(brainAdult, 'L', { a: 0, b: 0.5, c: 0.5 });
  assert.deepEqual([...ac], [...brainAdult.acMm]);
  // The piecewise split means anterior and posterior use different scales:
  // half a unit of b spans 70 mm forward but 102 mm back.
  const fwd = bvLocalToMm(brainAdult, 'L', { a: 0, b: 1, c: 0.5 });
  const back = bvLocalToMm(brainAdult, 'L', { a: 0, b: 0, c: 0.5 });
  assert.ok(Math.abs(fwd[1] - 70) < 1e-9, `anterior extent ${fwd[1]}`);
  assert.ok(Math.abs(back[1] + 102) < 1e-9, `posterior extent ${back[1]}`);
});

test('brain volume frame: the midsagittal plane resolves to L by convention', () => {
  const onMidline = bvLocalToMm(brainAdult, 'L', { a: 0, b: 0.6, c: 0.6 });
  assert.equal(encodeBrainVolume(brainAdult, onMidline, 4).address.startsWith('BV-L'), true);
});

// ---------------------------------------------------------------------------
test('cortical surface frame: index round-trips and nests', () => {
  const r = rng(31);
  for (let digits = 1; digits <= 6; digits += 1) {
    for (let i = 0; i < 2000; i += 1) {
      const theta = Math.acos(2 * r() - 1);
      const phi = 2 * Math.PI * r();
      const d = brEncodeSphere({ theta, phi }, digits);
      assert.equal(d.length, digits);
      const centre = brDecodeSphere(d);
      assert.equal(brEncodeSphere(centre, digits), d);
      if (digits > 1) {
        // The coarser code is the prefix of the finer one.
        assert.equal(brEncodeSphere({ theta, phi }, digits - 1), d.slice(0, digits - 1));
      }
    }
  }
});

test('cortical surface frame: precision ladder matches the published table', () => {
  const expected: Array<[number, number, number]> = [
    // digits, cells per hemisphere, mean cortical area mm^2
    [1, 12, 7500],
    [2, 192, 468.75],
    [3, 3072, 29.296875],
    [4, 49152, 1.8310546875],
  ];
  for (const [digits, cells, area] of expected) {
    assert.equal(Math.round(90000 / cellAreaMm2(digits)), cells);
    assert.ok(Math.abs(cellAreaMm2(digits) - area) < 1e-6, `${digits} digits -> ${cellAreaMm2(digits)}`);
  }
  // 3 digits already beats every standard parcellation by a wide margin.
  assert.ok(3072 / 52 > 50, 'should be >50x finer than Brodmann per hemisphere');
  assert.ok(3072 / 180 > 15, 'should be >15x finer than HCP-MMP1 per hemisphere');
});

test('cortical surface frame: refuses to pretend it has a template', () => {
  assert.equal(parse('BR-L-7A3F').experimental, true);
  assert.equal(parse('BD-T07-02O').experimental, false);
  assert.throws(() => locate('BR-L-7A3F', {}), (e: unknown) => (e as AlcError).code === 'frame_disabled');
});

test('frames without a template fail loudly', () => {
  assert.throws(() => locate('BD-T07-02O', {}), (e: unknown) => (e as AlcError).code === 'no_template');
  assert.throws(() => locate('BV-L-471', {}), (e: unknown) => (e as AlcError).code === 'no_template');
});
