/**
 * The ICBM152 2009c cortex gate (DOG-151): the shipped low tier is a clean
 * surface, its published figures are what the file holds, its lobe labels are
 * bound to it and first-party, and the cerebellar cut is never called
 * validated.
 *
 *   node tools/check-icbm-cortex.mjs                 gate
 *   node tools/check-icbm-cortex.mjs --write-report  regenerate docs/brain-cortex-icbm.md
 *
 * Works from the committed files alone; it never needs the template volumes.
 * What it cannot re-measure without them, it says it does not re-measure: the
 * low tier's error against the undecimated surface, and the leak count, are
 * build-time figures (tools/build-icbm-cortex.mjs), checked here for presence,
 * shape and internal consistency only.
 *
 * Per hemisphere, in cortex.lowres.bin:
 *
 *   manifold        0 non-manifold edges: every edge in exactly two triangles.
 *                   The acceptance criterion; verify-gates stages a breach.
 *   wound           0 inconsistently wound edges
 *   not degenerate  no zero-area or repeated-vertex triangle; indices in range
 *   as published    triangle and vertex counts, area and enclosed volume match
 *                   structures.json
 *
 * And: the set is natively MNI152 2009c asymmetric with an identity mapping;
 * lobes.json names the mesh by SHA-256, has one label per vertex, all six lobes
 * per hemisphere, the label strings the crosswalk targets, and per boundary the
 * landmark, its placement and its coordinates; it declares no third-party
 * parcellation; and the leak record says the cut is not validated.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { REPO_ROOT, fail, pass } from './lib/repo.mjs';
import { readMeshBin, structureGeometry } from './lib/meshbin.mjs';
import { degenerateTriangles, surfaceArea } from './lib/mesh-geometry.mjs';
import { manifoldReport, signedVolume } from './lib/marching-cubes.mjs';

const GATE = 'icbm cortex';
const ASSETS = join(REPO_ROOT, 'packages', 'atlas-assets');
const SET = 'brain/icbm152-2009c';
const FILES = {
  low: `${SET}/cortex.lowres.bin`,
  structures: `${SET}/structures.json`,
  lobes: `${SET}/lobes.json`,
  provenance: 'provenance/icbm152-2009c-cortex.json',
};
const REPORT_DOC = join(REPO_ROOT, 'docs', 'brain-cortex-icbm.md');
const SPACE = 'MNI152 2009c asymmetric';
/** The label strings the W5 crosswalk targets (DOG-130), exactly. */
const LOBE_LABELS = ['Frontal lobe', 'Parietal lobe', 'Temporal lobe', 'Occipital lobe', 'Insula', 'Limbic lobe'];
/** The landmarks the brief names (DOG-151, criterion 4); each must be recorded per hemisphere. */
const REQUIRED_LANDMARKS = ['central sulcus', 'lateral fissure', 'parieto-occipital sulcus', 'preoccipital notch', 'cingulate sulcus', 'circular sulcus'];
const SIDE_SUFFIX = { left: 'l', right: 'r' };

const missing = Object.values(FILES).filter((f) => !existsSync(join(ASSETS, f)));
if (missing.length > 0) {
  // Absent is a failure, never "nothing to check".
  fail(GATE, ['Missing:', ...missing.map((f) => `  packages/atlas-assets/${f}`), 'Rebuild with `node tools/build-icbm-cortex.mjs --icbm <dir>`.']);
}

const problems = [];
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const lowBytes = readFileSync(join(ASSETS, FILES.low));
const doc = JSON.parse(readFileSync(join(ASSETS, FILES.structures), 'utf8'));
const lobes = JSON.parse(readFileSync(join(ASSETS, FILES.lobes), 'utf8'));
const provenance = JSON.parse(readFileSync(join(ASSETS, FILES.provenance), 'utf8'));
let mesh;
try {
  mesh = readMeshBin(lowBytes);
} catch (err) {
  fail(GATE, [`${FILES.low} does not parse: ${err.message}`]);
}

