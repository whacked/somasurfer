/**
 * The brain mesh gate: no structure is lost to decimation, none is degenerate,
 * and every published error figure is what the committed files actually say.
 *
 *   node tools/check-mesh-assets.mjs            gate
 *   node tools/check-mesh-assets.mjs --report   print docs/brain-mesh-report.md
 *
 * Works from the committed files alone; it never needs brain.glb. "The source
 * manifest" here is the generated provenance file, filtered to the structures
 * that may ship: every one of them must be in both tiers. The producer,
 * tools/build-meshes.mjs, writes figures into structures.json; this re-measures
 * each of them from the two mesh files and fails on any disagreement, so a
 * published figure cannot drift from the geometry, or be written by hand.
 *
 * Per structure, in the low tier:
 *
 *   present         in both files, at the slot structures.json says
 *   floor           at least min(floorTriangles, its full-tier count) triangles
 *   not degenerate  no zero-area or repeated-vertex triangle; every index in range
 *   not a sliver    on every axis, at least half its full-tier extent. A thin
 *                   tract decimated flat keeps its triangle count and its length
 *                   and loses one axis, which no count-based check sees
 *   same surface    area within [0.75, 1.25] of the full tier. This is the check
 *                   that caught the first build's reorder bug: tubes came out at
 *                   2.3x their area with a Hausdorff figure that looked fine
 *
 * The thresholds were set from what decimation can and cannot do to a smooth
 * closed surface, not tuned to the current files: on the committed build the
 * area ratios run 0.90-1.02 and the floor is met exactly.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, fail, pass } from './lib/repo.mjs';
import { readMeshBin, structureGeometry } from './lib/meshbin.mjs';
import { bounds, degenerateTriangles, surfaceArea, surfaceDeviation } from './lib/mesh-geometry.mjs';
import { GROUPS } from './lib/brain-provenance.mjs';
import { BRAIN_MESH_BUILD, brainAssetPaths } from './lib/brain-asset-paths.mjs';

const GATE = 'mesh assets';
const MIN_AXIS_SHARE = 0.5;
const AREA_RATIO = [0.75, 1.25];
/** structures.json rounds error figures to 3 decimals; allow that and nothing more. */
const ERROR_TOLERANCE_MM = 0.0015;
const REPORT_DOC = join(REPO_ROOT, 'docs', 'brain-mesh-report.md');

const attribution = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'atlas-assets', 'attribution.json'), 'utf8'));
const pin = attribution.upstreamSources.find((s) => s.id === 'brainproject-brain-glb')?.pinned;
if (!pin) fail(GATE, ['attribution.json has no pinned brainproject-brain-glb source, so there is no brain mesh set to check.']);
const paths = brainAssetPaths(pin.commit);
const assets = join(REPO_ROOT, 'packages', 'atlas-assets');

const missingFiles = [paths.provenance, `${paths.dir}/structures.json`, `${paths.dir}/meshes.lowres.bin`, `${paths.dir}/meshes.fullres.bin`]
  .filter((p) => !existsSync(join(REPO_ROOT, p)));
if (missingFiles.length > 0) {
  // Absent is a failure, never "nothing to check": a gate that passes because
  // its subject was deleted is the cheapest way to make it go quiet.
  fail(GATE, [`Missing for brainproject ${pin.commit.slice(0, 7)}:`, ...missingFiles.map((p) => `  ${p}`),
    'Rebuild with `node tools/build-meshes.mjs --source <dir>`.']);
}

const provenance = JSON.parse(readFileSync(join(REPO_ROOT, paths.provenance), 'utf8'));
const doc = JSON.parse(readFileSync(join(assets, paths.structuresFile), 'utf8'));
const problems = [];
let low;
let full;
try {
  low = readMeshBin(readFileSync(join(assets, paths.lowFile)));
  full = readMeshBin(readFileSync(join(assets, paths.fullFile)));
} catch (err) {
  fail(GATE, [`A mesh file does not parse: ${err.message}`]);
}

