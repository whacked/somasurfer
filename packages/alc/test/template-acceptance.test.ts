/**
 * The body-template acceptance gate.
 *
 * docs/alc-1-admissibility.md section 5 requires that every template pass
 * `auditBodyTemplate()` and also run `measureRoundTrip()` — "the audit is
 * analytic, the probe is the thing that cannot be fooled". This suite runs the
 * reusable gate in src/testing/templateAcceptance.ts against every preset, and
 * then attacks the gate itself: templates the audit clears and the probe
 * breaks, and templates both of them clear that are still broken.
 *
 * Two holes were found and both are reproduced here as tests, so the gate's
 * extra stages cannot be removed as redundant.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  auditBodyTemplate,
  bodyLocalToMm,
  bodyMmToLocal,
  encodeBody,
  levelsAddressing,
  levelsClaiming,
  scanBodyTemplateFolds,
  type BodyTemplate,
  type VertebralSlab,
} from '../src/index.ts';
import {
  ADULT_HYPERKYPHOTIC_SHORT_WIDE,
  ADULT_P50,
  ADULT_P50_SPLIT_SACRUM,
  FOLD_REGRESSIONS,
  PRESETS,
  buildAnatomicalBodyTemplate,
} from '../src/testing/anatomicalTemplates.ts';
import { measureRoundTrip } from '../src/testing/admissibilityProbe.ts';
import {
  acceptBodyTemplate,
  formatAcceptanceReport,
  formatLevelTable,
} from '../src/testing/templateAcceptance.ts';

/** Cheaper settings for the per-test runs; the preset gate below uses defaults. */
const QUICK = { samplesPerLevel: 60, consistencyAzimuths: 48 } as const;

// ---------------------------------------------------------------------------
test('acceptance: every shipped preset passes every stage', () => {
  // The acceptance criterion for this suite. If a preset ever fails, the report
  // is printed in full, because the pipeline needs the whole list.
  for (const params of PRESETS) {
    const template = buildAnatomicalBodyTemplate(params);
    const report = acceptBodyTemplate(template);
    assert.equal(report.accepted, true, `\n${formatAcceptanceReport(report)}`);
    assert.equal(report.stages.length, 4, 'a stage went missing from the gate');
    assert.ok(report.stages.every((s) => s.passed));
    // The gate must actually have done work, not passed vacuously.
    const consistency = report.stages.find((s) => s.stage === 'ADMISSIBILITY-CONSISTENCY')!;
    assert.ok(
      Number(consistency.measurements.probed) > 10000,
      `${params.id}: the consistency stage probed only ${consistency.measurements.probed} points`,
    );
    assert.equal(Number(report.stages.find((s) => s.stage === 'PROBE')!.measurements.failures), 0);
    // And the per-level table that must ship with the template is producible.
    const table = formatLevelTable(report);
    assert.ok(table.includes('| `L04` |'), `${params.id}: level table is missing rows`);
    assert.equal(table.split('\n').length, template.slabs.length + 2);
  }
});

test('acceptance: the gate is reproducible from its seed', () => {
  // A rejection nobody can replay is not a finding.
  const template = buildAnatomicalBodyTemplate(ADULT_P50);
  const a = acceptBodyTemplate(template, { ...QUICK, seed: 777 });
  const b = acceptBodyTemplate(template, { ...QUICK, seed: 777 });
  assert.deepEqual(a.stages, b.stages);
  assert.equal(a.options.seed, 777);
});

test('acceptance: the rejected split-sacrum design is rejected, by name', () => {
  const report = acceptBodyTemplate(buildAnatomicalBodyTemplate(ADULT_P50_SPLIT_SACRUM), QUICK);
  assert.equal(report.accepted, false);
  const failed = report.stages.filter((s) => !s.passed).map((s) => s.stage);
  // All four stages see it, which is what a well-understood bad template looks
  // like: the structural rule, the analytic prediction and the measurement agree.
  assert.deepEqual(failed.sort(), ['ADMISSIBILITY-CONSISTENCY', 'AUDIT', 'PROBE', 'STRUCTURE']);
  assert.ok(
    report.stages.find((s) => s.stage === 'STRUCTURE')!.problems
      .some((p) => p.includes('5 addressable sacral levels')),
  );
});

