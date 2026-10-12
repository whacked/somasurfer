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
 *   dist/data/api/v1/**      the research API's paper tree: the curated
 *                            dataset alone (its region tree is an asset)
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
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ENABLED_FRAMES, FRAMES, VERTEBRAL_LEVELS } from '../alc/src/index.ts';
// The scanner behind the one check the trimmed research bundle makes
// necessary. A separate module so the suite can plant a violation and prove it
// still fires, the way address-equality.test.js does with alc's guard.
import { importSites, surfaceProblems } from './shim-surface.mjs';
import {
  ASSET_TEMPLATES,
  CURATED_CORPUS_RESOLUTION,
  NAME_INDEX_FILES,
} from './catalogue/asset-templates.mjs';
import { ASSET_MESH_SETS } from './catalogue/asset-meshes.mjs';
import { buildTemplates } from './fixtures/fixtures.mjs';
// The one value the build shares with the client: the roles a research corpus
// may declare. Imported from the validator that enforces it rather than
// restated, so the build cannot emit a role the viewer will reject.
import { RESEARCH_ROLES } from './src/viewer/research.js';
// The paper half of the static research API: the dataset alone, so ours.
import {
  API_LICENCES,
  API_ROOTS,
  API_SCHEMA,
  API_VERSION,
  apiDocuments,
  createPaperApi,
  loadDataset,
} from '../atlas-research/src/index.ts';

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
 * The mesh sets the page draws (DOG-129). Paths only, from the declaration in
 * catalogue/asset-meshes.mjs; each is checked against what was copied, so a
 * renamed asset fails here and not as a 404. The tiers inside each
 * structures.json are asset content and the browser reads them itself.
 */
const meshSetEntries = ASSET_MESH_SETS.map((declaration) => {
  const entry = { id: declaration.id, atlas: declaration.atlas };
  for (const key of ['structures', 'labels', 'registration']) {
    if (!declaration[key]) continue;
    if (!assetFiles.some((a) => a.path === `assets/${declaration[key]}`)) {
      throw new Error(
        `the catalogue declares mesh set ${declaration.id} ${key} ${declaration[key]}, but no such payload `
        + 'was copied from packages/atlas-assets; the page must not be sent to fetch a file the build did not ship.',
      );
    }
    entry[key] = `${BASE}assets/${declaration[key]}`;
  }
  if (declaration.research) entry.research = { ...declaration.research };
  return entry;
});

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

/**
 * The research corpus: the curated one, and where it gets resolved.
 *
 * DOG-68 found the page serving the 5-paper fixture while the Node-side QA
 * oracle read the curated 30-paper seed set, with nothing in the artefact
 * saying so. Two datasets and one unlabelled slot is how a §7 row drives the
 * page, finds `FXP-1`, and reports pass. Its fix — `role` required in the
 * document, a caveat required of a fixture, the provenance line on screen —
 * stands, and the page still carries all three.
 *
 * What has changed is which corpus fills the slot. DOG-68 also concluded that
 * the fixture was all v1 could honestly serve; DOG-74 re-measured and that
 * conclusion does not hold. Both of its arguments do, and this build still
 * obeys both:
 *
 *   **The build may not resolve a structure id.** Resolving one means reading
 *   the name index, the index is an asset payload, and rule 6 of
 *   `tools/check-licence-separation.mjs` holds `dist/data/` to deriving nothing
 *   from asset content. So `data/research.json` is emitted as TEXT, verbatim,
 *   and the join happens in the browser where the client has already fetched
 *   the index. That is the one structural change R2 makes.
 *
 *   **The synthetic name index is still never emitted or joined.**
 *   `data/names-seed.json` declares `synthetic: true` in its own header, and
 *   resolving the curated corpus against it would paint invented brain
 *   placements underneath 30 real citations — Brodmann 1909, Kanwisher 1997,
 *   Hickok 2007 — which is false precision attached to the names of people who
 *   did not claim it. It is the decision this build already made a few lines
 *   above, for the same reason.
 *
 * What DOG-68 got wrong was only the cost of the alternative. Against the index
 * this page actually binds, with BOTH templates bound, 31 of the 170 mappings
 * resolve across 10 of 30 papers and 24 of 120 findings. DOG-68's figure of 28
 * was measured with no brain template, which costs the three `coordinates`
 * mappings and two papers. 139 mappings resolve to nothing, and serving them
 * unplaced-and-explained is honest in a way that serving invented papers was
 * not: the residue is listed, described, and painted nowhere.
 *
 * ## The slot is still labelled, in three places that cannot disagree
 *
 *   the document    carries its own `role`, and the viewer refuses to load one
 *                   that does not. A fixture must also carry a caveat.
 *   the index       `research.role` and the counts, read off the dataset, plus
 *                   `research.expectedResolution` — declared, because this
 *                   build cannot measure it, and re-measured by the suite.
 *   the page        renders the role above the paper list, and compares what it
 *                   actually resolved against what the index declared.
 *
 * The counts are read off the dataset rather than hand-written for the reason
 * `maxUsefulDigits` is absent from the catalogue: a second copy of a number is
 * a number that goes stale the first time the dataset grows.
 */
