/**
 * The acceptance gate every candidate body template must pass.
 *
 * The criterion is `scanBodyTemplateFolds` — every point generated from a
 * level's own coordinates must be claimed by exactly that level. Everything
 * else here is either cheaper evidence collected on the way, or a check on a
 * property that criterion does not express.
 *
 * It is NOT `auditBodyTemplate().locallyAdmissible`. That field means one
 * thing: no level violates its own two bisector planes. Necessary, not
 * sufficient — 162 of 3 228 templates across the parameter box satisfy it and
 * still fold (DOG-9). Use the audit to LOCALISE a fold once one is known to
 * exist, which is what the per-level margins are genuinely good at, and gate on
 * the scan.
 *
 * Nor is it `measureRoundTrip().failures === 0`. Since `bodyMmToLocal` began
 * picking the nearest claimant, a folded point usually decodes correctly
 * anyway, so the round trip under-reports: ambiguity is the defect and a wrong
 * answer was only its symptom.
 *
 * Three measured holes motivated the stages beyond the scan:
 *
 *   - A template with a localised radial bulge passes the per-level audit with
 *     a 24x margin and still folds, because a non-adjacent level claims the
 *     point. Stage ADMISSIBILITY-CONSISTENCY is the cross-check. (QA-2)
 *
 *   - A template with two slabs sharing a label passes the audit *and* the
 *     probe, because `findSlab` resolves to the first match and the probe only
 *     ever asks for labels it read off the slabs. One vertebral level of the
 *     body is then unaddressable, and points inside it encode to an address
 *     that decodes 32 mm away, with no flag on either call. Stage STRUCTURE
 *     catches it. (QA-10)
 *
 *   - A fold can displace rather than duplicate: the point is claimed by one
 *     *other* level, so nothing is ambiguous at runtime and the flag stays
 *     quiet, while the original address for that point is gone. The scan's
 *     `lost` kind is what catches it. (QA-13)
 *
 * Usage, from the asset pipeline or a test:
 *
 *     const report = acceptBodyTemplate(template);
 *     if (!report.accepted) throw new Error(formatAcceptanceReport(report));
 *
 * Every stage is reported even when an earlier one fails, because an asset
 * pipeline wants the whole list, not the first problem.
 */

import {
  ADDRESSABLE_LEVELS,
  auditBodyTemplate,
  scanBodyTemplateFolds,
  spineGeometry,
  type BodyTemplate,
  type FoldSite,
  type TemplateAudit,
} from '../frames/bodySpine.ts';
import { BD } from '../frames/bodySpine.ts';
import { measureRoundTrip, type RoundTripResult } from './admissibilityProbe.ts';

export interface StageResult {
  stage: string;
  passed: boolean;
  /** One line per problem. Empty when the stage passed. */
  problems: string[];
  /** Numbers worth publishing with the template, pass or fail. */
  measurements: Record<string, number | string>;
}

export interface AcceptanceReport {
  templateId: string;
  accepted: boolean;
  stages: StageResult[];
  /** The analytic audit, for publication alongside the template. */
  audit: TemplateAudit;
  /** The empirical probe, same. */
  probe: RoundTripResult;
  options: Required<AcceptanceOptions>;
}

export interface AcceptanceOptions {
  /** Round-trip samples per level. The published runs use 5 000 total. */
  samplesPerLevel?: number;
  /** Seed, so a rejection reproduces exactly. */
  seed?: number;
  /**
   * Largest utilisation a shipping template may carry. 1.0 is the fold itself;
   * the default leaves a margin for the fact that the audit is computed on a
   * sampled azimuth grid rather than in closed form.
   */
  maxUtilisation?: number;
  /**
   * Azimuths probed by the consistency stage. Must exceed the template's own
   * `surfaceRadiiMm.length`, or the stage inherits the audit's blind spot.
   */
  consistencyAzimuths?: number;
  /** Absolute tolerance on recovered u, t and r. */
  tol?: number;
  /**
   * Require every slab label to be a level the ALC-1 grammar can address.
   * Off only for deliberately synthetic templates.
   */
  requireAddressableLabels?: boolean;
}

