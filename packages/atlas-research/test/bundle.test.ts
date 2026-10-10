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
 *
 * ## Two entries, and so two different right answers about exports
 *
 * Since DOG-84 the build emits a third output: `dist/atlas-research.viewer.js`,
 * built from `src/index.viewer.ts`, which exports the three names the page
 * imports. It is what `packages/atlas-web` serves, and it is 8.7 KiB of gzip
 * smaller than the package — `bundleGzipBytes` was reading 98% of 150 KiB.
 *
 * So "every output exports what the source does" is no longer the invariant,
 * and the replacement is not a weaker version of it. Each output is paired
 * below with the ENTRY it was built from and checked for exact equality
 * against that; the viewer entry is then checked to be a proper subset of
 * `src/index.ts` whose every name is the SAME BINDING, so a narrower surface
 * cannot become a second implementation. Both halves are needed: the first
 * alone would accept a reimplementation, the second alone would accept a
 * bundle that had drifted from its own entry.
 *
 * The behavioural comparisons split the same way, and deliberately do not
 * skip the viewer bundle: its three names are compared against the source like
 * everything else, and only the cases that NAME `browse.ts` or `layers.ts`
 * exports are restricted to the full-surface outputs. A viewer bundle that is
 * merely smaller and also wrong would pass a size check and fail these.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildNameIndex, type NameIndex, type NameIndexInput } from '../../alc/src/index.ts';
import * as source from '../src/index.ts';
import * as viewerSource from '../src/index.viewer.ts';
import { PKG_DIR, readJson } from './helpers.ts';

const ALC_DIR = resolve(PKG_DIR, '..', 'alc');
const ALC_SOURCE = join(ALC_DIR, 'src', 'index.ts');
const ALC_BUNDLE = join(ALC_DIR, 'dist', 'alc.js');

/**
 * Every emitted output, with the entry it is built from.
 *
 * `fullSurface` marks the outputs that export the whole package. It is what
 * splits the comparisons below, rather than the output's name, so adding a
 * fourth output means declaring its extent rather than editing six tests.
 */
const OUTPUTS = [
  { path: 'dist/atlas-research.js', entry: source, entryPath: 'src/index.ts', fullSurface: true },
  { path: 'dist/atlas-research.viewer.js', entry: viewerSource, entryPath: 'src/index.viewer.ts', fullSurface: false },
  { path: 'dist/esm/index.js', entry: source, entryPath: 'src/index.ts', fullSurface: true },
] as const;

/** The single-file bundles, whose text is asserted on directly. */
const SINGLE_FILE = ['dist/atlas-research.js', 'dist/atlas-research.viewer.js'] as const;

/** Where each output expects to find alc, and so where the shims go. */
const SHIMS = ['dist/alc.js', 'dist/esm/alc.js'] as const;
const alcPositions = SHIMS.map((p) => join(PKG_DIR, p));

execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: PKG_DIR, stdio: 'pipe' });

// Read before the shims go in: the build must not have shipped an alc of its own.
const shippedAlc = SHIMS.filter((p) => existsSync(join(PKG_DIR, p)));

const shim = `export * from ${JSON.stringify(pathToFileURL(ALC_SOURCE).href)};\n`;
for (const p of SHIMS) writeFileSync(join(PKG_DIR, p), shim);
const loaded = await Promise.all(OUTPUTS.map((o) => import(pathToFileURL(join(PKG_DIR, o.path)).href)));
for (const p of SHIMS) rmSync(join(PKG_DIR, p), { force: true });

/**
 * The outputs as loaded modules.
 *
 * Typed as the full surface because every helper below reaches for
 * `loadDataset` and `buildResearchIndex`, which all three really have. The
 * names the viewer bundle does NOT have are only ever touched through
 * `fullSurface`, and `each output exports exactly what its entry does` is what
 * holds that typing to the truth.
 */
const built = OUTPUTS.map((o, i) => ({ ...o, module: loaded[i] as typeof source }));
const bundle = built[0].module;
const viewerBundle = built[1].module;
const fullSurface = built.filter((o) => o.fullSurface);

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
test('bundle: each output exports exactly what the entry it was built from exports', () => {
  assert.ok(Object.keys(source).length > 20, `expected a substantial API, got ${Object.keys(source).length} names`);
  for (const { path: label, module, entry, entryPath } of built) {
    assert.deepEqual(Object.keys(module).sort(), Object.keys(entry).sort(), `${label} differs from ${entryPath}`);
  }
});

