/**
 * The public surface, as a contract.
 *
 * The spec's §6 rule — never compare addresses across subjects with string
 * equality — is a product requirement, not a library note, so it is tested
 * here as a property of the API rather than left to code review:
 *
 *  1. No exported function answers an equality question. The only sanctioned
 *     comparisons are `samePlace` and `coveringsSamePlace`.
 *  2. Neither of them has a default tolerance, so reaching an answer requires
 *     typing a number.
 *  3. The number that justifies all of it is measured here, not quoted, so the
 *     documentation cannot drift away from the behaviour.
 *  4. The addressing modules cannot see a template or a name index, which is
 *     what makes an address independent of both.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import * as alc from '../src/index.ts';
import {
  AlcError,
  covering,
  coveringsSamePlace,
  encodeBody,
  locate,
  recommendedDigits,
  samePlace,
} from '../src/index.ts';
import { bodyLocalToMm } from '../src/frames/bodySpine.ts';
import { ADULT_MALE, BRAIN_ADULT, buildBodyTemplate, buildBrainTemplate, rng } from '../src/testing/syntheticTemplates.ts';

const adult = buildBodyTemplate(ADULT_MALE);
const brainAdult = buildBrainTemplate(BRAIN_ADULT);
const body = { body: adult };

/** Every TypeScript source file in the package, for the structural assertions below. */
function walkSrc(dir = 'src'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkSrc(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
test('public surface: no exported function answers an equality question', () => {
  // `samePlace` and `coveringsSamePlace` are the sanctioned comparisons. Any
  // other export whose name promises sameness would be a way to reach the 4%
  // answer measured below without stating a tolerance.
  const SANCTIONED = new Set(['samePlace', 'coveringsSamePlace']);
  const SUSPICIOUS = /equal|equiv|identical|^is?same|same(?!Place)|matches$|^eq$/i;

  const offenders = Object.keys(alc).filter((name) => !SANCTIONED.has(name) && SUSPICIOUS.test(name));
  assert.deepEqual(offenders, [], `equality-shaped exports found: ${offenders.join(', ')}`);

  // The containment predicates that do exist are directional, not symmetric
  // equality, and they are the within-one-template answer.
  assert.equal(typeof alc.contains, 'function');
  assert.equal(typeof alc.overlaps, 'function');
  assert.equal(alc.overlaps('BV-L-471', 'BV-L-4710'), true, 'nested cells overlap');
  assert.equal(alc.contains('BV-L-4710', 'BV-L-471'), false, 'containment has a direction');

  // Nothing exported takes two addresses and returns a bare "yes, the same".
  for (const name of SANCTIONED) {
    assert.equal(typeof (alc as Record<string, unknown>)[name], 'function');
  }
});

test('public surface: every sanctioned comparison demands an explicit tolerance', () => {
  const A = covering(['BV-L-471']);
  const B = covering(['BV-L-472']);
  const brain = { brainVolume: brainAdult };

  for (const toleranceMm of [undefined, null, NaN, Infinity, -Infinity, -1, '5', {}, []] as never[]) {
    assert.throws(
      () => samePlace('BV-L-471', 'BV-L-472', brain, { toleranceMm }),
      (e: unknown) => (e as AlcError).code === 'bad_tolerance',
      `samePlace accepted toleranceMm ${JSON.stringify(toleranceMm)}`,
    );
    assert.throws(
      () => coveringsSamePlace(A, B, { across: 'subjects', toleranceMm, templatesA: brain, templatesB: brain }),
      (e: unknown) => (e as AlcError).code === 'bad_tolerance',
      `coveringsSamePlace accepted toleranceMm ${JSON.stringify(toleranceMm)}`,
    );
  }
  // Options are required outright, not defaulted.
  assert.throws(() => (samePlace as (...a: unknown[]) => unknown)('BV-L-471', 'BV-L-472', brain), Error);
  assert.throws(
    () => coveringsSamePlace(A, B, { across: 'subjects', templatesA: brain, templatesB: brain } as never),
    (e: unknown) => (e as AlcError).code === 'bad_tolerance',
  );
  // Zero is a legitimate, explicit statement of "exactly".
  assert.equal(samePlace('BV-L-471', 'BV-L-471', brain, { toleranceMm: 0 }).same, true);
});

test('public surface: comparing across frames is refused, not approximated', () => {
  assert.throws(
    () => samePlace('BV-L-471', 'BD-T07-02O-531', { brainVolume: brainAdult, body: adult }, { toleranceMm: 5 }),
    (e: unknown) => (e as AlcError).code === 'frame_mismatch',
  );
});

// ---------------------------------------------------------------------------
test('why string equality is banned, measured rather than quoted', () => {
  // Spec §6: at a 5 mm registration residual and 3 BD digits, exact string
  // agreement is about 4% while the median gap between the two decoded cell
  // centres is about 5.9 mm — the residual itself. The addresses still
  // localise correctly; only the strings differ. If this test ever disagrees
  // with the spec table, one of the two is wrong and both need looking at.
  const residualMm = 5;
  const digits = 3;
  const trials = 8000;
  const r = rng(99);

  let stringAgreements = 0;
  let samePlaceAgreements = 0;
  const gaps: number[] = [];

  for (let i = 0; i < trials; i += 1) {
    const slab = adult.slabs[7 + Math.floor(r() * 12)];
    const p = bodyLocalToMm(adult, { level: slab.label, u: r(), t: r(), r: 0.2 + r() * 0.75 });
    const x = r() * 2 - 1;
    const y = r() * 2 - 1;
    const z = r() * 2 - 1;
    const n = Math.hypot(x, y, z) || 1;
    const q: [number, number, number] = [
      p[0] + (x / n) * residualMm,
      p[1] + (y / n) * residualMm,
      p[2] + (z / n) * residualMm,
    ];

    const a = encodeBody(adult, p, digits).address;
    const b = encodeBody(adult, q, digits).address;
    if (a === b) stringAgreements += 1;

    const ca = locate(a, body).pointMm;
    const cb = locate(b, body).pointMm;
    gaps.push(Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]));

    if (samePlace(a, b, body, { toleranceMm: residualMm }).same) samePlaceAgreements += 1;
  }

  gaps.sort((m, n2) => m - n2);
  const stringRate = stringAgreements / trials;
  const medianGap = gaps[Math.floor(gaps.length * 0.5)];
  const samePlaceRate = samePlaceAgreements / trials;

  // String equality agrees roughly 4% of the time.
  assert.ok(stringRate < 0.10, `string agreement should be near 0.04, got ${stringRate.toFixed(3)}`);
  // ...yet the decoded cells stay about one residual apart, not wildly apart.
  assert.ok(
    medianGap > residualMm * 0.6 && medianGap < residualMm * 1.8,
    `median centre gap should be about the ${residualMm} mm residual, got ${medianGap.toFixed(2)}`,
  );
  // ...and the sanctioned comparison recognises almost all of them.
  assert.ok(
    samePlaceRate > 0.95,
    `samePlace with a stated ${residualMm} mm tolerance should recognise these, got ${samePlaceRate.toFixed(3)}`,
  );
  // The gap between the two is the whole reason this rule exists.
  assert.ok(samePlaceRate - stringRate > 0.8, 'the sanctioned comparison must be dramatically better');
});

