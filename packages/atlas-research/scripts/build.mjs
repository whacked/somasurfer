/**
 * Browser build for `@gstack/atlas-research`. One dependency, kept external.
 *
 * This is `packages/alc/scripts/build.mjs` applied to the research layer, and
 * deliberately not a second approach: same `stripTypeScriptTypes`, same
 * one-IIFE-per-module single file, same self-verification, no bundler. Read
 * that script first; this header only records the three things that differ.
 *
 * Two outputs, the same shape alc emits:
 *
 *   dist/esm/**.js             one file per module, `.ts` specifiers rewritten
 *                              to `.js`. The module graph still matches source.
 *   dist/atlas-research.js     a single ESM file for a plain
 *                              `<script type="module">`, which is what
 *                              `packages/atlas-web/build.mjs` can substitute
 *                              the way it already substitutes dist/app/alc.js.
 *
 * ## 1. `@gstack/alc` is external, not inlined
 *
 * The four `'../../alc/src/index.ts'` sites — in `layers.ts`, `browse.ts`,
 * `dataset.ts` and `validate.ts` — become one hoisted namespace import of
 * `ALC_SPECIFIER`, which every inlined module destructures from. It has to be
 * the *same* alc the page already loads: `buildNameIndex()` keys its lookup
 * tables in a `WeakMap` by index identity, so a second copy of alc is a second
 * WeakMap, and `buildResearchIndex()` would reject a `NameIndex` the page built
 * with the other copy ('not a name index built by buildNameIndex()'). That is
 * not hypothetical — it is the failure DOG-74 hit while measuring this work.
 *
 * `verify()` below proves the externality behaviourally rather than by reading
 * the output: it hands the built graph a `NameIndex` built by the alc the
 * *source* graph uses, and requires it to resolve.
 *
 * ## 2. Any other cross-package import is a build failure
 *
 * `moduleOrder()` walks relative specifiers, and alc's is relative, so an
 * "inline everything relative" rule would quietly inline alc. The rule here is
 * explicit instead: a specifier resolves either inside `src/`, or to alc, or
 * the build fails naming the file. A new dependency cannot reach the browser
 * without someone deciding what it means here.
 *
 * ## 3. Paths are anchored to this script, not to the working directory
 *
 * alc's build resolves `src` against the process cwd, so it only runs from
 * inside its own package — an error that names a command that then fails from
 * the repo root. `npm run ci` runs from the repo root, so this one anchors on
 * `import.meta.dirname`.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const PKG = resolvePath(import.meta.dirname, '..');
const SRC = join(PKG, 'src');
const DIST = join(PKG, 'dist');
const ENTRY = join(SRC, 'index.ts');
const BUNDLE = join(DIST, 'atlas-research.js');
const ESM_ENTRY = join(DIST, 'esm', 'index.js');

/** The one module that is not inlined. */
const ALC_SOURCE = resolvePath(PKG, '..', 'alc', 'src', 'index.ts');

/**
 * Where the emitted JS imports alc from: a sibling file named `alc.js`.
 *
 * Relative rather than bare, because the page resolves no import map: the
 * viewer's own `src/alc.js` is substituted for alc's browser bundle at
 * `dist/app/alc.js`, so a research bundle emitted next to it resolves this
 * specifier to exactly that file and the page gets one alc. Keep the two
 * outputs side by side, or pass alc through this specifier some other way;
 * what must not happen is a second copy.
 */
const ALC_SPECIFIER = './alc.js';

/** The binding the inlined modules destructure alc out of. */
const ALC_NAMESPACE = '__alc';

// ---------------------------------------------------------------------------
// Shared helpers — these are alc's, unchanged
// ---------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function strip(file) {
  // `strip` mode blanks type syntax in place rather than reprinting the file,
  // so line numbers in a browser stack trace still match the source.
  return stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
}

/** Statements of the form `import|export <clause> from '<specifier>';`. */
const FROM_STATEMENT = /\b(import|export)\s+((?:\{[\s\S]*?\})|(?:\*\s+as\s+[A-Za-z_$][\w$]*))\s+from\s+'([^']+)';/g;

/** `{ a, b as c, }` -> `{ a, b: c, }`, i.e. an import clause as a destructuring pattern. */
function clauseToPattern(clause) {
  return clause.replace(/\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g, '$1: $2');
}