const DEFAULTS: Required<AcceptanceOptions> = {
  samplesPerLevel: 200,
  seed: 20261008,
  maxUtilisation: 0.95,
  consistencyAzimuths: 720,
  tol: 1e-6,
  requireAddressableLabels: true,
};

/**
 * The levels an ALC-1 `BD` address can name (spec section 4).
 *
 * `ADDRESSABLE_LEVELS`, not `VERTEBRAL_LEVELS`: a template built for a subject
 * with thirteen ribs or six lumbar vertebrae legitimately realises `T13` or
 * `L06`, and gating on the canonical set alone would reject exactly the
 * templates the anomaly set exists to serve. See the DECISION note on
 * `ANOMALOUS_LEVELS` in frames/bodySpine.ts.
 */
const ADDRESSABLE = new Set(ADDRESSABLE_LEVELS);

// ---------------------------------------------------------------------------

/**
 * Stage STRUCTURE. Properties a template must have before any geometry is
 * meaningful. Neither the audit nor the probe checks these, and two of them are
 * silent-wrong-answer bugs rather than crashes.
 */
function stageStructure(template: BodyTemplate, opts: Required<AcceptanceOptions>): StageResult {
  const problems: string[] = [];
  const labels = template.slabs.map((s) => s.label);

  if (template.slabs.length === 0) problems.push('template has no slabs');

  // Duplicate labels: `findSlab` takes the first match, so the second slab is
  // unaddressable and points inside it resolve to the first one's millimetres.
  // The probe cannot see this because it only asks for labels it read off the
  // slabs, and the first match answers every time.
  const seen = new Map<string, number>();
  for (const l of labels) seen.set(l, (seen.get(l) ?? 0) + 1);
  for (const [label, n] of seen) {
    if (n > 1) {
      problems.push(
        `label ${label} is used by ${n} slabs; findSlab() resolves to the first, so ${n - 1} slab(s) `
        + 'are unaddressable and points inside them decode to the wrong level',
      );
    }
  }

  if (opts.requireAddressableLabels) {
    for (const label of new Set(labels)) {
      if (!ADDRESSABLE.has(label)) {
        problems.push(
          `slab label ${label} is not an addressable ALC-1 level, so this slab's anatomy has no address`,
        );
      }
    }
  }

  // Per docs/alc-1-admissibility.md section 5 requirement 1.
  const sacral = labels.filter((l) => l.startsWith('S'));
  if (sacral.length > 1) {
    problems.push(
      `${sacral.length} addressable sacral levels (${sacral.join(', ')}); the spec requires exactly one, `
      + 'S01, covering the whole fused sacrum. Cutting it up puts 1.2-3.2% of body volume inside a fold.',
    );
  }

  for (const slab of template.slabs) {
    if (!(slab.heightMm > 0)) problems.push(`${slab.label}: heightMm is ${slab.heightMm}`);
    if (slab.surfaceRadiiMm.length < 8) {
      problems.push(`${slab.label}: only ${slab.surfaceRadiiMm.length} azimuth samples`);
    }
    if (!slab.surfaceRadiiMm.every((r) => Number.isFinite(r) && r > 0)) {
      problems.push(`${slab.label}: surfaceRadiiMm contains a non-finite or non-positive radius`);
    }
    for (const [name, v] of [['origin', slab.origin], ['axial', slab.axial], ['anterior', slab.anterior], ['left', slab.left]] as const) {
      if (!v.every(Number.isFinite)) problems.push(`${slab.label}: ${name} is not finite`);
    }
    const norm = (v: readonly [number, number, number]) => Math.hypot(v[0], v[1], v[2]);
    if (Math.abs(norm(slab.axial) - 1) > 1e-6) problems.push(`${slab.label}: axial is not a unit vector`);
    if (Math.abs(norm(slab.anterior) - 1) > 1e-6) problems.push(`${slab.label}: anterior is not a unit vector`);
  }

  if (!(template.maxUsefulDigits >= 0) || !Number.isInteger(template.maxUsefulDigits)) {
    problems.push(`maxUsefulDigits is ${template.maxUsefulDigits}`);
  }
  if (template.maxUsefulDigits > BD.maxDigits) {
    problems.push(
      `maxUsefulDigits ${template.maxUsefulDigits} exceeds the BD frame cap of ${BD.maxDigits}, so `
      + 'the template claims a precision no address can express',
    );
  }

  // Every slab must have a resolvable axis before the audit runs.
  try {
    spineGeometry(template);
  } catch (e) {
    problems.push(`spineGeometry() failed: ${(e as Error).message}`);
  }

  return {
    stage: 'STRUCTURE',
    passed: problems.length === 0,
    problems,
    measurements: {
      slabs: template.slabs.length,
      distinctLabels: new Set(labels).size,
      sacralLevels: sacral.length,
      azimuthSamples: template.slabs[0]?.surfaceRadiiMm.length ?? 0,
      maxUsefulDigits: template.maxUsefulDigits,
    },
  };
}