// ---------------------------------------------------------------------------
// Attacking the gate: cases the audit and the probe do not catch.
// ---------------------------------------------------------------------------

test('acceptance: a fold the per-level audit cannot predict is still declared', () => {
  // QA-2. The per-level criterion is necessary and not sufficient: it only ever
  // tests a level against its OWN two bisector planes, while `bodyMmToLocal`
  // assigns a level by scanning the whole column. A point far enough off-axis
  // can be claimed by a non-adjacent level the criterion never considered.
  //
  // This is not a synthetic template — it is the committed
  // `anat-adult-p50-split-sacrum` preset, and the point is deterministic. S05
  // is cleared with +34 mm of margin and folds anyway.
  //
  // The defect was never that the prediction is incomplete; a cheap analytic
  // bound is allowed to be. It was that the wrong answer arrived silently, and
  // that `locallyAdmissible` was called `admissible` and read as a gate. Both
  // are fixed, and this test pins the fix: the fold is *declared*, with the
  // competing levels named, and it is not dressed up as a clamp.
  const template = buildAnatomicalBodyTemplate(ADULT_P50_SPLIT_SACRUM);
  const audit = auditBodyTemplate(template);

  const s05 = audit.levels.find((l) => l.level === 'S05')!;
  assert.ok(s05.marginMm > 0, 'precondition: the per-level criterion clears S05');
  assert.ok(!audit.violations.some((v) => v.level === 'S05'), 'precondition: S05 is not a violation');

  const mm = bodyLocalToMm(template, { level: 'S05', u: 0.02, t: 0, r: 0.95 });
  const back = bodyMmToLocal(template, mm);
  assert.equal(back.local.level, 'S01', 'precondition: this point is inside the fold');

  // Declared, not swallowed.
  assert.equal(back.flags.folded, true, 'a fold must raise flags.folded');
  const note = (back.flags.notes ?? []).join(' ');
  assert.match(note, /inadmissible/, 'the note must say the template is inadmissible here');
  assert.match(note, /S01/, 'the note must name the competing levels');
  assert.match(note, /S05/, 'the note must name the competing levels');
  // And it must say so without claiming the point left the body, which was the
  // original wrong diagnosis. This point is well inside the skin; `folded` and
  // `clamped` are different facts and conflating them tells the user their data
  // is out of range when the coordinate system is what failed.
  assert.equal(back.flags.clamped, undefined, 'a fold inside the body is not a clamp');
  assert.ok(
    !/outside the modelled body surface/.test(note),
    `a fold must not be described as leaving the body: ${note}`,
  );

  // The probe sees it even though the per-level criterion does not, which is
  // the whole reason the probe is required alongside the audit.
  const probe = measureRoundTrip(template, { samplesPerLevel: 200 });
  assert.ok(
    probe.failuresByLevel.some((f) => f.level === 'S05'),
    'the probe should observe S05 failures the per-level criterion did not predict',
  );
  assert.ok(probe.inadmissibleNotes > 0, 'and it should count the fold notes');

  // The gate rejects it. That is what the consistency stage is for.
  const report = acceptBodyTemplate(template, QUICK);
  const consistency = report.stages.find((s) => s.stage === 'ADMISSIBILITY-CONSISTENCY')!;
  assert.equal(consistency.passed, false);
  assert.ok(consistency.problems.some((p) => p.startsWith('S05:')), consistency.problems.join('\n'));
});