/**
 * The curated dataset, emitted VERBATIM as text.
 *
 * `research-seed.json` is `research/1`: papers, findings, structure ids,
 * evidence and provenance. No geometry. Copying it out adds `role: 'curated'`
 * and nothing else, which is what keeps rule 6 green — the text derives nothing
 * from asset content, and `atlas-research` is `licenceClass: code`.
 *
 * `buildResearchFixture()` is still in `fixtures/fixtures.mjs` and still used
 * by the viewer's own suite. It has simply stopped being page content.
 */
const curatedSeed = JSON.parse(
  readFileSync(join(REPO_ROOT, 'packages', 'atlas-research', 'data', 'research-seed.json'), 'utf8'),
);
const researchDoc = { ...curatedSeed, role: 'curated' };

if (!RESEARCH_ROLES.includes(researchDoc.role)) {
  throw new Error(
    `the research document declares role ${JSON.stringify(researchDoc.role)}, which the `
    + `viewer will refuse to load (it accepts ${RESEARCH_ROLES.join(' or ')}). A corpus that does `
    + 'not say whether its papers are invented must not be emitted.',
  );
}
// Belt and braces on the one claim a reader is most likely to take on trust.
// The version string is what `atlas-index.json` has always shown; if it ever
// says `fixture` while the role says `curated`, or the reverse, the artefact
// contradicts itself and the build is the place to find out.
if (/fixture/i.test(researchDoc.version) !== (researchDoc.role === 'fixture')) {
  throw new Error(
    `the research document's version ${JSON.stringify(researchDoc.version)} and its role `
    + `${JSON.stringify(researchDoc.role)} disagree about whether this corpus is invented.`,
  );
}
// The corpus this page serves is the one whose papers are real, so the invented
// one must not be reachable from `dist/` at all. Checked on the bytes about to
// be written rather than trusted: `tools/check-licence-separation.mjs` scans
// dist for asset content, and nothing scans it for the fixture.
{
  const text = JSON.stringify(researchDoc);
  for (const marker of ['FXP-', 'example.invalid']) {
    if (text.includes(marker)) {
      throw new Error(
        `the research document about to be emitted contains ${JSON.stringify(marker)}, which `
        + 'belongs to the invented fixture corpus. The page serves the curated corpus; a fixture '
        + 'paper reaching dist/ is how a §7 row reports pass against a paper that does not exist.',
      );
    }
  }
}

emit('data/research.json', JSON.stringify(researchDoc) + '\n');

/**
 * The static research API, v1 (DOG-131). `packages/atlas-research/schema/api-1.md`.
 *
 * Two trees. The paper tree is the curated dataset alone, so it is ours and is
 * emitted here, under dist/data/, from `createPaperApi` — the same function the
 * library answers with. The region tree is joined with BY-SA structure names,
 * so it is asset content: it is committed in packages/atlas-assets/api/v1/ by
 * tools/build-research-api.mjs and arrives above as a byte copy, like every
 * other payload. This build only checks that it arrived; it never reads it,
 * which is what keeps rule 6 true of dist/data/api/.
 *
 * Every link inside both trees is relative, so neither embeds the base. The
 * two roots are published, under the base, in `atlas-index.json`.
 */
