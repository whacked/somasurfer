/**
 * Runs each suite in ci/expected-test-counts.json and asserts three things:
 * the runner exited zero, no test failed, and at least `minTests` tests
 * actually ran.
 *
 * The third assertion is the point. `packages/alc`'s test script was
 * `node --test test/`, which runs none of the 37 real tests. Measured on
 * Node 24.21:
 *
 *   node --test test/                 0 real tests, exit 1
 *   node --test 'test/*.nope.ts'      0 tests,      exit 0
 *   node --test 'test/*.test.ts'      all tests,    exit 0
 *
 * The first is survivable; something goes red. The second is not: zero tests,
 * clean exit, and a green build that checked nothing. No exit-code check can
 * tell it from a passing run, and a one-character typo in a glob produces it.
 * So the count is what we gate on.
 *
 * Counts come from the TAP reporter's summary (`# tests N`, `# pass N`,
 * `# fail N`), which is a machine-readable contract rather than the spec
 * reporter's prose.
 *
 * Flags:
 *   --suite <id>   run one suite only
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, fail, pass } from './lib/repo.mjs';

const config = JSON.parse(readFileSync(join(REPO_ROOT, 'ci', 'expected-test-counts.json'), 'utf8'));

const only = process.argv.includes('--suite') ? process.argv[process.argv.indexOf('--suite') + 1] : null;
const suites = only ? config.suites.filter((s) => s.id === only) : config.suites;

if (suites.length === 0) fail('test count', [only ? `no suite with id ${only}` : 'no suites configured']);

/** `# tests 37` -> 37. Absent key -> null, which is itself a failure. */
function tapSummary(stdout) {
  const read = (key) => {
    const m = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(stdout);
    return m ? Number(m[1]) : null;
  };
  return { tests: read('tests'), pass: read('pass'), fail: read('fail') };
}

const problems = [];
const report = [];

for (const suite of suites) {
  const cwd = join(REPO_ROOT, suite.packageDir);
  const run = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', '--experimental-strip-types', suite.pattern],
    { cwd, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
  );

  const summary = tapSummary(run.stdout ?? '');
  const label = `${suite.id} (${suite.packageDir})`;

  if (summary.tests === null || summary.pass === null || summary.fail === null) {
    problems.push(`${label}: no TAP summary in the runner's output.`);
    problems.push(`  The suite did not run. Exit code ${run.status}.`);
    problems.push(...(run.stderr ?? '').trim().split('\n').slice(-8).map((l) => `  ${l}`));
    continue;
  }

  if (summary.fail > 0) {
    problems.push(`${label}: ${summary.fail} of ${summary.tests} tests failed.`);
    for (const line of (run.stdout ?? '').split('\n')) {
      if (/^not ok /.test(line)) problems.push(`  ${line.trim()}`);
    }
    continue;
  }

  if (run.status !== 0) {
    problems.push(`${label}: runner exited ${run.status} with no failing test.`);
    problems.push(`  ${(run.stderr ?? '').trim().split('\n').slice(-4).join('\n  ')}`);
    continue;
  }

  if (summary.tests < suite.minTests) {
    problems.push(`${label}: ran ${summary.tests} tests, expected at least ${suite.minTests}.`);
    problems.push(`  ${suite.minTests - summary.tests} test(s) stopped being discovered or stopped existing.`);
    problems.push(`  Do not lower minTests to make this pass. Find the tests.`);
    continue;
  }

  report.push(`${suite.id}: ${summary.tests} tests ran, ${summary.pass} passed (floor ${suite.minTests}).`);
}

if (problems.length > 0) fail('test count', problems);
pass('test count', report);
