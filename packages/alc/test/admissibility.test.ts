/**
 * Template admissibility, measured rather than argued.
 *
 * The `BD` frame is a tubular neighbourhood of the spinal curve, so it folds
 * where the body is thicker than the local radius of curvature *on the concave
 * side*. These tests establish three things the plan previously only guessed
 * at:
 *
 *   1. the constraint does not bind at the lumbar lordosis, because there the
 *      thick tissue is on the convex (anterior) side;
 *   2. it binds hard at the sacrum if the fused sacrum is cut into five short
 *      addressable levels, putting 1-3% of body volume — all pelvis — inside a
 *      fold; one sacral level removes it entirely;
 *   3. with one sacral level, the binding site moves to the L5/S1 kink unless
 *      that level's axis follows the upper sacral endplate rather than the
 *      sacrum's chord — which is the difference between a frame that holds for
 *      any human girth and one that folds past about a 110 cm waist;
 *   4. the exact discrete criterion classifies templates correctly in both
 *      directions, while the old worst-case-radius criterion condemns ordinary
 *      bodies that round-trip perfectly.
 *
 * Together, 2 and 3 are spec requirements on every body template. They are
 * cheap to satisfy and impossible to retrofit, because changing the level set
 * after addresses have been issued invalidates them.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  auditBodyTemplate,
  auditBodyTemplateWorstCase,
  bodyLocalToMm,
  bodyMmToLocal,
  formatFoldScan,
  levelsClaiming,
  scanBodyTemplateFolds,
  spineGeometry,
  type BodyTemplate,
} from '../src/index.ts';
import {
  ADULT_HYPERKYPHOTIC_SHORT_WIDE,
  ADULT_LARGE_GIRTH,
  ADULT_P50,
  ADULT_P50_SPLIT_SACRUM,
  FOLD_REGRESSIONS,
  PRESETS,
  buildAnatomicalBodyTemplate,
} from '../src/testing/anatomicalTemplates.ts';
import { measureRoundTrip } from '../src/testing/admissibilityProbe.ts';

const TOL = 1e-6;

/** Does a single dimensionless point survive mm and back, and what did it say? */
function probeRoundTrip(
  template: BodyTemplate,
  level: string,
  u: number,
  az: number,
  r: number,
): { ok: boolean; declared: boolean; became: string } {
  try {
    const mm = bodyLocalToMm(template, { level, u, t: az, r });
    const back = bodyMmToLocal(template, mm);
    let dt = Math.abs(back.local.t - az);
    dt = Math.min(dt, 1 - dt);
    const ok =
      back.local.level === level &&
      Math.abs(back.local.u - u) < TOL &&
      dt < TOL &&
      Math.abs(back.local.r - r) < TOL;
    return {
      ok,
      declared: back.flags.folded === true,
      became: `level ${back.local.level} (u=${back.local.u.toFixed(5)}, r=${back.local.r.toFixed(5)})`,
    };
  } catch (e) {
    return { ok: false, declared: false, became: `throw ${(e as { code?: string }).code ?? 'unknown'}` };
  }
}

/** Does a single dimensionless point survive mm and back? */
function roundTrips(template: BodyTemplate, level: string, u: number, az: number, r: number): boolean {
  return probeRoundTrip(template, level, u, az, r).ok;
}

/**
 * Fraction of body volume where the frame is ambiguous. Weighted by the volume
 * element (proportional to r * rho^2 * segment length), because counting raw
 * samples in the dimensionless cube would over-weight the axis.
 */
function ambiguousVolumeFraction(template: BodyTemplate): number {
  const g = spineGeometry(template);
  let bad = 0;
  let all = 0;
  template.slabs.forEach((slab, i) => {
    const n = slab.surfaceRadiiMm.length;
    for (let a = 0; a < 48; a += 1) {
      const az = (a + 0.5) / 48;
      const rho = slab.surfaceRadiiMm[Math.round(az * n) % n];
      for (let k = 0; k < 24; k += 1) {
        const r = (k + 0.5) / 24;
        const w = r * rho * rho * g.lens[i];
        all += w;
        if (!roundTrips(template, slab.label, 0.5, az, r)) bad += w;
      }
    }
  });
  return bad / all;
}

