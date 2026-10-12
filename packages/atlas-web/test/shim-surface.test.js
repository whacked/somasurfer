/**
 * The guard on the one failure the trimmed research bundle introduces.
 *
 * `src/atlas-research.js` re-exports all 24 names of
 * `@gstack/atlas-research`; `dist/app/atlas-research.js` is built from
 * `src/index.viewer.ts` and exports three. That is 8.7 KiB of gzip on a
 * `bundleGzipBytes` line that was reading 98% of 150 KiB — DOG-84 — and the
 * price is that the browser's surface is now narrower than the one this suite
 * runs against. An import of a name only Node has typechecks, passes every
 * test here, and throws `SyntaxError` on the real page.
 *
 * `../build.mjs` fails the build on exactly that, over the emitted `dist/app/`
 * tree. This file is the other half, and it is not a duplicate of it:
 *
 *   - It runs in `test:counted`, which `npm run ci` runs BEFORE `build`, so
 *     the cheap failure comes first and names a file in `src/`.
 *   - It is where the scanner is proved able to fire. A scanner over a tree
 *     that happens to be clean is indistinguishable from a scanner that
 *     matches nothing, which is why `address-equality.test.js` plants a
 *     violation against alc's guard and why the cases below plant four.
 *   - Its inputs are the source tree and the entry module, where the build's
 *     are the emitted tree and the emitted bundle's `Object.keys()`. Two
 *     different readings of the same rule; a mismatch between them is itself
 *     a finding.
 *
 * The scanner is shared with the build rather than restated, for the reason
 * `address-equality.test.js` shares alc's: one definition of what counts as an
 * import site, and no chance of the suite's copy drifting into leniency.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { importSites, surfaceProblems } from '../shim-surface.mjs';
import * as viewerEntry from '../../atlas-research/src/index.viewer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const SRC = join(PACKAGE_ROOT, 'src');

/** The shim in `src/`, which `build.mjs` substitutes the bundle for in `dist/app/`. */
const SHIM = join(SRC, 'atlas-research.js');

/** What the browser will really have. Three names; see index.viewer.ts. */
const EXPORTS = Object.keys(viewerEntry).sort();

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Every site in `src/` that imports the research shim, by RESOLVED path.
 *
 * `'./atlas-research.js'` from `src/` and `'../atlas-research.js'` from
 * `src/viewer/` are the same file, and a filename match would also catch an
 * unrelated module of that name in a subdirectory. The build resolves the same
 * way over `dist/app/`.
 */
function sitesInSource() {
  const sites = [];
  for (const file of jsFiles(SRC)) {
    if (file === SHIM) continue;
    const label = relative(PACKAGE_ROOT, file).split('\\').join('/');
    for (const site of importSites(label, readFileSync(file, 'utf8'))) {
      if (resolve(dirname(file), site.specifier) === SHIM) sites.push(site);
    }
  }
  return sites;
}

describe('the research bundle import scanner', () => {
  it('finds a named import, and the names it takes from the module', () => {
    const sites = importSites('src/viewer/x.js', "import { a, b } from '../atlas-research.js';\n");
    assert.equal(sites.length, 1);
    assert.equal(sites[0].kind, 'named');
    assert.equal(sites[0].specifier, '../atlas-research.js');
    assert.equal(sites[0].line, 1);
    assert.deepEqual(sites[0].names, ['a', 'b']);
  });

  it('reads an aliased name by its SOURCE name, which is the one that must exist', () => {
    // `import { solidColourLayers as layers }` needs `solidColourLayers` to be
    // exported; checking the local alias would miss it entirely.
    const sites = importSites('src/viewer/x.js', "import { loadDataset as load } from '../atlas-research.js';\n");
    assert.deepEqual(sites[0].names, ['loadDataset']);
  });

  it('separates a namespace import from a star re-export, and finds both', () => {
    const text = [
      "import * as research from '../atlas-research.js';",
      "export * from '../atlas-research.js';",
      '',
    ].join('\n');
    assert.deepEqual(
      importSites('src/viewer/x.js', text).map((s) => [s.kind, s.line]),
      [['namespace', 1], ['star', 2]],
    );
  });

  it('is silent when every imported name is one the bundle exports', () => {
    const sites = importSites('src/viewer/x.js', "import { a, b as c } from '../atlas-research.js';\n");
    assert.deepEqual(surfaceProblems(sites, ['a', 'b', 'z']), []);
  });

  it('is a real scanner: it still catches a planted import of an absent name', () => {
    // The planted violation. `browseByAnatomy` is a real export of the package
    // and really is absent from the viewer entry, so this is the exact mistake
    // the gate exists for rather than a synthetic one.
    const planted = "import { buildResearchIndex, browseByAnatomy } from '../atlas-research.js';\n";
    const problems = surfaceProblems(importSites('src/viewer/planted.js', planted), EXPORTS);
    assert.equal(problems.length, 1, `expected the scanner to fire, got ${JSON.stringify(problems)}`);
    assert.match(problems[0], /^src\/viewer\/planted\.js:1 imports browseByAnatomy,/);
    // The message has to say what IS available, or the next reader has to go
    // and find index.viewer.ts to learn what they may use.
    for (const name of EXPORTS) assert.match(problems[0], new RegExp(name));
  });

  it('refuses a namespace import of the bundle, whose property reads it cannot see', () => {
    // `research.browseByAnatomy` would be `undefined` rather than an error, so
    // this one does not even fail loudly in the browser.
    const text = "import * as research from '../atlas-research.js';\n";
    const problems = surfaceProblems(importSites('src/viewer/x.js', text), EXPORTS);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /namespace/);
  });

  it('refuses a star re-export of the bundle, which would make a module surface entry-dependent', () => {
    const text = "export * from '../atlas-research.js';\n";
    const problems = surfaceProblems(importSites('src/viewer/x.js', text), EXPORTS);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /star re-export/);
  });
});

describe('the viewer, against the entry the browser is built from', () => {
  it('imports only names src/index.viewer.ts exports', () => {
    const problems = surfaceProblems(sitesInSource(), EXPORTS);
    assert.deepEqual(
      problems,
      [],
      'a viewer module asks the research bundle for a name the browser will not have:\n'
      + problems.join('\n'),
    );
  });

  it('still has a site for the scan to find, so the check above is not vacuous', () => {
    // Zero sites is the state in which this whole arrangement is inert, and it
    // is reachable by renaming the shim or moving the import. `build.mjs`
    // fails on it too; this says the same thing where it is cheap to see.
    const sites = sitesInSource();
    assert.ok(sites.length > 0, 'nothing in src/ imports atlas-research.js, so the surface check proves nothing');
    assert.deepEqual(
      sites.map((s) => `${s.file}:${s.line}`),
      ['src/viewer/corpus.js:4'],
      'the set of modules that name the research layer has changed; confirm the new ones are intended',
    );
  });

  it('keeps the Node-side shim exporting the WHOLE package, not the subset', () => {
    // Clause 3 of the restated invariant. If this file were narrowed to match
    // the browser, the suite and the QA harness would lose browse, the colour
    // layers and the validator surface they are green against — and the trim
    // would stop being a bundling decision and become an API change.
    const text = readFileSync(SHIM, 'utf8');
    assert.match(text, /^export \* from '\.\.\/\.\.\/atlas-research\/src\/index\.ts';$/m);
    assert.equal(/index\.viewer\.ts/.test(text.replace(/\/\*[\s\S]*?\*\//g, '')), false);
  });
});