/** The parts of an import/export clause, with type-only entries already blanked. */
function clauseParts(clause) {
  return clause
    .replace(/[{}]/g, '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Names bound by an import/export clause, after aliasing. */
function clauseNames(clause) {
  return clauseParts(clause).map((part) => {
    const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(part);
    return alias ? alias[1] : part;
  });
}

/** Names a clause takes *from* the module, i.e. before any `as`. */
function clauseSourceNames(clause) {
  return clauseParts(clause).map((part) => /^([A-Za-z_$][\w$]*)\s+as\s+/.exec(part)?.[1] ?? part);
}

// ---------------------------------------------------------------------------
// The import boundary
// ---------------------------------------------------------------------------

/**
 * `'internal'` for a module of this package, `'alc'` for the one external
 * dependency. Anything else throws: see note 2 in the header.
 */
function classify(file, specifier) {
  if (!specifier.startsWith('.')) {
    throw new Error(
      `${relative(PKG, file)} imports '${specifier}'. The browser build inlines this package and `
      + `takes @gstack/alc from '${ALC_SPECIFIER}'; it has nowhere to resolve a bare specifier.`,
    );
  }
  const target = resolvePath(dirname(file), specifier);
  if (target === ALC_SOURCE) return { kind: 'alc', target };
  if (target === SRC || target.startsWith(SRC + sep)) return { kind: 'internal', target };
  throw new Error(
    `${relative(PKG, file)} imports '${specifier}', which is outside src/ and is not @gstack/alc.\n`
    + `  Resolved to ${relative(PKG, target)}.\n`
    + '  A browser build can inline it, keep it external, or neither; decide that in this script\n'
    + '  rather than letting it reach the viewer unresolved.',
  );
}

// ---------------------------------------------------------------------------
// Module graph
// ---------------------------------------------------------------------------

/** Depth-first postorder from the entry point, so dependencies come first. */
function moduleOrder(entry) {
  const order = [];
  const state = new Map(); // 'visiting' | 'done'
  const sources = new Map();

  function visit(file) {
    const marker = state.get(file);
    if (marker === 'done') return;
    if (marker === 'visiting') {
      throw new Error(`import cycle through ${relative(SRC, file)}; the single-file bundle cannot order it`);
    }
    state.set(file, 'visiting');
    const source = strip(file);
    sources.set(file, source);
    for (const [, , , specifier] of source.matchAll(FROM_STATEMENT)) {
      const { kind, target } = classify(file, specifier);
      if (kind === 'internal') visit(target);
    }
    state.set(file, 'done');
    order.push(file);
  }

  visit(entry);
  return { order, sources };
}

const moduleId = (file) => `__m_${relative(SRC, file).replace(/\.ts$/, '').replace(/[^A-Za-z0-9]/g, '_')}`;

// ---------------------------------------------------------------------------
// Output 1: per-module ESM
// ---------------------------------------------------------------------------

function buildEsm() {
  let count = 0;
  for (const file of walk(SRC)) {
    const source = strip(file).replace(FROM_STATEMENT, (match, keyword, clause, specifier) => {
      const { kind } = classify(file, specifier);
      const rewritten = kind === 'alc' ? ALC_SPECIFIER : specifier.replace(/\.ts$/, '.js');
      return `${keyword} ${clause} from '${rewritten}';`;
    });
    const target = join(DIST, 'esm', relative(SRC, file).replace(/\.ts$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Output 2: single-file ESM bundle
// ---------------------------------------------------------------------------

async function buildBundle() {
  const { order, sources } = moduleOrder(ENTRY);

  // Export names come from importing each module, so they are whatever the
  // runtime actually exports — not whatever a regex guessed from the source.
  const exportNames = new Map();
  for (const file of order) {
    const namespace = await import(pathToFileURL(file).href);
    exportNames.set(file, Object.keys(namespace).filter((name) => name !== 'default'));
  }

  // Names taken from alc, so a destructuring that would silently bind
  // `undefined` in the browser fails here instead.
  const alcUsed = new Map(); // name -> first file that imports it
  let alcSites = 0;

  const chunks = [
    '/**',
    ' * @gstack/atlas-research — the research layer: papers, findings, region',
    ' * mappings, both browse modes, and the solid-colour data path.',
    ' *',
    ' * Generated by scripts/build.mjs from the TypeScript source. Do not edit.',
    ' * One IIFE per source module, in dependency order; see the build script for',
    ' * why the module scopes are preserved rather than hoisted.',
    ' *',
    ` * @gstack/alc is NOT inlined. It is imported from '${ALC_SPECIFIER}', which must`,
    ' * resolve to the same alc the page loads: a second copy of the library is a',
    ' * second identity WeakMap, and buildResearchIndex() would then reject a',
    ' * NameIndex the page built with the other copy.',
    ' */',
    '',
    `import * as ${ALC_NAMESPACE} from '${ALC_SPECIFIER}';`,
    '',
  ];

  for (const file of order) {
    const body = sources
      .get(file)
      // Internal imports and re-exports become destructuring from the module
      // that was already evaluated above; alc's become destructuring from the
      // one external namespace import.
      .replace(FROM_STATEMENT, (match, keyword, clause, specifier) => {
        const { kind, target } = classify(file, specifier);
        const namespaceImport = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
        if (kind === 'alc') {
          alcSites += 1;
          if (namespaceImport) {
            return `const ${namespaceImport[1]} = ${ALC_NAMESPACE};`;
          }
          for (const name of clauseSourceNames(clause)) {
            if (!alcUsed.has(name)) alcUsed.set(name, relative(PKG, file));
          }
          return `const ${clauseToPattern(clause)} = ${ALC_NAMESPACE};`;
        }
        const id = moduleId(target);
        return namespaceImport
          ? `const ${namespaceImport[1]} = ${id};`
          : `const ${clauseToPattern(clause)} = ${id};`;
      })
      // `export { a, b };` with no source module: the names are already in scope.
      .replace(/^export\s+(\{[^}]*\})\s*;/gm, (match, clause) => `/* re-exported: ${clauseNames(clause).join(', ')} */`)
      // Declarations: drop the keyword, keep the declaration.
      .replace(/^export\s+(?=(?:const|let|var|function|async\s+function|class)\b)/gm, '');

    const names = exportNames.get(file);
    chunks.push(`const ${moduleId(file)} = (() => {`);
    chunks.push(body);
    chunks.push(`  return { ${names.join(', ')} };`);
    chunks.push('})();');
    chunks.push('');
  }

  const alc = await import(pathToFileURL(ALC_SOURCE).href);
  const alcExports = new Set(Object.keys(alc));
  const unknown = [...alcUsed].filter(([name]) => !alcExports.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `the build would destructure names @gstack/alc does not export, which binds undefined at runtime:\n`
      + unknown.map(([name, file]) => `  ${name} (imported by ${file})`).join('\n'),
    );
  }

  const entryNames = exportNames.get(ENTRY);
  chunks.push(`const { ${entryNames.join(', ')} } = ${moduleId(ENTRY)};`);
  chunks.push(`export { ${entryNames.join(', ')} };`);
  chunks.push('');

  mkdirSync(DIST, { recursive: true });
  writeFileSync(BUNDLE, chunks.join('\n'));
  return { modules: order.length, exports: entryNames.length, alcSites, alcNames: alcUsed.size };
}

// ---------------------------------------------------------------------------
// Verification: the build checks itself, so a rewrite bug fails here
// ---------------------------------------------------------------------------

/**
 * A fixture dataset resolved twice — once through the TypeScript source, once
 * through an output — against one `NameIndex` handed to both.
 *
 * Two things are being asserted at once, and they need each other:
 *
 *   - the rewrite preserved behaviour, per mapping, including `resolution` and
 *     `unresolvedReason`;
 *   - alc really is external, because the index was built by the alc the
 *     *source* graph imports. An inlined copy would throw `bad_name_index`
 *     here rather than at a user.
 *
 * Both indexes matter. Against the whole fixture index most mappings resolve,
 * which says nothing about the unresolved path, so the comparison is repeated
 * against an index with one mapped structure removed — and the run asserts
 * that it really did move a mapping from `resolved` to `unknown-structure`.
 * Equal-and-vacuous is not a verified rewrite.
 */
async function compareBehaviour(source, built, label) {
  const alc = await import(pathToFileURL(ALC_SOURCE).href);
  const readFixture = (name) => JSON.parse(readFileSync(join(PKG, 'fixtures', name), 'utf8'));
  const rawDataset = readFixture('research.fixture.json');
  const rawNames = readFixture('names.fixture.json');

  const mapped = new Set(rawDataset.findings.flatMap((f) => f.mappings.map((m) => m.structureId)));
  const dropped = rawNames.structures.find((s) => mapped.has(s.id));
  if (!dropped) {
    throw new Error('the names fixture indexes no structure the research fixture maps; nothing to compare');
  }

  const indexes = [
    ['the whole fixture index', alc.buildNameIndex({ version: rawNames.version, structures: rawNames.structures })],
    [
      `the fixture index without ${dropped.id}`,
      alc.buildNameIndex({
        version: `${rawNames.version}+verify-without-${dropped.id}`,
        structures: rawNames.structures.filter((s) => s.id !== dropped.id),
      }),
    ],
  ];

  /** One line per mapping: the fields a viewer branches on. */
  const rowsOf = (module, names) =>
    module
      .buildResearchIndex({ dataset: module.loadDataset(structuredClone(rawDataset)), names })
      .mappings.map((m) =>
        [m.mappingId, m.resolution, String(m.unresolvedReason), [...m.covering.cells].join(' ')].join(' | '),
      );

  const byIndex = [];
  for (const [tag, names] of indexes) {
    const expected = rowsOf(source, names);
    const got = rowsOf(built, names);
    if (expected.length === 0) throw new Error(`${label}: the fixture resolved no mappings at all against ${tag}`);
    if (got.length !== expected.length) {
      throw new Error(`${label}: resolved ${got.length} mappings against ${tag}, source resolved ${expected.length}`);
    }
    for (let i = 0; i < expected.length; i += 1) {
      if (got[i] !== expected[i]) {
        throw new Error(
          `${label}: mapping ${i} differs from the source graph against ${tag}\n`
          + `  source: ${expected[i]}\n`
          + `  built:  ${got[i]}`,
        );
      }
    }
    byIndex.push(expected);
  }

  // The must-pass half: the second index has to have actually changed an
  // answer, or the equality above proved nothing about `unresolvedReason`.
  const [whole, partial] = byIndex;
  const resolvedInWhole = whole.filter((r) => r.includes(' | resolved | ')).length;
  if (resolvedInWhole === 0) throw new Error(`${label}: no mapping resolved against the whole index`);
  const nowUnknown = partial.filter((row, i) => {
    return whole[i].includes(' | resolved | ') && row.includes(' | unresolved | unknown-structure | ');
  }).length;
  if (nowUnknown === 0) {
    throw new Error(
      `${label}: removing ${dropped.id} from the index moved no mapping to unknown-structure, so the`
      + ' comparison never exercised the unresolved path. Fix the fixtures or this check.',
    );
  }
  return { resolved: resolvedInWhole, movedToUnknown: nowUnknown };
}

async function verify() {
  const source = await import(pathToFileURL(ENTRY).href);
  const expected = Object.keys(source).filter((name) => name !== 'default').sort();
  if (expected.length === 0) throw new Error('src/index.ts exports nothing at runtime');

  if (!ALC_SPECIFIER.startsWith('.')) {
    throw new Error(`ALC_SPECIFIER is '${ALC_SPECIFIER}'; verification can only resolve a relative one`);
  }

  // The outputs import alc from a sibling `alc.js`, which under Node is this
  // shim: a re-export of the very module the source graph imports, so both
  // sides of the comparison share one alc and one identity WeakMap. The shims
  // are removed again in the `finally` — shipping one would be the second copy
  // of alc this whole arrangement exists to prevent.
  const shimText = `export * from ${JSON.stringify(pathToFileURL(ALC_SOURCE).href)};\n`;
  const shims = [];
  const report = [];
  try {
    for (const output of [BUNDLE, ESM_ENTRY]) {
      const shim = resolvePath(dirname(output), ALC_SPECIFIER);
      writeFileSync(shim, shimText);
      shims.push(shim);

      const label = relative(PKG, output);
      const built = await import(pathToFileURL(output).href);
      const got = Object.keys(built).filter((name) => name !== 'default').sort();
      if (got.join(',') !== expected.join(',')) {
        const missing = expected.filter((n) => !got.includes(n));
        const extra = got.filter((n) => !expected.includes(n));
        throw new Error(
          `${label} export mismatch; missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`,
        );
      }

      // The name list is not enough on its own: the entry re-exports a fixed
      // list of names, so a module that stopped returning one of them still
      // exports it — bound to `undefined`, and only discovered when a viewer
      // calls it.
      const hollow = got.filter((name) => built[name] === undefined);
      if (hollow.length > 0) {
        throw new Error(`${label} exports ${hollow.join(', ')} as undefined; the module scopes lost them`);
      }

      const counts = await compareBehaviour(source, built, label);
      report.push(
        `${label}: ${expected.length} exports, ${counts.resolved} mappings resolved, `
        + `${counts.movedToUnknown} moved to unknown-structure when the index lost a structure`,
      );
    }
  } finally {
    for (const shim of shims) rmSync(shim, { force: true });
  }
  return report;
}

// ---------------------------------------------------------------------------

rmSync(DIST, { recursive: true, force: true });
const esmFiles = buildEsm();
const bundle = await buildBundle();
const report = await verify();

const bytes = statSync(BUNDLE).size;
console.log(`dist/esm                 ${esmFiles} modules`);
console.log(
  `dist/atlas-research.js   ${bundle.modules} modules, ${bundle.exports} exports, ${(bytes / 1024).toFixed(1)} kB`,
);
console.log(
  `@gstack/alc              external: ${bundle.alcSites} import site(s), ${bundle.alcNames} names, `
  + `from '${ALC_SPECIFIER}'`,
);
for (const line of report) console.log(`verified      ${line}`);
