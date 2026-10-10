/**
 * Browser build for `@gstack/atlas-research`. One dependency, kept external.
 *
 * This is `packages/alc/scripts/build.mjs` applied to the research layer, and
 * deliberately not a second approach: same `stripTypeScriptTypes`, same
 * one-IIFE-per-module single file, same self-verification, no bundler. Read
 * that script first; this header only records the three things that differ.
 *
 * Three outputs, the same shape alc emits:
 *
 *   dist/esm/**.js             one file per module, `.ts` specifiers rewritten
 *                              to `.js`. The module graph still matches source.
 *   dist/atlas-research.js     a single ESM file for a plain
 *                              `<script type="module">`: the whole package,
 *                              which is what `exports['.'].browser` and
 *                              `exports['./bundle']` advertise.
 *   dist/atlas-research.viewer.js
 *                              the same, built from `src/index.viewer.ts` —
 *                              only the names the viewer imports, and so only
 *                              the modules those reach. This is the one
 *                              `packages/atlas-web/build.mjs` substitutes for
 *                              `src/atlas-research.js`, the way it already
 *                              substitutes dist/app/alc.js.
 *
 * ## 1. `@gstack/alc` is external, not inlined
 *
 * The four `'../../alc/src/index.ts'` sites — in `layers.ts`, `browse.ts`,
 * `dataset.ts` and `validate.ts` — become one hoisted namespace import of
 * a sibling `alc.js`, which every inlined module destructures from. It has to be
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
 *
 * ## 4. Two entries, and what `verify()` now asserts instead of equality
 *
 * The page imports three of the package's 24 exports. Serving it the whole
 * package costs 9.0 KiB of gzip against a 150 KiB `bundleGzipBytes` budget
 * that was reading 98%, so the bundle the page loads is built from
 * `src/index.viewer.ts` instead — see that file for the three names and for
 * the failure mode this introduces.
 *
 * `moduleOrder()` below already walks reachability from whatever entry it is
 * given, so the trim needs no bundler logic anywhere: a smaller entry is a
 * smaller graph. `browse.ts` and `layers.ts` were in the shipped bundle for
 * one reason, that `index.ts` re-exports them.
 *
 * What the trim does change is this script's central invariant. It used to
 * assert that every output exports exactly what `src/index.ts` does, which is
 * what kept the suite and the browser on one module graph. The two graphs now
 * differ in EXTENT by design, so that equality is the wrong statement — and
 * deleting it is the wrong answer. It becomes three statements:
 *
 *   - each output exports exactly what the entry IT was built from exports,
 *     which is the same check against the module that describes that output;
 *   - `index.viewer.ts`'s exports are a PROPER subset of `index.ts`'s, and
 *     each one is the same binding by identity, so the browser's surface is
 *     drawn from the full graph rather than reimplemented beside it — and a
 *     viewer entry that has quietly grown back to the full surface, which
 *     would spend the headroom again, fails here;
 *   - every output still resolves the fixture dataset mapping-for-mapping
 *     identically to the TypeScript source. That one is unchanged, and it is
 *     why a narrower surface is not a different answer.
 *
 * The fourth statement — that no viewer module imports a name this entry does
 * not export — cannot be made here, because this package cannot see the
 * viewer. It is in `packages/atlas-web/build.mjs`, over the emitted tree.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const PKG = resolvePath(import.meta.dirname, '..');
const SRC = join(PKG, 'src');
const DIST = join(PKG, 'dist');
const ESM = join(DIST, 'esm');
const ENTRY = join(SRC, 'index.ts');
const BUNDLE = join(DIST, 'atlas-research.js');
const ESM_ENTRY = join(ESM, 'index.js');

/** The viewer's three names, and the bundle built from them. See note 4. */
const VIEWER_ENTRY = join(SRC, 'index.viewer.ts');
const VIEWER_BUNDLE = join(DIST, 'atlas-research.viewer.js');

/** The one module that is not inlined. */
const ALC_SOURCE = resolvePath(PKG, '..', 'alc', 'src', 'index.ts');

/**
 * What the emitted JS calls alc, and where each output expects to find it.
 *
 * A relative specifier rather than a bare one, because the page resolves no
 * import map: the viewer's own `src/alc.js` is substituted for alc's browser
 * bundle at `dist/app/alc.js`, so a research bundle emitted next to it
 * resolves to exactly that file and the page gets one alc. Keep them side by
 * side, or supply alc under this name some other way; what must not happen is
 * a second copy.
 *
 * Each output's specifier is computed from where that output sits relative to
 * its own `alc.js`, rather than written down once as './alc.js'. The two
 * coincide while `src/` is flat, and a subdirectory would silently have
 * emitted a specifier pointing at a file that does not exist.
 */
