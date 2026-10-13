/**
 * DOG-133 (W8a), API row, the half the contract check does not do by itself:
 * every JSON file the built site serves under the two API roots, read straight
 * off disk and run through the published validator (`validateApiDocument`,
 * schema `packages/atlas-research/schema/api-1.md`), whether or not any query
 * reaches it. The other half, "equals the library's answer", is
 * `tools/check-research-api-contract.mjs`, run beside this at the same SHA.
 *
 *   node packages/atlas-qa/w8a/api-validate.mjs [--dist packages/atlas-web/dist]
 *
 * Prints one JSON line and exits 1 on any invalid document, if either root has
 * none to validate, or if any document kind is absent (an empty tree is not a
 * pass, and neither is half of one).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { API_ROOTS, validateApiDocument } from '../../atlas-research/src/index.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const i = process.argv.indexOf('--dist');
const DIST = resolve(ROOT, i > 0 ? process.argv[i + 1] : join('packages', 'atlas-web', 'dist'));

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const out = { dist: relative(ROOT, DIST), roots: {}, invalid: [] };
for (const [tree, root] of Object.entries(API_ROOTS)) {
  const files = walk(join(DIST, root)).filter((f) => f.endsWith('.json'));
  const kinds = {};
  for (const f of files) {
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    const problems = validateApiDocument(doc);
    kinds[doc.kind ?? '?'] = (kinds[doc.kind ?? '?'] ?? 0) + 1;
    if (problems.length) out.invalid.push({ file: relative(DIST, f), problems });
  }
  out.roots[tree] = { root, files: files.length, kinds };
}
const total = Object.values(out.roots).reduce((n, r) => n + r.files, 0);
out.total = total;
// The floor is per root and per kind: one full root must not carry an empty
// other, and a tree with every `region` document gone is not a whole API.
out.missing = [];
for (const [tree, r] of Object.entries(out.roots)) {
  if (r.files === 0) out.missing.push(`${tree} (${r.root}): no documents`);
}
const seenKinds = Object.assign({}, ...Object.values(out.roots).map((r) => r.kinds));
for (const k of ['index', 'paper', 'region-index', 'region', 'paper-regions']) {
  if (!seenKinds[k]) out.missing.push(`kind ${k}: no documents`);
}
out.verdict = out.missing.length === 0 && out.invalid.length === 0 ? 'pass' : 'fail';
console.log(JSON.stringify(out));
process.exit(out.verdict === 'pass' ? 0 : 1);
