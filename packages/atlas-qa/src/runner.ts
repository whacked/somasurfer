/**
 * Running the suite, and the one rule that makes it worth running.
 *
 * ## `unverified` never becomes `pass`
 *
 * Three outcomes, not two. A row passes, fails, or could not be evaluated, and
 * the third is a first-class result with its own propagation rules:
 *
 *   - A row whose required capability the build does not have is `unverified`.
 *   - A row whose fixture cannot pose the question is `unverified`.
 *   - A step whose dependency failed is `unverified`, not a second failure.
 *   - A row that throws something unexpected is a `fail`, not `unverified`.
 *     An exception is evidence; a missing capability is an absence of evidence.
 *
 * And then: a must-pass row that is `unverified` fails the suite in strict
 * mode, and in every mode prevents a `PASS`. There is no configuration under
 * which an unevaluated must-pass row reports a pass. That is the acceptance
 * criterion on this task, and it is here rather than in a convention because a
 * convention cannot be tested — `test/unverified.test.ts` tests this.
 *
 * ## Two verdicts, because "the harness is green" and "§7 is verified" are
 * different facts
 *
 * `harnessVerdict` says whether the suite is self-consistent and whether the
 * build it was pointed at satisfied it. `productVerdict` says whether that
 * build was the *product*. Running green against the reference stand-in means
 * `harnessVerdict: PASS, productVerdict: UNVERIFIED` — the harness works, and
 * §7 is not verified. Collapsing those into one word is how a suite that has
 * never seen the real build comes to be cited as evidence that the real build
 * works.
 *
 * ## Missing rows are a failure
 *
 * `mustPassMissing` compares the must-pass ids the matrix and journey declare
 * against the ids that actually produced a result. A row that silently does not
 * run is the specific false green this task exists to prevent, and no assertion
 * inside a row can catch a row that never executed.
 */

import { AlcError, locate, parse } from '../../alc/src/index.ts';
import {
  changedFacets,
  driverShapeProblems,
  facetKey,
  facetsEqual,
  hasMessage,
  messageCodes,
  messageText,
  unknownCapabilities,
  FACETS,
  type Capability,
  type ViewState,
  type ViewerDriver,
} from './contract.ts';
import {
  DEEP_LINK_MATRIX,
  matrixIntegrityProblems,
  QA_URL_PARAMS,
  type MatrixRow,
  type TemplateChoice,
} from './matrix.ts';
import {
  JOURNEY,
  journeyIntegrityProblems,
  planJourney,
  Unverifiable,
  type JourneyContext,
  type JourneyPlan,
} from './journey.ts';
import { resolveFixture, unmetRequirements, type ResearchFixture } from './fixture.ts';
import { templateSet } from './templates.ts';

export type Outcome = 'pass' | 'fail' | 'unverified';
export type Verdict = 'PASS' | 'FAIL' | 'UNVERIFIED';

export interface CaseResult {
  readonly id: string;
  readonly kind: 'matrix' | 'journey';
  readonly mustPass: boolean;
  readonly outcome: Outcome;
  /** What the case asserts, in observable terms. Carried into the report. */
  readonly observable: string;
  /** Case classes (matrix) or the DOG-1 §7 clause (journey). */
  readonly covers: readonly string[];
  /** Why it failed. Empty on pass. */
  readonly problems: readonly string[];
  /** Why it could not be evaluated. Set only when `outcome === 'unverified'`. */
  readonly unverifiedReason?: string;
  readonly durationMs: number;
}

