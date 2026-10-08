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
  spineGeometry,
  type BodyTemplate,
} from '../src/index.ts';
import {
  ADULT_LARGE_GIRTH,
  ADULT_P50,
  ADULT_P50_SPLIT_SACRUM,
  PRESETS,
  buildAnatomicalBodyTemplate,
} from '../src/testing/anatomicalTemplates.ts';
import { measureRoundTrip } from '../src/testing/admissibilityProbe.ts';

const TOL = 1e-6;

/** Does a single dimensionless point survive mm and back? */
function roundTrips(template: BodyTemplate, level: string, u: number, az: number, r: number): boolean {
  try {
    const mm = bodyLocalToMm(template, { level, u, t: az, r });
    const back = bodyMmToLocal(template, mm);
    let dt = Math.abs(back.local.t - az);
    dt = Math.min(dt, 1 - dt);
    return (
      back.local.level === level &&
      Math.abs(back.local.u - u) < TOL &&
      dt < TOL &&
      Math.abs(back.local.r - r) < TOL
    );
  } catch {
    return false;
  }
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
      audit.admissible,
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
  assert.equal(chordAudit.admissible, false);
  assert.deepEqual(chordAudit.violations.map((v) => v.level), ['L05']);
  assert.ok(measureRoundTrip(chordLarge, { samplesPerLevel: 200 }).failures > 0);
});

test('admissibility: cutting the fused sacrum into five levels folds the pelvis', () => {
  const split = buildAnatomicalBodyTemplate(ADULT_P50_SPLIT_SACRUM);
  const audit = auditBodyTemplate(split);
  assert.equal(audit.admissible, false);
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

test('admissibility: the exact criterion is sharp in both directions', () => {
  // What the gate promises is a whole-template property: if the audit passes,
  // nothing folds anywhere. Per-level margins do not compose on a template
  // that already fails, because points displaced by one level's fold land in
  // its neighbours — so "admissible" is asserted template-wide, and the fold
  // location is asserted only where the audit says there is one.
  for (const params of PRESETS) {
    const template = buildAnatomicalBodyTemplate(params);
    const audit = auditBodyTemplate(template);
    assert.equal(audit.admissible, true, params.id);
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

  // And where the audit does report a fold, the fold is really there, within
  // 5% of the predicted radius — so the criterion is not merely a safe bound.
  for (const params of [ADULT_P50_SPLIT_SACRUM, { ...ADULT_P50, id: 'chord', sacralTangentFraction: 0.5, radialScale: 1.45 }]) {
    const template = buildAnatomicalBodyTemplate(params);
    for (const level of auditBodyTemplate(template).violations) {
      const foldRatio = 1 / level.utilisation;
      assert.ok(foldRatio < 1);
      assert.ok(
        roundTrips(template, level.level, 0.5, level.worstAzimuthTurns, foldRatio * 0.95),
        `${params.id} ${level.level}: just inside the predicted fold should still be fine`,
      );
      assert.ok(
        !roundTrips(template, level.level, 0.5, level.worstAzimuthTurns, Math.min(0.9999, foldRatio * 1.05)),
        `${params.id} ${level.level}: predicted fold at r=${foldRatio.toFixed(3)} did not occur`,
      );
    }
  }
});

test('admissibility: the superseded worst-case criterion condemns usable bodies', () => {
  // Kept as a test rather than a comment so the regression cannot come back.
  const template = buildAnatomicalBodyTemplate(ADULT_LARGE_GIRTH);
  const worstCase = auditBodyTemplateWorstCase(template);
  const directional = auditBodyTemplate(template);

  assert.equal(worstCase.admissible, false);
  assert.equal(directional.admissible, true);

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