// --- Presence: the shippable manifest against both files' own tables -------
const shippable = provenance.structures.filter((s) => s.group === GROUPS.cleared);
const byId = new Map(provenance.structures.map((s) => [s.id, s]));
for (const [tier, mesh] of [['low', low], ['full', full]]) {
  const ids = new Set(mesh.table.map((t) => t.id));
  for (const s of shippable) {
    if (!ids.has(s.id)) problems.push(`${s.name.trim()} (id ${s.id}) is in the source manifest but missing from the ${tier} tier.`);
  }
  for (const t of mesh.table) {
    if (!byId.has(t.id)) problems.push(`The ${tier} tier carries structure id ${t.id}, which the provenance manifest does not know.`);
  }
  if (ids.size !== mesh.table.length) problems.push(`The ${tier} tier lists a structure id more than once.`);
}
if (doc.structures.length !== low.table.length || doc.structures.length !== full.table.length) {
  problems.push(`structures.json lists ${doc.structures.length} structures; the tiers hold ${low.table.length} (low) and ${full.table.length} (full).`);
}
doc.structures.forEach((s, slot) => {
  if (s.slot !== slot || low.table[slot]?.id !== s.id || full.table[slot]?.id !== s.id) {
    problems.push(`structures.json slot ${slot} (${s.name}) does not match the table slot in both mesh files.`);
  }
});
if (doc.build?.floorTriangles !== BRAIN_MESH_BUILD.floorTriangles || doc.build?.ratio !== BRAIN_MESH_BUILD.ratio) {
  problems.push(`structures.json was built with ${JSON.stringify(doc.build)}, not ${JSON.stringify(BRAIN_MESH_BUILD)}.`);
}
if (problems.length > 0) fail(GATE, problems);

// --- Per structure ----------------------------------------------------------
const rows = [];
for (const [slot, s] of doc.structures.entries()) {
  const lg = structureGeometry(low, low.table[slot]);
  const fg = structureGeometry(full, full.table[slot]);
  const name = `${s.name} (id ${s.id})`;
  const lowTris = lg.indices.length / 3;
  const fullTris = fg.indices.length / 3;

  for (const [tier, g] of [['low', lg], ['full', fg]]) {
    const outOfRange = g.indices.some((i) => i >= g.positions.length / 3);
    if (outOfRange) problems.push(`${name}: the ${tier} tier indexes a vertex outside its own range.`);
    const deg = outOfRange ? 0 : degenerateTriangles(g.positions, g.indices);
    if (deg > 0) problems.push(`${name}: ${deg} degenerate triangle(s) in the ${tier} tier.`);
    if (g.indices.length === 0) problems.push(`${name}: the ${tier} tier has no triangles.`);
  }
  const required = Math.min(BRAIN_MESH_BUILD.floorTriangles, fullTris);
  if (lowTris < required) {
    problems.push(`${name}: ${lowTris} triangles in the low tier, under the floor of ${required}.`);
  }
  const lb = bounds(lg.positions);
  const fb = bounds(fg.positions);
  for (const [a, axis] of ['x', 'y', 'z'].entries()) {
    if (fb.extent[a] > 0 && lb.extent[a] < MIN_AXIS_SHARE * fb.extent[a]) {
      problems.push(`${name}: the low tier keeps ${(lb.extent[a] * 1000).toFixed(2)} mm of its ${(fb.extent[a] * 1000).toFixed(2)} mm ${axis} extent; it has collapsed toward a sliver.`);
    }
  }
  const lowArea = surfaceArea(lg.positions, lg.indices) * 1e6;
  const fullArea = surfaceArea(fg.positions, fg.indices) * 1e6;
  const ratio = lowArea / fullArea;
  if (!(ratio >= AREA_RATIO[0] && ratio <= AREA_RATIO[1])) {
    problems.push(`${name}: low-tier area is ${ratio.toFixed(2)}x the full tier's, outside [${AREA_RATIO.join(', ')}]. Decimation does not do that to a surface; something moved vertices.`);
  }

  const dev = surfaceDeviation({ positions: lg.positions, indices: lg.indices }, { positions: fg.positions, indices: fg.indices });
  const hausdorff = dev.hausdorff * 1000;
  const mean = dev.meanSymmetric * 1000;
  if (Math.abs(hausdorff - s.errorMm.hausdorff) > ERROR_TOLERANCE_MM || Math.abs(mean - s.errorMm.mean) > ERROR_TOLERANCE_MM) {
    problems.push(`${name}: structures.json publishes Hausdorff ${s.errorMm.hausdorff} mm / mean ${s.errorMm.mean} mm; the files measure ${hausdorff.toFixed(3)} / ${mean.toFixed(3)} mm.`);
  }
  if (s.low.triangles !== lowTris || s.full.triangles !== fullTris) {
    problems.push(`${name}: structures.json says ${s.low.triangles}/${s.full.triangles} triangles; the files hold ${lowTris}/${fullTris}.`);
  }
  rows.push({ s, lowTris, fullTris, hausdorff, mean, ratio, extentMm: Math.max(...fb.extent) * 1000 });
}