export interface SuiteReport {
  readonly startedAt: string;
  readonly build: { readonly id: string; readonly kind: ViewerDriver['kind'] };
  readonly fixture: {
    readonly id: string;
    readonly path: string;
    readonly sha256: string;
    readonly kind: string;
  };
  readonly strict: boolean;
  /** Which fixture entities this run exercised. A result is not reproducible without them. */
  readonly plan: JourneyPlan | null;
  readonly harnessVerdict: Verdict;
  /**
   * Whether the PRODUCT is verified. `UNVERIFIED` for any run against a
   * reference or mutant build, whatever the rows said.
   */
  readonly productVerdict: Verdict;
  readonly counts: {
    readonly total: number;
    readonly pass: number;
    readonly fail: number;
    readonly unverified: number;
    readonly mustPassTotal: number;
    readonly mustPassPass: number;
    readonly mustPassFail: number;
    readonly mustPassUnverified: number;
  };
  /** Must-pass cases that declared themselves and then produced no result at all. */
  readonly mustPassMissing: readonly string[];
  /** Problems with the suite as authored, or with the driver's shape. Any of these fails. */
  readonly harnessProblems: readonly string[];
  readonly results: readonly CaseResult[];
}

// ---------------------------------------------------------------------------
// Matrix row evaluation
// ---------------------------------------------------------------------------

function missingCapabilities(driver: ViewerDriver, required: readonly Capability[]): Capability[] {
  const have = driver.capabilities();
  return required.filter((c) => !have.has(c));
}

/** The cell centre the camera is supposed to reach, or null when there is none. */
function expectedCellCentre(address: string | null, template: TemplateChoice): readonly number[] | null {
  if (!address) return null;
  try {
    const located = locate(address, templateSet(template));
    if (located.pointMm.some((x) => !Number.isFinite(x))) return null;
    return located.pointMm;
  } catch {
    return null;
  }
}

function templateOf(row: MatrixRow): TemplateChoice {
  if (row.input.kind === 'click-point') return row.input.template;
  const url = row.input.url;
  const match = new RegExp(`${QA_URL_PARAMS.template}=([a-z-]+)`).exec(url);
  if (match) return match[1] as TemplateChoice;
  return /a=BV/i.test(url) ? 'brain' : 'body';
}