/** Stage AUDIT. The analytic directional condition, gated with a margin. */
function stageAudit(audit: TemplateAudit, opts: Required<AcceptanceOptions>): StageResult {
  const problems: string[] = [];
  const worst = audit.levels.reduce(
    (m, l) => (l.utilisation > m.utilisation ? l : m),
    audit.levels[0] ?? { level: 'none', utilisation: 0, foldRadiusMm: Infinity, radiusAtWorstMm: 0, marginMm: Infinity, worstAzimuthTurns: 0, maxRadiusMm: 0, curvatureRadiusMm: Infinity },
  );

  for (const v of audit.violations) {
    problems.push(
      `${v.level}: the frame folds at ${v.foldRadiusMm.toFixed(0)} mm but the body reaches `
      + `${v.radiusAtWorstMm.toFixed(0)} mm at azimuth ${v.worstAzimuthTurns.toFixed(3)} turns `
      + `(utilisation ${v.utilisation.toFixed(2)})`,
    );
  }
  if (audit.locallyAdmissible && worst.utilisation > opts.maxUtilisation) {
    problems.push(
      `${worst.level}: utilisation ${worst.utilisation.toFixed(3)} is admissible but over the `
      + `${opts.maxUtilisation} acceptance ceiling, leaving ${worst.marginMm.toFixed(0)} mm of margin`,
    );
  }

  return {
    stage: 'AUDIT',
    passed: problems.length === 0,
    problems,
    measurements: {
      locallyAdmissible: String(audit.locallyAdmissible),
      worstLevel: worst.level,
      worstUtilisation: Number(worst.utilisation.toFixed(4)),
      worstMarginMm: Number(audit.worstMarginMm.toFixed(2)),
      worstAzimuthTurns: Number(worst.worstAzimuthTurns.toFixed(4)),
    },
  };
}

/** Stage PROBE. The empirical round trip. Zero failures or nothing ships. */
function stageProbe(probe: RoundTripResult): StageResult {
  const problems: string[] = [];
  if (probe.failures > 0) {
    problems.push(
      `${probe.failures}/${probe.samples} dimensionless points did not survive mm and back: `
      + probe.failuresByLevel.map((f) => `${f.level} x${f.failures}`).join(', '),
    );
  }
  if (probe.inadmissibleNotes > 0) {
    problems.push(`${probe.inadmissibleNotes} samples came back flagged as inadmissible`);
  }
  if (!(probe.worstGoodErrorMm < 1e-6)) {
    problems.push(`the inverse map drifted by ${probe.worstGoodErrorMm} mm, so it is not an exact inverse`);
  }
  return {
    stage: 'PROBE',
    passed: problems.length === 0,
    problems,
    measurements: {
      samples: probe.samples,
      failures: probe.failures,
      inadmissibleNotes: probe.inadmissibleNotes,
      worstGoodErrorMm: probe.worstGoodErrorMm,
    },
  };
}

