/**
 * The body mesh gate (DOG-128), run by tools/check-mesh-assets.mjs beside the
 * brain's. Works from the committed files alone; it never needs BodyParts3D.
 *
 *   tiers           both files parse, and hold exactly structures.json, slot for slot
 *   per structure   the brain's checks, from the same module
 *                   (tools/lib/mesh-tier-checks.mjs): floor, no degenerate
 *                   triangle, no sliver, area within [0.75, 1.25], published
 *                   error re-measured
 *   manifest        every structure cites BodyParts3D and nothing else; no element
 *                   file is in two structures, or in a structure and the excluded list;
 *                   the build parameters are tools/lib/body-asset-paths.mjs's
 *   registration    BD's own level points, re-derived from the committed full
 *                   tier with the template's own code (`axisPoint`), within
 *                   REGISTRATION_TOLERANCE_MM of what the template recorded.
 *                   This is the claim "the mesh is registered to BD", measured
 *   no address      no structure carries an ALC-1 address; the 25 vertebrae are
 *                   named like everything else
 *   report          docs/body-mesh-report.md equals what the files measure
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './repo.mjs';
import { readMeshBin } from './meshbin.mjs';
import { checkStructures, checkTables } from './mesh-tier-checks.mjs';
import { BODY_MESH_BUILD, bodyAssetPaths } from './body-asset-paths.mjs';
import { BD_LEVELS, SOURCE } from './bp3d.mjs';
import { axisPoint } from './bd-template.mjs';

/**
 * How far a level point re-derived from the shipped mesh may sit from the one
 * the template recorded. Set before the first measurement, from what BD can
 * resolve: its smallest cell side is 25.88 mm and the skin's mean edge 6.25 mm
 * (the template's own precision basis). 1 mm is under 4% of the smallest cell,
 * so a mesh within it cannot put a point in a different cell than BD would.
 */
export const REGISTRATION_TOLERANCE_MM = 1.0;
export const BODY_REPORT_DOC = join(REPO_ROOT, 'docs', 'body-mesh-report.md');
const TEMPLATE = join(REPO_ROOT, 'packages', 'atlas-assets', 'templates', 'bp3d-4.0-adult-body-centroid.body.json');

