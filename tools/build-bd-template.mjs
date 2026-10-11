/**
 * Write one `BD` body template from the BodyParts3D source set.
 *
 *   node tools/build-bd-template.mjs --source <dir> [--centreline body|whole]
 *                                    [--azimuths 72] [--out <path>]
 *
 * The geometry, and the reasoning behind every choice in it, is in
 * tools/lib/bd-template.mjs. This file is the command line and nothing else.
 *
 * `<dir>` holds the four published source files listed in tools/lib/bp3d.mjs.
 * They are NOT in the repository — 136 MB of third-party mesh data, reduced
 * here to a ~50 kB template. The template is the committed artefact; CI audits
 * it with tools/audit-real-template.mjs and never needs the meshes.
 *
 * This writes the template and says what it measured. It does NOT decide
 * whether the template is admissible: that is tools/audit-real-template.mjs
 * and tools/report-template-audit.mjs, and keeping the producer separate from
 * the gate is deliberate. A pipeline that graded its own output would be free
 * to grade it leniently.
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { REPO_ROOT, rel } from './lib/repo.mjs';
import { build, parseArgs } from './lib/bd-template.mjs';

const opts = parseArgs(process.argv.slice(2));
const { template, unverified, precision } = build(opts);

const outPath = opts.out
  ?? join(REPO_ROOT, 'packages', 'atlas-assets', 'templates', `${template.id}.body.json`);
const json = `${JSON.stringify(template, null, 1)}\n`;
writeFileSync(outPath, json);

const lines = [
  `template ${template.id}`,
  `  centreline ${opts.centreline}${opts.centreline === 'body' ? ` (anterior ${opts.bodyFraction})` : ''}`
    + `, ${opts.azimuths} azimuth knots, ${template.slabs.length} levels`,
  `  maxUsefulDigits ${precision.maxUsefulDigits} (${precision.basis.smallestCellSideMm} mm smallest cell side`
    + ` / ${precision.basis.skinMeanEdgeMm} mm skin edge)`,
  `  wrote ${rel(outPath)} (${json.length} bytes,`
    + ` sha256 ${createHash('sha256').update(json).digest('hex').slice(0, 16)})`,
];
if (unverified.length > 0) {
  lines.push(`  UNVERIFIED: ${unverified.length} azimuth(s) could not be measured; each filled with an upper bound`);
  for (const u of unverified.slice(0, 8)) {
    lines.push(`    ${u.level} at ${u.azimuthTurns} turns (${u.clock} o'clock): bound ${u.boundMm} mm`);
  }
  if (unverified.length > 8) lines.push(`    ...and ${unverified.length - 8} more`);
} else {
  lines.push('  every azimuth at every level reached the skin mesh');
}
console.log(lines.join('\n'));

if (opts.measurement) {
  writeFileSync(opts.measurement, `${JSON.stringify(template.provenance.measurement, null, 1)}\n`);
  console.log(`  wrote ${rel(opts.measurement)}`);
}