const researchApiDocs = apiDocuments(createPaperApi(loadDataset(curatedSeed)));
for (const d of researchApiDocs) emit(`${API_ROOTS.data}${d.path}`, JSON.stringify(d.body) + '\n');
if (!assetFiles.some((a) => a.path === `${API_ROOTS.assets}index.json`)) {
  throw new Error(
    `the paper tree links the region tree at ${API_ROOTS.assets}index.json, and no such payload was copied. `
    + 'Run node tools/build-research-api.mjs --write, or check that payloadDirs still covers api/.',
  );
}
const researchApi = {
  schema: API_SCHEMA,
  version: API_VERSION,
  dataRoot: `${BASE}${API_ROOTS.data}`,
  assetsRoot: `${BASE}${API_ROOTS.assets}`,
  licences: API_LICENCES,
};

/**
 * What the page says about the corpus it serves.
 *
 * Everything here except `resolution` is read straight off the dataset, so it
 * cannot disagree with the document beside it. `resolution` is the one value
 * this build is structurally unable to compute: resolving a structure id means
 * reading the name index, the index is an asset payload, and rule 6 holds
 * `dist/data/` to deriving nothing from asset content. So the join happens in
 * the browser and the expected outcome is DECLARED here — see
 * `CURATED_CORPUS_RESOLUTION` in the catalogue for why that is a declaration
 * and how `test/curated-corpus.test.js` keeps it from rotting.
 *
 * The page compares what it measured against this and says so if they differ.
 * That comparison is the only thing that can distinguish a broken join from
 * the 139 mappings that genuinely cannot be placed: both render as a paper
 * list with nothing painted.
 */
const research = {
  version: researchDoc.version,
  /** `fixture` or `curated`. The viewer refuses a document without it. */
  role: researchDoc.role,
  caveat: researchDoc.caveat ?? null,
  paperCount: researchDoc.papers.length,
  findingCount: researchDoc.findings.length,
  mappingCount: researchDoc.findings.reduce((n, f) => n + f.mappings.length, 0),
  path: `${BASE}data/research.json`,
  /** Resolved at load, in the browser, against the real index. Not here. */
  resolvedAt: 'load',
  expectedResolution: CURATED_CORPUS_RESOLUTION,
  /**
   * The partition declarations, forwarded so the page can explain its own
   * residue without re-reading the dataset. `reason` is carried verbatim: it is
   * the licence decision in the words of whoever made it, and a paraphrase of a
   * licence verdict is a new claim about a licence.
   */
  authoredAgainst: researchDoc.authoredAgainst,
};

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
  /** Mesh sets per atlas (DOG-129). Display and picking geometry; the templates stay the frames. */
  meshSets: meshSetEntries,
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
  research,
  /** The static research API's two roots; `createStaticApiClient` takes them as they are. */
  researchApi,
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
 * Two files under `src/` are not copied verbatim: the package shims. See below.
 */

