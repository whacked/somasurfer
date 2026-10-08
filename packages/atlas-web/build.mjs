/**
 * The static build. No backend, no bundler, no dependencies.
 *
 *   node build.mjs [--base /path/] [--out dist]
 *
 * Output shape:
 *
 *   dist/index.html          page shell, attribution rendered in
 *   dist/app/*.js|css        client bundle, served as native ES modules
 *   dist/data/*.json         prebuilt indexes, derived from @gstack/alc only
 *   dist/assets/**           asset payloads, byte-identical copies, with the
 *                            asset package's own LICENSE and ATTRIBUTION.md
 *   dist/build-manifest.json what was emitted, for the performance budget
 *
 * The licence boundary is built into the shape above, not bolted on:
 *
 *   - Asset payloads are only ever BYTE-COPIED into dist/assets/. This build
 *     never reads their contents, so nothing it emits can be a derivative of
 *     them, and `tools/check-licence-separation.mjs` verifies the copies are
 *     byte-identical to their sources.
 *   - The prebuilt indexes are derived from @gstack/alc (Apache-2.0, ours) and
 *     from asset METADATA — path, size, digest — never from asset geometry.
 *   - The client fetches assets at runtime. There is no import edge, so no
 *     asset is linked into the JavaScript.
 *
 * A bundler can be added later without changing any of that; what must not
 * change is that assets stay separate files fetched at runtime.
 */

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENABLED_FRAMES, FRAMES, VERTEBRAL_LEVELS } from '../alc/src/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const ASSETS_PKG = join(REPO_ROOT, 'packages', 'atlas-assets');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

/** Trailing slash always, so `${BASE}data/x.json` is correct at root and at a subpath. */
const BASE = (arg('base', '/') + '/').replace(/\/+$/, '/');
const OUT = join(HERE, arg('out', 'dist'));

const assetsManifest = JSON.parse(readFileSync(join(ASSETS_PKG, 'attribution.json'), 'utf8'));
const assetsPkg = JSON.parse(readFileSync(join(ASSETS_PKG, 'package.json'), 'utf8'));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'app'), { recursive: true });
mkdirSync(join(OUT, 'data'), { recursive: true });
mkdirSync(join(OUT, 'assets'), { recursive: true });

const emitted = [];
function emit(relPath, bytes) {
  const abs = join(OUT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  emitted.push({ path: relPath, bytes: statSync(abs).size });
}

// ---------------------------------------------------------------------------
// 1. Asset payloads: byte copies only.
// ---------------------------------------------------------------------------

/**
 * Copies a file without looking at it. `cpSync` is the whole implementation on
 * purpose: the moment this function parses or transforms an asset, the output
 * stops being mere aggregation of someone else's work and starts being a
 * derivative of it.
 */
function copyAsset(fromAbs, toRel) {
  const abs = join(OUT, toRel);
  mkdirSync(dirname(abs), { recursive: true });
  cpSync(fromAbs, abs);
  return { path: toRel, bytes: statSync(abs).size };
}

const assetFiles = [];
for (const dir of assetsPkg.atlas?.payloadDirs ?? []) {
  const root = join(ASSETS_PKG, dir);
  try {
    statSync(root);
  } catch {
    continue;
  }
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const relInPkg = relative(ASSETS_PKG, p).split('\\').join('/');
        const record = copyAsset(p, join('assets', relInPkg));
        // Digest of the copy, for the index and for cache busting. Reading the
        // bytes to hash them does not transform them, and the digest is not a
        // substitute for the asset.
        record.sha256 = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
        record.attribution = assetsManifest.entries.find((x) => (x.files ?? []).includes(relInPkg))?.id ?? null;
        assetFiles.push(record);
        emitted.push({ path: record.path, bytes: record.bytes });
      }
    }
  };
  walk(root);
}

// The asset licence and attribution travel with the assets. Without these two
// files beside them, serving the subtree is not mere aggregation.
for (const f of ['LICENSE', 'ATTRIBUTION.md']) {
  const record = copyAsset(join(ASSETS_PKG, f), join('assets', f));
  emitted.push(record);
}

// ---------------------------------------------------------------------------
// 2. Prebuilt indexes, from our own code and from asset metadata.
// ---------------------------------------------------------------------------