test('acceptance: a localised bulge folds a template the per-level audit gives 24x margin', () => {
  // The general form of QA-2, and the measure of how far the per-level
  // criterion can be from the truth. On the posterior side of L05 it concludes
  // the frame "never folds" out to infinity — true for that level's own two
  // planes, false for the column. A 250 mm posterior radius there (a gluteal
  // shelf, or a mesh that includes the thighs at hip level) folds it anyway,
  // because L01's region sweeps down and claims the point first.
  //
  // So the gate may not be the per-level criterion, however large its margin.
  const base = buildAnatomicalBodyTemplate(ADULT_P50);
  const index = base.slabs.findIndex((s) => s.label === 'L05');
  const slabs: VertebralSlab[] = base.slabs.map((s, i) =>
    i !== index
      ? s
      : {
          ...s,
          surfaceRadiiMm: s.surfaceRadiiMm.map((r, k) => {
            const t = k / s.surfaceRadiiMm.length;
            const d = Math.min(Math.abs(t - 0.5), 1 - Math.abs(t - 0.5));
            return d <= 0.0625 ? Math.max(r, 250) : r;
          }),
        },
  );
  const template: BodyTemplate = { id: 'p50-posterior-bulge-250', slabs, maxUsefulDigits: 5 };

  const audit = auditBodyTemplate(template);
  assert.equal(audit.locallyAdmissible, true, 'precondition: the audit clears this template');
  const l05 = audit.levels.find((l) => l.level === 'L05')!;
  assert.ok(l05.utilisation < 0.1, `precondition: the audit reports a large margin, got ${l05.utilisation}`);

  // The audit never even looks at the bulge: it reports the worst azimuth
  // elsewhere, because posteriorly it believes the fold radius is infinite.
  assert.ok(Math.abs(l05.worstAzimuthTurns - 0.5) > 0.1);

  // A point at r = 0.8 — 200 mm from the axis, comfortably inside a 250 mm
  // surface — is genuinely ambiguous here, and is declared so. Note it now
  // *recovers* L05: the tie is broken by proximity rather than by column order,
  // so the answer is usually right. That is not a reason to stay quiet about
  // it, because "usually right" is not a property an address can offer.
  const ambiguous = bodyMmToLocal(template, bodyLocalToMm(template, { level: 'L05', u: 0.1, t: 0.5, r: 0.8 }));
  assert.equal(ambiguous.flags.folded, true, 'the ambiguity must be declared even when resolved correctly');
  assert.equal(ambiguous.flags.clamped, undefined, 'a point inside the body is not clamped');
  const ambiguousNote = (ambiguous.flags.notes ?? []).join(' ');
  assert.match(ambiguousNote, /\d+ vertebral levels .* reach this point/);
  // Both sides of the ambiguity named, not just the one that won.
  for (const level of ['L05', 'L01']) {
    assert.ok(ambiguousNote.includes(level), `the note must name ${level}: ${ambiguousNote}`);
  }

  // Deeper in, the tie-break picks the wrong level — still declared, and still
  // not described as leaving the body.
  const wrong = bodyMmToLocal(template, bodyLocalToMm(template, { level: 'L05', u: 0.1, t: 0.5, r: 0.95 }));
  assert.notEqual(wrong.local.level, 'L05');
  assert.equal(wrong.flags.folded, true);

  const report = acceptBodyTemplate(template, QUICK);
  assert.equal(report.accepted, false, `the gate must reject this\n${formatAcceptanceReport(report)}`);
  // And it is the measurement that rejects it, not the per-level criterion —
  // which is the point of the stage existing.
  assert.equal(report.stages.find((s) => s.stage === 'AUDIT')!.passed, true);
  assert.equal(report.stages.find((s) => s.stage === 'ADMISSIBILITY-CONSISTENCY')!.passed, false);
});

test('acceptance: a duplicate slab label is caught, and only the structural stage can see it', () => {
  // Was the QA-10 characterisation test. Retired on DOG-10: the defect is the
  // *gate's*, not the library's, and the gate now rejects this template, so
  // what is worth asserting is that the structural stage is the one doing it —
  // the audit and the probe both still pass it, which is why the stage exists
  // and must not later be pruned as redundant.
  //
  // The gate cannot be audit-plus-probe alone. Relabel one slab so two share a
  // label: `findSlab` resolves to the first, so the second slab's anatomy has
  // no address, and the probe cannot see it because it only ever asks for
  // labels it read off the slabs — and the first match answers every time.
  const base = buildAnatomicalBodyTemplate(ADULT_P50);
  const index = base.slabs.findIndex((s) => s.label === 'L03');
  const template: BodyTemplate = {
    ...base,
    id: 'p50-duplicate-L02',
    slabs: base.slabs.map((s, i) => (i === index ? { ...s, label: 'L02' } : s)),
  };

  // Both existing gates are clean.
  assert.equal(auditBodyTemplate(template).locallyAdmissible, true);
  assert.equal(measureRoundTrip(template, { samplesPerLevel: 120 }).failures, 0);

  // And yet: a point in the second L02 slab encodes to an address that decodes
  // tens of millimetres away, with no flag on either call.
  const mm = bodyLocalToMm(base, { level: 'L03', u: 0.5, t: 0.25, r: 0.6 });
  const encoded = encodeBody(template, mm, 3);
  assert.deepEqual(encoded.flags, {}, 'precondition: encode is silent');
  const roundTripped = bodyLocalToMm(template, bodyMmToLocal(template, mm).local);
  const errorMm = Math.hypot(
    roundTripped[0] - mm[0],
    roundTripped[1] - mm[1],
    roundTripped[2] - mm[2],
  );
  assert.ok(errorMm > 10, `expected a large silent error, got ${errorMm.toFixed(2)} mm`);

  // The gate rejects it on the structural stage.
  const report = acceptBodyTemplate(template, QUICK);
  assert.equal(report.accepted, false);
  const structure = report.stages.find((s) => s.stage === 'STRUCTURE')!;
  assert.equal(structure.passed, false);
  assert.ok(structure.problems.some((p) => p.includes('label L02 is used by 2 slabs')));
});