// --- The set: space, mapping, tier record ------------------------------------
if (doc.schema !== 'atlas-brain-structures/1') problems.push(`structures.json schema is ${JSON.stringify(doc.schema)}.`);
if (doc.source?.kind !== 'volume' || doc.source?.upstream !== 'icbm152-2009c') problems.push('structures.json does not name the icbm152-2009c volume as its source.');
if (doc.frame?.space !== SPACE) problems.push(`structures.json frame.space is ${JSON.stringify(doc.frame?.space)}, not ${JSON.stringify(SPACE)}.`);
if (doc.mapping?.toMni152_2009cAsym !== 'identity' || doc.mapping?.errorMm !== 0 || doc.mapping?.affine !== null) {
  problems.push('structures.json does not declare the identity mapping to MNI152 2009c asymmetric (no affine, 0 mm): the surface is native to that space.');
}
const tier = doc.tiers?.low;
if (!tier || tier.file !== FILES.low) problems.push('structures.json has no low tier record for cortex.lowres.bin.');
else {
  if (tier.bytes !== lowBytes.length) problems.push(`structures.json says ${tier.bytes} B; the file is ${lowBytes.length} B.`);
  if (tier.sha256 !== sha256(lowBytes)) problems.push('structures.json records a different SHA-256 for cortex.lowres.bin than the file has.');
  if (tier.gzipBytes !== gzipSync(lowBytes, { level: 9 }).length) problems.push('structures.json records a different gzip size for cortex.lowres.bin than the file has.');
  if (tier.loading !== 'eager') problems.push(`the low tier is declared ${JSON.stringify(tier.loading)}; it is the eager tier.`);
}
if (Object.keys(doc.tiers ?? {}).some((k) => k !== 'low')) problems.push('structures.json declares a tier other than low; no other tier ships (DOG-151).');
if (!/Copyright \(C\) 1993-2004 Louis Collins/.test(doc.licence?.copying ?? '')) problems.push('structures.json does not carry the archive\'s COPYING notice, which must appear in all copies.');

// --- Per hemisphere: the geometry -------------------------------------------
if (doc.structures.length !== mesh.table.length) problems.push(`structures.json lists ${doc.structures.length} structures; the file holds ${mesh.table.length}.`);
const rows = [];
for (const [slot, s] of doc.structures.entries()) {
  const entry = mesh.table[slot];
  const name = `${s.name} (id ${s.id})`;
  if (!entry || entry.id !== s.id) {
    problems.push(`${name}: not at table slot ${slot} in cortex.lowres.bin.`);
    continue;
  }
  const g = structureGeometry(mesh, entry);
  const n = g.positions.length / 3;
  if (g.indices.some((i) => i >= n)) {
    problems.push(`${name}: indexes a vertex outside its own range.`);
    continue;
  }
  const m = manifoldReport(g.indices);
  if (m.nonManifoldEdges !== 0) {
    problems.push(`${name}: ${m.nonManifoldEdges} non-manifold edge(s) (${m.openEdges} open, ${m.overSharedEdges} in more than two triangles). The shipped tier must have none.`);
  }
  if (m.inconsistentlyWoundEdges !== 0) problems.push(`${name}: ${m.inconsistentlyWoundEdges} inconsistently wound edge(s).`);
  const deg = degenerateTriangles(g.positions, g.indices);
  if (deg !== 0) problems.push(`${name}: ${deg} degenerate triangle(s).`);
  const tris = g.indices.length / 3;
  if (s.low?.triangles !== tris || s.low?.vertices !== n) problems.push(`${name}: structures.json says ${s.low?.triangles} triangles / ${s.low?.vertices} vertices; the file holds ${tris} / ${n}.`);
  const area = surfaceArea(g.positions, g.indices);
  const volume = signedVolume(g.positions, g.indices) / 1000;
  if (Math.abs(area - s.low?.areaMm2) > 1) problems.push(`${name}: structures.json says ${s.low?.areaMm2} mm^2; the file measures ${area.toFixed(0)}.`);
  if (Math.abs(volume - s.low?.enclosedVolumeCm3) > 0.1) problems.push(`${name}: structures.json says ${s.low?.enclosedVolumeCm3} cm^3 enclosed; the file measures ${volume.toFixed(1)}.`);
  if (!(Number.isFinite(s.errorMm?.hausdorff) && Number.isFinite(s.errorMm?.mean))) problems.push(`${name}: no published error against the undecimated surface.`);
  rows.push({ s, tris, n, m, area, volume });
}

