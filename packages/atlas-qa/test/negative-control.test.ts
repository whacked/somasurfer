/**
 * The negative-control run, as a gate rather than an anecdote.
 *
 * "We saw it go red once" decays. This runs all thirteen deliberately broken
 * builds on every CI run and requires each to be caught BY THE CASE THAT
 * DECLARES IT OWNS IT — so a mutant failing for an unrelated reason does not
 * count, and a case that stops doing its job is reported against that case
 * rather than vanishing into an aggregate.
 *
 * The control matters as much as the mutants. Every mutant is run against the
 * same fixture as a reference build that passes 40/40 in the same file, which
 * is what makes a mutant's failure attributable to its mutation instead of to
 * ambient breakage.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MUTANTS,
  UNMUTATED_CLASSES,
  danglingCaughtBy,
  uncoveredClasses,
} from '../src/mutants.ts';
import { referenceViewer } from '../src/referenceViewer.ts';
import { resolveFixture } from '../src/fixture.ts';
import { runSuite } from '../src/runner.ts';

// The harness's own fixture, deliberately, so these self-tests keep asserting
// against a known input after DOG-37's curated one lands. A red suite caused by
// someone else's in-progress deliverable stops meaning anything.
const fixture = resolveFixture({ preferOwn: true });

test('the control passes, which is what makes the mutants evidence', async () => {
  const report = await runSuite(referenceViewer({ fixture }), { fixture });
  assert.equal(
    report.harnessVerdict,
    'PASS',
    `the reference build fails the suite, so no mutant below proves anything:\n`
    + report.results
      .filter((r) => r.outcome !== 'pass')
      .map((r) => `  ${r.id}: ${r.problems.join('; ') || r.unverifiedReason}`)
      .join('\n'),
  );
  assert.equal(report.counts.mustPassFail, 0);
  assert.equal(report.counts.mustPassUnverified, 0);
});

test('a reference pass is never a product pass', async () => {
  // The single most important line in the runner. A green run against the
  // stand-in must not be citable as §7 being verified.
  const report = await runSuite(referenceViewer({ fixture }), { fixture });
  assert.equal(report.harnessVerdict, 'PASS');
  assert.equal(
    report.productVerdict,
    'UNVERIFIED',
    'a reference build reported a product verdict other than UNVERIFIED',
  );
});

test('every mutant is caught by the case that declares it owns it', async () => {
  const escaped: string[] = [];
  for (const mutant of MUTANTS) {
    const report = await runSuite(mutant.build({ fixture }), { strict: true, fixture });
    const noticed = new Set(
      report.results.filter((r) => r.outcome === mutant.caughtAs).map((r) => r.id),
    );
    const missed = mutant.caughtBy.filter((id) => !noticed.has(id));
    if (report.harnessVerdict !== 'FAIL') {
      escaped.push(`${mutant.id}: suite verdict was ${report.harnessVerdict}, expected FAIL`);
    }
    if (missed.length > 0) {
      escaped.push(
        `${mutant.id}: expected ${JSON.stringify(missed)} to report ${mutant.caughtAs} and they did not. `
        + `Broken guarantee: ${mutant.breaks}`,
      );
    }
  }
  assert.deepEqual(escaped, [], `mutants not caught by their own case:\n  ${escaped.join('\n  ')}`);
});

test('the skipped-case mutant is caught, or nothing else here counts', async () => {
  // Called out separately because it breaks nothing about the viewer. It
  // declines a capability a must-pass row needs, which is the shape a false
  // green actually takes: no error, no red, and the case simply did not run.
  // If this one ever passes, every other mutant is worthless — any of them
  // could be skipped the same way.
  const mutant = MUTANTS.find((m) => m.id === 'silently-skips-a-must-pass-case');
  assert.ok(mutant, 'the skipped-case mutant has been removed');

  const strict = await runSuite(mutant.build({ fixture }), { strict: true, fixture });
  assert.equal(strict.harnessVerdict, 'FAIL', 'an unevaluated must-pass row must fail under --strict');
  assert.ok(strict.counts.mustPassUnverified > 0, 'the skipped rows were not reported as unverified');
  assert.equal(strict.counts.mustPassFail, 0, 'nothing should have actually FAILED; the rows did not run');

  // And without --strict it is still never a pass.
  const lenient = await runSuite(mutant.build({ fixture }), { strict: false, fixture });
  assert.equal(
    lenient.harnessVerdict,
    'UNVERIFIED',
    'an unevaluated must-pass row reported something other than UNVERIFIED without --strict',
  );
  assert.notEqual(lenient.harnessVerdict, 'PASS');
});

test('mutation coverage of the enumeration is declared, not left over', () => {
  // The gap list is allowed to be non-empty — some classes have no sensible
  // single-point mutation — but it has to be written down and argued. A class
  // that loses its mutant must be explained here before the suite goes green.
  const uncovered = uncoveredClasses().sort();
  const declared = UNMUTATED_CLASSES.map((u) => u.cls).sort();
  assert.deepEqual(
    uncovered,
    declared,
    'the classes with no mutant and the classes DECLARED to have no mutant disagree. Either add a '
    + 'mutant, or add an UNMUTATED_CLASSES entry giving the reason.',
  );
});

test('every declared mutation gap gives a reason', () => {
  for (const gap of UNMUTATED_CLASSES) {
    assert.ok(
      gap.reason.length >= 80,
      `the gap for ${gap.cls} is ${gap.reason.length} characters. A gap costs one argued sentence; that `
      + 'is what stops the list absorbing cases that should have been closed.',
    );
  }
});

test('no mutant names a case that does not exist', () => {
  // A `caughtBy` pointing at a deleted row would make the mutant permanently
  // "escaped" or, worse, silently unchecked.
  assert.deepEqual(danglingCaughtBy(), [], 'mutants referencing unknown cases');
});

test('every mutant declares what it breaks and how it is noticed', () => {
  const ids = new Set<string>();
  for (const m of MUTANTS) {
    assert.ok(!ids.has(m.id), `duplicate mutant id ${m.id}`);
    ids.add(m.id);
    assert.ok(m.breaks.length >= 30, `mutant ${m.id} does not say what it breaks`);
    assert.ok(m.caughtBy.length > 0, `mutant ${m.id} declares no case that catches it`);
    assert.ok(['fail', 'unverified'].includes(m.caughtAs), `mutant ${m.id} has no caughtAs`);
  }
  assert.ok(MUTANTS.length >= 13, `only ${MUTANTS.length} mutants; the control is thinning out`);
});

test('a mutant build can never report a product pass', async () => {
  for (const mutant of MUTANTS.slice(0, 3)) {
    const report = await runSuite(mutant.build({ fixture }), { fixture });
    assert.equal(report.build.kind, 'mutant', `${mutant.id} did not declare itself a mutant build`);
    assert.equal(report.productVerdict, 'UNVERIFIED', `${mutant.id} reported a product verdict`);
  }
});