test('acceptance: the gate rejects templates whose levels have no address', () => {
  // A mesh-derived template is free to call its slabs anything. If a label is
  // not an addressable ALC-1 level, that anatomy cannot be referred to at all —
  // no address can name it — and neither the audit nor the probe notices,
  // because both work off the labels the template supplies.
  //
  // `T14`, not `T13`: since DOG-9 settled the level set, `T13` is a recognised
  // count anomaly and a template realising it is legitimate (asserted just
  // below). `T14` is outside the grammar in either direction.
  const base = buildAnatomicalBodyTemplate(ADULT_P50);
  const template: BodyTemplate = {
    ...base,
    id: 'p50-unaddressable-label',
    slabs: base.slabs.map((s) => (s.label === 'T12' ? { ...s, label: 'T14' } : s)),
  };
  assert.equal(auditBodyTemplate(template).locallyAdmissible, true, 'precondition: the audit is clean');

  const report = acceptBodyTemplate(template, QUICK);
  assert.equal(report.accepted, false);
  assert.ok(
    report.stages.find((s) => s.stage === 'STRUCTURE')!.problems
      .some((p) => p.includes('T14') && p.includes('not an addressable')),
  );
});

test('acceptance: a template realising a recognised count anomaly is addressable', () => {
  // The other side of the test above, and the reason the gate checks
  // ADDRESSABLE_LEVELS rather than VERTEBRAL_LEVELS. A subject with a
  // thirteenth rib gets a template that realises T13, and that template must
  // clear STRUCTURE — rejecting it would make the anomaly set useless.
  const base = buildAnatomicalBodyTemplate(ADULT_P50);
  const thirteenRibs: BodyTemplate = {
    ...base,
    id: 'p50-thirteen-ribs',
    slabs: base.slabs.map((s) => (s.label === 'L01' ? { ...s, label: 'T13' } : s)),
  };
  const structure = acceptBodyTemplate(thirteenRibs, QUICK).stages
    .find((s) => s.stage === 'STRUCTURE')!;
  assert.ok(
    !structure.problems.some((p) => p.includes('addressable')),
    `T13 must be addressable, got: ${structure.problems.join('; ')}`,
  );
});

test('acceptance: the gate rejects a template that over-claims its own precision', () => {
  // maxUsefulDigits drives flags.overPrecise. A template claiming more digits
  // than the BD frame can express would make the honesty flag unreachable.
  const base = buildAnatomicalBodyTemplate(ADULT_P50);
  for (const maxUsefulDigits of [13, 20]) {
    const report = acceptBodyTemplate({ ...base, id: 'over-claim', maxUsefulDigits }, QUICK);
    assert.equal(report.accepted, false, `maxUsefulDigits ${maxUsefulDigits} should be rejected`);
    assert.ok(
      report.stages.find((s) => s.stage === 'STRUCTURE')!.problems
        .some((p) => p.includes('exceeds the BD frame cap')),
    );
  }
});