test('bundle: the viewer entry is a proper subset of the package, binding for binding', () => {
  const full = Object.keys(source).sort();
  const viewer = Object.keys(viewerSource).sort();

  // The three names `packages/atlas-web/src/viewer/corpus.js` imports, stated
  // as literals. The subset relation below would be satisfied by any subset at
  // all, including one missing a name the page needs — which is a build
  // failure in atlas-web and a blank panel if that check were ever removed.
  assert.deepEqual(viewer, ['buildResearchIndex', 'formatCitation', 'loadDataset']);

  assert.deepEqual(viewer.filter((n) => !full.includes(n)), [], 'the viewer entry exports a name the package does not');

  // By identity, not by name: a name check is satisfied by a reimplementation,
  // and the entire argument for serving a subset is that it is the same code
  // reached through a shorter path.
  for (const name of viewer) {
    assert.equal(
      (viewerSource as Record<string, unknown>)[name],
      (source as Record<string, unknown>)[name],
      `${name} is a different binding in index.viewer.ts than in index.ts`,
    );
  }

  // Proper, so an entry that has grown back to the whole package fails here
  // rather than silently re-spending the bundleGzipBytes headroom it exists to
  // recover. This is the assertion that would catch the trim being undone.
  assert.ok(viewer.length < full.length, `the viewer entry exports all ${full.length} names; the trim is gone`);
});