/**
 * The shims, and the browser bundles substituted for them.
 *
 * Each entry is a file in `src/` that re-exports a workspace package's
 * TypeScript source — which Node strips types from directly and a browser
 * cannot — paired with that package's own single-file ESM build.
 *
 * ## Both of them land in `dist/app/`, side by side, and that is load-bearing
 *
 * `atlas-research.js` imports alc rather than containing it, as the specifier
 * `'./alc.js'` — a sibling. That is the whole reason the research bundle may be
 * substituted at all: `buildNameIndex()` keys its lookup tables in a WeakMap by
 * index identity, so a second copy of alc is a second WeakMap, and
 * `buildResearchIndex()` would reject the `NameIndex` the page itself built
 * through `joinNameIndex()` → `buildNameIndex()` with a message about the value
 * not being a name index. Emitting both into the same directory is what makes
 * that sibling specifier resolve to the one alc the page already loads.
 *
 * So the order below matters and the verification depends on it: alc is emitted
 * first, and the research bundle is then verified *as emitted*, by importing
 * `dist/app/atlas-research.js` — which resolves `'./alc.js'` to the file beside
 * it. Verifying the source bundle instead would not load at all, because
 * `packages/atlas-research/dist/` has no alc next to it; and verifying it in a
 * way that papered over that would be verifying a layout nobody ships.
 *
 * ## The research bundle is a SUBSET of the package, and `source` says which
 *
 * `src/atlas-research.js` re-exports all 24 of `@gstack/atlas-research`, which
 * is what Node and the suite get. The browser gets
 * `dist/atlas-research.viewer.js`, built from `src/index.viewer.ts`, which
 * exports the four names `src/viewer/corpus.js` imports — 9 KiB of gzip
 * against a `bundleGzipBytes` line that was reading 98%. DOG-84; read
 * `packages/atlas-research/src/index.viewer.ts` for the reasoning and
 * `packages/atlas-research/scripts/build.mjs` note 4 for what that package now
 * asserts in place of export equality.
 *
 * `source` is therefore the entry each bundle was BUILT from, not the package
 * entry. The drift check below is unchanged in what it does — it is still
 * exact equality against a module this build imported itself, so a stale
 * `dist/` fails here — but the module it compares against is the one that
 * describes the emitted file. For alc those are the same file; for research
 * they are not, and pointing this at `src/index.ts` would fail by design.
 *
 * What that leaves uncovered is the viewer importing a name the subset does
 * not have, which typechecks and passes the suite. `checkShimImportSurface()`
 * below is the gate for it.
 */
const SHIMS = [
  {
    shim: 'alc.js',
    bundle: join(REPO_ROOT, 'packages', 'alc', 'dist', 'alc.js'),
    source: join(REPO_ROOT, 'packages', 'alc', 'src', 'index.ts'),
    rebuild: 'node packages/alc/scripts/build.mjs',
    /** The library is served whole; nothing narrows it, so nothing to check. */
    checkImportSurface: false,
  },
  {
    shim: 'atlas-research.js',
    bundle: join(REPO_ROOT, 'packages', 'atlas-research', 'dist', 'atlas-research.viewer.js'),
    source: join(REPO_ROOT, 'packages', 'atlas-research', 'src', 'index.viewer.ts'),
    rebuild: 'node packages/atlas-research/scripts/build.mjs',
    checkImportSurface: true,
  },
];
const SHIM_NAMES = new Set(SHIMS.map((s) => s.shim));

function copyClientTree(dir, prefix) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const from = join(dir, entry.name);
    const to = join(prefix, entry.name);
    if (entry.isDirectory()) copyClientTree(from, to);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.css')) {
      if (prefix === 'app' && SHIM_NAMES.has(entry.name)) continue;
      emit(to, readFileSync(from));
    }
  }
}
copyClientTree(join(HERE, 'src'), 'app');

/**
 * Each package, swapped for its browser build — and checked, not assumed.
 *
 * The substitution is sound only if both sides export the same names. A silent
 * drift would mean the suite exercises one module graph and users load another,
 * so each package's own build script verifies its bundle against its own
 * source, and this re-verifies it against the source THIS build imported.
 */
/**
 * Every emitted app module that imports the shimmed bundle must import names
 * it really exports.
 *
 * This is the gate for the one failure the subset introduces, and it is the
 * reason the subset is safe to ship. `shim-surface.mjs` carries the reasoning
 * and the three site kinds; what is here is the part that needs the layout.
 *
 * Over `emitted` rather than over `src/`, and against `Object.keys()` of the
 * module just imported from `dist/app/`, so both halves are the artefact: the
 * files that shipped, and the names the browser will see.
 *
 * `emitted` holds forward-slash paths relative to OUT. `resolve` against OUT
 * turns a specifier into an absolute path, which is how `'./atlas-research.js'`
 * from `app/` and `'../atlas-research.js'` from `app/viewer/` are recognised as
 * the same file.
 *
 * One blind spot, stated rather than left implicit: a computed
 * `import(expr)` resolves at runtime and no static pass can see it. There is
 * none in `src/`, and `address-equality.test.js`'s scan of this tree would be
 * the place to notice one appearing.
 */