test('acceptance: the gate survives a template it cannot build geometry for', () => {
  // An asset pipeline will hand this gate malformed geometry. It must report,
  // not throw, or the pipeline gets a stack trace instead of a reason.
  const base = buildAnatomicalBodyTemplate(ADULT_P50);
  const cases: Array<[string, BodyTemplate]> = [
    ['no slabs', { id: 'empty', slabs: [], maxUsefulDigits: 5 }],
    [
      'zero height',
      { ...base, id: 'zero-height', slabs: base.slabs.map((s) => ({ ...s, heightMm: 0 })) },
    ],
    [
      'NaN origin',
      {
        ...base,
        id: 'nan-origin',
        slabs: base.slabs.map((s, i) => (i === 3 ? { ...s, origin: [NaN, 0, 0] as const } : s)),
      },
    ],
    [
      'a single radius sample',
      { ...base, id: 'one-sample', slabs: base.slabs.map((s) => ({ ...s, surfaceRadiiMm: [100] })) },
    ],
    [
      'a negative radius',
      {
        ...base,
        id: 'negative-radius',
        slabs: base.slabs.map((s, i) =>
          i === 2 ? { ...s, surfaceRadiiMm: s.surfaceRadiiMm.map((r, k) => (k === 0 ? -r : r)) } : s,
        ),
      },
    ],
  ];
  for (const [name, template] of cases) {
    let report;
    assert.doesNotThrow(() => { report = acceptBodyTemplate(template, QUICK); }, `${name} threw`);
    assert.equal(report!.accepted, false, `${name} should be rejected`);
    assert.ok(report!.stages.some((s) => !s.passed && s.problems.length > 0), `${name} gave no reason`);
  }
});

test('acceptance: the utilisation ceiling is a real gate, not decoration', () => {
  // An admissible-but-marginal template is not shippable: the audit is computed
  // on a sampled azimuth grid, so a utilisation of 0.99 is inside the noise.
  const marginal = buildAnatomicalBodyTemplate({
    ...ADULT_P50,
    id: 'p50-chord-sacrum-wide',
    sacralTangentFraction: 0.5,
    radialScale: 1.3,
  });
  const audit = auditBodyTemplate(marginal);
  const worst = Math.max(...audit.levels.map((l) => l.utilisation));
  assert.ok(worst > 0.95 && worst < 1.15, `expected a marginal template, utilisation ${worst}`);

  // Rejected at the default ceiling...
  assert.equal(acceptBodyTemplate(marginal, QUICK).accepted, false);
  // ...and the ceiling is what rejects it, not something else.
  const loose = acceptBodyTemplate(marginal, { ...QUICK, maxUtilisation: 1.5 });
  const auditStage = loose.stages.find((s) => s.stage === 'AUDIT')!;
  if (audit.locallyAdmissible) assert.equal(auditStage.passed, true, 'a loose ceiling should clear the audit stage');
});