const atlasIndex = {
  schema: 'atlas-index/1',
  generatedBy: 'packages/atlas-web/build.mjs',
  base: BASE,
  frames: Object.values(FRAMES).map((f) => ({
    id: f.id,
    summary: f.summary,
    anchorSegments: f.anchorSegments,
    maxDigits: f.maxDigits,
    // Frames v1 can locate in millimetres with the shipped templates. The
    // viewer must not offer a frame it cannot resolve.
    enabled: ENABLED_FRAMES.has(f.id),
  })),
  bodyLevels: VERTEBRAL_LEVELS.map((label) => ({
    label,
    region: { C: 'cervical', T: 'thoracic', L: 'lumbar', S: 'sacral' }[label[0]],
  })),
  assets: assetFiles.map((a) => ({
    path: `${BASE}${a.path}`,
    bytes: a.bytes,
    sha256: a.sha256,
    attribution: a.attribution,
  })),
  // Rendered from attribution.json, which is our record about the assets, not
  // asset content. The licence text itself ships as dist/assets/LICENSE.
  attribution: {
    packageLicenceStatus: assetsManifest.packageLicenceStatus,
    packageLicenceDecision: assetsManifest.packageLicenceDecision,
    licenceUrl: `${BASE}assets/LICENSE`,
    attributionUrl: `${BASE}assets/ATTRIBUTION.md`,
    entries: assetsManifest.entries.map((e) => ({
      id: e.id,
      title: e.title,
      licence: e.licence,
      licenceUrl: e.licenceUrl ?? null,
      holder: e.holder,
      source: e.source,
      shareAlike: e.shareAlike,
    })),
  },
};

emit('data/atlas-index.json', JSON.stringify(atlasIndex) + '\n');

// ---------------------------------------------------------------------------
// 3. Client bundle. Native ES modules, copied, not compiled.
// ---------------------------------------------------------------------------

for (const name of readdirSync(join(HERE, 'src')).sort()) {
  if (name.endsWith('.js') || name.endsWith('.css')) {
    emit(join('app', name), readFileSync(join(HERE, 'src', name)));
  }
}

// ---------------------------------------------------------------------------
// 4. Page shell, with the attribution rendered in.
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const attributionHtml = [
  '<dl class="attribution">',
  ...assetsManifest.entries.flatMap((e) => [
    `<dt>${esc(e.title)}</dt>`,
    `<dd>${
      e.licenceUrl ? `<a href="${esc(e.licenceUrl)}" rel="license">${esc(e.licence)}</a>` : esc(e.licence)
    } — ${esc(e.holder)}. ${esc(e.source)}${e.shareAlike ? ' <strong>Share-alike.</strong>' : ''}</dd>`,
  ]),
  '</dl>',
  `<p class="attribution-links">Full text: <a href="${BASE}assets/ATTRIBUTION.md">asset attribution</a> · ` +
    `<a href="${BASE}assets/LICENSE">asset licence</a> · ` +
    `<a href="${BASE}LICENSE">code licence (Apache-2.0)</a></p>`,
].join('\n      ');

const html = readFileSync(join(HERE, 'src', 'index.html'), 'utf8')
  .replaceAll('{{BASE}}', BASE)
  .replaceAll('{{ATTRIBUTION}}', attributionHtml)
  .replaceAll(
    '{{LICENCE_STATUS}}',
    assetsManifest.packageLicenceStatus === 'pending'
      ? `Asset licence pending ${esc(assetsManifest.packageLicenceDecision)}. First-party placeholder geometry only.`
      : 'Asset licences as listed below.',
  );
emit('index.html', html);

// The code licence is served too, so the page's own licence link resolves.
emit('LICENSE', readFileSync(join(REPO_ROOT, 'LICENSE')));
// Static host, no backend: tell it not to look for one.
emit('.nojekyll', '');

// ---------------------------------------------------------------------------
// 5. Manifest, consumed by tools/perf-budget.mjs.
// ---------------------------------------------------------------------------

// Snapshotted before the manifest is emitted, so the manifest does not list
// itself and the logged total matches what it reports.
const files = [...emitted].sort((a, b) => a.path.localeCompare(b.path));
const manifest = {
  schema: 'build-manifest/1',
  base: BASE,
  builtAt: null, // deliberately not a timestamp: the build must be reproducible
  files,
  totalBytes: files.reduce((n, f) => n + f.bytes, 0),
};
emit('build-manifest.json', JSON.stringify(manifest, null, 2) + '\n');

console.log(`✓ build → ${relative(REPO_ROOT, OUT)} (base ${BASE})`);
for (const f of manifest.files) console.log(`  ${String(f.bytes).padStart(8)}  ${f.path}`);
console.log(`  ${String(manifest.totalBytes).padStart(8)}  total`);
