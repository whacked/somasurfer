/**
 * Turn the pinned BodyParts3D 4.0 element meshes into the body's mesh files
 * (DOG-128, Atlas v2 W3).
 *
 *   (cd tools/mesh-build && npm ci)        # once: the build-only simplifier
 *   node tools/build-body-meshes.mjs --source <dir>
 *   node tools/build-body-meshes.mjs --source <dir> --dry-run [--report <file>] [--ratio r] [--floor n] [--full-ratio r] [--full-floor n] [--min-component n]
 *
 * `<dir>` holds the seven BodyParts3D files listed in tools/lib/bp3d.mjs. Each
 * is checked against the SHA-256 pinned in packages/atlas-assets/attribution.json
 * (`bodyparts3d`) before anything is read; a file that does not match is refused.
 * They are NOT in the repository.
 *
 * Writes:
 *   packages/atlas-assets/body/bp3d-<sha7>/meshes.lowres.bin    low tier, eager
 *   packages/atlas-assets/body/bp3d-<sha7>/meshes.fullres.bin   full tier, lazy
 *   packages/atlas-assets/body/bp3d-<sha7>/structures.json      what is in them, and what is not
 *
 * `--dry-run` writes nothing and prints what the build would weigh. It alone
 * takes parameter overrides, so a committed file is always built with the
 * parameters in tools/lib/body-asset-paths.mjs, and the gate checks those.
 *
 * The frame is `BD`'s own: BodyParts3D millimetres, LAS. The BD template was
 * measured on these meshes in this chart, so the registration is the identity.
 * tools/check-mesh-assets.mjs re-derives the template's level points from the
 * committed vertebrae rather than taking that on trust.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { REPO_ROOT, fail, rel } from './lib/repo.mjs';
import { BD_LEVELS, SOURCE, assertLaterality, openSource } from './lib/bp3d.mjs';
import { BODY_CATEGORIES, BODY_EXCLUSIONS, groupBodyStructures } from './lib/body-structures.mjs';
import { buildMeshTiers } from './lib/brain-meshes.mjs';
import { BODY_MESH_BUILD, bodyAssetPaths } from './lib/body-asset-paths.mjs';

const args = process.argv.slice(2);
const arg = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const source = arg('--source') ?? process.env.ATLAS_BP3D_DIR;
if (!source) fail('build-body-meshes', ['Pass --source <dir> holding the BodyParts3D 4.0 files (or set ATLAS_BP3D_DIR).']);
const dryRun = args.includes('--dry-run');
const overrides = {
  ratio: arg('--ratio'),
  floorTriangles: arg('--floor'),
  fullRatio: arg('--full-ratio'),
  fullFloorTriangles: arg('--full-floor'),
  minComponentTriangles: arg('--min-component'),
};
if (!dryRun && Object.values(overrides).some((v) => v !== undefined)) {
  fail('build-body-meshes', ['Parameter overrides are for --dry-run only. Change BODY_MESH_BUILD in tools/lib/body-asset-paths.mjs to build with other values.']);
}
const params = { ...BODY_MESH_BUILD };
for (const [k, v] of Object.entries(overrides)) if (v !== undefined) params[k] = Number(v);

const attribution = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'atlas-assets', 'attribution.json'), 'utf8'));
const pin = attribution.upstreamSources.find((s) => s.id === 'bodyparts3d')?.pinned;
if (!pin) fail('build-body-meshes', ['attribution.json has no pinned `bodyparts3d` source.']);
for (const name of Object.values(SOURCE.files)) {
  const p = join(source, name);
  if (!existsSync(p)) fail('build-body-meshes', [`${p} does not exist.`]);
  const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
  if (sha !== pin.files[name]?.sha256) {
    fail('build-body-meshes', [
      `${p} has SHA-256 ${sha}.`,
      `The pin (attribution.json, bodyparts3d) is ${pin.files[name]?.sha256 ?? 'absent'}.`,
      'BodyParts3D publishes under a moving LATEST URL. This is not the file the pipeline was built and gated on; re-verify and re-pin.',
    ]);
  }
}

const archiveSha = pin.files[SOURCE.files.meshes].sha256;
const paths = bodyAssetPaths(archiveSha);
const bp3d = openSource(source);
const laterality = assertLaterality(bp3d);

const t0 = performance.now();
// Headers only to group, and each structure's geometry loaded when the tier
// builder asks for it and dropped after: holding all 2,234 parsed element files
// at once was more memory than the build host has (killed at 868 MB RSS).
const loaded = bp3d.files().map((f) => bp3d.loadHeader(f));
const { structures, excluded } = groupBodyStructures(bp3d, loaded);

const loadStructure = (s) => {
  const parts = s.files.map((f) => bp3d.loadFile(f));
  const positions = new Float32Array(parts.reduce((n, p) => n + p.V.length, 0));
  const indices = new Uint32Array(parts.reduce((n, p) => n + p.F.length, 0));
  let v = 0;
  let i = 0;
  for (const { V, F } of parts) {
    positions.set(V, v);
    for (let k = 0; k < F.length; k += 1) indices[i + k] = F[k] + v / 3;
    v += V.length;
    i += F.length;
  }
  return { positions, indices };
};
// The 25 BD vertebrae keep their source resolution in the full tier: the
// registration gate re-derives BD's level points from them, and decimated they
// moved two of those points past its 1 mm (T07 1.03, T09 1.31 mm at 09ee895).
const BD_WITNESSES = new Set(BD_LEVELS.map(([, fma]) => fma));
const meshes = structures.map((s) => ({ id: s.id, keepFull: BD_WITNESSES.has(s.fma), load: () => loadStructure(s) }));
const tiers = await buildMeshTiers({ meshes, mmPerUnit: 1, ...params });
const reportById = new Map(tiers.report.map((r) => [r.id, r]));

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const gz = (b) => gzipSync(b, { level: 9 }).length;
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

const structuresDoc = {
  schema: 'atlas-body-structures/1',
  id: paths.id,
  comment: [
    'Generated by tools/build-body-meshes.mjs. Do not edit; rebuild.',
    'Every structure listed under `structures` is in both mesh files, as the same table slot. Its id is its FMA number.',
    'Positions are BD\'s own chart: BodyParts3D millimetres, LAS (+x subject left, +y anterior, +z superior).',
    'Display geometry only: no structure here has an ALC-1 address it did not already have. BD stays the addressing frame.',
  ],
  source: {
    upstream: 'bodyparts3d',
    release: pin.release,
    archiveSha256: archiveSha,
    files: Object.fromEntries(Object.entries(pin.files).map(([k, v]) => [k, v.sha256])),
  },
  frame: {
    space: 'BodyParts3D 4.0 millimetres, LAS: the chart the BD template is measured in',
    units: 'millimetre',
    axes: { x: 'subject left', y: 'anterior', z: 'superior' },
    quantisation: { origin: tiers.frame.origin, step: tiers.frame.step, quantisationStepMm: Math.max(...tiers.frame.step) },
    laterality: laterality.map((w) => ({ witness: w.name, fma: w.fma, expected: w.side, meanXMm: round(w.meanXMm, 1) })),
  },
  registration: {
    frame: 'BD',
    template: 'templates/bp3d-4.0-adult-body-centroid.body.json',
    transform: 'identity',
    basis: 'The BD template was measured on these BodyParts3D meshes in this chart. tools/check-mesh-assets.mjs re-derives its per-level axis points and vertebral centroids from the committed full tier on every run.',
  },
  build: {
    ...params,
    simplifier: 'meshoptimizer 1.3.0 simplify(), LockBorder; topology-preserving edge collapse',
    errorMeasure: 'symmetric Hausdorff and mean surface distance, every vertex, exact nearest-surface, millimetres',
    exclusions: BODY_EXCLUSIONS,
    fullTierUndecimated: { fma: [...BD_WITNESSES], why: 'the 25 BD vertebrae: the registration gate re-derives BD level points from them' },
    categories: BODY_CATEGORIES.map(([category, tree, fma, term]) => ({ category, tree, fma, term })),
  },
  tiers: {
    low: { file: paths.lowFile, bytes: tiers.low.length, gzipBytes: gz(tiers.low), sha256: sha256(tiers.low), loading: 'eager' },
    full: { file: paths.fullFile, bytes: tiers.full.length, gzipBytes: gz(tiers.full), sha256: sha256(tiers.full), loading: 'lazy' },
  },
  counts: {
    elementFiles: loaded.length,
    structures: structures.length,
    excludedFiles: excluded.length,
    sourceTriangles: tiers.report.reduce((n, r) => n + r.sourceTriangles, 0),
  },
  structures: structures.map((s, slot) => {
    const r = reportById.get(s.id);
    return {
      id: s.id,
      slot,
      fma: s.fma,
      name: s.name,
      category: s.category,
      side: s.side,
      files: s.files,
      ...(s.resolvedBy ? { resolvedBy: s.resolvedBy } : {}),
      sources: ['bodyparts3d'],
      sourceTriangles: r.sourceTriangles,
      full: { triangles: r.full.triangles, vertices: r.full.vertices, areaMm2: round(r.full.areaMm2, 1) },
      low: { triangles: r.low.triangles, vertices: r.low.vertices, areaMm2: round(r.low.areaMm2, 1) },
      errorMm: { hausdorff: round(r.hausdorffMm, 3), mean: round(r.meanDeviationMm, 3) },
      fullVsSourceMm: r.fullVsSource
        ? { hausdorff: round(r.fullVsSource.hausdorffMm, 3), mean: round(r.fullVsSource.meanDeviationMm, 3), sourceAreaMm2: round(r.fullVsSource.sourceAreaMm2, 1) }
        : null,
    };
  }),
  excluded,
};

const tris = (k) => tiers.report.reduce((n, r) => n + r[k].triangles, 0);
const hs = structuresDoc.structures.map((s) => s.errorMm.hausdorff).sort((a, b) => a - b);
const fs = structuresDoc.structures.map((s) => s.fullVsSourceMm?.hausdorff ?? 0).sort((a, b) => a - b);
const structuresGzip = gz(Buffer.from(`${JSON.stringify(structuresDoc, null, 1)}\n`));
console.log([
  `body meshes ${paths.id}${dryRun ? ' (dry run: nothing written)' : ''}`,
  `  params ${JSON.stringify(params)}`,
  `  ${structures.length} structures from ${loaded.length - excluded.length} element files; ${excluded.length} files excluded`,
  `  low tier  ${tris('low')} triangles, ${structuresDoc.tiers.low.bytes} B, gzip ${structuresDoc.tiers.low.gzipBytes} B; structures.json gzip ${structuresGzip} B`,
  `  full tier ${tris('full')} triangles, ${structuresDoc.tiers.full.bytes} B, gzip ${structuresDoc.tiers.full.gzipBytes} B`,
  `  Hausdorff low<->full: median ${hs[hs.length >> 1]} mm, p95 ${hs[Math.floor(hs.length * 0.95)]} mm, max ${hs.at(-1)} mm`,
  `  Hausdorff full<->source: median ${fs[fs.length >> 1]} mm, p95 ${fs[Math.floor(fs.length * 0.95)]} mm, max ${fs.at(-1)} mm`,
  `  ${((performance.now() - t0) / 1000).toFixed(0)} s`,
].join('\n'));

if (dryRun && arg('--report')) {
  writeFileSync(arg('--report'), `${JSON.stringify(structuresDoc, null, 1)}\n`);
  console.log(`  dry-run structures.json written to ${arg('--report')}`);
}
if (!dryRun) {
  mkdirSync(join(REPO_ROOT, paths.dir), { recursive: true });
  writeFileSync(join(REPO_ROOT, paths.dir, 'meshes.lowres.bin'), tiers.low);
  writeFileSync(join(REPO_ROOT, paths.dir, 'meshes.fullres.bin'), tiers.full);
  writeFileSync(join(REPO_ROOT, paths.dir, 'structures.json'), `${JSON.stringify(structuresDoc, null, 1)}\n`);
  console.log(`  wrote ${rel(join(REPO_ROOT, paths.dir))}/`);
}