test('acceptance: a fold that displaces rather than duplicates is declared too', () => {
  // Was the QA-13 characterisation test, which asserted `flags: {}` here.
  //
  // The gap half of the non-partition. Spec §4 describes both halves: adjacent
  // regions "overlap in a wedge on the convex side and leave a gap on the
  // concave side". The bisector-plane design removes that for *adjacent*
  // levels, and QA-2's fix detected the overlap half by counting how many
  // levels claim a point. Where the map folds, the regions globally are neither
  // a partition nor merely overlapping: there is also territory whose sole
  // claimant is some *other* level. One claimant, so the claim-counting
  // detector was correctly quiet — and the answer was a different vertebra with
  // no flag at all.
  //
  // The fix is not a second detector beside the first. Both halves are one
  // fact — the inverse is not a function here — and one question finds both:
  // does any OTHER level have an in-body address for this point. See
  // `levelsAddressing`.
  const template = buildAnatomicalBodyTemplate(ADULT_P50_SPLIT_SACRUM);
  const worstAzimuth = 0.9917;
  const decode = (r: number) =>
    bodyMmToLocal(template, bodyLocalToMm(template, { level: 'S02', u: 0.5, t: worstAzimuth, r }));

  // The reported case: displaced a whole level, and now flagged, with the level
  // whose address was taken over named in the note.
  const back = decode(0.76);
  assert.equal(back.local.level, 'S01', 'precondition: this point is displaced a whole level');
  assert.equal(back.flags.folded, true, 'the displacement half must be declared');
  assert.equal(back.flags.clamped, undefined, 'a point inside the body is not clamped');
  const note = (back.flags.notes ?? []).join(' ');
  assert.ok(note.includes('S02'), `the note must name the displaced level: ${note}`);
  assert.ok(!/outside the modelled body surface/.test(note), note);

  // And it is one question answering for both halves, not two detectors: S02's
  // address for the point exists, is inside S02's skin, and is invisible to a
  // claim count, which names S01 alone.
  const mm = bodyLocalToMm(template, { level: 'S02', u: 0.5, t: worstAzimuth, r: 0.76 });
  assert.deepEqual(levelsClaiming(template, mm), ['S01'], 'precondition: one claimant, hence silent before');
  const addressing = levelsAddressing(template, mm);
  assert.deepEqual(addressing.map((a) => a.level).sort(), ['S01', 'S02']);
  const displaced = addressing.find((a) => a.level === 'S02')!;
  assert.equal(displaced.claims, false, 'S02 reaches the point with its planes already crossed');
  assert.ok(Math.abs(displaced.at.r - 0.76) < 1e-9, `S02's own address is recovered: r=${displaced.at.r}`);

  // The four regimes along this ray, asserted individually. Correctness is NOT
  // monotone in radius — right, wrong, right again, then wrong — which is why
  // no single "fold radius" describes the folded set and why
  // `admissibility.test.ts` asserts a one-sided bound. The flag covers all four.
  const REGIMES: Array<[number, string, boolean]> = [
    [0.60, 'S02', false], // inside everything; correct and quiet
    [0.68, 'S05', true], //  overlap: two claimants, resolved to the wrong one
    [0.72, 'S02', true], //  correct again — the non-monotonicity
    [0.76, 'S01', true], //  displacement: one claimant, the wrong level
  ];
  for (const [r, level, folded] of REGIMES) {
    const got = decode(r);
    assert.equal(got.local.level, level, `at r=${r} the ray decodes to ${got.local.level}, not ${level}`);
    assert.equal(got.flags.folded ?? false, folded, `at r=${r} folded should be ${folded}`);
  }
  // Correct-but-flagged is the right answer at r=0.72, not an over-report: S03
  // also has an in-body address for that point, so the address IS ambiguous
  // even though the tie-break lands on the level that generated it.
  const recovered = decode(0.72);
  assert.ok(Math.abs(recovered.local.r - 0.72) < 1e-6, 'r=0.72 still round-trips exactly');
  assert.ok(
    levelsAddressing(template, bodyLocalToMm(template, { level: 'S02', u: 0.5, t: worstAzimuth, r: 0.72 }))
      .length > 1,
    'a flag at r=0.72 would be an over-report if only one level addressed the point',
  );

  // The gate still rejects the template. The flag is honesty at runtime; it is
  // not a licence to ship a folding template.
  const report = acceptBodyTemplate(template, QUICK);
  assert.equal(report.accepted, false);
  assert.equal(report.stages.find((s) => s.stage === 'PROBE')!.passed, false);
});