// --- The labels --------------------------------------------------------------
if (lobes.schema !== 'atlas-brain-labels/1') problems.push(`lobes.json schema is ${JSON.stringify(lobes.schema)}.`);
if (lobes.geometry?.file !== FILES.low || lobes.geometry?.sha256 !== sha256(lowBytes)) {
  problems.push('lobes.json is not bound to the committed cortex.lowres.bin (file and SHA-256): its per-vertex labels would be read against other geometry.');
}
if (lobes.licence?.firstParty !== true || lobes.licence?.id !== 'Apache-2.0') problems.push('lobes.json does not declare itself first-party Apache-2.0.');
if (!Array.isArray(lobes.licence?.thirdPartyParcellationsUsed) || lobes.licence.thirdPartyParcellationsUsed.length !== 0) {
  problems.push(`lobes.json declares third-party parcellations used: ${JSON.stringify(lobes.licence?.thirdPartyParcellationsUsed)}. The lobe labels are drawn from landmarks only (DOG-151); a parcellation is a separate label set.`);
}
const values = new Map((lobes.values ?? []).map((v) => [v.value, v]));
for (const [k, label] of LOBE_LABELS.entries()) {
  if (values.get(k + 1)?.label !== label) problems.push(`lobes.json value ${k + 1} is ${JSON.stringify(values.get(k + 1)?.label)}, not ${JSON.stringify(label)}.`);
}
const labelCounts = {};
for (const r of rows) {
  const id = r.s.id;
  const labels = lobes.vertexLabels?.[String(id)];
  if (typeof labels !== 'string' || labels.length !== r.n) {
    problems.push(`lobes.json has ${labels?.length ?? 'no'} labels for structure ${id}; it has ${r.n} vertices.`);
    continue;
  }
  if (/[^0-6]/.test(labels)) problems.push(`lobes.json labels for structure ${id} hold a value outside 0-6.`);
  const counts = Array(7).fill(0);
  for (const ch of labels) counts[Number(ch)] += 1;
  labelCounts[r.s.side] = counts;
  for (let v = 1; v <= 6; v += 1) {
    if (counts[v] === 0) problems.push(`${r.s.side} hemisphere: no vertex is labelled ${LOBE_LABELS[v - 1]}.`);
  }
  for (const [k, label] of LOBE_LABELS.entries()) {
    const want = `${label}.${SIDE_SUFFIX[r.s.side]}`;
    const st = (lobes.structures ?? []).find((x) => x.name === want);
    if (!st) problems.push(`lobes.json has no structure ${want}.`);
    else if (st.label !== label || st.side !== r.s.side || st.geometryStructure !== id || st.value !== k + 1 || st.vertices !== counts[k + 1]) {
      problems.push(`lobes.json structure ${want} does not match its labels (label, side, geometry structure, value or vertex count).`);
    }
  }
  // Provenance per boundary.
  const p = lobes.provenance?.[r.s.side];
  if (!p || !Array.isArray(p.boundaries) || p.boundaries.length === 0) {
    problems.push(`lobes.json records no boundary provenance for the ${r.s.side} hemisphere.`);
    continue;
  }
  const isPoint = (x) => Array.isArray(x) && x.length === 3 && x.every(Number.isFinite);
  for (const b of p.boundaries) {
    if (typeof b.landmark !== 'string' || typeof b.placement !== 'string' || typeof b.coordinates !== 'string' || !/MNI152 2009c/.test(b.coordinates)) {
      problems.push(`${r.s.side} ${b.key}: the boundary does not record its landmark, its placement and its coordinate space.`);
    }
    if (!Array.isArray(b.controlPoints) || b.controlPoints.length < 2 || !b.controlPoints.every((c) => isPoint(c.givenMni) && isPoint(c.snappedMni))) {
      problems.push(`${r.s.side} ${b.key}: the boundary does not record its control points as given and as placed, in coordinates.`);
    }
  }
  const named = [...p.boundaries.map((b) => b.landmark), p.insula?.landmark ?? ''].join(' | ');
  for (const l of REQUIRED_LANDMARKS) {
    if (!named.includes(l)) problems.push(`${r.s.side} hemisphere: no boundary is drawn from the ${l}.`);
  }
}