test('why string equality is banned: a covering comparison behaves the same way', () => {
  // The same measurement at covering scale, so the rule holds for the unit the
  // research layer actually stores.
  const r = rng(1717);
  let exactRegime = 0;
  let acrossRegime = 0;
  const trials = 600;
  for (let i = 0; i < trials; i += 1) {
    const slab = adult.slabs[7 + Math.floor(r() * 12)];
    const p = bodyLocalToMm(adult, { level: slab.label, u: 0.2 + r() * 0.6, t: r(), r: 0.3 + r() * 0.5 });
    const x = r() * 2 - 1;
    const y = r() * 2 - 1;
    const z = r() * 2 - 1;
    const n = Math.hypot(x, y, z) || 1;
    const q: [number, number, number] = [p[0] + (x / n) * 5, p[1] + (y / n) * 5, p[2] + (z / n) * 5];
    const A = covering([encodeBody(adult, p, 3).address]);
    const B = covering([encodeBody(adult, q, 3).address]);
    if (coveringsSamePlace(A, B, { within: 'template' }).same) exactRegime += 1;
    if (coveringsSamePlace(A, B, { across: 'subjects', toleranceMm: 5, templatesA: body, templatesB: body }).same) {
      acrossRegime += 1;
    }
  }
  assert.ok(exactRegime / trials < 0.3, `cell sharing is unreliable at a 5 mm residual, got ${exactRegime / trials}`);
  assert.ok(acrossRegime / trials > 0.9, `the cross-subject regime should recognise these, got ${acrossRegime / trials}`);
});

test('recommendedDigits: the library tells a caller how much precision to show', () => {
  // The constructive half of the rule: do not print digits finer than the
  // uncertainty they stand in for.
  const fine = recommendedDigits('BD-T07-03O-53165', body, 1);
  const coarse = recommendedDigits('BD-T07-03O-53165', body, 10);
  assert.ok(fine > coarse, `expected more digits at 1 mm (${fine}) than at 10 mm (${coarse})`);
  for (const residualMm of [1, 2, 5, 10, 20]) {
    const d = recommendedDigits('BD-T07-03O-53165', body, residualMm);
    const address = d === 0 ? 'BD-T07-03O' : `BD-T07-03O-${'53165'.slice(0, d)}`;
    const extent = locate(address, body).extentMm;
    assert.ok(
      Math.min(...extent) >= residualMm,
      `at a ${residualMm} mm residual, ${address} has a ${Math.min(...extent).toFixed(1)} mm side`,
    );
  }
});

