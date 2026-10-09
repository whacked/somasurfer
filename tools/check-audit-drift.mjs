/**
 * Asserts that docs/alc-1-admissibility.md is byte-identical to what the
 * generator produces right now. Every number in that document is computed, so
 * the document is a claim about the code and must not be allowed to outlive it.
 *
 * Why this and not `npm run audit:report` followed by `git diff --exit-code`:
 * `audit:report` redirects stdout into the published document, so running it
 * in CI mutates the checked-out tree, and a generator that crashes halfway
 * leaves a truncated document behind. This regenerates into memory and
 * compares, so the committed file is never touched.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, fail, pass } from './lib/repo.mjs';

const TARGETS = [
  {
    doc: 'docs/alc-1-admissibility.md',
    packageDir: 'packages/alc',
    script: 'audit:print',
    regenerate: 'cd packages/alc && npm run audit:report',
  },
  {
    doc: 'packages/atlas-assets/ATTRIBUTION.md',
    packageDir: 'packages/atlas-assets',
    script: 'attribution:print',
    regenerate: 'cd packages/atlas-assets && npm run attribution:report',
  },
  {
    // The real template's audit. Computed from the committed templates, the
    // naming layer and ci/bd-centreline-trials.json - no mesh data - so CI can
    // regenerate it. A report about a template that has fallen behind the
    // template is worse than no report, and this is the only thing that can
    // tell the difference.
    doc: 'docs/alc-1-body-template-audit.md',
    packageDir: 'packages/atlas-assets',
    script: 'templates:audit:print',
    regenerate: 'cd packages/atlas-assets && npm run templates:audit',
  },
];

/** First differing byte, and the line it falls on, for a useful error. */
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  const line = a.subarray(0, i).toString('utf8').split('\n').length;
  return { byte: i, line };
}

function excerpt(buf, line, label) {
  const lines = buf.toString('utf8').split('\n');
  const from = Math.max(0, line - 2);
  return [`${label}:`, ...lines.slice(from, line + 1).map((l, k) => `    ${from + k + 1}| ${l}`)];
}

const problems = [];
const report = [];

for (const target of TARGETS) {
  const run = spawnSync('npm', ['run', '-s', target.script], {
    cwd: join(REPO_ROOT, target.packageDir),
    encoding: 'buffer',
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  if (run.status !== 0) {
    problems.push(`${target.doc}: generator \`npm run ${target.script}\` exited ${run.status}.`);
    problems.push(...(run.stderr ?? Buffer.alloc(0)).toString('utf8').trim().split('\n').slice(-10).map((l) => `  ${l}`));
    continue;
  }

  const generated = run.stdout;
  const committed = readFileSync(join(REPO_ROOT, target.doc));

  if (generated.equals(committed)) {
    report.push(`${target.doc}: byte-identical to the generator (${committed.length} bytes).`);
    continue;
  }

  const { byte, line } = firstDifference(committed, generated);
  problems.push(`${target.doc} has drifted from the code that generates it.`);
  problems.push(`  committed ${committed.length} bytes, generated ${generated.length} bytes;`);
  problems.push(`  first difference at byte ${byte}, line ${line}.`);
  problems.push('');
  problems.push(...excerpt(committed, line, '  committed'));
  problems.push(...excerpt(generated, line, '  generated'));
  problems.push('');
  problems.push(`  If the code changed on purpose, regenerate and commit the result:`);
  problems.push(`    ${target.regenerate}`);
}

if (problems.length > 0) fail('audit report drift', problems);
pass('audit report drift', report);