test('acceptance: on a folding template no point answers with the wrong level unflagged', () => {
  // The guarantee the QA-13 characterisation test stood in for, stated where it
  // is hard to hold: on the templates that DO fold, rather than on the presets
  // that do not. "No shipping preset is silently wrong" is below and is the
  // property a consumer depends on; this is the property that makes it a
  // property of the frame rather than of the gate.
  //
  // Walked on each level's own azimuth KNOTS, the way `scanBodyTemplateFolds`
  // does, and not on a round grid of its own choosing: the surface radii are
  // interpolated between knots, so a local maximum can only sit on one, and
  // QA-13's own report shows a uniform grid stepping over the regime
  // boundaries. `perKnot` subdivisions keep the between-knot interior covered.
  const TOL = 1e-6;
  const PER_KNOT = 3;
  let probed = 0;
  let wrong = 0;
  let silent = 0;
  const examples: string[] = [];

  for (const { params } of FOLD_REGRESSIONS) {
    const template = buildAnatomicalBodyTemplate(params);
    for (const slab of template.slabs) {
      const knots = slab.surfaceRadiiMm.length;
      for (let k = 0; k < knots; k += 1) {
        for (let e = 0; e < PER_KNOT; e += 1) {
          const t = (k + e / PER_KNOT) / knots;
          for (const u of [0.02, 0.5, 0.98]) {
            for (const r of [0.25, 0.5, 0.75, 0.9, 0.995]) {
              probed += 1;
              let back;
              try {
                back = bodyMmToLocal(template, bodyLocalToMm(template, { level: slab.label, u, t, r }));
              } catch {
                continue; // a throw is loud, which is the point
              }
              let dt = Math.abs(back.local.t - t);
              dt = Math.min(dt, 1 - dt);
              const good = back.local.level === slab.label
                && Math.abs(back.local.u - u) < TOL
                && dt < TOL
                && Math.abs(back.local.r - r) < TOL;
              if (good) continue;
              wrong += 1;
              if (!back.flags.folded && !back.flags.clamped) {
                silent += 1;
                if (examples.length < 5) {
                  examples.push(
                    `${params.id} ${slab.label} u=${u} t=${t.toFixed(4)} r=${r} -> `
                    + `${back.local.level} flags=${JSON.stringify(back.flags)}`,
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  assert.ok(probed > 80000, `only ${probed} points probed`);
  // The templates must really fold, or the assertion below is vacuous.
  assert.ok(wrong > 100, `expected material folding across the fixtures, got ${wrong} wrong answers`);
  assert.equal(silent, 0, `${silent}/${wrong} wrong answers carried no flag:\n  ${examples.join('\n  ')}`);
});

test('acceptance: the round-trip check costs nothing on an admissible template', () => {
  // The other half of the detector being honest: it must not cry fold on a
  // template that does not fold. A detector that flags the presets would be
  // worse than the silence it replaced, because the flag would stop meaning
  // anything — and it would also make the check expensive, since the cheap
  // screen is exactly "has any level's plane pair crossed before this point".
  for (const params of PRESETS) {
    const template = buildAnatomicalBodyTemplate(params);
    let flagged = 0;
    let probed = 0;
    for (const slab of template.slabs) {
      const knots = slab.surfaceRadiiMm.length;
      for (let k = 0; k < knots; k += 1) {
        for (const u of [0.02, 0.5, 0.98]) {
          for (const r of [0.5, 0.9, 0.995]) {
            probed += 1;
            const back = bodyMmToLocal(template, bodyLocalToMm(template, { level: slab.label, u, t: k / knots, r }));
            if (back.flags.folded) flagged += 1;
          }
        }
      }
    }
    assert.ok(probed > 1000, `${params.id}: only ${probed} points probed`);
    assert.equal(flagged, 0, `${params.id}: ${flagged}/${probed} points falsely declared folded`);
  }
});

test('acceptance: every fold the scan calls `lost` is flagged at runtime', () => {
  // The scan's three kinds used to split by whether a runtime caller could see
  // them: `ambiguous` was visible through `flags.folded`, `lost` was not, and
  // that asymmetry was QA-13. It is gone, and this is the test that keeps it
  // gone — stated over the scan's own site list so a new fold kind cannot be
  // added without confronting it.
  let lost = 0;
  for (const { params } of FOLD_REGRESSIONS) {
    const template = buildAnatomicalBodyTemplate(params);
    const scan = scanBodyTemplateFolds(template);
    assert.equal(scan.sound, false, `precondition: ${params.id} must fold`);
    for (const site of scan.sites) {
      const mm = bodyLocalToMm(template, { level: site.level, ...site.at });
      const back = bodyMmToLocal(template, mm);
      assert.equal(
        back.flags.folded,
        true,
        `${params.id}: a ${site.kind} site at ${site.level} u=${site.at.u} t=${site.at.t} `
        + `r=${site.at.r} decodes as ${back.local.level} with flags ${JSON.stringify(back.flags)}`,
      );
      if (site.kind === 'lost') lost += 1;
    }
  }
  assert.ok(lost > 0, 'no `lost` site was exercised, so this test cannot see the defect it pins');
});

test('acceptance: no shipping preset ever answers with the wrong level unflagged', () => {
  // The reason QA-13 is Medium and not High: it needs a template that folds,
  // and the gate rejects those. This is the assertion that keeps it that way —
  // it is the property a consumer actually depends on, stated over every
  // preset, and it would go red if a fold ever reached a shipped template.
  const TOL = 1e-6;
  for (const params of PRESETS) {
    const template = buildAnatomicalBodyTemplate(params);
    let silent = 0;
    let probed = 0;
    for (const slab of template.slabs) {
      const knots = slab.surfaceRadiiMm.length;
      for (let k = 0; k < knots; k += 1) {
        for (const u of [0.02, 0.5, 0.98]) {
          for (let j = 1; j <= 10; j += 1) {
            const r = (j / 10) * 0.995;
            const t = k / knots;
            probed += 1;
            try {
              const back = bodyMmToLocal(template, bodyLocalToMm(template, { level: slab.label, u, t, r }));
              let dt = Math.abs(back.local.t - t);
              dt = Math.min(dt, 1 - dt);
              const good = back.local.level === slab.label
                && Math.abs(back.local.u - u) < TOL
                && dt < TOL
                && Math.abs(back.local.r - r) < TOL;
              // A wrong answer is tolerable only if it says so.
              if (!good && !back.flags.folded && !back.flags.clamped) silent += 1;
            } catch {
              // A throw is loud, which is the point.
            }
          }
        }
      }
    }
    assert.ok(probed > 5000, `${params.id}: only ${probed} points probed`);
    assert.equal(silent, 0, `${params.id}: ${silent}/${probed} points answered with the wrong level unflagged`);
  }
});

test('acceptance: the gate rejects a folding template the round trip calls clean', () => {
  // The acid test for what the gate actually gates on, and the reason stage
  // ADMISSIBILITY-CONSISTENCY cannot be pruned as redundant with PROBE.
  //
  // `ADULT_HYPERKYPHOTIC_SHORT_WIDE` is the committed fixture from DOG-9: with
  // a tight kyphosis the bisector planes fan out anteriorly, so an
  // upper-thoracic level's region sweeps down and swallows anterior skin
  // several levels below. It clears the per-level criterion with 7.8 mm to
  // spare and folds at 597 of 54 000 skin points.
  //
  // Both of the obvious gates let it through:
  //   - `locallyAdmissible` is true, because no level violates its OWN planes.
  //   - `measureRoundTrip().failures` is 0 at this sampling, because
  //     `bodyMmToLocal` picks the nearest claimant and that repairs the decode.
  // The point is still denoted by two addresses in two different levels. That
  // is the defect, and only the claim-count scan sees it.
  const template = buildAnatomicalBodyTemplate(ADULT_HYPERKYPHOTIC_SHORT_WIDE);

  const audit = auditBodyTemplate(template);
  assert.equal(audit.locallyAdmissible, true, 'precondition: the per-level criterion clears it');
  assert.ok(audit.worstMarginMm > 0, `precondition: positive margin, got ${audit.worstMarginMm}`);

  const scan = scanBodyTemplateFolds(template);
  assert.equal(scan.sound, false, 'precondition: it folds');
  assert.ok(scan.foldedPoints > 100, `expected a material fold, got ${scan.foldedPoints} points`);

  const report = acceptBodyTemplate(template, QUICK);
  assert.equal(report.accepted, false, `the gate must reject this\n${formatAcceptanceReport(report)}`);

  const consistency = report.stages.find((s) => s.stage === 'ADMISSIBILITY-CONSISTENCY')!;
  assert.equal(consistency.passed, false, 'the scan stage must be the one that rejects it');
  assert.equal(consistency.measurements.sound, 'false');
  // Named, with the competing levels, so the asset pipeline can act on it.
  assert.ok(
    consistency.problems.some((p) => /Claimed by \[/.test(p)),
    consistency.problems.join('\n'),
  );

  // And the demonstration that the round trip alone would have passed it. If
  // this ever starts failing because PROBE also rejects, that is fine — but
  // the assertion above is the one that must keep holding.
  const probe = report.stages.find((s) => s.stage === 'PROBE')!;
  assert.equal(
    Number(probe.measurements.failures),
    0,
    'if the round trip now catches this too, the nearest-claimant repair has changed; the scan stage '
      + 'is still the gate',
  );
});
