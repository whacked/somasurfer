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
    `The hook is live: the first real template gates on auditBodyTemplate()`,
    `and measureRoundTrip() with no change to this job.`,
  ]);
  process.exit(0);
}

// Imported lazily so a repo with no templates never pays for loading the
// frame implementation, and so a broken import cannot fail the idle path.
const { auditBodyTemplate } = await import('../packages/alc/src/index.ts');
const { measureRoundTrip } = await import('../packages/alc/src/testing/admissibilityProbe.ts');

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

  // Requirement 4: the probe is the thing that cannot be fooled.
  if (probe.failures > 0) {
    problems.push(`${file}: measureRoundTrip() failed ${probe.failures}/${probe.samples} samples.`);
    for (const l of probe.failuresByLevel.slice(0, 8)) problems.push(`  ${l.level}: ${l.failures}`);
  }

  if (audit.admissible && probe.failures === 0) {
    report.push(
      `${file}: admissible. Worst level ${worst.level} at utilisation ${worst.utilisation.toFixed(2)},` +
        ` margin ${audit.worstMarginMm.toFixed(0)} mm, ${probe.samples} probe samples clean.`,
    );
  }
}

if (problems.length > 0) fail('body template audit', problems);
pass('body template audit', report);
