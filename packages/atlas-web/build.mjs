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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ENABLED_FRAMES, FRAMES, VERTEBRAL_LEVELS } from '../alc/src/index.ts';
import { ASSET_TEMPLATES, NAME_INDEX_FILES } from './catalogue/asset-templates.mjs';
import { buildResearchFixture, buildTemplates } from './fixtures/fixtures.mjs';

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

/**
 * Stage-A fixture data: templates, the name index, the 5-paper research set.
 *
 * Generated from `@gstack/alc` and our own fixture module — Apache-2.0 code
 * only, never from an asset payload — so nothing emitted here can carry a
 * share-alike obligation. One file per template, because the viewer binds one
 * at a time and should not pay for the others.
 */
const templateEntries = [];

// The real templates, bound by default. The declaration — and the reason
// `maxUsefulDigits` is absent from it — is in catalogue/asset-templates.mjs.
for (const declaration of ASSET_TEMPLATES) {
  // Matched against what was actually copied, so a renamed or dropped asset
  // fails the build here instead of becoming a 404 in the browser.
  const copied = assetFiles.find((a) => a.path === `assets/${declaration.file}`);
  if (!copied) {
    throw new Error(
      `the catalogue declares asset template ${declaration.file}, but no such payload was copied `
      + 'from packages/atlas-assets. Either the asset was renamed or payloadDirs no longer covers '
      + 'it; the catalogue must not advertise a template the build did not ship.',
    );
  }
  templateEntries.push({
    id: declaration.id,
    kind: declaration.kind,
    label: declaration.label,
    provenance: declaration.provenance,
    admissible: declaration.admissible,
    caveat: declaration.caveat,
    isDefault: declaration.isDefault,
    // See above: the bound template declares its own limit.
    maxUsefulDigits: null,
    path: `${BASE}${copied.path}`,
    sha256: copied.sha256,
    attribution: copied.attribution,
  });
}

/**
 * The synthetic templates stay in the catalogue, and stay bindable.
 *
 * They are not decoration and not dead weight. Three of `locate()`'s five
 * findings need a template that actually produces them, and the real body
 * template produces none of the three: it is admissible, it does not fold, and
 * it realises every level it claims. `anat-hyperkyphotic-short-wide` is the
 * only template in the repo that folds, so it is the only way the `folded`
 * message is reachable in a running build rather than only in the suite.
 *
 * `?template=<id>` is what binds one. See `app.js`.
 */
for (const definition of buildTemplates()) {
  const path = `data/templates/${definition.id}.json`;
  emit(path, JSON.stringify(definition.template) + '\n');
  templateEntries.push({
    id: definition.id,
    kind: definition.kind,
    label: definition.label,
    provenance: definition.provenance,
    admissible: definition.admissible,
    caveat: definition.caveat,
    // The real templates are the defaults now, so a fixture is never bound
    // unless a reader asks for it by id.
    isDefault: false,
    maxUsefulDigits: definition.template.maxUsefulDigits,
    path: `${BASE}${path}`,
  });
}

/**
 * The naming layer, as the two asset documents it actually is.
 *
 * `version` and `structureCount` are absent for the same reason
 * `maxUsefulDigits` is: both are asset content. The version in particular must
 * come from the documents themselves, since its whole job is to say which
 * build produced the names being shown — a copy of it in the catalogue could
 * be stale, and a stale version beside a name list is worse than no version.
 *
 * The synthetic name index is no longer emitted. With the real index bound,
 * shipping a second index of invented names would mean a build in which some
 * selections resolve to anatomy and others to fixtures, with nothing but a
 * version string distinguishing them. The fixture index still exists for the
 * suite, in `fixtures/fixtures.mjs`, where it cannot reach a user.
 */
for (const file of Object.values(NAME_INDEX_FILES)) {
  if (!assetFiles.some((a) => a.path === `assets/${file}`)) {
    throw new Error(`the catalogue declares name index document ${file}, but it was not copied.`);
  }
}

const researchFixture = buildResearchFixture();
emit('data/research.json', JSON.stringify(researchFixture) + '\n');

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
  /** Templates the viewer may bind. It is built against this, not one of them. */
  templates: templateEntries,
  /**
   * Two paths, joined at runtime by `viewer/nameindex.js`. `source: 'asset'`
   * is the discriminator the loader branches on, so a future first-party index
   * can be added without the loader guessing from which fields are present.
   */
  nameIndex: {
    source: 'asset',
    namesPath: `${BASE}assets/${NAME_INDEX_FILES.names}`,
    coveringsPath: `${BASE}assets/${NAME_INDEX_FILES.coverings}`,
    // Both live in the documents. See the comment above NAME_INDEX_FILES.
    version: null,
    structureCount: null,
  },
  research: {
    version: researchFixture.version,
    paperCount: researchFixture.papers.length,
    path: `${BASE}data/research.json`,
  },
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

/**
 * `src/` is mirrored into `dist/app/`, subdirectories and all, so a module's
 * relative specifiers resolve identically in both trees. That is what lets
 * `src/viewer/*.js` import `'../alc.js'` and have it mean the TypeScript source
 * under Node and the browser bundle under `dist/`.
 *
 * `src/alc.js` is the one file not copied verbatim. See below.
 */
const ALC_SHIM = 'alc.js';
const ALC_BUNDLE = join(REPO_ROOT, 'packages', 'alc', 'dist', 'alc.js');

function copyClientTree(dir, prefix) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const from = join(dir, entry.name);
    const to = join(prefix, entry.name);
    if (entry.isDirectory()) copyClientTree(from, to);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.css')) {
      if (prefix === 'app' && entry.name === ALC_SHIM) continue;
      emit(to, readFileSync(from));
    }
  }
}
copyClientTree(join(HERE, 'src'), 'app');

/**
 * The library, swapped for its browser build — and checked, not assumed.
 *
 * `src/alc.js` re-exports `../../alc/src/index.ts`, which Node strips types
 * from directly. A browser cannot, so `dist/app/alc.js` is the library's own
 * single-file ESM bundle instead. The substitution is sound only if both sides
 * export the same names; a silent drift would mean the suite exercises one
 * module graph and users load another. `packages/alc/scripts/build.mjs` already
 * verifies the bundle against its own source, and this re-verifies it against
 * the source THIS build imported.
 */
if (!existsSync(ALC_BUNDLE)) {
  throw new Error(
    'packages/alc/dist/alc.js is missing. Run `node packages/alc/scripts/build.mjs` first: '
    + 'the browser cannot load the TypeScript source that src/alc.js re-exports.',
  );
}
{
  const bundle = await import(pathToFileURL(ALC_BUNDLE).href);
  const source = await import(pathToFileURL(join(REPO_ROOT, 'packages', 'alc', 'src', 'index.ts')).href);
  const expected = Object.keys(source).filter((n) => n !== 'default').sort();
  const got = Object.keys(bundle).filter((n) => n !== 'default').sort();
  if (got.join(',') !== expected.join(',')) {
    throw new Error(
      'packages/alc/dist/alc.js has drifted from the TypeScript source, so dist/app/alc.js would not '
      + 'be the library the suite ran against.\n'
      + `  missing: ${expected.filter((n) => !got.includes(n)).join(', ') || 'none'}\n`
      + `  extra:   ${got.filter((n) => !expected.includes(n)).join(', ') || 'none'}\n`
      + '  Rebuild the library.',
    );
  }
  emit(join('app', ALC_SHIM), readFileSync(ALC_BUNDLE));
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