// --- The cerebellar leak -----------------------------------------------------
const leak = doc.cerebellarLeak;
if (!leak) problems.push('structures.json publishes no cerebellar leak count.');
else {
  if (leak.cutValidated !== false) {
    problems.push(`structures.json labels the cerebrum cut validated (cutValidated ${JSON.stringify(leak.cutValidated)}). Nothing has validated it: the leak is counted against one imperfect reference.`);
  }
  if (typeof leak.method !== 'string' || typeof leak.limitation !== 'string') problems.push('the leak record does not state its method and its limitation.');
  for (const r of rows) {
    const c = leak.shippedLowTier?.[r.s.side];
    const ok = c && [c.vertices, c.inside, c.deeperThan4Mm, c.deeperThanHeldOutError].every(Number.isInteger)
      && c.vertices === r.n && c.inside <= c.vertices && c.deeperThan4Mm <= c.inside && c.deeperThanHeldOutError <= c.deeperThan4Mm;
    if (!ok) problems.push(`the ${r.s.side} leak count is missing, or is not a count of this file's ${r.n} vertices.`);
  }
}

// --- The report --------------------------------------------------------------
const fmt = (x) => x.toLocaleString('en');
const hem = (side) => provenance.hemispheres.find((h) => h.name === side);
const reportLines = [
  '# ICBM152 2009c cortex and its lobe labels',
  '',
  'Generated by `node tools/check-icbm-cortex.mjs --write-report` from the committed files, and checked against them on',
  'every CI run. Do not edit; rebuild with `node tools/build-icbm-cortex.mjs --icbm <dir>`. The build\'s decisions are in',
  'its header; this page is what the files say.',
  '',
  '## The surface',
  '',
  `- **Source:** \`icbm152-2009c\`, the ICBM 152 non-linear 2009c asymmetric template (MNI BIC permissive licence, its COPYING`,
  '  carried in `structures.json`).',
  `- **Space:** ${SPACE}, natively. The surface was extracted in the template's own sform, so a coordinate in that space needs`,
  '  no mapping: `mapping.toMni152_2009cAsym` is `identity`, 0 mm.',
  `- **Field:** ${doc.build.field}.`,
  `- **Low tier:** \`${FILES.low}\`, ${fmt(tier.bytes)} B, ${fmt(tier.gzipBytes)} B gzip. No full tier ships.`,
  '',
  '| hemisphere | triangles | vertices | non-manifold edges | area (cm²) | enclosed (cm³) | Hausdorff vs full (mm) | mean (mm) |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map((r) => `| ${r.s.side} | ${fmt(r.tris)} | ${fmt(r.n)} | ${r.m.nonManifoldEdges} | ${(r.area / 100).toFixed(1)} | ${r.volume.toFixed(1)} | ${r.s.errorMm.hausdorff} | ${r.s.errorMm.mean} |`),
  '',
  'The error is against the undecimated extracted surface, measured at build time. That surface is not in the repository',
  '(about 8.6 MB gzip), so CI checks the figure is published but cannot re-measure it.',
  '',
  '## The lobe labels',
  '',
  '`lobes.json` is its own file and its own attribution entry: first-party, Apache-2.0, drawn by us from landmarks placed on',
  `this surface. It declares \`thirdPartyParcellationsUsed: []\`. Vertices per label in the shipped tier:`,
  '',
  '| hemisphere | not cortex | frontal | parietal | temporal | occipital | insula | limbic |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...Object.entries(labelCounts).map(([side, c]) => `| ${side} | ${c.map(fmt).join(' | ')} |`),
  '',
  `Conventions: limbic is ${lobes.conventions.limbic}. Insula is ${lobes.conventions.insula}. The paracentral lobule: ${lobes.conventions.paracentral}.`,
  '',
  'Boundaries, per hemisphere (control points, given and placed, are in `lobes.json`; the traced polylines in',
  `\`packages/atlas-assets/${FILES.provenance}\`):`,
  '',
  '| hemisphere | boundary | landmark | drawn as | points | length (mm) | mean depth (mm) |',
  '| --- | --- | --- | --- | ---: | ---: | ---: |',
  ...Object.entries(lobes.provenance).flatMap(([side, p]) => p.boundaries.map((b) => `| ${side} | ${b.key} | ${b.landmark} | ${b.kind} | ${b.controlPoints.length} | ${b.lengthMm} | ${b.meanDepthMm} |`)),
  '',
  'How well the boundaries close, on the full surface (`open fronts`: edges where two lobes met with no boundary between',
  'them; `fragments`: pieces of a lobe beyond its largest):',
  '',
  '| hemisphere | open-front edges | lobe fragments beyond the largest (vertices) |',
  '| --- | ---: | --- |',
  ...['left', 'right'].map((side) => {
    const h = hem(side).lobes;
    const fronts = Object.values(h.openFronts).reduce((s, f) => s + f.edges, 0);
    const frags = Object.entries(h.fragments).flatMap(([k, f]) => f.slice(1).map((x) => `${k} ${x.vertices}`)).join(', ') || 'none';
    return `| ${side} | ${fmt(fronts)} | ${frags} |`;
  }),
  '',
  'Boundary accuracy has no independent measurement for this template. Consumers should carry it as unstated.',
  '',
  '## The cerebellar leak',
  '',
  `**The cerebrum cut is not validated.** ${leak.limitation}`,
  '',
  `Method: ${leak.method}.`,
  '',
  `| shipped tier | vertices | inside the reference | deeper than 4 mm | deeper than ${provenance.cerebellarLeak.reference.heldOutErrorMm} mm |`,
  '| --- | ---: | ---: | ---: | ---: |',
  ...rows.map((r) => { const c = leak.shippedLowTier[r.s.side]; return `| ${r.s.side} | ${fmt(c.vertices)} | ${fmt(c.inside)} | ${fmt(c.deeperThan4Mm)} | ${fmt(c.deeperThanHeldOutError)} |`; }),
  '',
  `The reference's own placement: of its ${fmt(leak.referencePlacement.referenceVertices)} vertices carried into MNI space,`,
  `${fmt(leak.referencePlacement.inRemovedTissue)} land in tissue the cut removed, ${fmt(leak.referencePlacement.inKeptCerebrum)} in the kept cerebrum and`,
  `${fmt(leak.referencePlacement.outsideTissue)} outside tissue. The ones in the kept cerebrum are leak, or registration error, or both;`,
  'this build cannot tell which.',
  '',
];
const reportText = reportLines.join('\n');
if (process.argv.includes('--write-report')) writeFileSync(REPORT_DOC, reportText);
if (!existsSync(REPORT_DOC)) problems.push('docs/brain-cortex-icbm.md is missing. Write it with `node tools/check-icbm-cortex.mjs --write-report`.');
else if (readFileSync(REPORT_DOC, 'utf8') !== reportText) {
  problems.push('docs/brain-cortex-icbm.md is not what the committed files say. Regenerate it with `node tools/check-icbm-cortex.mjs --write-report`.');
}

if (problems.length > 0) fail(GATE, problems);

pass(GATE, [
  `cortex.lowres.bin: ${rows.length} structures, ${rows.map((r) => `${r.s.side} ${fmt(r.tris)} triangles`).join(', ')}; 0 non-manifold edges, 0 inconsistently wound, 0 degenerate.`,
  `Native ${SPACE}, identity mapping; published counts, area and volume match the file.`,
  `lobes.json bound to the mesh by SHA-256; all 6 lobes in both hemispheres; ${Object.values(lobes.provenance).reduce((s, p) => s + p.boundaries.length, 0)} boundaries with landmark, placement and coordinates; no third-party parcellation.`,
  `Cerebellar leak published with its method; the cut is labelled not validated. Not re-measured here: the error against the full surface and the leak (build-time; they need the template volumes).`,
]);