const ALC_FILENAME = 'alc.js';
const ALC_AT_BUNDLE = join(DIST, ALC_FILENAME);
const ALC_AT_ESM = join(ESM, ALC_FILENAME);

/** `'./alc.js'`, `'../alc.js'` — an ESM specifier for a path on disk. */
function relativeSpecifier(fromDir, toFile) {
  const path = relative(fromDir, toFile).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

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
      + `takes @gstack/alc from a sibling '${ALC_FILENAME}'; it has nowhere to resolve a bare specifier.`,
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
    const target = join(ESM, relative(SRC, file).replace(/\.ts$/, '.js'));
    const source = strip(file).replace(FROM_STATEMENT, (match, keyword, clause, specifier) => {
      const { kind } = classify(file, specifier);
      const rewritten =
        kind === 'alc'
          ? relativeSpecifier(dirname(target), ALC_AT_ESM)
          : specifier.replace(/\.ts$/, '.js');
      return `${keyword} ${clause} from '${rewritten}';`;
    });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Output 2: single-file ESM bundle
// ---------------------------------------------------------------------------

/**
 * One single-file ESM bundle, from `entry`, to `bundlePath`.
 *
 * Parameterised over the entry because the page and the package want different
 * extents of the same graph; see note 4. Everything else — the rewrite, the
 * alc boundary, the module scopes — is identical for both, deliberately: two
 * bundles from one code path cannot differ in the rewrite, only in reach.
 */
async function buildBundle(entry, bundlePath, surface) {
  const { order, sources } = moduleOrder(entry);

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

  const alcSpecifier = relativeSpecifier(dirname(bundlePath), join(dirname(bundlePath), ALC_FILENAME));

  const chunks = [
    '/**',
    ` * @gstack/atlas-research — ${surface}`,
    ' *',
    ` * Generated by scripts/build.mjs from ${relative(PKG, entry)}. Do not edit.`,
    ' * One IIFE per source module, in dependency order; see the build script for',
    ' * why the module scopes are preserved rather than hoisted.',
    ' *',
    ` * @gstack/alc is NOT inlined. It is imported from '${alcSpecifier}', which must`,
    ' * resolve to the same alc the page loads: a second copy of the library is a',
    ' * second identity WeakMap, and buildResearchIndex() would then reject a',
    ' * NameIndex the page built with the other copy.',
    ' */',
    '',
    `import * as ${ALC_NAMESPACE} from '${alcSpecifier}';`,
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

  const entryNames = exportNames.get(entry);
  chunks.push(`const { ${entryNames.join(', ')} } = ${moduleId(entry)};`);
  chunks.push(`export { ${entryNames.join(', ')} };`);
  chunks.push('');

  mkdirSync(dirname(bundlePath), { recursive: true });
  writeFileSync(bundlePath, chunks.join('\n'));
  return {
    output: relative(PKG, bundlePath),
    modules: order.length,
    exports: entryNames.length,
    alcSites,
    alcNames: alcUsed.size,
    alcSpecifier,
    bytes: statSync(bundlePath).size,
  };
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

const runtimeNames = (module) => Object.keys(module).filter((name) => name !== 'default').sort();

/**
 * The viewer entry is a NARROWING of `src/index.ts`, not a second API.
 *
 * Checked by identity rather than by name, because a name check would be
 * satisfied by a reimplementation — and the whole argument for serving a
 * subset is that it is the same code, reached through a shorter path. The
 * properness of the subset is checked too: an `index.viewer.ts` that has grown
 * back to the full surface would silently re-spend the `bundleGzipBytes`
 * headroom this file exists to recover, and would be green on every other
 * check here.
 */
async function verifyViewerSurface() {
  const full = await import(pathToFileURL(ENTRY).href);
  const viewer = await import(pathToFileURL(VIEWER_ENTRY).href);
  const fullNames = runtimeNames(full);
  const viewerNames = runtimeNames(viewer);

  if (viewerNames.length === 0) throw new Error(`${relative(PKG, VIEWER_ENTRY)} exports nothing at runtime`);

  const extra = viewerNames.filter((name) => !fullNames.includes(name));
  if (extra.length > 0) {
    throw new Error(
      `${relative(PKG, VIEWER_ENTRY)} exports ${extra.join(', ')}, which src/index.ts does not.\n`
      + '  The entry the browser gets must be a subset of the package, not a surface beside it:\n'
      + '  a name only the browser has is a name the suite never runs.',
    );
  }

  const rebound = viewerNames.filter((name) => viewer[name] !== full[name]);
  if (rebound.length > 0) {
    throw new Error(
      `${relative(PKG, VIEWER_ENTRY)} exports ${rebound.join(', ')} as a different binding from `
      + 'src/index.ts.\n'
      + '  Re-export the name from the module index.ts takes it from; do not restate the\n'
      + '  implementation, or the browser runs code the suite does not.',
    );
  }

  if (viewerNames.length >= fullNames.length) {
    throw new Error(
      `${relative(PKG, VIEWER_ENTRY)} exports all ${viewerNames.length} of src/index.ts's names, so the `
      + 'bundle the page loads is the whole package again.\n'
      + '  That is the state this entry exists to avoid: it costs ~9 KiB of gzip against a\n'
      + '  bundleGzipBytes budget that was reading 98%. Either narrow it again, or say on the\n'
      + '  record that the viewer genuinely needs the full surface and delete this entry.',
    );
  }

  return { viewerNames, fullNames };
}

async function verify() {
  const source = await import(pathToFileURL(ENTRY).href);
  if (runtimeNames(source).length === 0) throw new Error('src/index.ts exports nothing at runtime');

  const surface = await verifyViewerSurface();

  /**
   * Each output, paired with the entry that describes what it exports.
   *
   * The pairing is the restated invariant: equality against `src/index.ts` was
   * right while every output had the same extent, and is wrong now that the
   * viewer bundle deliberately does not. Equality against the output's OWN
   * entry is the same check, kept exact, against the module that makes the
   * claim.
   */
  const outputs = [
    [BUNDLE, ALC_AT_BUNDLE, ENTRY],
    [VIEWER_BUNDLE, ALC_AT_BUNDLE, VIEWER_ENTRY],
    [ESM_ENTRY, ALC_AT_ESM, ENTRY],
  ];

  // The outputs import alc from an `alc.js` of their own, which under Node is
  // this shim: a re-export of the very module the source graph imports, so
  // both sides of the comparison share one alc and one identity WeakMap. The
  // shims are removed again in the `finally` — shipping one would be the
  // second copy of alc this whole arrangement exists to prevent.
  const shimText = `export * from ${JSON.stringify(pathToFileURL(ALC_SOURCE).href)};\n`;
  const shims = [];
  const report = [];
  try {
    for (const [output, alcAt, entry] of outputs) {
      writeFileSync(alcAt, shimText);
      shims.push(alcAt);

      const expected = runtimeNames(await import(pathToFileURL(entry).href));
      const label = relative(PKG, output);
      const built = await import(pathToFileURL(output).href);
      const got = runtimeNames(built);
      if (got.join(',') !== expected.join(',')) {
        const missing = expected.filter((n) => !got.includes(n));
        const extra = got.filter((n) => !expected.includes(n));
        throw new Error(
          `${label} export mismatch against ${relative(PKG, entry)}; `
          + `missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`,
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
  return { report, surface };
}

// ---------------------------------------------------------------------------

rmSync(DIST, { recursive: true, force: true });
const esmFiles = buildEsm();
const bundles = [
  await buildBundle(
    ENTRY,
    BUNDLE,
    'the research layer: papers, findings, region mappings, both browse modes,\n'
    + ' * and the solid-colour data path.',
  ),
  await buildBundle(
    VIEWER_ENTRY,
    VIEWER_BUNDLE,
    'the subset the viewer imports. Not the whole package; see\n'
    + ' * src/index.viewer.ts for which names, and why the page is served this instead.',
  ),
];
const { report, surface } = await verify();

console.log(`dist/esm                 ${esmFiles} modules`);
for (const b of bundles) {
  console.log(
    `${b.output.padEnd(24)} ${b.modules} modules, ${b.exports} exports, ${(b.bytes / 1024).toFixed(1)} kB`,
  );
}
// One line per bundle would be the same sentence twice: the alc boundary is a
// property of the rewrite, which both bundles share by construction.
const [{ alcSites, alcNames, alcSpecifier }] = bundles;
console.log(`@gstack/alc              external: ${alcSites} import site(s), ${alcNames} names, from '${alcSpecifier}'`);
console.log(
  `src/index.viewer.ts      ${surface.viewerNames.length} of src/index.ts's ${surface.fullNames.length} exports, `
  + `same bindings: ${surface.viewerNames.join(', ')}`,
);
for (const line of report) console.log(`verified      ${line}`);
