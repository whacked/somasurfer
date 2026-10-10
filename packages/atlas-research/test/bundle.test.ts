/**
 * The browser build, as part of the suite.
 *
 * `dist/` is generated and not committed, so this test runs the build itself
 * and then exercises the output — the same arrangement as
 * `packages/alc/test/bundle.test.ts`, and for the same reason: a build verified
 * only by a separate manual step is a build that breaks quietly, and the viewer
 * loads the build, not the source. It is also how this build reaches
 * `npm run ci`, which runs `test:counted` before `build`.
 *
 * ## Supplying alc the way the page does
 *
 * The outputs import `@gstack/alc` from `'./alc.js'` and do not contain it.
 * Under Node that sibling is written here as a one-line re-export of
 * `../../alc/src/index.ts` — the very module this file and `src/` import — so
 * the source graph and the built graph share one alc, and a difference between
 * them can only be the rewrite. In the page the same specifier resolves to
 * alc's own browser bundle at `dist/app/alc.js`, which `atlas-web`'s build
 * already verifies against alc's source.
 *
 * That sharing is not a convenience, it is the contract: `buildNameIndex()`
 * keys its lookup tables in a `WeakMap` by index identity, so two copies of alc
 * in one page are two WeakMaps and `buildResearchIndex()` rejects an index
 * built by the other one. `alc is external` below asserts the accepting case
 * and then reproduces the rejecting one against alc's real browser bundle, so
 * the assertion is known to be able to fail.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildNameIndex, type NameIndex, type NameIndexInput } from '../../alc/src/index.ts';
import * as source from '../src/index.ts';
import { PKG_DIR, readJson } from './helpers.ts';

const ALC_DIR = resolve(PKG_DIR, '..', 'alc');
const ALC_SOURCE = join(ALC_DIR, 'src', 'index.ts');
const ALC_BUNDLE = join(ALC_DIR, 'dist', 'alc.js');

const OUTPUTS = ['dist/atlas-research.js', 'dist/esm/index.js'] as const;
/** Where each output resolves `'./alc.js'` to. */
const SHIMS = ['dist/alc.js', 'dist/esm/alc.js'] as const;

execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: PKG_DIR, stdio: 'pipe' });

// Read before the shims go in: the build must not have shipped an alc of its own.
const shippedAlc = SHIMS.filter((p) => existsSync(join(PKG_DIR, p)));

const shim = `export * from ${JSON.stringify(pathToFileURL(ALC_SOURCE).href)};\n`;
for (const p of SHIMS) writeFileSync(join(PKG_DIR, p), shim);
const [bundle, esm] = await Promise.all(OUTPUTS.map((p) => import(pathToFileURL(join(PKG_DIR, p)).href)));
for (const p of SHIMS) rmSync(join(PKG_DIR, p), { force: true });

const built: Array<[string, typeof source]> = [
  ['dist/atlas-research.js', bundle as typeof source],
  ['dist/esm/index.js', esm as typeof source],
];

/**
 * A second, independent copy of alc, for the negative control below: alc's own
 * browser bundle is one file with its own identity WeakMap, so it stands in for
 * the page that loaded alc twice. Built here if it is not already, because
 * which suite ran first is not something this file should depend on.
 */
if (!existsSync(ALC_BUNDLE)) {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: ALC_DIR, stdio: 'pipe' });
}
const secondAlc = (await import(pathToFileURL(ALC_BUNDLE).href)) as { buildNameIndex: typeof buildNameIndex };

const rawDataset = readJson('fixtures/research.fixture.json') as {
  findings: Array<{ mappings: Array<{ structureId: string }> }>;
};
const rawNames = readJson('fixtures/names.fixture.json') as NameIndexInput;

/** A structure the fixture dataset actually maps, so removing it changes an answer. */
const droppedId = rawNames.structures.find((s) =>
  rawDataset.findings.some((f) => f.mappings.some((m) => m.structureId === s.id)),
)!.id;

const wholeIndex = () => buildNameIndex({ version: rawNames.version, structures: rawNames.structures });
const partialIndex = () =>
  buildNameIndex({
    version: `${rawNames.version}+without-${droppedId}`,
    structures: rawNames.structures.filter((s) => s.id !== droppedId),
  });

/**
 * One line per mapping, carrying the fields a viewer branches on. Built from a
 * module's own `loadDataset` so the validator is on the compared path too.
 */
