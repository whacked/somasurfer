/**
 * The one rule this harness is built around: `unverified` never becomes `pass`.
 *
 * DOG-38 states it as an acceptance criterion — "a gate that cannot measure
 * must report UNVERIFIED and must not report a pass; a case that silently does
 * not run is a false green, and a false green here is invisible". A rule like
 * that cannot live in a convention or a docstring, because neither can be run.
 * This file runs it.
 *
 * Six ways a case can fail to be evaluated, and all six must land on
 * `unverified` rather than on `pass`:
 *
 *   the build lacks a required capability
 *   the fixture cannot pose the question
 *   an earlier step the case depends on failed
 *   the journey cannot be planned against the fixture at all
 *   the case declared itself and produced no result (the skipped case)
 *   the driver is not the right shape to be driven
 *
 * And one way that must NOT be unverified: an exception. An exception is
 * evidence of a defect; a missing capability is an absence of evidence. Reading
 * a crash as "could not measure" is how a build that throws on every deep link
 * reports clean.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { referenceViewer, ReferenceViewer } from '../src/referenceViewer.ts';
import { resolveFixture } from '../src/fixture.ts';
import { runSuite, exitCodeFor } from '../src/runner.ts';
import { DEEP_LINK_MATRIX } from '../src/matrix.ts';
import { JOURNEY } from '../src/journey.ts';
import type { Capability, ViewState } from '../src/contract.ts';

const fixture = resolveFixture({ preferOwn: true });

test('a withheld capability makes its rows unverified, never passed', async () => {
  const driver = referenceViewer({ fixture, withhold: ['deep-link'] as Capability[] });
  const report = await runSuite(driver, { fixture });

  const deepLinkRows = DEEP_LINK_MATRIX.filter((r) => r.requires.includes('deep-link')).map((r) => r.id);
  assert.ok(deepLinkRows.length > 5, 'expected many rows to require deep-link');
  for (const id of deepLinkRows) {
    const result = report.results.find((r) => r.id === id);
    assert.ok(result, `row ${id} produced no result at all`);
    assert.equal(result.outcome, 'unverified', `row ${id} was ${result.outcome}, expected unverified`);
    assert.ok(result.unverifiedReason?.includes('deep-link'), `row ${id} does not say what was missing`);
  }
  assert.notEqual(report.harnessVerdict, 'PASS', 'a suite with unevaluated must-pass rows passed');
});

test('an unevaluated must-pass row fails under --strict and is UNVERIFIED without it', async () => {
  const driver = referenceViewer({ fixture, withhold: ['view-restore'] as Capability[] });

  const lenient = await runSuite(driver, { fixture, strict: false });
  assert.equal(lenient.harnessVerdict, 'UNVERIFIED');
  assert.ok(lenient.counts.mustPassUnverified > 0);

  const strict = await runSuite(driver, { fixture, strict: true });
  assert.equal(strict.harnessVerdict, 'FAIL', 'strict mode must turn an unevaluated must-pass row red');
});

test('there is no configuration in which an unevaluated must-pass row passes', async () => {
  // Exhaustive over the two modes, because "never" is the claim.
  const driver = referenceViewer({ fixture, withhold: ['browse-by-research'] as Capability[] });
  for (const strict of [true, false]) {
    const report = await runSuite(driver, { fixture, strict });
    assert.notEqual(
      report.harnessVerdict,
      'PASS',
      `strict=${strict} reported PASS with ${report.counts.mustPassUnverified} unevaluated must-pass rows`,
    );
    assert.notEqual(report.productVerdict, 'PASS', `strict=${strict} reported a product PASS`);
  }
});

test('a failed step blocks its dependants as unverified rather than failing them again', async () => {
  // One defect must read as one defect. A suite that reports five failures for
  // one broken step buries the only fact worth knowing.
  class BrokenSelection extends ReferenceViewer {
    async clickStructure(): Promise<ViewState> {
      // Selects nothing, so step 3 fails on its own assertions.
      return super.state();
    }
  }
  const driver = new BrokenSelection({ fixture });
  const report = await runSuite(driver, { fixture });

  const select = report.results.find((r) => r.id === 'select-structure-without-leaving-atlas');
  assert.equal(select?.outcome, 'fail', 'the broken step should fail');

  const dependants = JOURNEY.filter((s) => s.dependsOn.includes('select-structure-without-leaving-atlas'));
  assert.ok(dependants.length > 0, 'expected the selection step to have dependants');
  for (const step of dependants) {
    const result = report.results.find((r) => r.id === step.id);
    assert.equal(
      result?.outcome,
      'unverified',
      `dependant ${step.id} was ${result?.outcome}; a step that never ran is not a second failure`,
    );
    assert.match(
      result?.unverifiedReason ?? '',
      /blocked/,
      `dependant ${step.id} does not say it was blocked`,
    );
  }
  assert.equal(report.harnessVerdict, 'FAIL');
});

test('a case that declares itself and produces no result fails the suite', async () => {
  // The false green in its purest form: no assertion inside a row can catch a
  // row that never executed, so the runner compares the declared must-pass ids
  // against the ids that produced results.
  const report = await runSuite(referenceViewer({ fixture }), {
    fixture,
    // One row is declared by the matrix and withheld from the run.
    rows: DEEP_LINK_MATRIX.filter((r) => r.id !== 'c08-rejected-with-the-correction-named'),
  });
  // The runner's `mustPassMissing` is computed from the rows it was GIVEN, so
  // dropping a row from the input cannot be detected there — it is detected by
  // the matrix-integrity gate instead, which this asserts is wired in.
  assert.ok(
    report.harnessProblems.some((p) => p.includes('c08-correction')),
    `removing the C08 row must break the integrity gate. Problems were: ${JSON.stringify(report.harnessProblems)}`,
  );
  assert.equal(report.harnessVerdict, 'FAIL');
});

test('a driver of the wrong shape fails rather than reporting an empty pass', async () => {
  const notADriver = { buildId: 'broken', kind: 'product' } as never;
  const report = await runSuite(notADriver, { fixture });
  assert.equal(report.harnessVerdict, 'FAIL');
  assert.ok(report.harnessProblems.some((p) => p.includes('missing method')), 'shape problems not reported');
  assert.equal(report.counts.pass, 0, 'a driver that cannot be driven reported passing cases');
});

test('an exception is a failure, not an absence of evidence', () => {
  // The distinction that keeps a crashing build from reporting clean. Two
  // cases, because they are handled in different places.
  //
  // A build that throws on ONE row: that row fails, naming the exception, and
  // the rest of the suite still runs.
  class ThrowsOnFold extends ReferenceViewer {
    async open(url: string): Promise<ViewState> {
      if (url.includes('fold-fixture')) throw new TypeError('the fold path blew up');
      return super.open(url);
    }
  }
  return runSuite(new ThrowsOnFold({ fixture }), { fixture }).then((report) => {
    const fold = report.results.find((r) => r.id === 'folded-reports-fold-not-clamp');
    assert.equal(fold?.outcome, 'fail', 'a thrown exception on one row must be that row failing');
    assert.ok(
      fold?.problems.some((p) => p.includes('threw') && p.includes('TypeError')),
      `the failure must name the exception. Got: ${JSON.stringify(fold?.problems)}`,
    );
    assert.ok(report.counts.pass > 20, 'one throwing row should not stop the rest of the suite');
    assert.equal(report.harnessVerdict, 'FAIL');
  });
});

test('a build that throws on the initial load produces a failing report, not no report', async () => {
  // The baseline load is special: every `unchanged` assertion is anchored to
  // it, so a build that throws there leaves nothing to compare against. The
  // exception used to propagate out of runSuite, which meant a build that blew
  // up on load produced no report at all rather than a failing one.
  class ThrowsOnLoad extends ReferenceViewer {
    async open(): Promise<ViewState> {
      throw new TypeError('the viewer blew up');
    }
  }
  const report = await runSuite(new ThrowsOnLoad({ fixture }), { fixture });
  assert.equal(report.harnessVerdict, 'FAIL');
  assert.ok(
    report.harnessProblems.some((p) => p.includes('threw on the initial load')),
    `the report must say the build failed to load. Problems: ${JSON.stringify(report.harnessProblems)}`,
  );
  assert.ok(
    report.mustPassMissing.length > 0,
    'every must-pass case consequently did not run, and the report must say so',
  );
  assert.equal(report.counts.pass, 0, 'a build that cannot load reported passing cases');
});

test('exit codes distinguish pass, failure and could-not-measure', async () => {
  // 2 is the one that matters: a caller must be able to tell "nothing was
  // measured" from "everything passed" without parsing prose.
  const pass = await runSuite(referenceViewer({ fixture }), { fixture });
  assert.equal(pass.harnessVerdict, 'PASS');
  assert.equal(exitCodeFor(pass), 2, 'a reference pass is not a product pass, so it must not exit 0');

  const unverified = await runSuite(
    referenceViewer({ fixture, withhold: ['deep-link'] as Capability[] }),
    { fixture },
  );
  assert.equal(exitCodeFor(unverified), 2);

  const failed = await runSuite({ buildId: 'x', kind: 'product' } as never, { fixture });
  assert.equal(exitCodeFor(failed), 1);
});

test('the report never prints a pass for a run that verified nothing', async () => {
  const { formatReport } = await import('../src/runner.ts');
  const report = await runSuite(referenceViewer({ fixture }), { fixture });
  const text = formatReport(report);
  const firstLine = text.split('\n')[0];
  assert.match(
    firstLine,
    /UNVERIFIED/,
    `the headline of a reference run must say UNVERIFIED. It said: ${JSON.stringify(firstLine)}`,
  );
  assert.ok(
    !/^§7 PASS/.test(firstLine),
    'the headline claimed a §7 pass for a run against the stand-in',
  );
  assert.ok(
    text.includes('verifies the harness'),
    'the report does not say that a reference run verifies the harness rather than the product',
  );
});

test('the fixture digest is in the report, so a result is reproducible', async () => {
  const report = await runSuite(referenceViewer({ fixture }), { fixture });
  assert.equal(report.fixture.id, fixture.id);
  assert.match(report.fixture.sha256, /^[0-9a-f]{64}$/, 'the fixture is not pinned by digest');
  assert.ok(report.plan, 'the report does not say which fixture entities were exercised');
  assert.ok(report.plan.researchRegionId, 'no research region recorded');
});