async function evaluateRow(
  driver: ViewerDriver,
  row: MatrixRow,
  baseline: ViewState,
): Promise<{ problems: string[]; unverifiedReason?: string }> {
  const missing = missingCapabilities(driver, row.requires);
  if (missing.length > 0) {
    return {
      problems: [],
      unverifiedReason: `build ${driver.buildId} lacks ${missing.join(', ')}`,
    };
  }

  const problems: string[] = [];
  const must = (condition: boolean, message: string): void => {
    if (!condition) problems.push(message);
  };

  // Reach the state under test. Each row starts from a fresh load so that one
  // row cannot leave state that makes the next one pass.
  let state: ViewState;
  if (row.input.kind === 'url') {
    state = await driver.open(row.input.url);
  } else {
    await driver.open(
      row.input.template === 'body' ? '/' : `/?${QA_URL_PARAMS.template}=${row.input.template}`,
    );
    state = await driver.clickPointMm(row.input.pointMm, row.input.digits);
  }

  const e = row.expect;
  const codes = messageCodes(state);

  for (const code of e.messages) {
    must(hasMessage(state, code), `expected the ${code} message; got ${JSON.stringify(codes)}`);
  }
  for (const code of e.forbiddenMessages ?? []) {
    must(!hasMessage(state, code), `the ${code} message must NOT appear here, and did`);
  }
  for (const needle of e.textMustContain ?? []) {
    const text = e.messages.map((c) => messageText(state, c)).join(' ');
    must(
      text.includes(needle),
      `the message must name ${JSON.stringify(needle)}. Got: ${JSON.stringify(text.slice(0, 300))}`,
    );
  }

  if (e.urlAddress !== undefined) {
    must(
      state.urlAddress === e.urlAddress,
      `URL address: expected ${JSON.stringify(e.urlAddress)}, got ${JSON.stringify(state.urlAddress)}`,
    );
  }
  if (e.atlas !== undefined) must(state.atlas === e.atlas, `atlas: expected ${e.atlas}, got ${state.atlas}`);
  if (e.selectionAddress !== undefined) {
    must(
      state.selection.address === e.selectionAddress,
      `selected address: expected ${JSON.stringify(e.selectionAddress)}, got ${JSON.stringify(state.selection.address)}`,
    );
  }
  if (e.assetsAvailable !== undefined) {
    must(
      state.assetsAvailable === e.assetsAvailable,
      `assetsAvailable: expected ${e.assetsAvailable}, got ${state.assetsAvailable}`,
    );
  }

  if (e.cellKind === null) {
    must(state.cell === null, `no cell should be drawn here, but one was: ${JSON.stringify(state.cell)}`);
  } else if (e.cellKind === 'extent') {
    must(state.cell !== null, 'no cell was drawn');
    if (state.cell) {
      must(
        state.cell.kind === 'extent',
        'the cell is rendered as a POINT. A cell must be drawn at its true extent — an over-precise '
        + 'address has to look coarse on screen, and a point throws away the only cue that it is.',
      );
      must(
        state.cell.extentMm.every((x) => Number.isFinite(x) && x > 0),
        `the drawn extent is not a positive finite box: ${JSON.stringify(state.cell.extentMm)}`,
      );
    }
  }
  if (e.displayedDigits !== undefined && state.cell) {
    must(
      state.cell.displayedDigits === e.displayedDigits,
      `the cell must be displayed at ${e.displayedDigits} digits, was ${state.cell.displayedDigits}`,
    );
  }

  if (e.namesResolve) {
    must(
      (state.names?.length ?? 0) > 0,
      'names must still resolve here — name resolution needs no mesh, so a failed asset load must not '
      + 'take it down',
    );
  }

  // The camera.
  if (e.camera === 'unchanged') {
    must(
      facetKey(baseline.camera) === facetKey(state.camera),
      `the camera must not move here. It moved: ${JSON.stringify(state.camera)}`,
    );
  } else {
    must(
      facetKey(baseline.camera) !== facetKey(state.camera),
      'the camera must fly to the cell, and did not move at all',
    );
    must(
      state.camera.targetMm.every((x) => Number.isFinite(x)),
      `the camera target is not finite: ${JSON.stringify(state.camera.targetMm)}`,
    );
    // Where the address resolves to millimetres, the camera has to be at them.
    // "The camera moved" is satisfied by moving anywhere.
    const centre = expectedCellCentre(e.urlAddress ?? state.urlAddress, templateOf(row));
    if (centre && state.cell) {
      const tolerance = Math.max(...state.cell.extentMm.map((x) => Math.abs(x))) + 1e-6;
      const offset = Math.hypot(...state.camera.targetMm.map((v, i) => v - centre[i]));
      must(
        offset <= tolerance,
        `the camera settled ${offset.toFixed(2)} mm from the cell centre, which is outside the cell `
        + `(longest extent ${tolerance.toFixed(2)} mm). Expected ${JSON.stringify(centre.map((x) => +x.toFixed(2)))}, `
        + `got ${JSON.stringify(state.camera.targetMm.map((x) => +x.toFixed(2)))}`,
      );
    }
  }

  // What does not change.
  for (const facet of e.unchanged) {
    must(
      facetsEqual(baseline, state, [facet]),
      `${facet} must be unchanged here, and changed. All changed facets: `
      + JSON.stringify(changedFacets(baseline, state)),
    );
  }

  return { problems };
}

/**
 * The two equality-guard rows, which are about a question rather than a view.
 *
 * Kept out of `evaluateRow` because their input is a pair of address lists, not
 * a URL — but they are matrix rows and not a separate suite, because the point
 * is that a UI-level regression is caught by the same enumeration everything
 * else is.
 */