function rows(module: typeof source, names: NameIndex): string[] {
  const index = module.buildResearchIndex({
    dataset: module.loadDataset(structuredClone(rawDataset)),
    names,
  });
  return index.mappings.map((m) =>
    [m.mappingId, m.resolution, String(m.unresolvedReason), [...m.covering.cells].join(' ')].join(' | '),
  );
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

/**
 * `import|export <clause> from '<specifier>';` — the build script's own
 * definition of a from-statement, reused here on purpose.
 *
 * A bare `from '...'` search would also match the prose in the generated
 * header, which names the alc specifier in a sentence; requiring the clause
 * means only real statements are counted.
 */
const FROM_STATEMENT = /\b(?:import|export)\s+(?:(?:\{[\s\S]*?\})|(?:\*\s+as\s+[A-Za-z_$][\w$]*))\s+from\s+'([^']+)';/g;

const specifiersOf = (file: string) =>
  [...readFileSync(join(PKG_DIR, file), 'utf8').matchAll(FROM_STATEMENT)].map((m) => m[1]);

// ---------------------------------------------------------------------------
test('bundle: both outputs export exactly what the source does', () => {
  const expected = Object.keys(source).sort();
  assert.ok(expected.length > 20, `expected a substantial API, got ${expected.length} names`);
  for (const [label, module] of built) {
    assert.deepEqual(Object.keys(module).sort(), expected, `${label} exports differ`);
  }
});

