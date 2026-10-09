/**
 * The Node version is pinned in `.nvmrc` and nowhere else. CI feeds that file
 * to `actions/setup-node`; this script makes a local run just as honest.
 *
 * It is a hard failure on a different major, because that is where the test
 * runner's own behaviour changes — `node --test test/` ran zero tests and
 * exited non-zero on Node 24 while working on Node 22, which is the bug this
 * whole CI job exists to catch. A different minor or patch is a warning: it is
 * worth knowing about, but it is not worth blocking a developer's laptop over.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, fail, pass } from './lib/repo.mjs';

const pinned = readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf8').trim();
const actual = process.versions.node;

const [pMajor, pMinor, pPatch] = pinned.split('.');
const [aMajor, aMinor, aPatch] = actual.split('.');

if (pMajor !== aMajor) {
  fail('node version', [
    `.nvmrc pins Node ${pinned}, this is Node ${actual}.`,
    `Major version mismatch. The test runner's glob and exit-code behaviour`,
    `differs across majors, so results from ${aMajor}.x do not transfer.`,
    ``,
    `Run \`nvm use\` (or install Node ${pinned}) and try again.`,
  ]);
}

if (pMinor !== aMinor || pPatch !== aPatch) {
  console.log(`⚠ node version: .nvmrc pins ${pinned}, running ${actual} (same major, continuing)`);
} else {
  pass('node version', [`Node ${actual}, matching .nvmrc exactly.`]);
}
