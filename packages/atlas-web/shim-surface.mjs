/**
 * The one failure mode that comes with serving a trimmed research bundle.
 *
 * `src/atlas-research.js` re-exports the whole of `@gstack/atlas-research` —
 * all 24 names — and that is what Node, the suite and the QA harness import.
 * `build.mjs` substitutes `dist/app/atlas-research.js` for it in the browser,
 * and since DOG-84 that file is built from `src/index.viewer.ts` and exports
 * three. The surfaces differ on purpose: it is 9 KiB of gzip against a budget
 * that was reading 98%.
 *
 * So a viewer module can now import a name that exists under Node and does not
 * exist in the browser. Nothing about that is visible to the type checker, the
 * suite, or `npm run ci`'s test phase — it is a load-time `SyntaxError` on the
 * real page and nowhere else. This scanner is what makes it a build failure
 * instead.
 *
 * ## Scope, and why it runs over `dist/app/` rather than `src/`
 *
 * The subject is the artefact, so the scan is over what was emitted and the
 * names come from importing the emitted bundle — `Object.keys()` of the module
 * the browser will actually evaluate, not a parse of the entry it was built
 * from. The specifier is matched by RESOLVED PATH, the way
 * `packages/atlas-research/test/bundle.test.ts` matches alc's: `'./alc.js'`
 * and `'../atlas-research.js'` are the same file from two depths, and a
 * filename comparison would miss a module that moved.
 *
 * ## Three kinds of site, two of which cannot be checked by name
 *
 *   named       `import { a, b as c } from '...'`, `export { a } from '...'`.
 *               Checkable: every name must be one the bundle exports.
 *   namespace   `import * as r from '...'`. NOT checkable — `r.browseByAnatomy`
 *               is a property read that no static pass sees, and it would be
 *               `undefined` rather than an error. Refused.
 *   star        `export * from '...'`. NOT checkable, and worse: it makes the
 *               re-exporting module's own surface depend on which entry the
 *               bundle was built from. Refused.
 *
 * Both refusals are about this specific specifier, not a general rule: the
 * viewer uses `import * as` elsewhere and should.
 *
 * A computed `import()` is outside any static scan. There is none in the
 * viewer today, and `build.mjs` says so where it calls this.
 */

/**
 * `import|export <clause> from '<specifier>';` — the same definition
 * `packages/atlas-research/scripts/build.mjs` uses, widened by one alternative
 * for the bare `export * from`, which has no clause and which that script's
 * regex therefore does not match. That gap is the whole reason this one is
 * spelled out rather than imported: a star re-export is exactly the site a
 * named-import check would wave through.
 */
const FROM_STATEMENT =
  /\b(?:import|export)\s+(?:(\{[\s\S]*?\})|(\*\s+as\s+[A-Za-z_$][\w$]*)|(\*))\s+from\s+'([^']+)';/g;

/** The names a clause takes FROM the module, i.e. before any `as`. */
function sourceNames(clause) {
  return clause
    .replace(/[{}]/g, '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => /^([A-Za-z_$][\w$]*)\s+as\s+/.exec(part)?.[1] ?? part);
}

/**
 * Every from-statement in one file, with the names it binds.
 *
 * Pure, and takes the text rather than reading it, so the suite can run it
 * over a planted violation without writing one into the tree.
 */
export function importSites(file, text) {
  const sites = [];
  for (const match of text.matchAll(FROM_STATEMENT)) {
    const [, named, namespace, star, specifier] = match;
    sites.push({
      file,
      line: text.slice(0, match.index).split('\n').length,
      specifier,
      kind: named ? 'named' : namespace ? 'namespace' : 'star',
      names: named ? sourceNames(named) : [],
    });
  }
  return sites;
}

/**
 * The problems, as sentences, for the sites that resolve to the shimmed bundle.
 *
 * `sites` is already filtered to that one specifier by the caller, which is the
 * half that needs to know the directory layout. `exports` is the bundle's own
 * export list.
 */
export function surfaceProblems(sites, exports) {
  const available = new Set(exports);
  const problems = [];
  for (const site of sites) {
    const where = `${site.file}:${site.line}`;
    if (site.kind !== 'named') {
      problems.push(
        `${where} takes the research bundle as a ${site.kind === 'star' ? 'star re-export' : 'namespace'} `
        + `(\`${site.kind === 'star' ? 'export *' : 'import * as'}\`), whose names cannot be checked against `
        + 'what the bundle exports. Import the names you use.',
      );
      continue;
    }
    const absent = site.names.filter((name) => !available.has(name));
    if (absent.length > 0) {
      problems.push(
        `${where} imports ${absent.join(', ')}, which the research bundle the browser loads does not `
        + `export. It has: ${[...available].sort().join(', ')}.`,
      );
    }
  }
  return problems;
}