async function evaluateEqualityGuardRow(
  driver: ViewerDriver,
  row: MatrixRow,
): Promise<{ problems: string[]; unverifiedReason?: string }> {
  const problems: string[] = [];
  const must = (c: boolean, m: string): void => { if (!c) problems.push(m); };

  if (row.id === 'equality-guard-different-strings-same-place') {
    // Two addresses that are different strings and the same place: a cell and
    // the cell next to it, compared at a tolerance wider than the cell. Any
    // honest geometric answer is yes; string equality says no.
    const a = ['BD-T07-03O-531'];
    const b = ['BD-T07-03O-530'];
    must(a[0] !== b[0], 'the guard needs two DIFFERENT strings to be a test of anything');
    const answer = await driver.samePlaceAcrossSubjects(a, b, 25);
    must(
      answer.same,
      `the build says ${JSON.stringify(a)} and ${JSON.stringify(b)} are not the same place at a 25 mm `
      + 'tolerance. They are adjacent cells a few millimetres apart; this is the string-equality answer.',
    );
    must(
      answer.basis !== 'string-equality',
      `the build answered on the basis ${JSON.stringify(answer.basis)}`,
    );
  } else {
    // The same string twice. The right answer is yes, and the wrong *reason*
    // is string identity — which is why the basis is asserted and not only the
    // verdict. Getting this one right by comparing strings is how the row
    // above starts failing later.
    const same = ['BD-T07-03O-531'];
    const answer = await driver.samePlaceAcrossSubjects(same, [...same], 6);
    must(answer.same, 'two identical coverings are the same place at any tolerance');
    must(
      answer.basis !== 'string-equality',
      `the build answered "same place?" by comparing strings (basis ${JSON.stringify(answer.basis)}). `
      + 'Right answer, wrong instrument.',
    );
  }
  return { problems };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Fail, rather than report UNVERIFIED, when a must-pass case cannot be evaluated. */
  readonly strict?: boolean;
  readonly fixture?: ResearchFixture;
  readonly rows?: readonly MatrixRow[];
  readonly journey?: typeof JOURNEY;
}

