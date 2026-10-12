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
 * Prints one JSON line and exits 1 on any invalid document, or if it found
 * none to validate (an empty tree is not a pass).
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
out.verdict = total > 0 && out.invalid.length === 0 ? 'pass' : 'fail';
console.log(JSON.stringify(out));
process.exit(out.verdict === 'pass' ? 0 : 1);
