/**
 * The body-template admissibility hook.
 *
 * docs/alc-1-admissibility.md §5 puts three requirements on any real body
 * template: one addressable sacral level, its axis taken from the upper sacral
 * endplate, and `auditBodyTemplate()` passing with its per-level table
 * published. This is where CI enforces them.
 *
 * No real template exists yet — it comes out of the asset pipeline, which is
 * waiting on the mesh source decision. So the hook is deliberately idle rather
 * than absent: it reports that it found nothing to audit and exits zero. The
 * moment a `*.body.json` lands in packages/atlas-assets/templates/ it starts
 * gating, with no CI change needed. That is the whole point of landing it now.
 *
 * Three checks, not one, and the third is here because the first two are not
 * enough. `auditBodyTemplate()` is a per-level criterion: it derives the radius
 * at which a level's *own two* bisector planes meet. But a point is lost as
 * soon as *any* level claims it, and on the convex side of a tight kyphosis the
 * planes fan out, so a distant level can reach across several others. The
 * pre-landing structural review of ALC-1 found this; measured over a 320-template
 * clinical sweep (kyphosis 35-70, lordosis 38-85, girth 1.0-1.7x, stature
 * 0.88-1.08x):
 *
 *   304 templates cleared by auditBodyTemplate()
 *    22 of those fold anyway
 *     7 of the 22 caught by measureRoundTrip({ samplesPerLevel: 200 })
 *    22 of the 22 caught by the dense skin scan below
 *
 * The probe misses two thirds of them because it samples the volume uniformly
 * in r, so only ~0.5% of its samples land in the outermost 0.5% of tissue —
 * and the fold lives at the skin, in a narrow band of azimuth, usually hard
 * against a level boundary. Uniform random sampling is the wrong instrument for
 * that; a deterministic sweep of exactly those surfaces is the right one. It
 * costs about half a second per template and has zero false positives on all
 * five shipped presets (97,200 samples each). Keep all three: the audit names
 * the mechanism and the margin, the probe covers the interior, the scan covers
 * the place folds actually are.
 *
 * Templates are read as JSON data. The hook is CI tooling, not a shipped code
 * package, so this is not a build-time dependency of our Apache-2.0 code on
 * asset licences — see tools/check-licence-separation.mjs, which enforces that
 * boundary for the packages themselves.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, fail, pass, rel } from './lib/repo.mjs';

const TEMPLATE_DIR = join(REPO_ROOT, 'packages', 'atlas-assets', 'templates');

const found = existsSync(TEMPLATE_DIR)
  ? readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.body.json')).sort()
  : [];

if (found.length === 0) {
  pass('body template audit', [
    `No *.body.json in ${rel(TEMPLATE_DIR)} — nothing to audit yet.`,
    `The hook is live: the first real template gates on auditBodyTemplate(),`,
    `measureRoundTrip() and a dense skin scan, with no change to this job.`,
  ]);
  process.exit(0);
}

// Imported lazily so a repo with no templates never pays for loading the
// frame implementation, and so a broken import cannot fail the idle path.
const { auditBodyTemplate, bodyLocalToMm, bodyMmToLocal } = await import('../packages/alc/src/index.ts');
const { measureRoundTrip } = await import('../packages/alc/src/testing/admissibilityProbe.ts');

/**
 * The surfaces a fold actually shows up on: just inside the skin, swept through
 * every azimuth, with u clustered towards both level boundaries because that is
 * where the bisector planes are. Deterministic — no seed, no sampling luck. The
 * three radii distinguish "the skin folds" from "a fifth of the tissue folds",
 * which is the difference between a template to fix and a template to reject.
 */
const SKIN_AZIMUTHS = 144;
const SKIN_U = [0.02, 0.08, 0.2, 0.35, 0.5, 0.65, 0.8, 0.92, 0.98];
const SKIN_R = [0.999, 0.97, 0.9];

function skinScan(template) {
  const byLevel = new Map();
  let samples = 0;
  let failures = 0;
  let worst = null; // the failure at the largest r: the shallowest one found

  for (const slab of template.slabs) {
    for (let a = 0; a < SKIN_AZIMUTHS; a += 1) {
      const t = a / SKIN_AZIMUTHS;
      for (const u of SKIN_U) {
        for (const r of SKIN_R) {
          samples += 1;
          let bad = false;
          let claimedBy = null;
          try {
            const mm = bodyLocalToMm(template, { level: slab.label, u, t, r });
            const back = bodyMmToLocal(template, mm);
            claimedBy = back.local.level;
            let dt = Math.abs(back.local.t - t);
            dt = Math.min(dt, 1 - dt); // azimuth is circular
            bad =
              back.local.level !== slab.label ||
              Math.abs(back.local.u - u) > 1e-6 ||
              dt > 1e-6 ||
              Math.abs(back.local.r - r) > 1e-6;
          } catch {
            bad = true;
          }
          if (bad) {
            failures += 1;
            byLevel.set(slab.label, (byLevel.get(slab.label) ?? 0) + 1);
            if (!worst || r > worst.r) worst = { level: slab.label, u, t, r, claimedBy };
          }
        }
      }
    }
  }

  return {
    samples,
    failures,
    byLevel: [...byLevel.entries()]
      .map(([level, n]) => ({ level, failures: n }))
      .sort((x, y) => y.failures - x.failures),
    worst,
  };
}

