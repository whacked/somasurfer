/**
 * Build every candidate centreline rule, gate all of them, and record the
 * results in `ci/bd-centreline-trials.json`.
 *
 *   node tools/trial-bd-centrelines.mjs --source <dir>
 *
 * Why this is a committed artefact rather than a paragraph in the audit
 * report. The pipeline has to choose how to turn a vertebra mesh into an axis
 * point, and there is more than one defensible answer; "we chose the
 * vertebral-body centroid" is an assertion, while "the whole-vertebra centroid
 * folds at L05 with utilisation 1.14 and 979 folded points, and the
 * vertebral-body centroid folds nowhere in 162 000" is a result. Only the
 * accepted template ships, so the rejected candidates' numbers would otherwise
 * be unverifiable — and the audit report is drift-gated against committed
 * inputs only, which the 136 MB mesh set is not.
 *
 * So: this tool needs the meshes and is run by hand; the JSON it writes is
 * committed; docs/alc-1-body-template-audit.md renders it; CI regenerates that
 * document from the JSON and the shipped template and compares byte for byte.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, rel } from './lib/repo.mjs';
import { build, parseArgs } from './lib/bd-template.mjs';

const { acceptBodyTemplate } = await import('../packages/alc/src/testing/templateAcceptance.ts');

/**
 * The candidates. `centreline` is the axis-point rule for the 24 presacral
 * levels; `sacralAxis` is how S01 reads the upper sacral endplate.
 *
 * `ships: true` marks the one whose output is committed under
 * packages/atlas-assets/templates/. Exactly one may claim it, and this tool
 * fails if the one that claims it is not accepted — a shipping template chosen
 * over a better-measured alternative is the failure this file exists to make
 * impossible.
 */
const CANDIDATES = [
  {
    centreline: 'body',
    sacralAxis: 'endplate-normal',
    ships: true,
    why: 'vertebral-body centroid (the radiologist\'s centroid method), S01 along the endplate normal',
  },
  {
    centreline: 'body',
    sacralAxis: 'entry-tangent',
    ships: false,
    why: 'same centreline, but S01 takes the direction the column is travelling as it reaches the endplate',
  },
  {
    centreline: 'whole',
    sacralAxis: 'endplate-normal',
    ships: false,
    why: 'whole-vertebra volume centroid: no parameter, but the laminae and spinous process pull it posterior',
  },
  {
    centreline: 'whole',
    sacralAxis: 'entry-tangent',
    ships: false,
    why: 'both alternative rules at once, so neither can be blamed for the other\'s result',
  },
];

const base = parseArgs(process.argv.slice(2));