test('bundle: the browser outputs use no Node built-ins and no bare specifiers', () => {
  // The research layer runs in a browser. Anything resolved from outside the
  // package except alc would fail there.
  for (const file of [...OUTPUTS, 'dist/esm/dataset.js', 'dist/esm/validate.js', 'dist/esm/layers.js']) {
    const text = readFileSync(join(PKG_DIR, file), 'utf8');
    assert.equal(/from\s+'node:/.test(text), false, `${file} imports a Node built-in`);
    assert.equal(/\brequire\(/.test(text), false, `${file} uses require()`);
    assert.equal(/\bprocess\.|__dirname|Buffer\b/.test(text), false, `${file} touches a Node global`);
    for (const specifier of specifiersOf(file)) {
      assert.ok(specifier.startsWith('./'), `${file}: non-sibling specifier ${specifier}`);
      assert.ok(specifier.endsWith('.js'), `${file}: specifier ${specifier} should be rewritten to .js`);
    }
  }
});

test('bundle: alc is external, not inlined, and no copy of it ships', () => {
  const text = readFileSync(join(PKG_DIR, 'dist/atlas-research.js'), 'utf8');

  assert.deepEqual(
    specifiersOf('dist/atlas-research.js'),
    ['./alc.js'],
    'the single-file bundle must import alc and nothing else',
  );

  // Inlining alc would put its own exports in this file. They are not here.
  assert.equal(/\bfunction buildNameIndex\b/.test(text), false, 'buildNameIndex is defined in the bundle');
  for (const name of ['buildNameIndex', 'parse', 'covering', 'resolve'] as const) {
    assert.equal((bundle as Record<string, unknown>)[name], undefined, `${name} is re-exported by the bundle`);
  }

  assert.deepEqual(shippedAlc, [], `the build left an alc beside its output: ${shippedAlc.join(', ')}`);
});

test('bundle: a NameIndex built by the alc the page loads resolves through the build', () => {
  // The accepting case. `buildNameIndex` here is the one `src/` imports, and
  // the outputs were given the same module as their './alc.js'.
  for (const [label, module] of built) {
    const index = module.buildResearchIndex({
      dataset: module.loadDataset(structuredClone(rawDataset)),
      names: wholeIndex(),
    });
    assert.ok(index.mappings.length > 0, `${label} resolved no mappings`);
    assert.ok(
      index.mappings.some((m) => m.resolution === 'resolved'),
      `${label}: nothing resolved, so the index was not really read`,
    );
  }
});

test('bundle: an index built by a second copy of alc is rejected', () => {
  // The negative control for the test above, and the failure DOG-74 hit while
  // measuring this work. `secondAlc` is alc's own browser bundle: a genuinely
  // separate module with its own identity WeakMap, which is exactly what a page
  // carrying two copies of alc would have. An index built by it must be refused
  // rather than silently resolving to nothing.
  assert.notEqual(secondAlc.buildNameIndex, buildNameIndex, 'the second copy is the same module');
  const foreign = secondAlc.buildNameIndex({ version: rawNames.version, structures: rawNames.structures });

  for (const [label, module] of built) {
    assert.throws(
      () =>
        module.buildResearchIndex({
          dataset: module.loadDataset(structuredClone(rawDataset)),
          names: foreign,
        }),
      (e: unknown) => {
        assert.equal((e as Error).name, 'AlcError', `${label} threw ${(e as Error).name}`);
        assert.equal((e as { code?: string }).code, 'bad_name_index', `${label} threw the wrong code`);
        return true;
      },
      `${label} accepted a NameIndex built by another copy of alc`,
    );
  }

  // Same rejection for an index-shaped literal, which is the other way the
  // identity check can be reached: anything buildNameIndex() did not make.
  const shaped = wholeIndex();
  assert.throws(
    () =>
      bundle.buildResearchIndex({
        dataset: bundle.loadDataset(structuredClone(rawDataset)),
        names: { version: shaped.version, structures: shaped.structures, coverings: shaped.coverings },
      }),
    (e: unknown) => (e as { code?: string }).code === 'bad_name_index',
  );
});

test('bundle: resolution and unresolvedReason match the source graph, mapping by mapping', () => {
  const names = wholeIndex();
  const expected = rows(source, names);
  assert.ok(expected.length > 0, 'the fixture resolved no mappings');
  for (const [label, module] of built) {
    assert.deepEqual(rows(module, wholeIndex()), expected, `${label} differs from the source graph`);
  }
});

test('bundle: ... and still match when the index loses a structure the dataset maps', () => {
  const whole = rows(source, wholeIndex());
  const partial = rows(source, partialIndex());

  // The must-pass half. Equality over a dataset that resolves everywhere says
  // nothing about `unresolvedReason`, so the comparison is only meaningful
  // while removing `droppedId` really does move a mapping to unresolved.
  const moved = partial.filter(
    (row, i) => whole[i].includes(' | resolved | ') && row.includes(' | unresolved | unknown-structure | '),
  );
  assert.ok(
    moved.length > 0,
    `removing ${droppedId} moved no mapping to unknown-structure; this comparison proves nothing`,
  );

  for (const [label, module] of built) {
    assert.deepEqual(rows(module, partialIndex()), partial, `${label} differs from the source graph`);
  }
});

test('bundle: browse, selection and the colour layers behave identically', () => {
  const names = wholeIndex();
  const index = source.buildResearchIndex({ dataset: source.loadDataset(structuredClone(rawDataset)), names });
  const papers = index.papers.map((p) => p.id).slice(0, 2);
  const cell = index.cellKeys[0];
  assert.ok(papers.length === 2 && typeof cell === 'string', 'the fixture must offer two papers and a resolved cell');

  const cases: Array<[string, (m: typeof source, i: source.ResearchIndex) => unknown]> = [
    ['browseByAnatomy', (m, i) => m.browseByAnatomy(i, cell)],
    ['browseByResearch', (m, i) => m.browseByResearch(i, { selected: papers })],
    ['paperSelection', (m, i) => m.paperSelection(i, papers)],
    ['selectionExtent', (m, i) => [...m.selectionExtent(m.paperSelection(i, papers)).cells]],
    ['solidColourLayers', (m, i) => m.solidColourLayers(i, papers)],
    ['pairOverlap', (m, i) => [...m.pairOverlap(i, papers[0], papers[1]).cells]],
    ['anatomyScan', (m) => m.anatomyScan(cell)],
    ['assignPaperColours', (m) => m.assignPaperColours(papers)],
    ['formatCitation', (m, i) => m.formatCitation(i.papers[0])],
    ['safeHref', (m) => m.safeHref('javascript:alert(1)')],
  ];

  for (const [label, module] of built) {
    const theirIndex = module.buildResearchIndex({
      dataset: module.loadDataset(structuredClone(rawDataset)),
      names: wholeIndex(),
    });
    for (const [name, fn] of cases) {
      assert.deepEqual(plain(fn(module, theirIndex)), plain(fn(source, index)), `${name} differs in ${label}`);
    }
  }
});

test('bundle: package exports keep the TypeScript source reachable', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['.'].types, './src/index.ts', 'types must point at the real source');
  assert.equal(pkg.exports['.'].default, './src/index.ts', 'the source must remain the default entry');
  assert.equal(pkg.exports['.'].browser, './dist/atlas-research.js');
  assert.equal(pkg.exports['./bundle'], './dist/atlas-research.js');
  assert.ok(pkg.exports['./src/*'], 'individual source modules must stay importable');
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@gstack/alc'], 'alc is the only dependency');
  assert.equal(pkg.atlas.licenceClass, 'code');
  for (const output of OUTPUTS) assert.ok(existsSync(join(PKG_DIR, output)), `${output} should exist after the build`);
});