// ---------------------------------------------------------------------------
test('admissibility: every anatomical preset is admissible and round-trips exactly', () => {
  for (const params of PRESETS) {
    const template = buildAnatomicalBodyTemplate(params);
    const audit = auditBodyTemplate(template);
    assert.equal(
      audit.locallyAdmissible,
      true,
      `${params.id} should be admissible, violations: ${JSON.stringify(audit.violations)}`,
    );
    const probe = measureRoundTrip(template, { samplesPerLevel: 120 });
    assert.equal(probe.failures, 0, `${params.id} had ${probe.failures}/${probe.samples} round-trip failures`);
    assert.equal(probe.inadmissibleNotes, 0);
    assert.ok(probe.worstGoodErrorMm < 1e-6, `${params.id} inverse drifted by ${probe.worstGoodErrorMm} mm`);
  }
});

test('admissibility: the lumbar lordosis is not where the constraint binds', () => {
  // The feared case: a wide waist on an average lumbar curve. The thick tissue
  // is anterior, the curve is concave posterior, so the two never meet.
  const template = buildAnatomicalBodyTemplate(ADULT_LARGE_GIRTH);
  const audit = auditBodyTemplate(template);
  const lumbar = audit.levels.filter((l) => l.level.startsWith('L'));
  assert.equal(lumbar.length, 5);
  for (const level of lumbar) {
    assert.ok(level.marginMm > 0, `${level.level} margin ${level.marginMm} mm`);
  }
  // L01..L04 bind on the posterior side (0.5 turns), where there is little
  // tissue — not anteriorly where the waist is. L05 is governed by the
  // lumbosacral kink instead and is covered by its own test below.
  for (const level of lumbar.slice(0, 4)) {
    assert.ok(
      Math.abs(level.worstAzimuthTurns - 0.5) < 0.1,
      `${level.level} binds at azimuth ${level.worstAzimuthTurns}, expected the posterior side`,
    );
    // The binding radius is far below the widest radius, which is exactly why
    // the worst-case test was wrong.
    assert.ok(level.radiusAtWorstMm < level.maxRadiusMm * 0.6);
    assert.ok(level.utilisation < 0.75, `${level.level} utilisation ${level.utilisation}`);
  }
});

test('admissibility: a collapsed sacral level must follow the upper endplate', () => {
  // Taking the single sacral level's axis from the sacrum's own chord puts a
  // ~30 degree kink at L5/S1, and that kink — not the sacrum, and not the
  // lumbar lordosis — then becomes the limit on how wide a body may be.
  const girths = [1.0, 1.3, 1.6];
  for (const radialScale of girths) {
    const chord = buildAnatomicalBodyTemplate({
      ...ADULT_P50,
      id: `chord-axis-${radialScale}`,
      sacralTangentFraction: 0.5,
      radialScale,
    });
    const endplate = buildAnatomicalBodyTemplate({
      ...ADULT_P50,
      id: `endplate-axis-${radialScale}`,
      radialScale,
    });
    const worst = (t) =>
      auditBodyTemplate(t).levels.reduce((m, l) => Math.max(m, l.utilisation), 0);
    assert.ok(
      worst(endplate) < worst(chord) * 0.6,
      `endplate axis should relieve the kink: ${worst(endplate)} vs ${worst(chord)}`,
    );
    assert.equal(measureRoundTrip(endplate, { samplesPerLevel: 200 }).failures, 0);
  }

  // And the chord convention genuinely folds a large body, it is not merely
  // flagged conservatively.
  const chordLarge = buildAnatomicalBodyTemplate({
    ...ADULT_P50,
    id: 'chord-axis-large',
    sacralTangentFraction: 0.5,
    radialScale: 1.45,
  });
  const chordAudit = auditBodyTemplate(chordLarge);
  assert.equal(chordAudit.locallyAdmissible, false);
  assert.deepEqual(chordAudit.violations.map((v) => v.level), ['L05']);
  assert.ok(measureRoundTrip(chordLarge, { samplesPerLevel: 200 }).failures > 0);
});