const trials = [];
for (const candidate of CANDIDATES) {
  const opts = {
    ...base,
    centreline: candidate.centreline,
    sacralAxisRule: candidate.sacralAxis,
    id: null,
  };
  // parseArgs derives the id from the rules; redo that here.
  opts.id = `bp3d-4.0-adult-${opts.centreline}-centroid`
    + (opts.sacralAxisRule === 'endplate-normal' ? '' : `-${opts.sacralAxisRule}`);

  const { template, unverified } = build(opts);
  // The consistency stage must probe more azimuths than the template has
  // knots, or it inherits the template's own blind spot. Ten times is the
  // same ratio the shipped audit uses.
  const report = acceptBodyTemplate(template, { consistencyAzimuths: opts.azimuths * 10 });

  const stage = (name) => report.stages.find((s) => s.stage === name) ?? null;
  const consistency = stage('ADMISSIBILITY-CONSISTENCY');
  const audit = report.audit;
  const worst = audit.levels.reduce((m, l) => (l.utilisation > m.utilisation ? l : m), audit.levels[0]);
  const sacral = template.provenance.measurement.levels.at(-1);
  const lumbosacralKink = template.provenance.measurement.levels
    .find((l) => l.level === 'S01')?.kinkAtCranialBoundaryDeg ?? null;

  trials.push({
    id: template.id,
    ships: candidate.ships,
    why: candidate.why,
    options: template.provenance.options,
    accepted: report.accepted,
    stages: report.stages.map((s) => ({ stage: s.stage, passed: s.passed, problems: s.problems.length })),
    maxUsefulDigits: template.maxUsefulDigits,
    audit: {
      locallyAdmissible: audit.locallyAdmissible,
      worstLevel: worst.level,
      worstUtilisation: Number(worst.utilisation.toFixed(4)),
      worstMarginMm: Number(audit.worstMarginMm.toFixed(2)),
      worstAzimuthTurns: Number(worst.worstAzimuthTurns.toFixed(4)),
      violations: audit.violations.map((v) => ({
        level: v.level,
        azimuthTurns: Number(v.worstAzimuthTurns.toFixed(4)),
        marginMm: Number((v.foldRadiusMm - v.radiusAtWorstMm).toFixed(2)),
        foldRadiusMm: Number(v.foldRadiusMm.toFixed(2)),
        bodyRadiusMm: Number(v.radiusAtWorstMm.toFixed(2)),
        utilisation: Number(v.utilisation.toFixed(4)),
      })),
    },
    probe: {
      samples: report.probe.samples,
      failures: report.probe.failures,
      inadmissibleNotes: report.probe.inadmissibleNotes,
      byLevel: report.probe.failuresByLevel.map((f) => ({ level: f.level, failures: f.failures })),
    },
    scan: {
      probed: consistency?.measurements.probed ?? null,
      foldedPoints: consistency?.measurements.foldedPoints ?? null,
      sound: consistency?.measurements.sound ?? null,
      kinds: consistency?.measurements.kinds ?? null,
      levelsFolding: consistency?.measurements.levelsFolding ?? null,
      azimuthsProbed: opts.azimuths * 10,
    },
    lumbosacral: {
      kinkDeg: lumbosacralKink,
      endplateSlopeDeg: sacral?.endplateSlopeDeg ?? null,
      endplatePlanarityRatio: sacral?.endplatePlanarityRatio ?? null,
    },
    unverifiedAzimuths: unverified.length,
  });

  console.log(
    `${template.id}: ${report.accepted ? 'ACCEPTED' : 'REJECTED'}`
    + `  worst ${worst.level} util ${worst.utilisation.toFixed(3)}`
    + `  folded ${consistency?.measurements.foldedPoints ?? '?'}/${consistency?.measurements.probed ?? '?'}`
    + `  probe ${report.probe.failures}/${report.probe.samples}`
    + `  L5/S1 kink ${lumbosacralKink ?? '?'} deg`,
  );
}

const shipping = trials.filter((t) => t.ships);
if (shipping.length !== 1) {
  throw new Error(`exactly one candidate must ship, found ${shipping.length}`);
}
if (!shipping[0].accepted) {
  throw new Error(
    `the shipping candidate ${shipping[0].id} was REJECTED by the gate. Escalate the measurement; `
    + 'do not change which candidate ships in order to get a green trial.',
  );
}
const better = trials.filter((t) => !t.ships && t.accepted
  && t.audit.worstUtilisation < shipping[0].audit.worstUtilisation);
if (better.length > 0) {
  console.log(
    `  note: ${better.map((t) => t.id).join(', ')} also passed with a lower worst utilisation `
    + `than the shipping candidate (${shipping[0].audit.worstUtilisation}).`,
  );
}

const out = join(REPO_ROOT, 'ci', 'bd-centreline-trials.json');
writeFileSync(out, `${JSON.stringify({
  comment: [
    'Produced by tools/trial-bd-centrelines.mjs from the BodyParts3D source set,',
    'which is not in this repository. Committed because the rejected candidates',
    'do not ship, so their numbers would otherwise be unverifiable, and because',
    'docs/alc-1-body-template-audit.md is drift-gated against committed inputs.',
    'Regenerate with: node tools/trial-bd-centrelines.mjs --source <dir>',
  ],
  source: `${trials[0].options.source ?? 'BodyParts3D 4.0 isa_BP3D_4.0_obj_99'}`,
  azimuthKnots: base.azimuths,
  trials,
}, null, 1)}\n`);
console.log(`wrote ${rel(out)}`);