export async function runSuite(driver: ViewerDriver, options: RunOptions = {}): Promise<SuiteReport> {
  const startedAt = new Date().toISOString();
  const strict = options.strict ?? false;
  const rows = options.rows ?? DEEP_LINK_MATRIX;
  const steps = options.journey ?? JOURNEY;
  const fixture = options.fixture ?? resolveFixture();

  const harnessProblems: string[] = [
    ...driverShapeProblems(driver).map((p) => `driver: ${p}`),
    ...matrixIntegrityProblems(rows).map((p) => `matrix: ${p}`),
    ...journeyIntegrityProblems(steps).map((p) => `journey: ${p}`),
    ...unknownCapabilities(driver).map((c) => `driver declares unknown capability ${JSON.stringify(c)}`),
  ];

  const results: CaseResult[] = [];
  let plan: JourneyPlan | null = null;

  // Nothing can be driven if the driver is the wrong shape; report that rather
  // than producing a page of TypeErrors attributed to individual rows.
  const driverUsable = driverShapeProblems(driver).length === 0;

  if (driverUsable) {
    // ---- the deep-link matrix -------------------------------------------
    const baseline = await driver.open('/');
    for (const row of rows) {
      const began = Date.now();
      let problems: string[] = [];
      let unverifiedReason: string | undefined;
      try {
        const evaluated = row.classes.includes('equality-guard')
          ? await evaluateEqualityGuardRow(driver, row)
          : await evaluateRow(driver, row, baseline);
        problems = evaluated.problems;
        unverifiedReason = evaluated.unverifiedReason;
      } catch (error) {
        if (error instanceof Unverifiable) {
          unverifiedReason = error.message;
        } else {
          // An exception is evidence of a defect, not an absence of evidence.
          const e = error as Error;
          problems = [
            `threw ${e instanceof AlcError ? `AlcError(${(e as AlcError).code})` : e?.constructor?.name}: ${e?.message}`,
          ];
        }
      }
      results.push({
        id: row.id,
        kind: 'matrix',
        mustPass: row.mustPass,
        outcome: unverifiedReason ? 'unverified' : problems.length > 0 ? 'fail' : 'pass',
        observable: row.expect.observable,
        covers: row.classes,
        problems,
        unverifiedReason,
        durationMs: Date.now() - began,
      });
    }

    // ---- the DOG-1 §7 journey -------------------------------------------
    const unmet = unmetRequirements(fixture);
    try {
      plan = planJourney(fixture);
    } catch (error) {
      harnessProblems.push(`journey plan: ${(error as Error).message}`);
    }

    const ctx: JourneyContext | null = plan
      ? { driver, fixture, plan, snapshots: new Map<string, ViewState>() }
      : null;
    const failedSteps = new Set<string>();

    for (const step of steps) {
      const began = Date.now();
      let problems: string[] = [];
      let unverifiedReason: string | undefined;

      const blockedBy = step.dependsOn.filter((d) => failedSteps.has(d));
      const missing = missingCapabilities(driver, step.requires);

      if (!ctx) {
        unverifiedReason = 'the journey could not be planned against this fixture';
      } else if (blockedBy.length > 0) {
        // Not a second failure: the step never ran, and reporting it as failing
        // would multiply one defect into a page of them.
        unverifiedReason = `blocked: ${blockedBy.join(', ')} failed, so this step never ran`;
      } else if (missing.length > 0) {
        unverifiedReason = `build ${driver.buildId} lacks ${missing.join(', ')}`;
      } else if (unmet.has(step.id)) {
        unverifiedReason = unmet.get(step.id)!.join('; ');
      } else {
        try {
          problems = await step.run(ctx);
        } catch (error) {
          if (error instanceof Unverifiable) {
            unverifiedReason = error.message;
          } else {
            const e = error as Error;
            problems = [`threw ${e?.constructor?.name}: ${e?.message}`];
          }
        }
      }

      const outcome: Outcome = unverifiedReason ? 'unverified' : problems.length > 0 ? 'fail' : 'pass';
      if (outcome === 'fail') failedSteps.add(step.id);
      // A blocked step blocks its own dependents too, or the first failure's
      // consequences would be reported as independent defects two steps later.
      if (outcome === 'unverified') failedSteps.add(step.id);

      results.push({
        id: step.id,
        kind: 'journey',
        mustPass: step.mustPass,
        outcome,
        observable: step.observable,
        covers: [step.clause],
        problems,
        unverifiedReason,
        durationMs: Date.now() - began,
      });
    }
  }

  // ---- verdicts ---------------------------------------------------------
  const declaredMustPass = [
    ...rows.filter((r) => r.mustPass).map((r) => r.id),
    ...steps.filter((s) => s.mustPass).map((s) => s.id),
  ];
  const produced = new Set(results.map((r) => r.id));
  const mustPassMissing = declaredMustPass.filter((id) => !produced.has(id));

  const mustPass = results.filter((r) => r.mustPass);
  const counts = {
    total: results.length,
    pass: results.filter((r) => r.outcome === 'pass').length,
    fail: results.filter((r) => r.outcome === 'fail').length,
    unverified: results.filter((r) => r.outcome === 'unverified').length,
    mustPassTotal: declaredMustPass.length,
    mustPassPass: mustPass.filter((r) => r.outcome === 'pass').length,
    mustPassFail: mustPass.filter((r) => r.outcome === 'fail').length,
    mustPassUnverified: mustPass.filter((r) => r.outcome === 'unverified').length,
  };

  let harnessVerdict: Verdict;
  if (harnessProblems.length > 0 || mustPassMissing.length > 0 || counts.mustPassFail > 0) {
    harnessVerdict = 'FAIL';
  } else if (counts.mustPassUnverified > 0) {
    // The one-sided bound: a must-pass case nobody could evaluate is not a
    // pass. In strict mode it is a failure; otherwise it is the honest third
    // answer. It is never a pass.
    harnessVerdict = strict ? 'FAIL' : 'UNVERIFIED';
  } else {
    harnessVerdict = 'PASS';
  }

  const productVerdict: Verdict = driver.kind === 'product' ? harnessVerdict : 'UNVERIFIED';

  return {
    startedAt,
    build: { id: driver.buildId, kind: driver.kind },
    fixture: {
      id: fixture.id,
      path: fixture.source.path,
      sha256: fixture.source.sha256,
      kind: fixture.source.kind,
    },
    strict,
    plan,
    harnessVerdict,
    productVerdict,
    counts,
    mustPassMissing,
    harnessProblems,
    results,
  };
}

