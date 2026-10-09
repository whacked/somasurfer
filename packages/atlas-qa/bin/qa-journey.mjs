#!/usr/bin/env node
/**
 * Run the §7 journey and deep-link matrix against a build.
 *
 * This is the tool task 7 (DOG-39) executes. Today it has no product build to
 * point at, so it runs against the reference stand-in and exits 2 —
 * `UNVERIFIED`, which is the honest answer and deliberately not 0.
 *
 *   node packages/atlas-qa/bin/qa-journey.mjs
 *   node packages/atlas-qa/bin/qa-journey.mjs --strict --json report.json
 *   node packages/atlas-qa/bin/qa-journey.mjs --build ./path/to/driver.mjs
 *   node packages/atlas-qa/bin/qa-journey.mjs --negative-control
 *
 * Exit codes, and why there are three:
 *
 *   0  the PRODUCT passed. Only reachable with a product build.
 *   1  something failed, or the harness itself is inconsistent.
 *   2  could not measure. No product build, or a must-pass case that could not
 *      be evaluated.
 *
 * A caller must be able to tell "nothing was measured" from "everything
 * passed" without parsing prose, which is why 2 exists and why this is not
 * wired into the blocking CI chain yet: until a product build exists it would
 * be permanently 2, and a job that is always the same colour stops being read.
 * The `node --test` suites in `test/` ARE in CI, and they gate the parts that
 * can be gated today. See README.md.
 */

import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { runSuite, formatReport, exitCodeFor } from '../src/runner.ts';
import { referenceViewer } from '../src/referenceViewer.ts';
import { resolveFixture, provenanceGaps } from '../src/fixture.ts';
import { MUTANTS } from '../src/mutants.ts';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flag('help')) {
  console.log(
    [
      'qa-journey — the DOG-1 §7 journey and the deep-link matrix',
      '',
      '  --build <path>       ES module default-exporting a ViewerDriver factory.',
      '                       Without it, the reference stand-in is used and the',
      '                       product verdict is UNVERIFIED whatever the rows say.',
      '  --strict             A must-pass case that cannot be evaluated FAILS.',
      '                       Use this for task 7; the point of a run against a real',
      '                       build is that nothing is allowed to be skipped.',
      '  --own-fixture        Use the harness fixture even if a curated one exists.',
      '  --json <path>        Write the full report as JSON.',
      '  --negative-control   Run the thirteen broken builds and report whether each',
      '                       was caught by the case that declares it owns it.',
      '',
      'Exit: 0 product pass, 1 failure, 2 could not measure.',
    ].join('\n'),
  );
  process.exit(0);
}

const fixture = resolveFixture({ preferOwn: flag('own-fixture') });

// ---------------------------------------------------------------------------
// The negative control
// ---------------------------------------------------------------------------
if (flag('negative-control')) {
  console.log('Negative control: each build below breaks exactly one guarantee.\n');
  const control = await runSuite(referenceViewer({ fixture }), { fixture });
  console.log(
    `  control (unmutated)  ${control.harnessVerdict === 'PASS' ? 'PASS' : 'BROKEN'} `
    + `— ${control.counts.pass}/${control.counts.total} cases`,
  );
  if (control.harnessVerdict !== 'PASS') {
    console.error('\n✗ the control does not pass, so nothing below is evidence of anything.\n');
    console.error(formatReport(control));
    process.exit(1);
  }

  let escaped = 0;
  for (const mutant of MUTANTS) {
    const report = await runSuite(mutant.build({ fixture }), { strict: true, fixture });
    const noticed = new Set(
      report.results.filter((r) => r.outcome === mutant.caughtAs).map((r) => r.id),
    );
    const missed = mutant.caughtBy.filter((id) => !noticed.has(id));
    const caught = report.harnessVerdict === 'FAIL' && missed.length === 0;
    if (!caught) escaped += 1;
    console.log(`  ${caught ? 'caught  ' : 'ESCAPED '} ${mutant.id}`);
    console.log(`             breaks: ${mutant.breaks}`);
    console.log(`             caught by: ${mutant.caughtBy.join(', ')} (as ${mutant.caughtAs})`);
    if (!caught) console.log(`             MISSED BY: ${missed.join(', ') || '(suite did not fail)'}`);
  }
  console.log(
    `\n${MUTANTS.length - escaped}/${MUTANTS.length} caught by the case that owns them.`,
  );
  process.exit(escaped === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// A normal run
// ---------------------------------------------------------------------------
const buildPath = value('build');
let driver;
if (buildPath && buildPath !== 'reference') {
  // The product build supplies a factory; anything else here would mean this
  // tool knowing how to construct the viewer, which is the coupling the
  // contract exists to avoid.
  const module = await import(resolvePath(process.cwd(), buildPath));
  const factory = module.default ?? module.createDriver;
  if (typeof factory !== 'function') {
    console.error(
      `✗ ${buildPath} does not default-export a function returning a ViewerDriver.\n`
      + '  See packages/atlas-qa/src/contract.ts for the shape, and README.md for the adapter.',
    );
    process.exit(1);
  }
  driver = await factory({ fixture });
} else {
  driver = referenceViewer({ fixture });
}

const report = await runSuite(driver, { strict: flag('strict'), fixture });

console.log(formatReport(report));

const gaps = provenanceGaps(fixture);
if (gaps.length > 0) {
  console.log(`\n  provenance gaps in the fixture (${gaps.length}), carried so task 7 knows:`);
  for (const gap of gaps.slice(0, 6)) console.log(`    · ${gap}`);
  if (gaps.length > 6) console.log(`    · … and ${gaps.length - 6} more`);
}

const jsonPath = value('json');
if (jsonPath) {
  writeFileSync(resolvePath(process.cwd(), jsonPath), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n  report written to ${jsonPath}`);
}

const code = exitCodeFor(report);
if (code === 2) {
  console.log(
    '\n  Exit 2: could not measure. This is not a pass. '
    + (driver.kind === 'product'
      ? 'A must-pass case could not be evaluated against this build.'
      : 'No product build was supplied, so §7 remains unverified.'),
  );
}
process.exit(code);