test('admissibility: cutting the fused sacrum into five levels folds the pelvis', () => {
  const split = buildAnatomicalBodyTemplate(ADULT_P50_SPLIT_SACRUM);
  const audit = auditBodyTemplate(split);
  assert.equal(audit.locallyAdmissible, false);
  assert.ok(audit.violations.length >= 3, `violations: ${audit.violations.length}`);
  assert.ok(
    audit.violations.every((v) => v.level.startsWith('S')),
    `violations should be sacral only, got ${audit.violations.map((v) => v.level).join(',')}`,
  );
  // Concavity faces anteriorly here — into the pelvis, where there is a lot of
  // tissue — which is exactly why this case bites and the lumbar one does not.
  for (const v of audit.violations) {
    assert.ok(Math.min(v.worstAzimuthTurns, 1 - v.worstAzimuthTurns) < 0.1);
  }

  const probe = measureRoundTrip(split, { samplesPerLevel: 120 });
  assert.ok(probe.failures > 0, 'the fold must actually be observable, not just predicted');
  assert.ok(probe.failuresByLevel.every((f) => f.level.startsWith('S')));

  const ambiguous = ambiguousVolumeFraction(split);
  assert.ok(ambiguous > 0.005, `expected a material ambiguous volume, got ${(ambiguous * 100).toFixed(2)}%`);

  // One sacral level, same body: the problem is gone, not merely smaller.
  const fused = buildAnatomicalBodyTemplate(ADULT_P50);
  assert.equal(ambiguousVolumeFraction(fused), 0);
});