/**
 * Stage ADMISSIBILITY-CONSISTENCY. Is the frame actually injective, and does
 * the audit's verdict match?
 *
 * Gates on `scanBodyTemplateFolds` (DOG-9), which is the sound criterion:
 * every point generated from level L's own coordinates must be claimed by
 * exactly `[L]`. This stage used to decide by round trip, and that is no longer
 * good enough for two reasons the frame's own fix created:
 *
 *   - `bodyMmToLocal` now picks the NEAREST claimant rather than the most
 *     cranial, which repairs most mis-decodes. A point can therefore round-trip
 *     perfectly and still be denoted by a second address in another level. The
 *     ambiguity is the defect; the wrong answer was only ever its symptom, and
 *     a round-trip gate now misses the cases that got repaired.
 *   - Counting claimants alone is not enough either. Past its own fold radius a
 *     level's planes stop bracketing its own points, so the point can be
 *     claimed *solely by a neighbour* — one claimant, nothing ambiguous to
 *     detect, and L's address for that point silently lost. `FoldSite.kind`
 *     separates `ambiguous` (claimed by several) from `lost` (claimed by one
 *     other) and `unclaimed` (claimed by none).
 *
 * The second direction of disagreement is still checked here and nowhere else:
 * a level the audit *flags* that the scan finds sound means the published
 * per-level margin is wrong, even though the template may be perfectly usable.
 * That is a defect in the audit rather than in the template, so it is reported
 * as one.
 */
