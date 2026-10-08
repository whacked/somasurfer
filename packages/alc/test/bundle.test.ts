/**
 * The browser build, as part of the conformance suite.
 *
 * `dist/` is generated and not committed, so this test runs the build itself
 * and then exercises the output. That is deliberate: a build verified only by
 * a separate manual step is a build that breaks quietly, and the viewer loads
 * the build, not the source. Everything the viewer depends on is asserted
 * against `dist/alc.js` and `dist/esm/index.js` here.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as source from '../src/index.ts';

execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'pipe' });

const bundle = await import(pathToFileURL(resolve('dist/alc.js')).href);
const esm = await import(pathToFileURL(resolve('dist/esm/index.js')).href);

// ---------------------------------------------------------------------------
test('bundle: both outputs export exactly what the source does', () => {
  const expected = Object.keys(source).sort();
  assert.ok(expected.length > 80, `expected a substantial API, got ${expected.length} names`);
  assert.deepEqual(Object.keys(bundle).sort(), expected);
  assert.deepEqual(Object.keys(esm).sort(), expected);
});

test('bundle: the browser outputs use no Node built-ins and no dependencies', () => {
  // The viewer runs in a browser. Anything resolved from outside the package
  // would fail there, and a framework dependency would make this package
  // unusable from a different one.
  for (const file of ['dist/alc.js', 'dist/esm/index.js']) {
    const text = readFileSync(file, 'utf8');
    assert.equal(/from\s+'node:/.test(text), false, `${file} imports a Node built-in`);
    assert.equal(/\brequire\(/.test(text), false, `${file} uses require()`);
    assert.equal(/\bprocess\.|__dirname|Buffer\b/.test(text), false, `${file} touches a Node global`);
  }
  // Every specifier in the per-module output is relative, so nothing resolves
  // outside the package.
  const index = readFileSync('dist/esm/index.js', 'utf8');
  for (const [, specifier] of index.matchAll(/from\s+'([^']+)'/g)) {
    assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `non-relative specifier ${specifier}`);
    assert.ok(specifier.endsWith('.js'), `specifier ${specifier} should be rewritten to .js`);
  }
});

test('bundle: the private helpers that share names across modules did not collide', () => {
  // `dot`, `cross`, `unit`, `add`, `normalize` are defined privately in more
  // than one module, and `parseHemisphere` is exported by two different
  // frames. A flat concatenation would shadow them silently, so check the
  // geometry that depends on each.
  assert.equal(bundle.BD.id, 'BD');
  assert.equal(bundle.BV.id, 'BV');
  assert.equal(bundle.BR.id, 'BR');
  assert.equal(bundle.parse('BV-L-471').anchors[0], 'L');
  assert.equal(bundle.parse('BR-R-7A3F').anchors[0], 'R');

  const built = bundle.buildBodyTemplate ?? null;
  assert.equal(built, null, 'test-only template builders are not part of the public API');

  // Frame geometry still inverts, which exercises bodySpine's private vector
  // helpers rather than brainVolume's.
  const template = bundleTemplate();
  const p = bundle.bodyLocalToMm(template, { level: 'T07', u: 0.5, t: 0.25, r: 0.6 });
  const { address } = bundle.encodeBody(template, p, 5);
  assert.match(address, /^BD-T07-03O-/);
  assert.equal(bundle.encodeBody(template, bundle.locate(address, { body: template }).pointMm, 5).address, address);
});

test('bundle: every layer behaves identically to the source', () => {
  const cases: Array<[string, (m: typeof source) => unknown]> = [
    ['parse', (m) => m.parse('bd-t7-3o-531').canonical],
    ['withCheck', (m) => m.parse('BD-T07-03O-531').withCheck],
    ['ancestors', (m) => m.ancestors('BD-T07-03O-531').map((a) => a.canonical)],
    ['children', (m) => m.children('BV-L-4').map((c) => c.canonical)],
    ['covering', (m) => [...m.covering(['BV-L-471', 'BV-L-47']).cells]],
    ['coveringIntersect', (m) => [...m.coveringIntersect(m.covering(['BV-L-4']), m.covering(['BV-L-471'])).cells]],
    ['coveringRollUp', (m) => [...m.coveringRollUp(m.covering(['BV-L-47123']), 2).cells]],
    ['relativeMeasure', (m) => m.relativeMeasure('BD-T07', 'BD-T07-02O-5')],
    ['prefixRange', (m) => ({ ...m.prefixRange('BD-T07') })],
    ['coveringScan', (m) => m.renderScan(m.coveringScan(m.covering(['BV-L-4'])), { column: 'addr' })],
    ['toReadable', (m) => m.toReadable('BD-T07-03O-531')],
    ['toSpoken', (m) => m.toSpoken('BR-L-7A3F')],
    ['fromReadable', (m) => m.fromReadable('brain, left hemisphere, cell four seven one').canonical],
    ['describe', (m) => m.describe('BD-T07-03O-531').parts.map((p) => p.label)],
    ['frameSummaries', (m) => m.frameSummaries()],
    ['healpix', (m) => [m.healpix.npix(0), m.healpix.npix(2)]],
    ['cellAreaMm2', (m) => m.cellAreaMm2(3)],
    ['checkSymbol', (m) => m.checkSymbol('BD-T07-03O-531')],
  ];
  for (const [name, fn] of cases) {
    const expected = JSON.parse(JSON.stringify(fn(source)));
    assert.deepEqual(JSON.parse(JSON.stringify(fn(bundle as typeof source))), expected, `${name} differs in dist/alc.js`);
    assert.deepEqual(JSON.parse(JSON.stringify(fn(esm as typeof source))), expected, `${name} differs in dist/esm`);
  }
});

test('bundle: name resolution works through the build', () => {
  for (const built of [bundle, esm] as Array<typeof source>) {
    const index = built.buildNameIndex({
      version: 'bundle-test-1',
      structures: [{ id: 'a', name: 'left lung', cells: ['BD-T07-03O-5', 'BD-T07-03O-4'] }],
    });
    const r = built.resolve('BD-T07-03O-5', index);
    assert.equal(r.indexVersion, 'bundle-test-1');
    assert.equal(r.matches[0].structure.name, 'left lung');
    assert.equal(r.matches[0].fraction, 1);
    assert.deepEqual([...built.structureCovering('a', index).cells], ['BD-T07-03O-4', 'BD-T07-03O-5']);
  }
});

test('bundle: errors are still AlcError with the same codes', () => {
  // The viewer branches on `code`, so the error contract has to survive the build.
  for (const built of [bundle, esm] as Array<typeof source>) {
    for (const [input, code] of [
      ['XX-L-1', 'unknown_frame'],
      ['BD-T07-02O-9', 'bad_digit'],
      ['BD-T14-02O', 'bad_level'],
      ['BD-T07-02O-531~Z', 'check_failed'],
    ] as Array<[string, string]>) {
      assert.throws(
        () => built.parse(input),
        (e: unknown) => {
          assert.equal((e as Error).name, 'AlcError', `${input} threw ${(e as Error).name}`);
          assert.equal((e as source.AlcError).code, code);
          return true;
        },
      );
    }
    assert.throws(() => built.locate('BR-L-7A3F', {}), (e: unknown) => (e as source.AlcError).code === 'frame_disabled');
  }
});

test('bundle: package exports keep the TypeScript source reachable', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.exports['.'].types, './src/index.ts', 'types must point at the real source');
  assert.equal(pkg.exports['.'].default, './src/index.ts', 'the source must remain the default entry');
  assert.equal(pkg.exports['.'].browser, './dist/alc.js');
  assert.equal(pkg.exports['./bundle'], './dist/alc.js');
  assert.ok(pkg.exports['./src/*'], 'individual source modules must stay importable');
  assert.equal(pkg.dependencies, undefined, 'this package must have no runtime dependencies');
  for (const target of ['./dist/alc.js', './dist/esm/index.js']) {
    assert.ok(existsSync(target.slice(2)), `${target} should exist after the build`);
  }
});

/** A minimal body template, built through the bundle rather than the source. */
function bundleTemplate() {
  const slabs = [];
  let z = 0;
  for (const label of ['T06', 'T07', 'T08']) {
    const heightMm = 22;
    slabs.push({
      label,
      origin: [0, 0, z - heightMm / 2],
      axial: [0, 0, -1],
      anterior: [0, 1, 0],
      left: [1, 0, 0],
      heightMm,
      surfaceRadiiMm: Array.from({ length: 24 }, () => 120),
    });
    z -= heightMm;
  }
  return { id: 'bundle-test', slabs, maxUsefulDigits: 5 };
}