// ---------------------------------------------------------------------------
test('architecture: the addressing modules cannot see a template or a name index', () => {
  // This is the structural guarantee behind two separate claims: that an
  // address means the same place in every template, and that a parcellation
  // revision cannot invalidate an issued address. Neither survives if the
  // address layer can reach the layers below it.
  const FORBIDDEN: Record<string, string[]> = {
    'src/codec.ts': ['address.ts', 'locate.ts', 'resolve.ts', 'covering.ts', 'query.ts', 'frames/'],
    'src/address.ts': ['locate.ts', 'resolve.ts', 'covering.ts', 'query.ts', 'compare.ts'],
    'src/types.ts': ['address.ts', 'codec.ts', 'locate.ts', 'resolve.ts'],
  };
  for (const [file, forbidden] of Object.entries(FORBIDDEN)) {
    const source = readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const bad of forbidden) {
      assert.ok(
        !imports.some((i) => i.includes(bad)),
        `${file} must not import ${bad}; it imports ${imports.join(', ')}`,
      );
    }
  }
  // And nothing in src imports a package: no framework dependency, no runtime
  // dependency at all, so the browser build is the source and nothing else.
  for (const file of walkSrc()) {
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+'([^']+)'/g)) {
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('../'),
        `${file} imports ${specifier}; this package must have no dependencies`,
      );
    }
  }
});

test('docs: the published error-code table matches the codes the source throws', () => {
  // The API docs are a deliverable, so they get a test. Drift in either
  // direction is a bug: an undocumented code is one the viewer cannot branch
  // on safely, and a documented code that no longer exists is a lie.
  const thrown = new Set<string>();
  for (const file of walkSrc()) {
    const text = readFileSync(file, 'utf8');
    for (const [, args] of text.matchAll(/new AlcError\(([\s\S]*?)\);/g)) {
      const quoted = [...args.matchAll(/'([a-z_]+)'/g)];
      if (quoted.length > 0) thrown.add(quoted[quoted.length - 1][1]);
    }
  }
  assert.ok(thrown.size > 30, `expected a substantial code set, found ${thrown.size}`);

  // Just the error-code section, not the prose after it: `types` and the like
  // are backticked identifiers elsewhere in the document.
  const docs = readFileSync('../../docs/alc-1-api.md', 'utf8');
  const start = docs.indexOf('## 9. Error codes');
  assert.ok(start > 0, 'the API docs must keep an error-code section');
  const end = docs.indexOf('\n## ', start + 1);
  const section = docs.slice(start, end < 0 ? undefined : end);
  const documented = new Set([...section.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));

  const undocumented = [...thrown].filter((code) => !documented.has(code)).sort();
  assert.deepEqual(undocumented, [], `error codes thrown but not documented: ${undocumented.join(', ')}`);

  const stale = [...documented].filter((code) => !thrown.has(code)).sort();
  assert.deepEqual(stale, [], `error codes documented but never thrown: ${stale.join(', ')}`);
});

test('docs: a code means one thing, so each is thrown from one module', () => {
  // `bad_index` (a BR HEALPix pixel out of range) and `bad_name_index` (the
  // caller passed something that is not a name index) were the same code once.
  // A viewer branching on it could not tell a malformed address from a
  // programming error.
  const modulesByCode = new Map<string, Set<string>>();
  for (const file of walkSrc()) {
    const text = readFileSync(file, 'utf8');
    for (const [, args] of text.matchAll(/new AlcError\(([\s\S]*?)\);/g)) {
      const quoted = [...args.matchAll(/'([a-z_]+)'/g)];
      if (quoted.length === 0) continue;
      const code = quoted[quoted.length - 1][1];
      if (!modulesByCode.has(code)) modulesByCode.set(code, new Set());
      modulesByCode.get(code)!.add(file);
    }
  }
  assert.deepEqual([...(modulesByCode.get('bad_index') ?? [])], ['src/frames/brainSurface.ts']);
  assert.deepEqual([...(modulesByCode.get('bad_name_index') ?? [])], ['src/resolve.ts']);
  assert.deepEqual([...(modulesByCode.get('bad_tolerance') ?? [])].sort(), ['src/compare.ts', 'src/covering.ts']);
});

test('architecture: every export is reachable from the package entry point', () => {
  // A module that index.ts forgets to re-export is a module the viewer cannot
  // use, and the viewer imports the package, not its files.
  const index = readFileSync('src/index.ts', 'utf8');
  for (const module of ['covering.ts', 'query.ts', 'resolve.ts', 'translate.ts']) {
    assert.ok(index.includes(`'./${module}'`), `index.ts must re-export ${module}`);
  }
  for (const name of [
    'covering', 'coveringIntersect', 'coveringRollUp', 'coveringFromRegion', 'coveringsSamePlace',
    'prefixRange', 'coveringScan', 'renderScan',
    'buildNameIndex', 'resolve', 'structureCovering',
    'toReadable', 'toSpoken', 'fromReadable', 'describe', 'frameSummary',
  ]) {
    assert.equal(typeof (alc as Record<string, unknown>)[name], 'function', `${name} should be exported`);
  }
});