function stageConsistency(
  template: BodyTemplate,
  audit: TemplateAudit,
  opts: Required<AcceptanceOptions>,
): StageResult {
  const problems: string[] = [];
  const scan = scanBodyTemplateFolds(template, { azimuths: opts.consistencyAzimuths });

  // Group the recorded sites by kind so the report names the failure mode
  // rather than only its count.
  const byKind = new Map<string, FoldSite[]>();
  for (const site of scan.sites) {
    if (!byKind.has(site.kind)) byKind.set(site.kind, []);
    byKind.get(site.kind)!.push(site);
  }

  const explain: Record<string, string> = {
    ambiguous:
      'claimed by more than one level, so two addresses denote this millimetre point',
    lost:
      "claimed by one OTHER level, so this level's address for the point is gone and nothing at "
      + 'runtime looks ambiguous',
    unclaimed: 'claimed by no level at all',
  };

  for (const [kind, sites] of byKind) {
    for (const site of sites.slice(0, 4)) {
      problems.push(
        `${site.level}: ${kind} at (u=${site.at.u}, t=${site.at.t.toFixed(4)}, r=${site.at.r}), `
        + `${site.radiusMm.toFixed(0)} mm from its axis — ${explain[kind] ?? kind}. `
        + `Claimed by [${site.claimedBy.join(', ') || 'nothing'}]; decodes as ${site.decodesAs}.`,
      );
    }
    if (sites.length > 4) problems.push(`  ...and ${sites.length - 4} more ${kind} site(s)`);
  }

  // A fold the per-level criterion did not predict is the QA-2 case: worth
  // naming explicitly, because it is the audit that is wrong and not only the
  // template.
  for (const { level } of scan.foldsByLevel) {
    const levelAudit = audit.levels.find((l) => l.level === level);
    if (levelAudit && levelAudit.marginMm > 0) {
      problems.push(
        `${level}: folds, but the per-level criterion clears it with ${levelAudit.marginMm.toFixed(0)} mm `
        + `of margin (utilisation ${levelAudit.utilisation.toFixed(2)}). The criterion only tests a level `
        + 'against its own two bisector planes; a distant level can claim the point. Localise with the '
        + 'audit, gate on the scan.',
      );
    }
  }

  // And the converse, which nothing else checks.
  for (const levelAudit of audit.levels) {
    if (levelAudit.marginMm > 0) continue;
    const observed = scan.foldsByLevel.some((f) => f.level === levelAudit.level);
    if (!observed) {
      problems.push(
        `${levelAudit.level}: the audit reports a fold (utilisation ${levelAudit.utilisation.toFixed(2)}) `
        + 'but the skin scan finds this level sound, so the published margin is mis-stated even though '
        + 'the template may be usable',
      );
    }
  }

  return {
    stage: 'ADMISSIBILITY-CONSISTENCY',
    passed: scan.sound && problems.length === 0,
    problems,
    measurements: {
      probed: scan.probed,
      foldedPoints: scan.foldedPoints,
      sound: String(scan.sound),
      kinds: [...byKind.keys()].sort().join(',') || 'none',
      levelsFolding: scan.foldsByLevel.length,
      azimuthKnotsPerLevel: template.slabs[0]?.surfaceRadiiMm.length ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Run the whole gate. Pure; makes no assertions and throws nothing, so a
 * pipeline can report or publish the result as it prefers.
 */
export function acceptBodyTemplate(
  template: BodyTemplate,
  options: AcceptanceOptions = {},
): AcceptanceReport {
  const opts: Required<AcceptanceOptions> = { ...DEFAULTS, ...options };

  const structure = stageStructure(template, opts);

  // The remaining stages need a resolvable spine. If STRUCTURE could not build
  // one, say so once rather than failing four times with the same cause.
  let audit: TemplateAudit;
  try {
    audit = auditBodyTemplate(template);
  } catch (e) {
    return {
      templateId: template.id,
      accepted: false,
      stages: [
        structure,
        {
          stage: 'AUDIT',
          passed: false,
          problems: [`auditBodyTemplate() threw: ${(e as Error).message}`],
          measurements: {},
        },
      ],
      audit: { templateId: template.id, locallyAdmissible: false, violations: [], levels: [], worstMarginMm: NaN },
      probe: {
        templateId: template.id, samples: 0, failures: 0, failuresByLevel: [],
        inadmissibleNotes: 0, worstGoodErrorMm: NaN,
      },
      options: opts,
    };
  }

  const probe = measureRoundTrip(template, {
    samplesPerLevel: opts.samplesPerLevel,
    seed: opts.seed,
    tol: opts.tol,
  });

  const stages = [
    structure,
    stageAudit(audit, opts),
    stageProbe(probe),
    stageConsistency(template, audit, opts),
  ];

  return {
    templateId: template.id,
    accepted: stages.every((s) => s.passed),
    stages,
    audit,
    probe,
    options: opts,
  };
}

/** A report a human can act on, and that CI can print. */
export function formatAcceptanceReport(report: AcceptanceReport): string {
  const lines: string[] = [
    `template ${report.templateId}: ${report.accepted ? 'ACCEPTED' : 'REJECTED'}`,
    `  seed ${report.options.seed}, ${report.options.samplesPerLevel} probe samples per level, `
      + `utilisation ceiling ${report.options.maxUtilisation}`,
  ];
  for (const stage of report.stages) {
    const measured = Object.entries(stage.measurements).map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(`  [${stage.passed ? 'pass' : 'FAIL'}] ${stage.stage}${measured ? `  ${measured}` : ''}`);
    for (const p of stage.problems) lines.push(`         - ${p}`);
  }
  return lines.join('\n');
}

/** The per-level table docs/alc-1-admissibility.md section 5 requires shipping. */
export function formatLevelTable(report: AcceptanceReport): string {
  const rows = report.audit.levels.map((l) => {
    const failures = report.probe.failuresByLevel.find((f) => f.level === l.level)?.failures ?? 0;
    return `| \`${l.level}\` | ${fmt(l.foldRadiusMm)} | ${fmt(l.radiusAtWorstMm)} | ${fmt(l.marginMm)} | `
      + `${l.utilisation.toFixed(3)} | ${l.worstAzimuthTurns.toFixed(3)} | ${failures} |`;
  });
  return [
    '| level | fold radius mm | body radius mm | margin mm | utilisation | worst azimuth turns | probe failures |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(0) : '∞');