/** 0 for a pass, 1 for a failure, 2 for "could not measure". */
export function exitCodeFor(report: SuiteReport): 0 | 1 | 2 {
  if (report.harnessVerdict === 'FAIL') return 1;
  if (report.productVerdict === 'PASS') return 0;
  return 2;
}

/**
 * The report as text.
 *
 * The first line is the one that gets quoted into an issue, so it never says
 * anything shorter than the truth: a reference run prints
 * `§7 UNVERIFIED (harness PASS against reference build ...)` and cannot be
 * mistaken for a product result by someone reading only the first line.
 */
export function formatReport(report: SuiteReport): string {
  const out: string[] = [];
  const mark = { pass: '✓', fail: '✗', unverified: '?' } as const;

  out.push(
    report.productVerdict === 'PASS'
      ? `§7 PASS against product build ${report.build.id}`
      : `§7 ${report.productVerdict} (harness ${report.harnessVerdict} against ${report.build.kind} build ${report.build.id})`,
  );
  if (report.build.kind !== 'product') {
    out.push(
      `  This is a ${report.build.kind} build. Nothing here verifies the product; it verifies the harness.`,
    );
  }
  out.push(
    `  fixture ${report.fixture.id} (${report.fixture.kind}) sha256 ${report.fixture.sha256.slice(0, 16)}…`,
  );
  if (report.plan) {
    out.push(
      `  exercised: structure ${report.plan.bodyStructureId}, region ${report.plan.researchRegionId}, `
      + `papers ${report.plan.multiRegionPaperId} + ${report.plan.comparisonPaperId}`,
    );
  }
  out.push(
    `  ${report.counts.pass} passed, ${report.counts.fail} failed, ${report.counts.unverified} unverified `
    + `of ${report.counts.total}; must-pass ${report.counts.mustPassPass}/${report.counts.mustPassTotal}`,
  );
  out.push('');

  for (const problem of report.harnessProblems) out.push(`  ✗ HARNESS  ${problem}`);
  for (const id of report.mustPassMissing) {
    out.push(
      `  ✗ MISSING  must-pass case ${id} declared itself and produced no result. A case that silently `
      + 'does not run is a false green.',
    );
  }
  if (report.harnessProblems.length > 0 || report.mustPassMissing.length > 0) out.push('');

  for (const r of report.results) {
    if (r.outcome === 'pass') continue;
    const tag = r.mustPass ? 'MUST-PASS' : 'advisory';
    out.push(`  ${mark[r.outcome]} ${r.outcome.toUpperCase()} [${tag}] ${r.kind}/${r.id}`);
    out.push(`      covers: ${r.covers.join('; ')}`);
    out.push(`      expected: ${r.observable}`);
    if (r.unverifiedReason) out.push(`      not evaluated: ${r.unverifiedReason}`);
    for (const p of r.problems) out.push(`      - ${p}`);
    out.push('');
  }

  const passed = report.results.filter((r) => r.outcome === 'pass').map((r) => `${r.kind}/${r.id}`);
  if (passed.length > 0) out.push(`  passed: ${passed.join(', ')}`);
  return out.join('\n');
}
