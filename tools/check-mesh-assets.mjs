/**
 * The brain mesh gate: no structure is lost to decimation, none is degenerate,
 * and every published error figure is what the committed files actually say.
 *
 *   node tools/check-mesh-assets.mjs            gate
 *   node tools/check-mesh-assets.mjs --report        print docs/brain-mesh-report.md
 *   node tools/check-mesh-assets.mjs --body-report   print docs/body-mesh-report.md
 *   node tools/check-mesh-assets.mjs --write-report  write both
 *
 * The body (DOG-128) is checked by tools/lib/body-mesh-gate.mjs, with the same
 * per-structure checks (tools/lib/mesh-tier-checks.mjs) and its own
 * registration to BD.
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
 *
 * And per shipped structure, in the full tier (DOG-238):
 *
 *   in the cortex   carried into MNI by the registration, no vertex more than
 *                   3 mm outside the ICBM cortex where nothing of the cortex is
 *                   above it (tools/lib/brain-cortex-containment.mjs), and the
 *                   committed containment result says exactly what this measures
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, fail, pass } from './lib/repo.mjs';
import { readMeshBin } from './lib/meshbin.mjs';
import { checkStructures, checkTables } from './lib/mesh-tier-checks.mjs';
import { GROUPS, verifyProvenance } from './lib/brain-provenance.mjs';
import { BRAIN_MESH_BUILD, brainAssetPaths } from './lib/brain-asset-paths.mjs';
import { HELD_OUT, LANDMARKS, MAX_OPEN_EDGE_SHARE, evaluate, meshGeometries, volumeCentroid } from './lib/brain-registration.mjs';
import { checkSample } from './lib/brain-qa-sample.mjs';
import { CONTAINMENT, cortexReference, measureMeshSet, outsideCortex } from './lib/brain-cortex-containment.mjs';
import { checkBodyMeshes } from './lib/body-mesh-gate.mjs';

const GATE = 'mesh assets';
const REPORT_DOC = join(REPO_ROOT, 'docs', 'brain-mesh-report.md');

const attribution = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'atlas-assets', 'attribution.json'), 'utf8'));
const pin = attribution.upstreamSources.find((s) => s.id === 'brainproject-brain-glb')?.pinned;
if (!pin) fail(GATE, ['attribution.json has no pinned brainproject-brain-glb source, so there is no brain mesh set to check.']);
const paths = brainAssetPaths(pin.commit);
const assets = join(REPO_ROOT, 'packages', 'atlas-assets');

const missingFiles = [paths.provenance, paths.containment, `${paths.dir}/structures.json`, `${paths.dir}/meshes.lowres.bin`, `${paths.dir}/meshes.fullres.bin`]
  .filter((p) => !existsSync(join(REPO_ROOT, p)));
if (missingFiles.length > 0) {
  // Absent is a failure, never "nothing to check": a gate that passes because
  // its subject was deleted is the cheapest way to make it go quiet.
  fail(GATE, [`Missing for brainproject ${pin.commit.slice(0, 7)}:`, ...missingFiles.map((p) => `  ${p}`),
    'Rebuild with `node tools/build-meshes.mjs --source <dir>`.']);
}

const provenance = JSON.parse(readFileSync(join(REPO_ROOT, paths.provenance), 'utf8'));
const containment = JSON.parse(readFileSync(join(REPO_ROOT, paths.containment), 'utf8'));
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

// --- The manifest itself: re-derived, not taken as given ----------------------
// Only build-meshes.mjs writes it, and that needs the glb, so nothing else would
// notice a record hand-edited to `cleared`. Every group and source is derived
// again here from the inputs the manifest records.
const ORIGIN_RESULT = join(assets, 'provenance', 'origin-test-bodyparts3d.json');
if (!existsSync(ORIGIN_RESULT)) fail(GATE, ['packages/atlas-assets/provenance/origin-test-bodyparts3d.json is missing; the provenance manifest cannot be re-derived without it.']);
for (const p of verifyProvenance(provenance, JSON.parse(readFileSync(ORIGIN_RESULT, 'utf8')), containment)) problems.push(`provenance: ${p}`);

// --- Presence: the shippable manifest against both files' own tables -------
const shippable = provenance.structures.filter((s) => s.group === GROUPS.cleared);
const byId = new Map(provenance.structures.map((s) => [s.id, s]));
for (const [tier, mesh] of [['low', low], ['full', full]]) {
  const ids = new Set(mesh.table.map((t) => t.id));
  for (const s of shippable) {
    if (!ids.has(s.id)) problems.push(`${s.name.trim()} (id ${s.id}) is in the source manifest but missing from the ${tier} tier.`);
  }
  for (const t of mesh.table) {
    const rec = byId.get(t.id);
    if (!rec) problems.push(`The ${tier} tier carries structure id ${t.id}, which the provenance manifest does not know.`);
    else if (rec.group !== GROUPS.cleared) problems.push(`The ${tier} tier carries ${rec.name.trim()} (id ${t.id}), which is held as ${rec.group}.`);
  }
}
problems.push(...checkTables({ doc, low, full }));
if (doc.build?.floorTriangles !== BRAIN_MESH_BUILD.floorTriangles || doc.build?.ratio !== BRAIN_MESH_BUILD.ratio) {
  problems.push(`structures.json was built with ${JSON.stringify(doc.build)}, not ${JSON.stringify(BRAIN_MESH_BUILD)}.`);
}
if (problems.length > 0) fail(GATE, problems);

// --- Per structure ----------------------------------------------------------
// tools/lib/mesh-tier-checks.mjs: the same checks the body is held to.
const checked = checkStructures({ doc, low, full, floorTriangles: BRAIN_MESH_BUILD.floorTriangles, mmPerUnit: 1000 });
problems.push(...checked.problems);
const rows = checked.rows;

// --- The registration: everything but the MNI centroids is re-derived ---------
// The MNI side needs the CIT168 volume, which is not in the repository; its
// digest is recorded in the file. Everything else (the mesh centroids, the
// affine, every residual) is recomputed here from the committed full tier and
// compared, so the published held-out error is a measurement, not a claim.
const REG_FILE = join(assets, 'registration', `mni-to-${paths.id}.json`);
let reg = null;
if (!existsSync(REG_FILE)) {
  problems.push(`packages/atlas-assets/registration/mni-to-${paths.id}.json is missing. Fit it with tools/fit-brain-registration.mjs.`);
} else {
  reg = JSON.parse(readFileSync(REG_FILE, 'utf8'));
  const fullBytes = readFileSync(join(assets, paths.fullFile));
  const expected = [...LANDMARKS.flatMap((l) => ['l', 'r'].map((side) => ({ l, side, held: false }))),
    ...HELD_OUT.flatMap((l) => ['l', 'r'].map((side) => ({ l, side, held: true })))];
  const recorded = [...reg.landmarks, ...reg.heldOut];
  if (recorded.length !== expected.length) problems.push(`registration: ${recorded.length} landmarks recorded, ${expected.length} defined.`);
  const fit = [];
  const held = [];
  for (const { l, side, held: isHeld } of expected) {
    const id = `${l.key}.${side}`;
    const rec = (isHeld ? reg.heldOut : reg.landmarks).find((x) => x.id === id);
    if (!rec) {
      problems.push(`registration: ${id} is defined as a ${isHeld ? 'held-out pair' : 'landmark'} but not recorded as one.`);
      continue;
    }
    const m = volumeCentroid(meshGeometries(fullBytes, doc, l.mesh[side]));
    if (m.boundaryEdges > MAX_OPEN_EDGE_SHARE * m.edges) problems.push(`registration: ${id}'s surface is open (${m.boundaryEdges} of ${m.edges} edges).`);
    if (m.centroid.some((x, k) => Math.abs(x - rec.meshM[k]) > 1e-6)) {
      problems.push(`registration: ${id}'s mesh centroid is recorded as ${rec.meshM.join(', ')}; the committed mesh gives ${m.centroid.map((x) => x.toFixed(7)).join(', ')}.`);
    }
    // Fit from the recorded centroid, just checked against the mesh: the file
    // fitted from exactly these rounded values.
    (isHeld ? held : fit).push({ id, mniMm: rec.mniMm, meshM: rec.meshM });
  }
  if (fit.length === reg.landmarks.length && held.length === reg.heldOut.length) {
    const r = evaluate(fit, held);
    const close = (a, b, tol) => Math.abs(a - b) <= tol;
    if (!r.mniToMesh.every((row, i) => row.every((x, j) => close(x, reg.mniToMesh[i][j], 1e-8)))) {
      problems.push('registration: mniToMesh is not the least-squares fit of the recorded landmarks.');
    }
    for (const [list, key, got] of [[reg.landmarks, 'residualMm', r.inSample], [reg.landmarks, 'leaveOneOutMm', r.loo], [reg.heldOut, 'errorMm', r.heldOut]]) {
      for (const g of got) {
        const rec = list.find((x) => x.id === g.id);
        if (!close(g.mm, rec[key], 0.006)) problems.push(`registration: ${g.id} records ${key} ${rec[key]}; refitting gives ${g.mm.toFixed(2)}.`);
      }
    }
  }
}

// --- The cortex containment (DOG-238): re-measured for everything that ships ---
// The result is measured against one registration and one cortex; if either has
// changed since, every figure in it is stale, whatever the mesh says.
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const icbmDoc = JSON.parse(readFileSync(join(assets, 'brain', 'icbm152-2009c', 'structures.json'), 'utf8'));
const icbmBytes = readFileSync(join(assets, icbmDoc.tiers.low.file));
const containmentInputs = {
  cortex: { file: icbmDoc.tiers.low.file, sha256: sha256(icbmBytes) },
  registration: { file: `registration/mni-to-${paths.id}.json`, sha256: existsSync(REG_FILE) ? sha256(readFileSync(REG_FILE)) : null },
};
for (const [k, want] of Object.entries(containmentInputs)) {
  const got = containment.inputs?.[k];
  if (got?.file !== want.file || got?.sha256 !== want.sha256) {
    problems.push(`cortex containment: measured against ${k} ${got?.file} ${got?.sha256?.slice(0, 12)}; the committed one is ${want.file} ${want.sha256?.slice(0, 12)}. Rebuild with tools/build-meshes.mjs.`);
  }
}
if (JSON.stringify(containment.rule) !== JSON.stringify({ ...CONTAINMENT, tier: 'full' })) {
  problems.push(`cortex containment: measured under ${JSON.stringify(containment.rule)}, not the rule in tools/lib/brain-cortex-containment.mjs. Rebuild.`);
}
const containmentRows = reg ? measureMeshSet(cortexReference(icbmDoc, icbmBytes), readFileSync(join(assets, paths.fullFile)), doc.structures, reg.meshToMni) : [];
const FIELDS = ['vertices', 'outside', 'beyond', 'overTolerance', 'beyondMaxMm', 'underMaxMm'];
for (const got of containmentRows) {
  const rec = containment.structures.find((r) => r.id === got.id);
  if (!rec) problems.push(`cortex containment: ${got.name} ships but has no row; it was never measured.`);
  else {
    const off = FIELDS.filter((k) => rec[k] !== got[k]);
    if (off.length > 0) problems.push(`cortex containment: ${got.name} records ${off.map((k) => `${k} ${rec[k]}`).join(', ')}; the committed full tier gives ${off.map((k) => got[k]).join(', ')}.`);
  }
  if (outsideCortex(got)) {
    problems.push(`cortex containment: ${got.name} (${got.category}) ships with a vertex ${got.beyondMaxMm} mm outside the ICBM cortex, past the ${CONTAINMENT.toleranceMm} mm tolerance. It is drawn poking out of the brain; hold it.`);
  }
}
const heldOutside = containment.structures.filter(outsideCortex).sort((a, b) => b.beyondMaxMm - a.beyondMaxMm);
const nearest = containmentRows.filter((r) => r.beyondMaxMm > 0).sort((a, b) => b.beyondMaxMm - a.beyondMaxMm);
const excused = containmentRows.filter((r) => r.underMaxMm > CONTAINMENT.toleranceMm).sort((a, b) => b.underMaxMm - a.underMaxMm);

// --- The QA sample: checked against its rules and against what ships ----------
const SAMPLE_FIXTURE = join(REPO_ROOT, 'packages', 'atlas-qa', 'fixtures', 'brain-structure-sample.json');
let sample = null;
if (!existsSync(SAMPLE_FIXTURE)) {
  problems.push('packages/atlas-qa/fixtures/brain-structure-sample.json is missing. Draw it once with tools/draw-brain-qa-sample.mjs.');
} else {
  sample = JSON.parse(readFileSync(SAMPLE_FIXTURE, 'utf8'));
  for (const p of checkSample(sample, doc)) problems.push(`QA sample: ${p}`);
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
  ...(reg
    ? [
        '',
        '## Registration: MNI to this mesh',
        '',
        `Our own 12-parameter affine, fitted on ${reg.summary.landmarks} landmark centroids (Z-Anatomy surfaces against CIT168 in ICBM152 2009c) and`,
        're-derived from the committed full tier on every CI run. Errors are in MNI millimetres.',
        '',
        '| measure | mean (mm) | max (mm) |',
        '| --- | ---: | ---: |',
        `| in-sample residual | ${reg.summary.inSample.meanMm} | ${reg.summary.inSample.maxMm} |`,
        `| leave-one-out | ${reg.summary.leaveOneOut.meanMm} | ${reg.summary.leaveOneOut.maxMm} |`,
        `| **held out: red nucleus, L and R** | **${reg.summary.heldOut.meanMm}** | **${reg.summary.heldOut.maxMm}** |`,
        '',
        `Per-axis scale, mesh mm per MNI mm: ${reg.axisScaleMeshMmPerMniMm.join(', ')}. The held-out figure is the honest one,`,
        'and only near the deep grey nuclei. Every landmark is one, and the red nucleus sits just outside their',
        'hull, which is likely why it reads worse than leave-one-out. For structures far from that cluster (the',
        'cerebellum, pons and medulla, corpus callosum, and cortex) the error is extrapolated and unmeasured, and is',
        'likely larger. No coordinate carried onto this mesh is placed exactly.',
      ]
    : []),
  '',
  '## Containment in the ICBM cortex',
  '',
  'The cortex is ICBM152 2009c; every other structure is Z-Anatomy, carried into MNI by the affine above. A vertex is',
  '*beyond* the cortex when it is outside the closed cortex surface and nothing of the cortex lies above it (an upward',
  `ray from it, or from ${CONTAINMENT.roofOffsetMm} mm to any side, misses the cortex) and it is above the cortex's lowest point. A structure with a`,
  `vertex more than ${CONTAINMENT.toleranceMm} mm beyond is held as \`held-outside-cortex\`: it would be drawn poking out of the brain. The`,
  'rule is tools/lib/brain-cortex-containment.mjs; shipped structures are re-measured, full tier, on every CI run.',
  'A misplaced structure that stays inside or under the cortex is not caught by this rule.',
  '',
  '| held | category | vertices beyond | of which > tolerance | farthest beyond (MNI mm) |',
  '| --- | --- | ---: | ---: | ---: |',
  ...heldOutside.map((r) => `| ${r.name} | ${r.category} | ${r.beyond} | ${r.overTolerance} | ${fmt(r.beyondMaxMm)} |`),
  '',
  `Of what ships, ${nearest.length} structure(s) have any vertex beyond the cortex: ${nearest.map((r) => `${r.name} ${fmt(r.beyondMaxMm)} mm`).join(', ') || 'none'}.`,
  '',
  '**Excused, not measured against any limit.** A vertex outside the cortex but under it is not gated, so a structure',
  'displaced downward cannot be held by this rule (DOG-240 found the orbitofrontal ACA branches 8-13 mm below the orbital',
  'surface; they are held by decision). Every shipped structure with an excused vertex, above the cortex\'s lowest point,',
  `more than ${CONTAINMENT.toleranceMm} mm outside it, farthest first (${excused.length}). Most are the posterior fossa, the skull base and the basal`,
  'cisterns, outside the cerebrum by anatomy; anything that should lie on the cortex is a candidate misregistration to judge.',
  '',
  '| ships | category | farthest excused (MNI mm) |',
  '| --- | --- | ---: |',
  ...excused.map((r) => `| ${r.name} | ${r.category} | ${fmt(r.underMaxMm)} |`),
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

if (process.argv.includes('--body-report')) {
  const { reportText: text, problems: bodyProblems } = checkBodyMeshes();
  if (!text) fail(GATE, bodyProblems);
  process.stdout.write(text);
  process.exit(0);
}
if (process.argv.includes('--report')) {
  process.stdout.write(reportText);
  process.exit(0);
}
if (process.argv.includes('--write-report')) writeFileSync(REPORT_DOC, reportText);

if (!existsSync(REPORT_DOC)) problems.push('docs/brain-mesh-report.md is missing. Write it with `node tools/check-mesh-assets.mjs --write-report`.');
else if (readFileSync(REPORT_DOC, 'utf8') !== reportText) {
  problems.push('docs/brain-mesh-report.md is not what the committed mesh files measure. Regenerate it with `node tools/check-mesh-assets.mjs --write-report`.');
}

// --- The body (DOG-128): the same per-structure checks, plus its registration to BD
const body = checkBodyMeshes({ writeReport: process.argv.includes('--write-report') });
problems.push(...body.problems.map((p) => `body: ${p}`));

if (problems.length > 0) fail(GATE, problems);

pass(GATE, [
  `${paths.id}: provenance re-derived for all ${provenance.structures.length} structures;`
    + ` ${rows.length} of ${shippable.length} shippable structures in both tiers; ${doc.excluded.length} held structures in neither.`,
  `Floor ${BRAIN_MESH_BUILD.floorTriangles} met by all; no degenerate triangle; no sliver; area low/full ${fmt(Math.min(...rows.map((r) => r.ratio)))}-${fmt(Math.max(...rows.map((r) => r.ratio)))}.`,
  `Published error re-measured for all ${rows.length}: Hausdorff median ${fmt(pct(hs, 0.5))} mm, max ${fmt(Math.max(...hs))} mm.`,
  `Cortex containment re-measured for all ${containmentRows.length}: farthest beyond ${fmt(nearest[0]?.beyondMaxMm ?? 0)} mm, tolerance ${CONTAINMENT.toleranceMm} mm; ${heldOutside.length} held outside it.`,
  `Registration re-derived: held-out ${reg.summary.heldOut.maxMm} mm; QA sample ${sample.sample.length} structures,`
    + ` ${sample.withheldControls.length} withheld control(s), every rule met.`,
  ...body.pass,
]);