// --- The published report ----------------------------------------------------
const fmt = (x, d = 2) => x.toFixed(d);
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const pct = (xs, p) => sorted(xs)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const hs = rows.map((r) => r.hausdorff);
const byCategory = new Map();
for (const r of rows) {
  if (!byCategory.has(r.s.category)) byCategory.set(r.s.category, []);
  byCategory.get(r.s.category).push(r);
}
const reportLines = [
  '# Brain mesh report',
  '',
  `Generated by \`node tools/check-mesh-assets.mjs --report\` from the committed files of \`${paths.id}\`, and checked`,
  'against them on every CI run. Do not edit; rebuild. Every figure here is re-measured from the two mesh files.',
  '',
  `- **Structures:** ${rows.length} shipped (the cleared group); ${doc.excluded.length} held and listed by name in \`structures.json\` \`excluded\`.`,
  `- **Low tier:** ${doc.tiers.low.gzipBytes.toLocaleString('en')} B gzip, ${rows.reduce((n, r) => n + r.lowTris, 0).toLocaleString('en')} triangles. **Full tier:** ${doc.tiers.full.gzipBytes.toLocaleString('en')} B gzip, ${rows.reduce((n, r) => n + r.fullTris, 0).toLocaleString('en')} triangles.`,
  `- **Decimation:** ratio ${BRAIN_MESH_BUILD.ratio}, floor ${BRAIN_MESH_BUILD.floorTriangles} triangles, every structure meets it.`,
  `- **Geometric error, low vs full tier** (symmetric Hausdorff, mesh-frame mm): median ${fmt(pct(hs, 0.5))}, p95 ${fmt(pct(hs, 0.95))}, max ${fmt(Math.max(...hs))}.`,
  `- **Quantisation step:** ${fmt(doc.frame.quantisation.quantisationStepMm, 4)} mm, both tiers.`,
  '',
  'Mesh-frame millimetres are the Z-Anatomy model\'s own, not MNI millimetres. The MNI-to-mesh affine,',
  'its scale and its residuals are in `packages/atlas-assets/registration/`.',
  '',
  '## By category',
  '',
  '| category | structures | low triangles | Hausdorff median (mm) | Hausdorff max (mm) |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...[...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, rs]) =>
    `| ${c} | ${rs.length} | ${rs.reduce((n, r) => n + r.lowTris, 0)} | ${fmt(pct(rs.map((r) => r.hausdorff), 0.5))} | ${fmt(Math.max(...rs.map((r) => r.hausdorff)))} |`),
  '',
  '## Every structure',
  '',
  '| id | structure | category | full tris | low tris | Hausdorff (mm) | mean (mm) | area low/full |',
  '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map((r) => `| ${r.s.id} | ${r.s.name} | ${r.s.category} | ${r.fullTris} | ${r.lowTris} | ${fmt(r.hausdorff, 3)} | ${fmt(r.mean, 3)} | ${fmt(r.ratio, 3)} |`),
  '',
];
const reportText = `${reportLines.join('\n')}`;

if (process.argv.includes('--report')) {
  process.stdout.write(reportText);
  process.exit(0);
}
if (process.argv.includes('--write-report')) writeFileSync(REPORT_DOC, reportText);

if (!existsSync(REPORT_DOC)) problems.push('docs/brain-mesh-report.md is missing. Write it with `node tools/check-mesh-assets.mjs --write-report`.');
else if (readFileSync(REPORT_DOC, 'utf8') !== reportText) {
  problems.push('docs/brain-mesh-report.md is not what the committed mesh files measure. Regenerate it with `node tools/check-mesh-assets.mjs --write-report`.');
}

if (problems.length > 0) fail(GATE, problems);

pass(GATE, [
  `${paths.id}: ${rows.length} of ${shippable.length} shippable structures in both tiers; ${doc.excluded.length} held structures in neither.`,
  `Floor ${BRAIN_MESH_BUILD.floorTriangles} met by all; no degenerate triangle; no sliver; area low/full ${fmt(Math.min(...rows.map((r) => r.ratio)))}-${fmt(Math.max(...rows.map((r) => r.ratio)))}.`,
  `Published error re-measured for all ${rows.length}: Hausdorff median ${fmt(pct(hs, 0.5))} mm, max ${fmt(Math.max(...hs))} mm.`,
]);