export function checkBodyMeshes({ writeReport = false } = {}) {
  const problems = [];
  const attribution = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'atlas-assets', 'attribution.json'), 'utf8'));
  const archiveSha = attribution.upstreamSources.find((s) => s.id === 'bodyparts3d')?.pinned?.files?.[SOURCE.files.meshes]?.sha256;
  if (!archiveSha) return { problems: ['attribution.json pins no BodyParts3D archive, so there is no body mesh set to check.'] };
  const paths = bodyAssetPaths(archiveSha);
  const assets = join(REPO_ROOT, 'packages', 'atlas-assets');
  const missing = [`${paths.dir}/structures.json`, `${paths.dir}/meshes.lowres.bin`, `${paths.dir}/meshes.fullres.bin`]
    .filter((p) => !existsSync(join(REPO_ROOT, p)));
  if (missing.length > 0) {
    return { problems: [`Missing for BodyParts3D ${archiveSha.slice(0, 7)}:`, ...missing.map((p) => `  ${p}`), 'Rebuild with `node tools/build-body-meshes.mjs --source <dir>`.'] };
  }

  const doc = JSON.parse(readFileSync(join(assets, paths.structuresFile), 'utf8'));
  let low;
  let full;
  try {
    low = readMeshBin(readFileSync(join(assets, paths.lowFile)));
    full = readMeshBin(readFileSync(join(assets, paths.fullFile)));
  } catch (err) {
    return { problems: [`A body mesh file does not parse: ${err.message}`] };
  }

  // --- The manifest -----------------------------------------------------------
  if (doc.schema !== 'atlas-body-structures/1') problems.push(`body structures.json has schema ${JSON.stringify(doc.schema)}, not "atlas-body-structures/1".`);
  if (doc.source?.archiveSha256 !== archiveSha) problems.push(`body structures.json was built from archive ${doc.source?.archiveSha256}, not the pinned ${archiveSha}.`);
  for (const k of Object.keys(BODY_MESH_BUILD)) {
    if (doc.build?.[k] !== BODY_MESH_BUILD[k]) problems.push(`body structures.json was built with ${k} = ${doc.build?.[k]}, not ${BODY_MESH_BUILD[k]}.`);
  }
  if (doc.registration?.frame !== 'BD' || doc.registration?.transform !== 'identity') {
    problems.push('body structures.json does not declare itself registered to BD by the identity; the registration check below measures exactly that claim.');
  }
  const owner = new Map();
  for (const s of doc.structures) {
    if (JSON.stringify(s.sources) !== JSON.stringify(['bodyparts3d'])) {
      problems.push(`${s.name} (id ${s.id}) cites ${JSON.stringify(s.sources)}; every body structure derives from BodyParts3D alone.`);
    }
    if (s.id !== Number(String(s.fma).replace(/^FMA/, ''))) problems.push(`${s.name}: id ${s.id} is not its FMA number (${s.fma}).`);
    if ('address' in s || 'alc' in s) problems.push(`${s.name} (id ${s.id}) carries an ALC-1 address; body meshes are display geometry, named and not addressed.`);
    for (const f of s.files ?? []) {
      if (owner.has(f)) problems.push(`Element file ${f} is in both ${owner.get(f)} and ${s.name}.`);
      owner.set(f, s.name);
    }
  }
  for (const e of doc.excluded ?? []) {
    if (owner.has(e.file)) problems.push(`Element file ${e.file} is listed as excluded (${e.reason}) and shipped in ${owner.get(e.file)}.`);
  }
  problems.push(...checkTables({ doc, low, full }));
  if (problems.length > 0) return { problems };

  // --- Per structure: the brain's checks ----------------------------------------
  const checked = checkStructures({ doc, low, full, floorTriangles: BODY_MESH_BUILD.floorTriangles, mmPerUnit: 1 });
  problems.push(...checked.problems);
  const rows = checked.rows;

  // --- Registration: BD's level points, re-derived from the shipped vertebrae ---
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  const opts = template.provenance.options;
  const recorded = new Map(template.provenance.measurement.levels.map((l) => [l.level, l]));
  const rowByFma = new Map(rows.map((r) => [r.s.fma, r]));
  const levels = [];
  for (const [label, fma, term] of BD_LEVELS) {
    const row = rowByFma.get(fma);
    const rec = recorded.get(label);
    if (!row) {
      problems.push(`registration: BD level ${label} (${term}, ${fma}) is not a structure in the body meshes, so the frame cannot be checked there.`);
      continue;
    }
    const mesh = { fma, V: row.fullGeometry.positions, F: row.fullGeometry.indices };
    const a = axisPoint(mesh, opts.centreline, opts.bodyFraction);
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    // S01's recorded axis point is its endplate fit, not a vertebral axis point.
    const axis = label === 'S01' ? null : dist(a.point, rec.axisPointMm);
    const centroid = dist(a.whole.centroid, rec.wholeCentroidMm);
    for (const [what, d] of [['axis point', axis], ['volume centroid', centroid]]) {
      if (d !== null && !(d <= REGISTRATION_TOLERANCE_MM)) {
        problems.push(`registration: BD ${label} ${what} re-derived from the shipped ${term} is ${d.toFixed(2)} mm from the template's, over ${REGISTRATION_TOLERANCE_MM} mm.`);
      }
    }
    levels.push({ label, term, axis, centroid });
  }

  // --- Report -------------------------------------------------------------------
  const reportText = bodyReport({ doc, rows, levels, paths });
  if (writeReport) writeFileSync(BODY_REPORT_DOC, reportText);
  if (!existsSync(BODY_REPORT_DOC)) problems.push('docs/body-mesh-report.md is missing. Write it with `node tools/check-mesh-assets.mjs --write-report`.');
  else if (readFileSync(BODY_REPORT_DOC, 'utf8') !== reportText) {
    problems.push('docs/body-mesh-report.md is not what the committed body mesh files measure. Regenerate it with `node tools/check-mesh-assets.mjs --write-report`.');
  }

  const hs = rows.map((r) => r.hausdorff);
  const worst = (xs) => Math.max(...xs.filter((x) => x !== null));
  return {
    problems,
    reportText,
    pass: [
      `${paths.id}: ${rows.length} body structures in both tiers; ${doc.excluded.length} element files excluded and listed.`
        + ` Floor ${BODY_MESH_BUILD.floorTriangles} met by all; no degenerate triangle; no sliver; area low/full ${Math.min(...rows.map((r) => r.ratio)).toFixed(2)}-${Math.max(...rows.map((r) => r.ratio)).toFixed(2)}.`,
      `Published error re-measured for all ${rows.length}: Hausdorff median ${pct(hs, 0.5).toFixed(2)} mm, max ${Math.max(...hs).toFixed(2)} mm.`,
      `Registered to BD: ${levels.length} level points re-derived from the shipped vertebrae, worst ${worst(levels.map((l) => l.axis)).toFixed(3)} mm (axis point),`
        + ` ${worst(levels.map((l) => l.centroid)).toFixed(3)} mm (centroid), tolerance ${REGISTRATION_TOLERANCE_MM} mm.`,
    ],
  };
}

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function bodyReport({ doc, rows, levels, paths }) {
  const fmt = (x, d = 2) => (x === null ? '—' : x.toFixed(d));
  const n = (x) => x.toLocaleString('en');
  const hs = rows.map((r) => r.hausdorff);
  const fvs = doc.structures.map((s) => s.fullVsSourceMm?.hausdorff).filter((x) => typeof x === 'number');
  const byCategory = new Map();
  for (const r of rows) {
    if (!byCategory.has(r.s.category)) byCategory.set(r.s.category, []);
    byCategory.get(r.s.category).push(r);
  }
  const sided = rows.filter((r) => r.s.side).length;
  return `${[
    '# Body mesh report',
    '',
    `Generated by \`node tools/check-mesh-assets.mjs --write-report\` from the committed files of \`${paths.id}\`, and checked`,
    'against them on every CI run. Do not edit; rebuild. Every figure but the source comparison is re-measured from the two mesh files.',
    '',
    `- **Source:** BodyParts3D ${doc.source.release}, archive SHA-256 \`${doc.source.archiveSha256}\`; ${n(doc.counts.elementFiles)} element files, ${n(doc.counts.sourceTriangles)} triangles shipped from.`,
    `- **Structures:** ${n(rows.length)}, one per FMA concept an element file names itself (${sided} sided by their own name). ${doc.excluded.length} element files excluded, each listed with its reason in \`structures.json\` \`excluded\`.`,
    `- **Low tier (eager):** ${n(doc.tiers.low.gzipBytes)} B gzip, ${n(rows.reduce((t, r) => t + r.lowTris, 0))} triangles. **Full tier (lazy):** ${n(doc.tiers.full.gzipBytes)} B gzip, ${n(rows.reduce((t, r) => t + r.fullTris, 0))} triangles.`,
    `- **Decimation:** source to full tier ratio ${doc.build.fullRatio}, floor ${doc.build.fullFloorTriangles}; full to low tier ratio ${doc.build.ratio}, floor ${doc.build.floorTriangles}. Every structure meets the low floor.`,
    `- **Geometric error, low vs full tier** (symmetric Hausdorff, mm): median ${fmt(pct(hs, 0.5))}, p95 ${fmt(pct(hs, 0.95))}, max ${fmt(Math.max(...hs))}.`,
    `- **Geometric error, full tier vs source** (the build's figure; the source is not in the repository): median ${fmt(pct(fvs, 0.5))}, p95 ${fmt(pct(fvs, 0.95))}, max ${fmt(Math.max(...fvs))}.`,
    `- **Quantisation step:** ${fmt(doc.frame.quantisation.quantisationStepMm, 4)} mm, both tiers.`,
    '',
    '## Registration to `BD`',
    '',
    'The mesh is in `BD`\'s own chart, because the BD template was measured on these meshes. That claim is checked here, not',
    'assumed: each level point is re-derived from the shipped full-tier vertebra with the template builder\'s own `axisPoint`',
    `and compared with what the template recorded. Tolerance ${REGISTRATION_TOLERANCE_MM} mm, set before the first measurement.`,
    'S01\'s recorded axis point is its endplate fit, so it is compared on its volume centroid only.',
    '',
    '| level | vertebra | axis point (mm) | volume centroid (mm) |',
    '| --- | --- | ---: | ---: |',
    ...levels.map((l) => `| ${l.label} | ${l.term} | ${fmt(l.axis, 3)} | ${fmt(l.centroid, 3)} |`),
    '',
    'BD stays the addressing frame. No structure in these files has an ALC-1 address; limbs and the skull are named and pickable,',
    'and nothing more. A limb frame would be an ALC-1 spec change (`docs/alc-1-spec.md`), and it is out of scope.',
    '',
    '## By category',
    '',
    '| category | structures | low triangles | full triangles | Hausdorff median (mm) | Hausdorff max (mm) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...[...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, rs]) =>
      `| ${c} | ${rs.length} | ${n(rs.reduce((t, r) => t + r.lowTris, 0))} | ${n(rs.reduce((t, r) => t + r.fullTris, 0))} | ${fmt(pct(rs.map((r) => r.hausdorff), 0.5))} | ${fmt(Math.max(...rs.map((r) => r.hausdorff)))} |`),
    '',
    '## Excluded element files',
    '',
    '| file | concept | name | reason |',
    '| --- | --- | --- | --- |',
    ...doc.excluded.map((e) => `| ${e.file} | ${e.fma ?? '—'} | ${e.name ?? '—'} | ${e.reason} |`),
    '',
    '## Every structure',
    '',
    '| id | structure | category | files | full tris | low tris | Hausdorff (mm) | mean (mm) | area low/full |',
    '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map((r) => `| ${r.s.id} | ${r.s.name} | ${r.s.category} | ${r.s.files.length} | ${r.fullTris} | ${r.lowTris} | ${fmt(r.hausdorff, 3)} | ${fmt(r.mean, 3)} | ${fmt(r.ratio, 3)} |`),
    '',
  ].join('\n')}`;
}