test('admissibility: the exact criterion is a safe bound, and binds where it says', () => {
  // What the gate promises is a whole-template property: if the audit passes,
  // nothing folds anywhere. Per-level margins do not compose on a template
  // that already fails, because points displaced by one level's fold land in
  // its neighbours — so "admissible" is asserted template-wide, and the fold
  // location is asserted only where the audit says there is one.
  for (const params of PRESETS) {
    const template = buildAnatomicalBodyTemplate(params);
    const audit = auditBodyTemplate(template);
    assert.equal(audit.locallyAdmissible, true, params.id);
    // Probe the skin itself, all the way round, at three axial positions.
    for (const level of audit.levels) {
      for (let a = 0; a < 36; a += 1) {
        for (const u of [0.02, 0.5, 0.98]) {
          assert.ok(
            roundTrips(template, level.level, u, a / 36, 0.995),
            `${params.id} ${level.level}: skin point at azimuth ${a / 36} did not round-trip`,
          );
        }
      }
    }
  }

  // And where the audit reports a fold, the fold is really there — at or
  // before the predicted radius.
  //
  // This is a SAFE-BOUND claim, and deliberately only that. An earlier version
  // asserted sharpness from both sides: that the point still round-trips just
  // inside the predicted radius and fails just outside. The outer direction is
  // a theorem — past its own fold radius a level's two bounding planes have
  // crossed, so it cannot bracket its own point and the loss is certain. The
  // inner direction is not, for two independent reasons:
  //
  //   1. DOG-9 finding 1: a level can lose a point well inside its own fold
  //      radius to a DISTANT level that also claims it. `S03` just inside its
  //      own radius is claimed by `S05`, five levels away.
  //   2. QA-13: failure is not monotonic in radius. There are several regimes
  //      between the axis and the skin, so there is no single threshold for a
  //      two-sided claim to be sharp about in the first place.
  //
  // So the honest assertion is that the prediction is never optimistic:
  // failure begins at or before it. Replacing "within 5% from both sides" with
  // this is a weaker claim, and the weaker claim is the true one. (The wording
  // in docs/alc-1-admissibility.md §4 still says "not merely a safe bound";
  // DOG-18 carries that documentation fix along with QA-13 itself.)
  for (const params of [ADULT_P50_SPLIT_SACRUM, { ...ADULT_P50, id: 'chord', sacralTangentFraction: 0.5, radialScale: 1.45 }]) {
    const template = buildAnatomicalBodyTemplate(params);
    for (const level of auditBodyTemplate(template).violations) {
      const foldRatio = 1 / level.utilisation;
      assert.ok(foldRatio < 1);

      // Walk outward and find where this level actually starts losing points.
      let firstFailure = Infinity;
      for (let k = 1; k <= 400; k += 1) {
        const r = (k / 400) * 0.9999;
        if (!roundTrips(template, level.level, 0.5, level.worstAzimuthTurns, r)) {
          firstFailure = r;
          break;
        }
      }

      assert.ok(
        Number.isFinite(firstFailure),
        `${params.id} ${level.level}: the audit reports a fold but no radius on this azimuth fails, `
        + 'so the prediction is not merely conservative — it is wrong',
      );
      assert.ok(
        firstFailure <= foldRatio * 1.05,
        `${params.id} ${level.level}: predicted fold at r=${foldRatio.toFixed(3)} but the level held `
        + `to r=${firstFailure.toFixed(3)}, so the prediction is optimistic rather than safe`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Sound fold detection (DOG-9 findings 1 and 2)
// ---------------------------------------------------------------------------

test('fold scan: no skin point of a shipped preset is claimed by anything but its own level', () => {
  // The SOUND criterion, and the one the per-level audit cannot express:
  // `levelsClaiming(bodyLocalToMm(L, ...)) === [L]` at every skin point. This
  // is what "the levels tile space" has to mean in practice, and it is the
  // property the whole frame rests on — if it fails, two addresses denote one
  // millimetre point and `encode(locate(a)) === a` is no longer a guarantee.
  for (const params of PRESETS) {
    const template = buildAnatomicalBodyTemplate(params);
    const scan = scanBodyTemplateFolds(template);
    assert.equal(scan.sound, true, `${params.id}:\n${formatFoldScan(scan)}`);
    assert.equal(scan.foldedPoints, 0, params.id);
    // The scan must have done real work, not passed vacuously on an empty grid.
    assert.ok(scan.probed > 10000, `${params.id}: only ${scan.probed} points probed`);
    assert.ok(formatFoldScan(scan).includes('SOUND'));
  }
});

test('fold scan: it catches the non-local fold the per-level audit clears', () => {
  // DOG-9 finding 1, as a regression fixture. This is the template that proves
  // the per-level criterion is not a gate: it clears with margin to spare and
  // folds anyway, because the fold is between a level and one SEVERAL levels
  // away, which no per-level condition can see.
  const template = buildAnatomicalBodyTemplate(ADULT_HYPERKYPHOTIC_SHORT_WIDE);

  const audit = auditBodyTemplate(template);
  assert.equal(audit.locallyAdmissible, true, 'precondition: the cheap criterion clears it');
  assert.ok(audit.worstMarginMm > 0, `precondition: positive margin, got ${audit.worstMarginMm}`);

  // And yet.
  const scan = scanBodyTemplateFolds(template);
  assert.equal(scan.sound, false, 'the scan must catch what the audit missed');
  assert.ok(scan.foldedPoints > 100, `expected a material fold, got ${scan.foldedPoints}`);

  // The fold is genuinely non-local: some site names two levels that are not
  // neighbours, which is precisely the case the audit cannot model.
  const labels = template.slabs.map((s) => s.label);
  const nonLocal = scan.sites.filter(
    (s) => s.claimedBy.length > 1
      && Math.max(...s.claimedBy.map((l) => Math.abs(labels.indexOf(l) - labels.indexOf(s.level)))) > 1,
  );
  assert.ok(
    nonLocal.length > 0,
    `expected a non-adjacent claimant:\n${formatFoldScan(scan)}`,
  );

  // The thoracic levels are where it bites, per the review's measurement.
  assert.ok(
    scan.foldsByLevel.some((f) => f.level.startsWith('T')),
    `expected thoracic folds, got ${scan.foldsByLevel.map((f) => f.level).join(',')}`,
  );
});

test('fold scan: every fold regression fixture is caught, and the audit alone is not enough', () => {
  // The whole rejection set in one place. The `auditCatchesIt: false` row is
  // the reason this suite cannot gate on `locallyAdmissible`.
  let auditMissed = 0;
  for (const { params, auditCatchesIt, why } of FOLD_REGRESSIONS) {
    const template = buildAnatomicalBodyTemplate(params);
    const audit = auditBodyTemplate(template);
    const scan = scanBodyTemplateFolds(template);

    assert.equal(scan.sound, false, `${params.id} (${why}) must be caught by the scan`);
    assert.equal(
      audit.locallyAdmissible,
      !auditCatchesIt,
      `${params.id}: the per-level audit's verdict changed; update FOLD_REGRESSIONS`,
    );
    if (!auditCatchesIt) auditMissed += 1;
  }
  assert.ok(auditMissed > 0, 'at least one fixture must defeat the per-level audit, or the scan is redundant');
});

test('fold reporting: a fold is declared, names every claimant, and picks the nearest', () => {
  // DOG-9 finding 2. The note used to be unreachable: it lived in the branch
  // where NO level claims a point, and folding produces DOUBLY claimed points.
  //
  // The "nearest" half needs a site where nearest and most-cranial actually
  // differ, or it would pass under the old first-match rule too. Both folding
  // fixtures are searched for one, and the test fails if neither has any —
  // that would mean the distinction had become untestable.
  const distanceTo = (template: BodyTemplate, label: string, mm: readonly number[]): number => {
    const g = spineGeometry(template);
    const i = template.slabs.findIndex((s) => s.label === label);
    const rel = [mm[0] - g.nodes[i][0], mm[1] - g.nodes[i][1], mm[2] - g.nodes[i][2]] as const;
    const along = Math.min(
      g.lens[i],
      Math.max(0, rel[0] * g.dirs[i][0] + rel[1] * g.dirs[i][1] + rel[2] * g.dirs[i][2]),
    );
    return Math.hypot(
      rel[0] - g.dirs[i][0] * along,
      rel[1] - g.dirs[i][1] * along,
      rel[2] - g.dirs[i][2] * along,
    );
  };

  let discriminating = 0;
  let checked = 0;

  for (const params of [ADULT_P50_SPLIT_SACRUM, ADULT_HYPERKYPHOTIC_SHORT_WIDE]) {
    const template = buildAnatomicalBodyTemplate(params);
    const scan = scanBodyTemplateFolds(template);
    const ambiguous = scan.sites.filter((s) => s.kind === 'ambiguous');
    assert.ok(ambiguous.length > 0, `${params.id}: expected an ambiguous site\n${formatFoldScan(scan)}`);

    for (const site of ambiguous) {
      const mm = bodyLocalToMm(template, {
        level: site.level,
        u: site.at.u,
        t: site.at.t,
        r: site.at.r,
      });
      const claimants = levelsClaiming(template, mm);
      if (claimants.length < 2) continue;
      checked += 1;

      const back = bodyMmToLocal(template, mm);
      assert.equal(back.flags.folded, true, `${params.id} ${site.level}: the fold must be declared`);

      const note = (back.flags.notes ?? []).join(' ');
      // Every competing level is named, not just the one that won.
      for (const level of claimants) {
        assert.ok(note.includes(level), `the note must name ${level}: ${note}`);
      }
      // And it must not blame the body for a failure of the coordinate system.
      assert.ok(
        !/outside the modelled body surface/.test(note),
        `a fold must not be reported as leaving the body: ${note}`,
      );

      // The nearest claimant wins, not the most cranial.
      const nearest = claimants.reduce((a, b) =>
        (distanceTo(template, b, mm) < distanceTo(template, a, mm) ? b : a));
      assert.equal(
        back.local.level,
        nearest,
        `${params.id} ${site.level}: claimed by [${claimants.join(',')}], nearest is ${nearest}`,
      );
      if (nearest !== claimants[0]) discriminating += 1;
    }
  }

  assert.ok(checked > 0, 'no ambiguous site was exercised');
  assert.ok(
    discriminating > 0,
    'every ambiguous site had its nearest claimant also be its most cranial, so this test '
    + 'cannot tell the new rule from the first-match scan it replaced',
  );
});

test('fold reporting: inadmissibleNotes is a real counter, non-zero on a folding template', () => {
  // The counter used to watch a note that could not be emitted, so
  // `assert.equal(probe.inadmissibleNotes, 0)` held on every template —
  // including one with 60 observed round-trip failures. It read as "no
  // inadmissibility detected" and meant nothing.
  const folding = buildAnatomicalBodyTemplate(ADULT_P50_SPLIT_SACRUM);
  const probe = measureRoundTrip(folding, { samplesPerLevel: 200 });
  assert.ok(probe.failures > 0, 'precondition: this template folds');
  assert.ok(
    probe.inadmissibleNotes > 0,
    'the fold note must be reachable, or the counter is decoration again',
  );

  // And it stays silent where there is nothing to report, so it is a signal
  // rather than noise. This is the assertion that was previously vacuous.
  for (const params of PRESETS) {
    const clean = measureRoundTrip(buildAnatomicalBodyTemplate(params), { samplesPerLevel: 120 });
    assert.equal(clean.inadmissibleNotes, 0, params.id);
    assert.equal(clean.failures, 0, params.id);
  }
});

test('admissibility: the superseded worst-case criterion condemns usable bodies', () => {
  // Kept as a test rather than a comment so the regression cannot come back.
  const template = buildAnatomicalBodyTemplate(ADULT_LARGE_GIRTH);
  const worstCase = auditBodyTemplateWorstCase(template);
  const directional = auditBodyTemplate(template);

  assert.equal(worstCase.locallyAdmissible, false);
  assert.equal(directional.locallyAdmissible, true);

  const falseAlarms = worstCase.violations.filter(
    (v) => !directional.violations.some((d) => d.level === v.level),
  );
  assert.ok(falseAlarms.length >= 5, 'expected the worst-case test to over-reject');
  for (const level of falseAlarms) {
    // Probe the skin itself, in every direction that could possibly fold.
    for (const az of [0, 0.25, 0.5, 0.75, level.worstAzimuthTurns]) {
      assert.ok(
        roundTrips(template, level.level, 0.5, az, 0.9995),
        `${level.level} was condemned by the worst-case test but round-trips at the skin`,
      );
    }
  }
});

test('admissibility: the anatomical builder puts the spinal apices where they belong', () => {
  // Guards the sign of each region's tangent turn. If a lordosis were built
  // with the wrong sign every admissibility result above would be meaningless.
  const template = buildAnatomicalBodyTemplate(ADULT_P50);
  const y = (label: string): number => {
    const slab = template.slabs.find((s) => s.label === label);
    assert.ok(slab, `missing ${label}`);
    return slab.origin[1];
  };
  // Each region bulges the way it should, with its apex strictly inside the
  // region. Asserted per region rather than at a named level, because the
  // regional turns are distributed uniformly and that places each apex within
  // a level or two of the textbook one, not exactly on it.
  const apex = (prefix: string, sense: 1 | -1): string =>
    template.slabs
      .filter((s) => s.label.startsWith(prefix))
      .reduce((best, s) => (sense * s.origin[1] > sense * best.origin[1] ? s : best)).label;

  assert.equal(apex('L', 1), 'L03');
  assert.ok(y('L03') > y('T12') && y('L03') > y('S01'), 'lumbar apex should be anterior');
  assert.equal(apex('T', -1), 'T05');
  assert.ok(y('T05') < y('C07') && y('T05') < y('L01'), 'thoracic apex should be posterior');
  assert.ok(y('C03') > y('C07'), 'cervical lordosis should be convex anterior');

  // Sagittally balanced: the top of the column sits over the bottom.
  const height = template.slabs[0].origin[2] - template.slabs.at(-1).origin[2];
  assert.ok(Math.abs(y('C01') - y('S01')) < 0.05 * height, 'column should be plumb');
  // And the column descends monotonically.
  for (let i = 1; i < template.slabs.length; i += 1) {
    assert.ok(template.slabs[i].origin[2] < template.slabs[i - 1].origin[2]);
  }
});