function checkShimImportSurface(shim, exports) {
  const shimAbs = join(OUT, 'app', shim);
  const sites = [];
  for (const { path } of emitted) {
    if (!path.startsWith('app/') || !path.endsWith('.js')) continue;
    const abs = join(OUT, path);
    if (abs === shimAbs) continue; // the bundle itself; its own imports are alc's
    for (const site of importSites(path, readFileSync(abs, 'utf8'))) {
      if (resolve(dirname(abs), site.specifier) === shimAbs) sites.push(site);
    }
  }

  const problems = surfaceProblems(sites, exports);
  if (problems.length > 0) {
    throw new Error(
      `dist/app/${shim} is the trimmed browser bundle, and ${problems.length} import site(s) ask it for `
      + 'more than it has.\n'
      + 'Each of these loads under Node — src/atlas-research.js re-exports the whole package — and\n'
      + 'throws SyntaxError in the browser, so the suite cannot see it:\n'
      + problems.map((p) => `  ${p}`).join('\n')
      + '\n  Fix by adding the name to packages/atlas-research/src/index.viewer.ts and paying what its\n'
      + '  module graph costs in bundleGzipBytes, or by not importing it in the viewer.',
    );
  }
  return sites;
}

const surfaceReport = [];
for (const { shim, bundle: bundlePath, source: sourcePath, rebuild, checkImportSurface } of SHIMS) {
  if (!existsSync(bundlePath)) {
    throw new Error(
      `${relative(REPO_ROOT, bundlePath)} is missing. Run \`${rebuild}\` first: the browser cannot `
      + `load the TypeScript source that src/${shim} re-exports.`,
    );
  }
  // Emitted before it is imported, so the import exercises the shipped layout:
  // a bundle whose sibling specifier does not resolve in `dist/app/` fails here
  // rather than in a browser.
  emit(join('app', shim), readFileSync(bundlePath));

  const bundle = await import(pathToFileURL(join(OUT, 'app', shim)).href);
  const source = await import(pathToFileURL(sourcePath).href);
  const expected = Object.keys(source).filter((n) => n !== 'default').sort();
  const got = Object.keys(bundle).filter((n) => n !== 'default').sort();
  if (got.join(',') !== expected.join(',')) {
    throw new Error(
      `${relative(REPO_ROOT, bundlePath)} has drifted from the TypeScript source, so dist/app/${shim} `
      + 'would not be the module the suite ran against.\n'
      + `  missing: ${expected.filter((n) => !got.includes(n)).join(', ') || 'none'}\n`
      + `  extra:   ${got.filter((n) => !expected.includes(n)).join(', ') || 'none'}\n`
      + `  Rebuild: ${rebuild}`,
    );
  }

  if (checkImportSurface) {
    const sites = checkShimImportSurface(shim, got);
    if (sites.length === 0) {
      throw new Error(
        `nothing in dist/app/ imports ${shim}, so the surface check above proved nothing.\n`
        + `  Either the viewer stopped using @gstack/atlas-research — in which case drop the shim and\n`
        + '  the bundle rather than shipping a module nobody loads — or the scan no longer finds the\n'
        + '  import site it is meant to guard (see packages/atlas-web/shim-surface.mjs).',
      );
    }
    surfaceReport.push(
      `${shim}: ${got.length} exports, asked for by ${sites.length} import site(s) in dist/app/ — `
      + sites.map((s) => `${s.file}:${s.line}`).join(', '),
    );
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
for (const line of surfaceReport) console.log(`  surface: ${line}`);
for (const f of manifest.files) console.log(`  ${String(f.bytes).padStart(8)}  ${f.path}`);
console.log(`  ${String(manifest.totalBytes).padStart(8)}  total`);