test('bundle: the viewer bundle stopped containing the modules it stopped reaching', () => {
  const full = readFileSync(join(PKG_DIR, 'dist/atlas-research.js'), 'utf8');
  const viewer = readFileSync(join(PKG_DIR, 'dist/atlas-research.viewer.js'), 'utf8');

  // The build names each inlined module's scope `__m_<module>`, so the emitted
  // graph can be read off the output rather than inferred from its size. This
  // is the claim the whole change rests on: `browse.ts` and `layers.ts` were in
  // the shipped bundle only because `index.ts` re-exports them.
  const scopes = (text: string) => [...text.matchAll(/^const (__m_\w+) = \(\(\) => \{$/gm)].map((m) => m[1]).sort();

  assert.deepEqual(scopes(full), ['__m_browse', '__m_dataset', '__m_index', '__m_layers', '__m_links', '__m_validate']);
  assert.deepEqual(scopes(viewer), ['__m_dataset', '__m_index_viewer', '__m_links', '__m_validate']);

  // And the functions themselves are gone, not merely unexported. An unreached
  // module that was still inlined would cost the same bytes.
  for (const name of ['browseByAnatomy', 'solidColourLayers', 'assignPaperColours'] as const) {
    assert.ok(new RegExp(`function ${name}\\b`).test(full), `${name} should be defined in the full bundle`);
    assert.equal(new RegExp(`function ${name}\\b`).test(viewer), false, `${name} is still inlined in the viewer bundle`);
  }

  assert.ok(viewer.length < full.length, 'the viewer bundle is not smaller than the package bundle');
});

test('bundle: the browser outputs use no Node built-ins and no bare specifiers', () => {
  // The research layer runs in a browser. Anything resolved from outside the
  // package except alc would fail there.
  const files = [...OUTPUTS.map((o) => o.path), 'dist/esm/dataset.js', 'dist/esm/validate.js', 'dist/esm/layers.js'];
  for (const file of files) {
    const text = readFileSync(join(PKG_DIR, file), 'utf8');
    assert.equal(/from\s+'node:/.test(text), false, `${file} imports a Node built-in`);
    assert.equal(/\brequire\(/.test(text), false, `${file} uses require()`);
    assert.equal(/\bprocess\.|__dirname|Buffer\b/.test(text), false, `${file} touches a Node global`);
    for (const specifier of specifiersOf(file)) {
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('../'),
        `${file}: non-relative specifier ${specifier}`,
      );
      assert.ok(specifier.endsWith('.js'), `${file}: specifier ${specifier} should be rewritten to .js`);
      // Every specifier resolves to something the build emitted, with one
      // allowed exception: alc's, which the page supplies and the build
      // deliberately does not. Asserting the resolved path rather than the
      // literal `'./alc.js'` keeps this true if src/ ever gains a
      // subdirectory, where the right specifier is `'../alc.js'`.
      const target = resolve(dirname(join(PKG_DIR, file)), specifier);
      assert.ok(
        alcPositions.includes(target) || existsSync(target),
        `${file}: ${specifier} resolves to ${target}, which the build did not emit`,
      );
    }
  }
});

test('bundle: alc is external, not inlined, and no copy of it ships', () => {
  // Both single-file bundles, because the trimmed one is a second emission of
  // the same rewrite and a second chance to inline the library by accident.
  for (const file of SINGLE_FILE) {
    const text = readFileSync(join(PKG_DIR, file), 'utf8');
    assert.deepEqual(specifiersOf(file), ['./alc.js'], `${file} must import alc and nothing else`);
    // Inlining alc would put its own exports in this file. They are not here.
    assert.equal(/\bfunction buildNameIndex\b/.test(text), false, `buildNameIndex is defined in ${file}`);
  }

  for (const module of [bundle, viewerBundle]) {
    for (const name of ['buildNameIndex', 'parse', 'covering', 'resolve'] as const) {
      assert.equal((module as Record<string, unknown>)[name], undefined, `${name} is re-exported by a bundle`);
    }
  }

  assert.deepEqual(shippedAlc, [], `the build left an alc beside its output: ${shippedAlc.join(', ')}`);
});

test('bundle: a NameIndex built by the alc the page loads resolves through the build', () => {
  // The accepting case. `buildNameIndex` here is the one `src/` imports, and
  // the outputs were given the same module as their './alc.js'.
  for (const { path: label, module } of built) {
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

  for (const { path: label, module } of built) {
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
  for (const { path: label, module } of built) {
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

  for (const { path: label, module } of built) {
    assert.deepEqual(rows(module, partialIndex()), partial, `${label} differs from the source graph`);
  }
});

/**
 * The fixture state every behavioural case below is built from, so the two
 * tests cannot disagree about which papers and which cell they used.
 */
function behaviourFixture() {
  const names = wholeIndex();
  const index = source.buildResearchIndex({ dataset: source.loadDataset(structuredClone(rawDataset)), names });
  const papers = index.papers.map((p) => p.id).slice(0, 2);
  const cell = index.cellKeys[0];
  assert.ok(papers.length === 2 && typeof cell === 'string', 'the fixture must offer two papers and a resolved cell');
  return { index, papers, cell };
}

type Case = [string, (m: typeof source, i: source.ResearchIndex) => unknown];

function compare(outputs: typeof built, cases: Case[], index: source.ResearchIndex) {
  for (const { path: label, module } of outputs) {
    const theirIndex = module.buildResearchIndex({
      dataset: module.loadDataset(structuredClone(rawDataset)),
      names: wholeIndex(),
    });
    for (const [name, fn] of cases) {
      assert.deepEqual(plain(fn(module, theirIndex)), plain(fn(source, index)), `${name} differs in ${label}`);
    }
  }
}

test('bundle: the three exports the viewer gets behave identically in every output', () => {
  // The viewer bundle's whole surface, over all three outputs including it.
  // `loadDataset` and `buildResearchIndex` are already compared mapping by
  // mapping above; this is where `formatCitation` is, and it would otherwise be
  // the one name the page uses that no comparison in this file touches.
  const { index, papers } = behaviourFixture();
  assert.deepEqual(Object.keys(viewerSource).sort(), ['buildResearchIndex', 'formatCitation', 'loadDataset']);
  compare(built, [
    ['formatCitation', (m, i) => m.formatCitation(i.papers[0])],
    ['formatCitation (second paper)', (m, i) => m.formatCitation(i.papers[1])],
    ['buildResearchIndex: papers', (m, i) => i.papers.map((p) => p.id)],
    ['buildResearchIndex: cellKeys', (m, i) => i.cellKeys],
  ], index);
  assert.ok(papers.length === 2);
});

test('bundle: browse, selection and the colour layers behave identically in the full-surface outputs', () => {
  // Restricted to the outputs that export these names at all. The viewer
  // bundle does not, by design — `packages/atlas-web/build.mjs` fails the build
  // if the viewer ever imports one, which is what makes "the page cannot reach
  // these" a checked claim rather than this test's omission.
  const { index, papers, cell } = behaviourFixture();
  assert.deepEqual(fullSurface.map((o) => o.path), ['dist/atlas-research.js', 'dist/esm/index.js']);
  compare(fullSurface, [
    ['browseByAnatomy', (m, i) => m.browseByAnatomy(i, cell)],
    ['browseByResearch', (m, i) => m.browseByResearch(i, { selected: papers })],
    ['paperSelection', (m, i) => m.paperSelection(i, papers)],
    ['selectionExtent', (m, i) => [...m.selectionExtent(m.paperSelection(i, papers)).cells]],
    ['solidColourLayers', (m, i) => m.solidColourLayers(i, papers)],
    ['pairOverlap', (m, i) => [...m.pairOverlap(i, papers[0], papers[1]).cells]],
    ['anatomyScan', (m) => m.anatomyScan(cell)],
    ['assignPaperColours', (m) => m.assignPaperColours(papers)],
    ['safeHref', (m) => m.safeHref('javascript:alert(1)')],
  ], index);
});

test('bundle: package exports keep the TypeScript source reachable', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['.'].types, './src/index.ts', 'types must point at the real source');
  assert.equal(pkg.exports['.'].default, './src/index.ts', 'the source must remain the default entry');
  // Still the WHOLE package, not the viewer subset. `browser` and `./bundle`
  // are claims about what `@gstack/atlas-research` is in a browser, and a
  // three-name module under those names would resolve `browseByAnatomy` to
  // undefined for the next consumer rather than failing.
  assert.equal(pkg.exports['.'].browser, './dist/atlas-research.js');
  assert.equal(pkg.exports['./bundle'], './dist/atlas-research.js');
  assert.equal(pkg.exports['./viewer-bundle'], './dist/atlas-research.viewer.js');
  assert.ok(pkg.exports['./src/*'], 'individual source modules must stay importable');
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@gstack/alc'], 'alc is the only dependency');
  assert.equal(pkg.atlas.licenceClass, 'code');
  for (const { path } of OUTPUTS) assert.ok(existsSync(join(PKG_DIR, path)), `${path} should exist after the build`);
});