/** Structural validation, so a malformed template fails loudly here. */
function validate(t, file, problems) {
  if (typeof t.id !== 'string' || !t.id) problems.push(`${file}: missing \`id\`.`);
  if (!Number.isInteger(t.maxUsefulDigits) || t.maxUsefulDigits < 0) {
    problems.push(`${file}: \`maxUsefulDigits\` must be a non-negative integer, derived from mesh resolution.`);
  }
  if (!Array.isArray(t.slabs) || t.slabs.length === 0) {
    problems.push(`${file}: \`slabs\` must be a non-empty cranial-to-caudal array.`);
    return false;
  }
  for (const [i, s] of t.slabs.entries()) {
    const at = `${file}: slabs[${i}]${s?.label ? ` (${s.label})` : ''}`;
    if (typeof s.label !== 'string') problems.push(`${at}: missing \`label\`.`);
    for (const key of ['origin', 'axial', 'anterior', 'left']) {
      if (!Array.isArray(s[key]) || s[key].length !== 3 || s[key].some((v) => !Number.isFinite(v))) {
        problems.push(`${at}: \`${key}\` must be three finite numbers.`);
      }
    }
    if (!(s.heightMm > 0)) problems.push(`${at}: \`heightMm\` must be positive.`);
    if (!Array.isArray(s.surfaceRadiiMm) || s.surfaceRadiiMm.length < 12) {
      problems.push(`${at}: \`surfaceRadiiMm\` needs at least 12 azimuth samples.`);
    } else if (s.surfaceRadiiMm.some((v) => !(v > 0))) {
      problems.push(`${at}: \`surfaceRadiiMm\` must all be positive.`);
    }
  }
  return problems.length === 0;
}

const problems = [];
const report = [];

for (const file of found) {
  const template = JSON.parse(readFileSync(join(TEMPLATE_DIR, file), 'utf8'));
  if (!validate(template, file, problems)) continue;

  // Requirement 1: one addressable sacral level, S01. S02-S05 stay reserved in
  // the grammar and absent from templates. This cannot be retrofitted — once
  // addresses are issued, changing the level set invalidates them.
  const sacral = template.slabs.map((s) => s.label).filter((l) => /^S\d\d$/.test(l));
  if (sacral.length !== 1 || sacral[0] !== 'S01') {
    problems.push(
      `${file}: sacral levels are ${sacral.length ? sacral.join(',') : '(none)'}; must be exactly S01.`,
      `  docs/alc-1-admissibility.md §2: splitting the fused sacrum is strictly worse at every girth.`,
    );
  }

  const audit = auditBodyTemplate(template);
  const probe = measureRoundTrip(template, { samplesPerLevel: 200 });
  const worst = audit.levels.reduce((m, l) => (l.utilisation > m.utilisation ? l : m), audit.levels[0]);

  // Requirement 3: the audit must pass.
  if (!audit.admissible) {
    problems.push(`${file}: auditBodyTemplate() FAILS on ${audit.violations.length} level(s).`);
    for (const v of audit.violations) {
      problems.push(
        `  ${v.level}: utilisation ${v.utilisation.toFixed(2)} at azimuth ${v.worstAzimuthTurns.toFixed(3)} turns` +
          ` (body ${v.radiusAtWorstMm.toFixed(0)} mm vs fold ${v.foldRadiusMm.toFixed(0)} mm)`,
      );
    }
  }

  // Requirement 4: the interior probe. Uniform in r, so it covers the volume.
  if (probe.failures > 0) {
    problems.push(`${file}: measureRoundTrip() failed ${probe.failures}/${probe.samples} samples.`);
    for (const l of probe.failuresByLevel.slice(0, 8)) problems.push(`  ${l.level}: ${l.failures}`);
  }

  // Requirement 5: the dense skin scan. This is the one that catches a fold the
  // per-level audit cannot see, because a distant level claimed the point. See
  // the header for why neither of the two above is sufficient on its own.
  const scan = skinScan(template);
  if (scan.failures > 0) {
    problems.push(
      `${file}: dense skin scan folds at ${scan.failures}/${scan.samples} samples` +
        ` across ${scan.byLevel.length} level(s).`,
    );
    if (audit.admissible && probe.failures === 0) {
      problems.push(
        `  auditBodyTemplate() CLEARED this template and the interior probe found nothing.`,
        `  That combination means a non-local fold: the planes of a level several`,
        `  levels away reach across on the convex side of a curve, which a per-level`,
        `  criterion cannot see. Do not "fix" this by trusting the audit.`,
      );
    }
    const w = scan.worst;
    problems.push(
      `  shallowest fold: ${w.level} at u ${w.u}, azimuth ${w.t.toFixed(3)} turns, r ${w.r}` +
        ` → decodes as ${w.claimedBy ?? 'a throw'}`,
    );
    for (const l of scan.byLevel.slice(0, 8)) problems.push(`  ${l.level}: ${l.failures}`);
  }

  if (audit.admissible && probe.failures === 0 && scan.failures === 0) {
    report.push(
      `${file}: admissible. Worst level ${worst.level} at utilisation ${worst.utilisation.toFixed(2)},` +
        ` margin ${audit.worstMarginMm.toFixed(0)} mm, ${probe.samples} probe` +
        ` and ${scan.samples} skin samples clean.`,
    );
  }
}

if (problems.length > 0) fail('body template audit', problems);
pass('body template audit', report);
