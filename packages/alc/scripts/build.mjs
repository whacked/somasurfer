/**
 * Browser build for `@gstack/alc`. Zero dependencies, by design.
 *
 * The package has no runtime dependencies and uses no Node built-ins, so the
 * only thing a browser build has to do is remove the type annotations. Node's
 * own `stripTypeScriptTypes` does exactly that, which means this package needs
 * no bundler, no transpiler and no toolchain to ship — nothing to keep up to
 * date, and nothing between the source the conformance suite runs against and
 * the code the viewer loads.
 *
 * Two outputs:
 *
 *   dist/esm/**.js   one file per module, `.ts` specifiers rewritten to `.js`.
 *                    What a bundler should consume: tree-shakeable, and the
 *                    module graph still matches the source.
 *   dist/alc.js      a single ESM file for a plain `<script type="module">`
 *                    or an import map, with no further resolution needed.
 *
 * Type declarations are not emitted. `exports` points `types` at the `.ts`
 * source instead, so TypeScript consumers read the real annotations and their
 * doc comments rather than a generated approximation.
 *
 * The single-file bundle wraps each module in an IIFE rather than hoisting
 * everything into one scope. That matters: several modules define private
 * helpers with the same names — `dot`, `cross`, `unit`, `add`, `normalize`,
 * and `parseHemisphere` is exported by two different frames — so a flat
 * concatenation would silently shadow them. One function scope per module
 * keeps the semantics identical to the ESM graph without renaming anything.
 *
 * The build verifies itself at the end: it imports both outputs and checks
 * their export names against the source module, then runs a behavioural smoke
 * test. A rewrite bug fails the build instead of reaching the viewer.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const SRC = resolvePath('src');
const DIST = resolvePath('dist');
const ENTRY = join(SRC, 'index.ts');

// ---------------------------------------------------------------------------
// Shared helpers
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

/** Relative specifiers reachable from a stripped source. */
function dependenciesOf(source) {
  const out = [];
  for (const [, , , specifier] of source.matchAll(FROM_STATEMENT)) {
    if (specifier.startsWith('.')) out.push(specifier);
  }
  return out;
}

/** `{ a, b as c, }` -> `{ a, b: c, }`, i.e. an import clause as a destructuring pattern. */
function clauseToPattern(clause) {
  return clause.replace(/\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g, '$1: $2');
}

/** Names bound by an import/export clause, after aliasing. */
function clauseNames(clause) {
  return clause
    .replace(/[{}]/g, '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(part);
      return alias ? alias[1] : part;
    });
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
    for (const specifier of dependenciesOf(source)) {
      visit(resolvePath(dirname(file), specifier));
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
    const source = strip(file).replace(
      FROM_STATEMENT,
      (match, keyword, clause, specifier) =>
        specifier.startsWith('.')
          ? `${keyword} ${clause} from '${specifier.replace(/\.ts$/, '.js')}';`
          : match,
    );
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

  const chunks = [
    '/**',
    ' * @gstack/alc — ALC-1 anatomical location codes.',
    ' *',
    ' * Generated by scripts/build.mjs from the TypeScript source. Do not edit.',
    ' * One IIFE per source module, in dependency order; see the build script for',
    ' * why the module scopes are preserved rather than hoisted.',
    ' */',
    '',
  ];

  for (const file of order) {
    const body = sources
      .get(file)
      // Internal imports and re-exports become destructuring from the module
      // that was already evaluated above.
      .replace(FROM_STATEMENT, (match, keyword, clause, specifier) => {
        if (!specifier.startsWith('.')) {
          throw new Error(`${relative(SRC, file)} imports ${specifier}; this package must have no dependencies`);
        }
        const id = moduleId(resolvePath(dirname(file), specifier));
        const namespaceImport = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
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

  const entryNames = exportNames.get(ENTRY);
  chunks.push(`const { ${entryNames.join(', ')} } = ${moduleId(ENTRY)};`);
  chunks.push(`export { ${entryNames.join(', ')} };`);
  chunks.push('');

  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, 'alc.js'), chunks.join('\n'));
  return { modules: order.length, exports: entryNames.length };
}

// ---------------------------------------------------------------------------
// Verification: the build checks itself, so a rewrite bug fails here
// ---------------------------------------------------------------------------

async function verify() {
  const source = await import(pathToFileURL(ENTRY).href);
  const expected = Object.keys(source).sort();

  for (const output of ['dist/alc.js', 'dist/esm/index.js']) {
    const built = await import(pathToFileURL(resolvePath(output)).href);
    const got = Object.keys(built).sort();
    if (got.join(',') !== expected.join(',')) {
      const missing = expected.filter((n) => !got.includes(n));
      const extra = got.filter((n) => !expected.includes(n));
      throw new Error(
        `${output} export mismatch; missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`,
      );
    }

    // Behaviour, not just shape. One call into each layer that the viewer uses.
    const address = built.parse('bd-t7-3o-531').canonical;
    if (address !== 'BD-T07-03O-531') throw new Error(`${output}: parse returned ${address}`);
    if (built.toReadable(address) !== "body, T7 level, three o'clock, outer, cell 531") {
      throw new Error(`${output}: toReadable returned ${built.toReadable(address)}`);
    }
    if (built.fromReadable(built.toSpoken(address)).canonical !== address) {
      throw new Error(`${output}: spoken round-trip failed`);
    }
    if (built.covering(['BV-L-470', 'BV-L-471']).cells.length !== 2) {
      throw new Error(`${output}: covering normalisation failed`);
    }
    if (built.prefixRange('BD-T07').upperExclusive !== 'BD-T08') {
      throw new Error(`${output}: prefixRange failed`);
    }
    if (built.renderScan(built.descendantScan('BV-L-4'), { column: 'addr' }).params.length !== 2) {
      throw new Error(`${output}: renderScan failed`);
    }
    if (built.healpix.npix(0) !== 12) throw new Error(`${output}: namespace re-export failed`);
    // The two frames that both export `parseHemisphere` must not have collided.
    if (built.BD.id !== 'BD' || built.BV.id !== 'BV' || built.BR.id !== 'BR') {
      throw new Error(`${output}: frame descriptors collided`);
    }
  }
}

// ---------------------------------------------------------------------------

rmSync(DIST, { recursive: true, force: true });
const esmFiles = buildEsm();
const bundle = await buildBundle();
await verify();

const bytes = statSync(join(DIST, 'alc.js')).size;
console.log(`dist/esm      ${esmFiles} modules`);
console.log(`dist/alc.js   ${bundle.modules} modules, ${bundle.exports} exports, ${(bytes / 1024).toFixed(1)} kB`);
console.log('verified      export names and behaviour match the TypeScript source');
