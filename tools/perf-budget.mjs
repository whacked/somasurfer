/**
 * Measures the built site against ci/performance-budget.json and fails if it
 * is over budget on any line.
 *
 *   node tools/perf-budget.mjs [--json out.json] [--quiet] [--dist <dir>]
 *
 * What is honestly measured here, and what is not:
 *
 *   MEASURED. Gzipped transfer size of the bundle, the prebuilt indexes and
 *   the low-resolution assets. Time to JSON.parse each of them and build the
 *   lookup structures the client builds. These are the parts of the budget the
 *   build controls, and they are where a regression actually comes from — one
 *   careless asset export, one library added to the page shell.
 *
 *   DERIVED. Low-resolution asset load time and first-interaction time on the
 *   reference machine, computed from those measurements through the transfer
 *   model stated in the budget file, plus a fixed render allowance. Derived, not
 *   observed: a GitHub runner is not a mid-range laptop on a 25 Mbit/s link.
 *
 *   NOT MEASURED YET. The same two numbers in a real browser. That needs the
 *   viewer and a headless browser in CI, and neither exists. The gap is
 *   printed on every run rather than papered over, and docs/performance-budget.md
 *   says what it will take to close it.
 *
 * Parse times are normalised by a calibration workload so a fast or slow
 * runner does not silently move the gate. Raw numbers are always reported too.
 *
 * When the runner is too far from the reference for that correction to mean
 * anything, the gate does not quote a normalised number — that refusal is from
 * DOG-16 and it stays. What changed in DOG-29 is what the refusal costs. It
 * used to fail the build, which said "over budget" when the truth was "not
 * measurable from here", and a merge commit changing no file contents went red
 * on a fast runner. Now the line falls back to the one-sided bound that the
 * direction of the error makes valid:
 *
 *   runner faster than the reference  → unnormalised time is a LOWER bound on
 *     what the reference machine pays. Over budget here is over budget there;
 *     under budget here proves nothing and is reported `not evaluated`.
 *   runner slower than the reference  → unnormalised time is an UPPER bound.
 *     Under budget here is proof it fits; over budget proves nothing.
 *
 * So the gate still only ever fails on certainty, and byte budgets — which
 * never touch the calibration — stay exact and hard in every case.
 */

import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { REPO_ROOT, fail, pass, rel } from './lib/repo.mjs';
import { buildNameIndex } from '../packages/alc/src/index.ts';
import { MAGIC as ATLM_MAGIC, readMeshBin } from './lib/meshbin.mjs';
import { joinNameIndex } from '../packages/atlas-web/src/viewer/nameindex.js';
import { meshSetFrom } from '../packages/atlas-web/src/viewer/meshset.js';

/**
 * `--dist <dir>` measures a build somewhere other than packages/atlas-web/dist.
 * It exists so tools/verify-gates.mjs can measure a non-root-base build without
 * overwriting the one CI just built and checked; the Deploy job does not pass it.
 */
const distAt = process.argv.indexOf('--dist');
const DIST = distAt >= 0 ? resolve(REPO_ROOT, process.argv[distAt + 1]) : join(REPO_ROOT, 'packages', 'atlas-web', 'dist');
const budget = JSON.parse(readFileSync(join(REPO_ROOT, 'ci', 'performance-budget.json'), 'utf8'));

if (!existsSync(DIST)) {
  fail('performance budget', [`${rel(DIST)} does not exist. Run \`npm run build\` first.`]);
}

// ---------------------------------------------------------------------------
// Calibration. A fixed workload whose cost on the reference machine is recorded
// in the budget file, used to scale measured parse times onto that machine.
// ---------------------------------------------------------------------------

function calibrationMs() {
  const t0 = performance.now();
  // Mixed integer and float work on a sizeable array: closer to JSON parsing
  // and mesh index building than a tight integer loop would be.
  const n = 1 << 20;
  const buf = new Float64Array(n);
  for (let i = 0; i < n; i += 1) buf[i] = (i * 2654435761) % 1000 / 7 + 1;
  let acc = 0;
  for (let pass = 0; pass < 6; pass += 1) {
    for (let i = 0; i < n; i += 1) acc += Math.sqrt(buf[i]) * (i & 7);
  }
  if (!Number.isFinite(acc)) throw new Error('calibration diverged');
  return performance.now() - t0;
}

/**
 * `--calibration-ms <n>` substitutes a calibration reading instead of measuring
 * one. It exists so tools/verify-gates.mjs can put this gate on a runner of a
 * chosen speed — the fast-runner path cannot be reproduced on demand otherwise,
 * and an unreproducible path is one nobody can prove still works. Every run
 * that uses it says so, in the report and in the JSON, because a substituted
 * calibration makes the parse lines something other than a measurement.
 */
const overrideAt = process.argv.indexOf('--calibration-ms');
const calibrationOverrideMs = overrideAt >= 0 ? Number(process.argv[overrideAt + 1]) : null;
if (calibrationOverrideMs !== null && !(calibrationOverrideMs > 0)) {
  fail('performance budget', [`--calibration-ms needs a positive number, got ${process.argv[overrideAt + 1]}.`]);
}

// Best of three: we want the machine's capability, not the scheduler's mood.
const observedCalibrationMs =
  calibrationOverrideMs ?? Math.min(calibrationMs(), calibrationMs(), calibrationMs());
const speedFactor = budget.calibration.referenceMs / observedCalibrationMs;
const { minSpeedFactor, maxSpeedFactor } = budget.calibration;

/**
 * Which side of the band this runner is on. Being outside it is a statement
 * about the runner, not about the build, which is why it no longer ends the
 * run: `faster` and `slower` each leave one direction of the comparison sound,
 * and the gate goes on to use it.
 */
const band = speedFactor > maxSpeedFactor ? 'faster' : speedFactor < minSpeedFactor ? 'slower' : 'in';

// ---------------------------------------------------------------------------
// Measurement.
// ---------------------------------------------------------------------------

function filesUnder(dir, predicate) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (predicate(relative(DIST, p))) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const gzipBytes = (paths) => paths.reduce((n, p) => n + gzipSync(readFileSync(p), { level: 9 }).length, 0);

const bundleFiles = [
  join(DIST, 'index.html'),
  ...filesUnder(join(DIST, 'app'), () => true),
].filter((p) => existsSync(p));

/**
 * Where the built site says its name index lives, read the way app.js reads it.
 *
 * This matters more than it looks. The name index is served out of the assets
 * tree, for licence and attribution reasons, but it is not a low-resolution
 * asset: `app.js` awaits it in step 1, before templates and before the page can
 * answer a click. It is an index on the critical path that happens to live in
 * the assets directory.
 *
 * Until DOG-80 this gate partitioned by DIRECTORY, so the name index fell into
 * the asset lines and `covering()` was measured by no line at all — the asset
 * parse term only walks `positions` and `indices`. `indexParseMsNormalised`
 * therefore reported 0.9 ms raw, 4% of its budget, for a row whose stated
 * subject is "building the lookup maps", while the real name index took
 * seconds. Classifying by ROLE instead is what makes the critical-path
 * derivation below mean what it says.
 */
function nameIndexFiles() {
  const indexPath = join(DIST, 'data', 'atlas-index.json');
  if (!existsSync(indexPath)) {
    fail('performance budget', [`${rel(indexPath)} does not exist. Run \`npm run build\` first.`]);
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const descriptor = index.nameIndex;

  // A build that declares no name index has nothing here to measure, and that
  // is a fact about the build rather than a failure — `main` is such a build
  // today, with no app.js step 1 and no assets/labels. It is reported, loudly,
  // in the detail block and in the JSON, because an omission nobody could see
  // is the whole of DOG-80 and a silent zero would recreate it.
  if (descriptor === undefined || descriptor === null) return [];

  // A descriptor that exists but is not one this understands is different: the
  // build has a name index and this gate cannot find it, so measuring the
  // critical path without it would be the DOG-80 defect with the evidence
  // sitting right there.
  if (descriptor.source !== 'asset') {
    fail('performance budget', [
      `The atlas index declares name index source ${JSON.stringify(descriptor.source ?? null)}, not "asset".`,
      ``,
      `This gate measures the name index because app.js builds it on the critical`,
      `path, and it finds it through this descriptor rather than by hardcoding a`,
      `path. A source this does not understand means the critical-path measurement`,
      `would silently omit the name index again, which is the DOG-80 defect. If this`,
      `build genuinely has no name index, omit the \`nameIndex\` key rather than`,
      `declaring a source, and the line will say so instead of failing.`,
    ]);
  }
  // The descriptor's paths are URLs, and they carry the deploy base: Pages builds
  // with `--base /somasurfer/` and the index says `/somasurfer/assets/...`, which
  // is right for the site and is not a path under dist/. app.js strips the
  // index's own `base` before it fetches, so this does the same, from the same
  // field. Joining the URL onto dist/ as it stood failed every non-root deploy
  // (DOG-120), and CI only ever builds at `/`, so nothing here could see it.
  // A relative path is fetched under the base as it stands, so only an absolute
  // one outside the base is unreachable.
  const base = typeof index.base === 'string' && index.base !== '' ? index.base : '/';
  const urls = [descriptor.namesPath, descriptor.coveringsPath].map((p) => String(p ?? ''));
  const outside = urls.filter((u) => u.startsWith('/') && !u.startsWith(base));
  if (outside.length > 0) {
    fail('performance budget', [
      `The atlas index points at a name index outside its own base ${JSON.stringify(base)}:`,
      ...outside.map((u) => `  ${u}`),
      ``,
      `app.js fetches these paths under the base, so a path outside it is one the`,
      `page cannot fetch from this build either.`,
    ]);
  }
  const paths = urls.map((u) => join(DIST, u.startsWith(base) ? u.slice(base.length) : u));
  const missing = paths.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    fail('performance budget', [
      `The atlas index points at a name index that is not in the build:`,
      ...missing.map((p) => `  ${rel(p)}`),
    ]);
  }
  return paths;
}

const nameIndexPaths = nameIndexFiles();
const isNameIndex = (p) => nameIndexPaths.includes(p);

// Classified by role, not by directory: the name index counts as index on both
// the byte line and the parse line, so the critical path is costed once and
// consistently. `indexGzipBytes` was written for this — "256 KiB holds the full
// ALC-1 level and frame tables with room for a label index per frame".
const indexFiles = [...filesUnder(join(DIST, 'data'), () => true), ...nameIndexPaths];
const allAssetFiles = filesUnder(
  join(DIST, 'assets'),
  (r) => !r.endsWith('LICENSE') && !r.endsWith('ATTRIBUTION.md'),
).filter((p) => !isNameIndex(p));

/**
 * Asset files a mesh set declares as fetched lazily: its full-resolution tier
 * (DOG-127). They are not on the path to seeing anything, so they are not
 * low-resolution assets, and they get a byte line of their own.
 *
 * Classified by the set's own declaration (`tiers.*.loading` in its
 * structures.json) and never by a file name, so the failure is one-sided: a
 * lazy file nobody declared counts as low-resolution, where it is paid for, not
 * the other way round.
 *
 * The other direction is a declaration that is wrong, not missing: a lazy
 * `tiers.*.file` that points out of its own set (a template, a body mesh, the
 * next set over). Taking it off the low-resolution line would put it on no line
 * at all. So a set may only declare files in its own directory, and every lazy
 * file must land on a line that counts it.
 *
 * The body (DOG-128) is a mesh set like the brain, with its own share of the
 * low-resolution line and its own lazy line, so both kinds of set are read
 * here, and a lazy file must sit under the directory whose lines count it.
 */
const BRAIN_ASSETS = join(DIST, 'assets', 'brain');
const BODY_ASSETS = join(DIST, 'assets', 'body');
const inBrain = (p) => p.startsWith(`${BRAIN_ASSETS}/`);
const inBody = (p) => p.startsWith(`${BODY_ASSETS}/`);
const MESH_SET_SCHEMAS = ['atlas-brain-structures/1', 'atlas-body-structures/1'];
function lazyAssetFiles() {
  const out = new Set();
  const wrong = [];
  for (const p of allAssetFiles.filter((f) => f.endsWith('structures.json'))) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    if (!MESH_SET_SCHEMAS.includes(doc?.schema)) continue;
    for (const [name, tier] of Object.entries(doc.tiers ?? {})) {
      if (tier.loading !== 'lazy') continue;
      const file = join(DIST, 'assets', String(tier.file));
      if (dirname(file) !== dirname(p)) wrong.push(`  ${rel(p)} declares tiers.${name} ${tier.file} lazy; a set may only declare files beside its own structures.json.`);
      else if (!inBrain(file) && !inBody(file)) wrong.push(`  ${rel(p)} declares ${tier.file} lazy, and no byte line counts a lazy file outside dist/assets/brain/ or dist/assets/body/.`);
      else out.add(file);
    }
  }
  if (wrong.length > 0) {
    fail('performance budget', ['A lazy declaration would take a file off every byte line:', ...wrong]);
  }
  return out;
}
const lazyAssets = lazyAssetFiles();
const assetFiles = allAssetFiles.filter((p) => !lazyAssets.has(p));
const lowResBrainFiles = assetFiles.filter(inBrain);
const fullResBrainFiles = [...lazyAssets].filter(inBrain);
const lowResBodyFiles = assetFiles.filter(inBody);
const fullResBodyFiles = [...lazyAssets].filter(inBody);
const missingLazy = [...lazyAssets].filter((p) => !existsSync(p));
if (missingLazy.length > 0) {
  fail('performance budget', [
    'A mesh set declares lazily fetched files that are not in the build:',
    ...missingLazy.map((p) => `  ${rel(p)}`),
  ]);
}

/**
 * Parse cost, measured the way the client pays it: parse the JSON, then build
 * the lookup structures. Parsing alone understates it, because a mesh is not
 * useful until it is indexed.
 *
 * A binary mesh (DOG-127) is recognised by its magic bytes and read with the
 * format's own reader, tools/lib/meshbin.mjs, which is the reader the viewer
 * takes too. Its parse is the header and the typed-array views over it, and its
 * lookups are the same single walk of positions and indices a JSON mesh gets.
 * JSON.parse of a binary file is what this used to do, and it threw.
 */
const isAtlm = (bytes) => bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === ATLM_MAGIC;
function parseMs(paths, buildLookups) {
  const sources = paths.map((p) => {
    const bytes = readFileSync(p);
    return isAtlm(bytes) ? { binary: bytes } : { text: bytes.toString('utf8') };
  });
  let best = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const t0 = performance.now();
    let sink = 0;
    for (const src of sources) sink += buildLookups(src.binary ? readMeshBin(src.binary) : JSON.parse(src.text));
    const dt = performance.now() - t0;
    if (!Number.isFinite(sink)) throw new Error('parse produced nothing');
    best = Math.min(best, dt);
  }
  return best;
}

const dataFiles = indexFiles.filter((p) => !isNameIndex(p));

function indexLookups(value) {
  // What app.js does: index frames by id and group levels by region.
  const frames = new Map((value.frames ?? []).map((f) => [f.id, f]));
  const byRegion = new Map();
  for (const l of value.bodyLevels ?? []) {
    if (!byRegion.has(l.region)) byRegion.set(l.region, []);
    byRegion.get(l.region).push(l.label);
  }
  return frames.size + byRegion.size;
}

/**
 * The index parse term: `data/*.json` and the lookup maps built from them.
 *
 * This is the scope the 40 ms was written for, and DOG-98 put it back. DOG-80
 * had the name index inside this block, which made the row measure the right
 * total against a limit written for part of it; the name index now has two lines
 * of its own below and the critical-path derivation adds them both.
 */
const indexParseMs = parseMs(dataFiles, indexLookups);

/**
 * Step 1 of `app.js`, timed on its own: join the two documents the build emitted
 * and build one index from the pair. `null` when the build declares no name
 * index, which is a fact about the build and not a zero.
 *
 * It cannot go through `parseMs` because it is not per-file work — `app.js`
 * joins the pair and `buildNameIndex` calls `covering()` once per structure.
 * Measuring the files separately would measure neither the join nor the
 * normalisation, which is most of the cost and the whole subject of DOG-80.
 */
/**
 * Attempts behind the name index reading, and the reason it is not three.
 *
 * Best-of-three measures the JIT warming up, not the work. Interleaved against
 * the calibration on this runner, best-of-three read 72-92 ms normalised while
 * best-of-fifteen read 47-63 ms from the same build in the same process: the
 * raw figure falls from about 53 ms to about 24 ms and then stops falling. The
 * first few attempts are the optimiser, and a limit derived from them is a
 * limit set against a cost the browser pays once and this gate pays every run.
 *
 * It is also what makes a both-directions limit possible at all. The rule in
 * DOG-98 is `1.5 x the gate's own best-of-N reading`, and 1.5x only covers the
 * spread if the spread is small; at N=3 it was not. Fifteen attempts of a ~25 ms
 * build cost well under a second, which is nothing against this gate's run.
 *
 * The CALIBRATION is deliberately left at best-of-three. Raising it would move
 * speedFactor and therefore every other normalised line on this gate, against
 * limits that were set with the current reading — a change to lines DOG-98 is
 * not about. The noise that remains in this figure is mostly that calibration's.
 */
const NAME_INDEX_ATTEMPTS = 15;

const nameIndexBuild = (() => {
  if (nameIndexPaths.length === 0) return { best: null, firstAttempt: null };
  const [namesText, coveringsText] = nameIndexPaths.map((p) => readFileSync(p, 'utf8'));
  let best = Infinity;
  let firstAttempt = null;
  for (let attempt = 0; attempt < NAME_INDEX_ATTEMPTS; attempt += 1) {
    const t0 = performance.now();
    const sink = buildNameIndex(joinNameIndex(JSON.parse(namesText), JSON.parse(coveringsText))).structures.length;
    const dt = performance.now() - t0;
    if (!Number.isFinite(sink) || sink <= 0) throw new Error('name index build produced nothing');
    if (firstAttempt === null) firstAttempt = dt;
    best = Math.min(best, dt);
  }
  return { best, firstAttempt };
})();

const nameIndexBuildMs = nameIndexBuild.best;

/**
 * The attempt the browser actually pays, kept beside the one that is gated.
 *
 * A best-of-N reading is the machine's capability, which is the right thing to
 * gate on: it is comparable run to run, and every other line on this gate is
 * measured the same way. It is NOT what a user pays. `app.js` builds this index
 * exactly once, on a cold JIT, and the first attempt here runs about twice the
 * steady-state time — roughly 53 ms against 25 ms raw on this runner. So the
 * gated figure, and the critical path derived from it, are optimistic about the
 * name index by about that factor.
 *
 * Reported rather than gated, deliberately: a single cold sample is far too
 * noisy to put a limit against, and the honest ceiling for the user-facing claim
 * is the 5%-of-first-interaction cap on the limit itself. Closing the gap needs a
 * browser-observed first interaction, which is already this gate's largest
 * NOT MEASURED item.
 */
const nameIndexFirstAttemptMs = nameIndexBuild.firstAttempt;

/** Structures and cells in the index just measured, or null if the build has none. */
const nameIndexScale = (() => {
  if (nameIndexPaths.length === 0) return null;
  const doc = JSON.parse(readFileSync(nameIndexPaths[1], 'utf8'));
  const coverings = doc.coverings ?? [];
  return { structures: coverings.length, cells: coverings.reduce((n, s) => n + (s.cells?.length ?? 0), 0) };
})();

const assetParseMs = parseMs(assetFiles, (value) => {
  // What a viewer does before it can draw: walk positions and indices once.
  let sink = 0;
  for (const key of ['positions', 'indices']) {
    const arr = value[key];
    if (Array.isArray(arr) || ArrayBuffer.isView(arr)) for (let i = 0; i < arr.length; i += 1) sink += arr[i];
  }
  return sink + (value.levels?.length ?? 0) + 1;
});

/**
 * The first brain frame (DOG-129): every file a brain link fetches before the
 * brain can be drawn, and the work the page does on them.
 *
 * Read from the build's own `meshSets` declaration in the atlas index, the way
 * app.js reads it, so the bytes are the files the page fetches: each brain
 * set's structures.json, its label file and registration where it has them,
 * and its eager (`low`) tier. Not `lowResBrainAssetGzipBytes`, which is a byte
 * line over a directory and would cost a file nobody fetches for this frame.
 *
 * The parse term is the viewer's own decode, `meshSetFrom` in
 * packages/atlas-web/src/viewer/meshset.js: JSON.parse of the documents, then
 * dequantise, transform into MNI, split the cortex into lobes, lay out by
 * layer and box every structure. The reader's walk alone, which is what
 * `lowResAssetParseMsNormalised` measures, is a fraction of that, and the page
 * draws nothing until all of it has run.
 *
 * `null` when the build declares no brain mesh set, as `main` does today: a
 * fact about the build, reported as such, never a zero.
 */
const brainFrame = (() => {
  const index = JSON.parse(readFileSync(join(DIST, 'data', 'atlas-index.json'), 'utf8'));
  const base = typeof index.base === 'string' && index.base !== '' ? index.base : '/';
  const sets = (index.meshSets ?? []).filter((e) => e.atlas === 'brain');
  if (sets.length === 0) return null;
  const toDist = (u) => join(DIST, String(u).startsWith(base) ? String(u).slice(base.length) : String(u));
  const files = [];
  const inputs = sets.map((entry) => {
    const texts = {};
    for (const key of ['structures', 'labels', 'registration']) {
      if (!entry[key]) continue;
      const path = toDist(entry[key]);
      files.push(path);
      texts[key] = readFileSync(path, 'utf8');
    }
    const low = JSON.parse(texts.structures).tiers?.low?.file;
    if (typeof low !== 'string') fail('performance budget', [`${rel(toDist(entry.structures))} declares no low tier, so no first brain frame can be drawn from it.`]);
    const path = join(DIST, 'assets', low);
    files.push(path);
    return { entry, texts, bytes: readFileSync(path) };
  });
  let best = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const t0 = performance.now();
    let sink = 0;
    for (const { entry, texts, bytes } of inputs) {
      const docs = Object.fromEntries(Object.entries(texts).map(([k, t]) => [k, JSON.parse(t)]));
      sink += meshSetFrom(entry, docs, bytes).structures.length;
    }
    if (!(sink > 0)) throw new Error('the first brain frame decoded no structures');
    best = Math.min(best, performance.now() - t0);
  }
  return { files, gzip: gzipBytes(files), parseMs: best };
})();

// ---------------------------------------------------------------------------
// Derivation onto the reference machine.
// ---------------------------------------------------------------------------

const { downlinkMbps, rttMs } = budget.referenceMachine.network;
const bytesPerMs = (downlinkMbps * 1e6) / 8 / 1000;
const transferMs = (bytes) => bytes / bytesPerMs;

const bundleGzip = gzipBytes(bundleFiles);
const indexGzip = gzipBytes(indexFiles);
const assetGzip = gzipBytes(assetFiles);
const lowResBrainGzip = gzipBytes(lowResBrainFiles);
const fullResBrainGzip = gzipBytes(fullResBrainFiles);
const lowResBodyGzip = gzipBytes(lowResBodyFiles);
const fullResBodyGzip = gzipBytes(fullResBodyFiles);

/**
 * Every line, as a function of the factor the parse times are scaled by. Called
 * with `speedFactor` to get the figures for the reference machine, and with 1
 * to get the unnormalised figures the one-sided bounds are built from.
 */
function linesScaledBy(parseFactor) {
  const indexParseNorm = indexParseMs * parseFactor;
  const assetParseNorm = assetParseMs * parseFactor;
  const nameIndexNorm = nameIndexBuildMs === null ? null : nameIndexBuildMs * parseFactor;

  // Splitting the name index onto its own lines changed which line reports it,
  // not when the page pays it: `app.js` awaits the index before it can answer a
  // click, so it is still inside the critical path here. Dropping it from this
  // sum while giving it a line of its own would be DOG-80's defect wearing a
  // different hat — a number that looks measured and is quietly missing.
  const criticalPathMs =
    budget.transferModel.roundTrips.criticalPath * rttMs
    + transferMs(bundleGzip + indexGzip)
    + indexParseNorm
    + (nameIndexNorm ?? 0);

  return {
    bundleGzipBytes: bundleGzip,
    indexGzipBytes: indexGzip,
    lowResAssetGzipBytes: assetGzip,
    // The brain's share of the line above, agreed with W3 (DOG-128) so the body
    // has its own room inside the same 2.5 MiB. Inside, not beside: these bytes
    // are counted in lowResAssetGzipBytes as well.
    lowResBrainAssetGzipBytes: lowResBrainGzip,
    // Lazily fetched; not in derivedLowResAssetLoadMs, because nothing waits
    // for it before the brain can be seen.
    fullResBrainAssetGzipBytes: fullResBrainGzip,
    // The body's share (DOG-128), on the same terms: inside the 2.5 MiB line,
    // and its lazy tier on a line of its own.
    lowResBodyAssetGzipBytes: lowResBodyGzip,
    fullResBodyAssetGzipBytes: fullResBodyGzip,
    indexParseMsNormalised: indexParseNorm,
    nameIndexBuildMsNormalised: nameIndexNorm,
    // The same measurement over the cells it bound. The absolute line is what
    // the main thread can afford at boot today; this one is what the work costs
    // per unit of index, and it is the only one of the two that growth cannot
    // consume. 57 structures is the smallest index v1 will ever bind.
    nameIndexBuildUsPerCell:
      nameIndexNorm === null || !nameIndexScale?.cells ? null : (nameIndexNorm * 1000) / nameIndexScale.cells,
    lowResAssetParseMsNormalised: assetParseNorm,
    derivedLowResAssetLoadMs:
      criticalPathMs + budget.transferModel.roundTrips.assets * rttMs + transferMs(assetGzip) + assetParseNorm,
    derivedFirstInteractionMs: criticalPathMs + budget.renderAllowanceMs.value,
    // A brain link: the critical path, one round of asset requests, the brain
    // frame's own files, the viewer's decode of them, and the render allowance.
    derivedFirstBrainFrameMs: brainFrame === null
      ? null
      : criticalPathMs + budget.transferModel.roundTrips.assets * rttMs + transferMs(brainFrame.gzip)
        + brainFrame.parseMs * parseFactor + budget.renderAllowanceMs.value,
  };
}

// In the band, the normalised figures are the measurement. Outside it, the
// unnormalised figures are all that is sound, and each one is a bound in a
// stated direction rather than a value.
const measurements = linesScaledBy(band === 'in' ? speedFactor : 1);

// ---------------------------------------------------------------------------
// Gate.
// ---------------------------------------------------------------------------

/**
 * Byte lines never touch the calibration, so they are exact on any machine and
 * hard in every case. Every other line carries a parse term scaled by
 * speedFactor and is only as good as that correction. An unclassified budget
 * line fails the gate rather than defaulting to one or the other, so adding a
 * line forces whoever adds it to say which kind it is.
 */
const EXACT_LINES = new Set([
  'bundleGzipBytes',
  'indexGzipBytes',
  'lowResAssetGzipBytes',
  'lowResBrainAssetGzipBytes',
  'fullResBrainAssetGzipBytes',
  'lowResBodyAssetGzipBytes',
  'fullResBodyAssetGzipBytes',
]);
const CALIBRATED_LINES = new Set([
  'indexParseMsNormalised',
  // Both DOG-98 lines carry the parse term and are therefore only as good as
  // the correction. `nameIndexBuildUsPerCell` has no `Normalised` in its name
  // and is normalised all the same — it is the normalised millisecond figure
  // divided by a cell count, so it inherits every property of the correction.
  'nameIndexBuildMsNormalised',
  'nameIndexBuildUsPerCell',
  'lowResAssetParseMsNormalised',
  'derivedLowResAssetLoadMs',
  'derivedFirstInteractionMs',
  'derivedFirstBrainFrameMs',
]);

const unclassified = Object.keys(budget.budgets).filter((k) => !EXACT_LINES.has(k) && !CALIBRATED_LINES.has(k));
if (unclassified.length > 0) {
  fail('performance budget', [
    `Budget line(s) this gate does not know how to classify: ${unclassified.join(', ')}.`,
    ``,
    `Add each one to EXACT_LINES in tools/perf-budget.mjs if its value does not`,
    `depend on the calibration correction, or to CALIBRATED_LINES if it does. The`,
    `distinction decides whether the line can still be gated on a runner too far`,
    `from the reference to normalise, so it is not inferred.`,
  ]);
}

/**
 * The budget file and the set of things this gate measures must name exactly the
 * same lines, and disagreeing either way fails.
 *
 * The `unclassified` check above is only half the invariant: it catches a budget
 * line nobody measures. The other half is a measurement nobody budgets, and that
 * is the quieter failure — the verdict loop walks `budget.budgets`, so deleting
 * an entry from the JSON deletes the only thing that reads the number. The
 * measurement goes on being taken, the row stops being printed, and the gate
 * stays green while measuring strictly less than it did. DOG-98's two new lines
 * are exactly the kind of line that invites it: the cheapest way to make a
 * name-index regression go away is to delete the line that caught it.
 */
const measuredLines = Object.keys(linesScaledBy(1));
const unbudgeted = measuredLines.filter((k) => !(k in budget.budgets));
const unmeasured = Object.keys(budget.budgets).filter((k) => !measuredLines.includes(k));
if (unbudgeted.length > 0 || unmeasured.length > 0) {
  fail('performance budget', [
    `The budget file and this gate's measurements do not name the same lines.`,
    ``,
    ...(unbudgeted.length > 0
      ? [
          `Measured with no budget line beside it: ${unbudgeted.join(', ')}.`,
          `Nothing reads these numbers, so nothing can go red over them. If a line`,
          `is genuinely retired, stop measuring it in linesScaledBy() in the same`,
          `change; deleting only the budget entry removes the check and keeps the`,
          `cost, which is how a gate goes quiet without going red.`,
          ``,
        ]
      : []),
    ...(unmeasured.length > 0
      ? [
          `Budgeted with nothing measuring it: ${unmeasured.join(', ')}.`,
          `A limit with no measurement beside it reports NaN, not a pass.`,
          ``,
        ]
      : []),
  ]);
}

/**
 * Lines whose limit is declared as not yet settled against what the line now
 * measures. Such a line is reported `UNVERIFIED`, with its number, and does not
 * gate in either direction.
 *
 * This exists for one situation and it is narrow: the gate has started
 * measuring something real that the limit beside it was not written for. DOG-80
 * is the case. `indexParseMsNormalised` was 40 ms for `data/*.json` alone, and
 * it now also costs the name index that app.js builds on the critical path. The
 * measurement is sound and the limit is a product decision, so the gate quoting
 * either a pass or a failure would be inventing an answer it does not have.
 *
 * It is not a suppression, and the difference is worth being explicit about:
 *
 *   - a declaration must carry `reason` and `clearedBy`, or the gate fails
 *     naming the line, so "unverified" always comes with a sentence and a way
 *     out rather than being a flag someone set;
 *   - the number and its utilisation are printed on every run and kept in the
 *     JSON report, so the line is louder than it was when it was green, not
 *     quieter;
 *   - `verify-gates.mjs` holds a must-pass case that removes the declaration
 *     and requires the line to go RED. A declaration over a line that would
 *     have passed anyway is therefore caught, which is the failure mode that
 *     would otherwise turn this into exactly the suppression it is not.
 */
const UNVERIFIED_LINES = new Set(
  Object.entries(budget.budgets).filter(([, spec]) => spec.unverified !== undefined).map(([key]) => key),
);

const badlyDeclared = [...UNVERIFIED_LINES].filter((key) => {
  const u = budget.budgets[key].unverified;
  return typeof u?.reason !== 'string' || u.reason.trim() === ''
    || typeof u?.clearedBy !== 'string' || u.clearedBy.trim() === '';
});
if (badlyDeclared.length > 0) {
  fail('performance budget', [
    `Budget line(s) declared unverified without saying why: ${badlyDeclared.join(', ')}.`,
    ``,
    `An \`unverified\` block needs a non-empty \`reason\` and a non-empty \`clearedBy\`.`,
    `A line that stops being gated without a stated reason and a stated way back`,
    `is a suppression, and this gate does not have one of those.`,
  ]);
}

const isBytes = (key) => key.endsWith('Bytes');
const isPerCell = (key) => key.endsWith('UsPerCell');
const fmt = (key, v) =>
  v === null
    ? 'not in this build'
    : isBytes(key)
      ? `${(v / 1024).toFixed(1)} KiB`
      : isPerCell(key)
        ? `${v.toFixed(1)} us/cell`
        // Sub-10 ms fractions keep two significant figures: verify-gates stages
        // limits below a fast runner's 0.9 ms reading, and "a budget of 0 ms"
        // would misstate them.
        : `${v >= 10 || Number.isInteger(v) ? v.toFixed(0) : Number(v.toPrecision(2))} ms`;

/**
 * What a line's number is allowed to prove.
 *
 *   exact       both directions. The bytes are the bytes.
 *   normalised  both directions, through a correction inside the band.
 *   at-least    the runner is faster than the reference, so the reference pays
 *               at least this much: over the limit proves over budget, under it
 *               proves nothing.
 *   at-most     the runner is slower, so the reference pays at most this much:
 *               under the limit proves it fits, over it proves nothing.
 *   absent      this build produced nothing to measure. Not a zero and not a
 *               pass: `main` declares no name index at all, so its DOG-98 lines
 *               have no subject rather than a cheap one.
 */
const ABSENT_LINES = new Set(Object.keys(budget.budgets).filter((k) => measurements[k] === null));

const kindOf = (key) => {
  if (ABSENT_LINES.has(key)) return 'absent';
  if (EXACT_LINES.has(key)) return 'exact';
  if (band === 'in') return 'normalised';
  return band === 'faster' ? 'at-least' : 'at-most';
};

const SIGIL = { exact: ' ', normalised: ' ', 'at-least': '≥', 'at-most': '≤', absent: ' ' };

/**
 * True when the line's figure is a one-sided bound rather than the quantity its
 * key names. The JSON report nulls these, and every sentence printed about them
 * has to say "at least"/"at most" rather than "measured".
 */
const isBound = (key) => {
  const kind = kindOf(key);
  return kind === 'at-least' || kind === 'at-most' || kind === 'absent';
};

const rows = [];
const over = [];
const notEvaluated = [];
const unverified = [];
const verdicts = {};

for (const [key, spec] of Object.entries(budget.budgets)) {
  const value = measurements[key];
  const kind = kindOf(key);
  const used = value === null ? null : value / spec.limit;
  const exceeds = used !== null && used > 1;

  // A bound only settles the question it points at. The other way round it is
  // silence, and silence is reported as silence.
  const verdict = kind === 'absent'
    ? 'not evaluated'
    : UNVERIFIED_LINES.has(key)
      ? 'unverified'
      : kind === 'exact' || kind === 'normalised'
        ? exceeds
          ? 'over'
          : 'within'
        : kind === 'at-least'
          ? exceeds
            ? 'over'
            : 'not evaluated'
          : exceeds
            ? 'not evaluated'
            : 'within';
  // `reported` is the figure the verdict was taken from, whatever kind it is.
  // The JSON report nulls `measurements[key]` for a line that was not
  // evaluated, so this is where the bound survives without being mistaken for
  // a measurement of the line the key is named after.
  verdicts[key] = { kind, verdict, reported: value };

  rows.push(
    `${key.padEnd(30)} ${(SIGIL[kind] + fmt(key, value)).padStart(18)} / ${fmt(key, spec.limit).padStart(12)}` +
      `  ${(used === null ? '   -' : (used * 100).toFixed(0).padStart(4))}% ` +
      `${verdict === 'over' ? 'OVER' : verdict === 'not evaluated' ? 'not evaluated' : verdict === 'unverified' ? 'UNVERIFIED' : ''}`,
  );

  if (verdict === 'not evaluated') notEvaluated.push(key);

  if (verdict === 'unverified') {
    const u = spec.unverified;
    // Off-band this line's number is a bound, not a measurement, and an
    // unverified line is no more exempt from saying so than a gated one is.
    const quantity = kind === 'at-least'
      ? `at least ${fmt(key, value)}`
      : kind === 'at-most'
        ? `at most ${fmt(key, value)}`
        : `${fmt(key, value)} measured`;
    unverified.push(`${key}: ${quantity} against a budget of ${fmt(key, spec.limit)}`
      + ` (${(used * 100).toFixed(0)}%), NOT GATED.`);
    unverified.push(`  why it is not gated: ${u.reason}`);
    unverified.push(`  what would clear it: ${u.clearedBy}`);
    unverified.push(`  covers: ${spec.covers}`);
  }

  if (verdict === 'over') {
    const claim =
      kind === 'at-least'
        ? `at least ${fmt(key, value)} on the reference machine, against a budget of ${fmt(key, spec.limit)}`
        : `${fmt(key, value)} against a budget of ${fmt(key, spec.limit)} (${(used * 100).toFixed(0)}%)`;
    over.push(`${key}: ${claim}.`);
    if (kind === 'at-least') {
      over.push(`  This is the unnormalised time. The runner is ${speedFactor.toFixed(2)}× faster than the`);
      over.push(`  reference, so the reference machine pays at least this much: over budget`);
      over.push(`  here is over budget there, whatever the correction would have been.`);
    }
    over.push(`  covers: ${spec.covers}`);
    over.push(`  why the budget is what it is: ${spec.why}`);
  }
}

/**
 * The one pair of verdicts whose remedy is not the obvious one.
 *
 * `nameIndexBuildMsNormalised` over while `nameIndexBuildUsPerCell` is still
 * within means the per-cell cost has not moved and the index got bigger. That is
 * not a regression and raising the absolute line does not answer it, so the gate
 * says so itself rather than leaving the next reader to re-derive it from two
 * rows. DOG-97 §2.4 is the decision this sentence carries: the fix is to take
 * the build off the critical path, and the only reason it is not already done is
 * that there is no "after first interaction" to move it to while a deep link
 * consumes the index before anything is drawn.
 */
if (verdicts.nameIndexBuildMsNormalised?.verdict === 'over' && verdicts.nameIndexBuildUsPerCell?.verdict === 'within') {
  over.push(``);
  over.push(`THIS IS NOT A REGRESSION, AND RAISING THE LINE IS THE WRONG FIX.`);
  over.push(`  nameIndexBuildUsPerCell is still within its limit, so the cost of binding one`);
  over.push(`  cell has not moved. The index has grown past what the main thread should be`);
  over.push(`  doing at boot — more structures and more cells, each one costing what it`);
  over.push(`  always did.`);
  over.push(`  The remedy is to move the name index build off the critical path — build it`);
  over.push(`  in a worker, or after first interaction — not to raise this limit. Raising it`);
  over.push(`  buys one more index's worth of growth and spends first-interaction budget`);
  over.push(`  that the viewer needs. See DOG-97 §2.4.`);
  over.push(`  If the per-cell line is ALSO over, this sentence does not apply: that is a`);
  over.push(`  real regression in covering() or the join, and it is the per-cell line's`);
  over.push(`  failure to explain.`);
}

// What the calibration reading means for this run, said before the table so
// the table's sigils are never read as a measurement they are not.
const calibrationNote =
  band === 'in'
    ? [
        `calibration: ${observedCalibrationMs.toFixed(0)} ms here vs ${budget.calibration.referenceMs} ms reference` +
          ` → parse times scaled by ${speedFactor.toFixed(2)}`,
      ]
    : [
        `calibration: ${observedCalibrationMs.toFixed(0)} ms here vs ${budget.calibration.referenceMs} ms reference` +
          ` → speed factor ${speedFactor.toFixed(2)}, OUTSIDE [${minSpeedFactor}, ${maxSpeedFactor}]`,
        `  This runner is ${band === 'faster' ? 'too fast' : 'too slow'} for a ${speedFactor.toFixed(2)}× correction to mean anything, so no`,
        `  normalised parse time is quoted. Byte budgets are exact and still hard.`,
        band === 'faster'
          ? `  Calibrated lines are shown unnormalised and marked ≥: a lower bound on what`
          : `  Calibrated lines are shown unnormalised and marked ≤: an upper bound on what`,
        band === 'faster'
          ? `  the reference machine pays. Over budget there is proof; under it is not, and`
          : `  the reference machine pays. Under budget there is proof; over it is not, and`,
        `  is reported as not evaluated rather than as a pass or a failure.`,
      ];

const detail = [
  `reference: ${budget.referenceMachine.label}, ${downlinkMbps} Mbit/s, ${rttMs} ms RTT`,
  ...calibrationNote,
  `raw parse: index ${indexParseMs.toFixed(1)} ms, assets ${assetParseMs.toFixed(1)} ms`
    + `${nameIndexBuildMs === null ? '' : `, name index build ${nameIndexBuildMs.toFixed(1)} ms`
      + ` (best of ${NAME_INDEX_ATTEMPTS})`} on this machine`,
  nameIndexScale === null
    ? `  NAME INDEX NOT IN THIS BUILD: the atlas index declares none, so the two`
      + ` nameIndexBuild lines have no subject and are not evaluated. The index term`
      + ` is data/*.json either way.`
    : `  the name index app.js builds on the critical path, timed on its own lines and`
      + ` still inside the derived critical path: ${nameIndexScale.structures} structures,`
      + ` ${nameIndexScale.cells} cells`,
  ...(nameIndexFirstAttemptMs === null
    ? []
    : [
        `  its cold first attempt was ${nameIndexFirstAttemptMs.toFixed(1)} ms raw, against the`
          + ` ${nameIndexBuildMs.toFixed(1)} ms best-of-${NAME_INDEX_ATTEMPTS} the limit is set`
          + ` against. The browser pays the cold one, once,`,
        `  so the gated figure and derivedFirstInteractionMs are optimistic about this`
          + ` term. Not gated: one cold sample is too noisy for a limit.`,
      ]),
  `files: ${bundleFiles.length} bundle, ${indexFiles.length} index (${nameIndexPaths.length} of them the name index), ${assetFiles.length} asset`
    + ` (${lowResBrainFiles.length} of them the low-resolution brain, ${lowResBodyFiles.length} the low-resolution body),`
    + ` ${lazyAssets.size} fetched lazily (${fullResBrainFiles.length} brain, ${fullResBodyFiles.length} body, full resolution)`,
  brainFrame === null
    ? `first brain frame: NOT IN THIS BUILD — the atlas index declares no brain mesh set.`
    : `first brain frame: ${brainFrame.files.length} files, ${(brainFrame.gzip / 1024).toFixed(1)} KiB gzip,`
      + ` the viewer's decode ${brainFrame.parseMs.toFixed(1)} ms raw (best of 3)`,
  ...(calibrationOverrideMs !== null
    ? [
        ``,
        `CALIBRATION SUBSTITUTED: --calibration-ms ${calibrationOverrideMs} was passed, so the speed`,
        `factor above was not measured on this machine and the parse lines are not a`,
        `measurement of it. Only tools/verify-gates.mjs passes this.`,
      ]
    : []),
  ``,
  ...rows,
  ``,
  ...(notEvaluated.length > 0
    ? [
        `NOT EVALUATED THIS RUN: ${notEvaluated.join(', ')}.`,
        `A green result here is not a statement about those lines. They need a runner`,
        `inside [${minSpeedFactor}, ${maxSpeedFactor}] of the reference, or a browser-observed measurement.`,
        // Two different reasons land in one list, and they are not the same
        // problem: a runner off the band is a property of this machine and goes
        // away on the next run, while an absent line is a property of the build
        // and does not. Saying which is which is the difference between "try
        // again" and "this base cannot answer that question at all".
        ...(ABSENT_LINES.size > 0
          ? [
              `  of those, not in this build at all: ${[...ABSENT_LINES].join(', ')}.`,
              `  A different runner will not change that; a build that declares a name index will.`,
            ]
          : []),
        ``,
      ]
    : []),
  ...(unverified.length > 0
    ? [
        `UNVERIFIED, MEASURED BUT NOT GATED:`,
        ...unverified,
        `A green result from this gate is not a statement about the line(s) above.`,
        `The measurement is sound; what is unsettled is the limit beside it.`,
        ``,
      ]
    : []),
  `NOT MEASURED: the derived numbers in a real browser. That needs the`,
  `viewer and a headless browser in CI. Until then the ${budget.renderAllowanceMs.value} ms render allowance`,
  `in derivedFirstInteractionMs and derivedFirstBrainFrameMs is a stated placeholder, not an observation.`,
];

const report = {
  schema: 'performance-measurement/1',
  referenceMachine: budget.referenceMachine,
  calibration: {
    observedMs: observedCalibrationMs,
    referenceMs: budget.calibration.referenceMs,
    speedFactor,
    band,
    // What every number below rests on, in one field: either the correction was
    // inside the band and the parse lines are normalised onto the reference
    // machine, or it was not and they are one-sided bounds taken from the raw
    // time. A consumer that branches on anything here should branch on this.
    decisionBasis: band === 'in' ? 'normalised' : 'one-sided-bound-from-raw',
    substituted: calibrationOverrideMs !== null,
  },
  raw: {
    indexParseMs,
    assetParseMs,
    nameIndexBuildMs,
    nameIndexBuildAttempts: NAME_INDEX_ATTEMPTS,
    // The cold attempt, which is the one the browser pays and the one no limit
    // is set against. A consumer comparing the gated figure to a real browser
    // needs this to know which way the difference points.
    nameIndexBuildFirstAttemptMs: nameIndexFirstAttemptMs,
  },
  // What the name index lines are about, in the report rather than inferred from
  // a key. `cells` is the divisor behind nameIndexBuildUsPerCell, so a consumer
  // can recompute the per-cell figure and see it is the same measurement.
  nameIndex: nameIndexScale === null
    ? { measured: false, reason: 'the atlas index declares no name index in this build' }
    : {
        measured: true,
        ...nameIndexScale,
        files: nameIndexPaths.map((p) => rel(p)),
        countedAs: { bytes: 'indexGzipBytes', time: 'nameIndexBuildMsNormalised + nameIndexBuildUsPerCell' },
        inCriticalPath: true,
      },
  // `null` for a line this run could not establish. Never a zero, never a pass,
  // and deliberately not the bound: off-band these keys are named for a
  // normalised figure that was not computed, so publishing the unnormalised
  // number here would make the key a false claim about its own contents. The
  // bound is in `verdicts[key].reported`, where its kind travels with it.
  //
  // Keyed off the KIND and not off the verdict. The two used to coincide, and
  // DOG-80's `unverified` verdict broke the coincidence: an unverified line is a
  // statement about the LIMIT and says nothing about whether the figure beside
  // it was normalised, so an off-band unverified line went on publishing a raw
  // number under a `...Normalised` key. `perf-fast-runner-is-not-a-failure`
  // caught it. The kind is what the sentence above was always about, and
  // off-band over-budget lines are now nulled here too, which is what that
  // sentence said and what the previous condition did not quite do.
  measurements: Object.fromEntries(
    Object.keys(budget.budgets).map((k) => [k, isBound(k) ? null : measurements[k]]),
  ),
  budgets: Object.fromEntries(Object.entries(budget.budgets).map(([k, v]) => [k, v.limit])),
  utilisation: Object.fromEntries(
    Object.entries(budget.budgets).map(([k, v]) => [
      k,
      isBound(k) ? null : Number((measurements[k] / v.limit).toFixed(3)),
    ]),
  ),
  // Which lines the numbers above can carry a verdict for, and in which
  // direction. A consumer that reads `measurements` without reading this is
  // reading a bound as if it were a measurement.
  verdicts,
  notEvaluated,
  // Measured, reported, and deliberately not gated. A consumer that treats this
  // gate's exit code as "every line is within budget" has to read this.
  unverified: Object.fromEntries(
    [...UNVERIFIED_LINES].map((k) => [k, { ...budget.budgets[k].unverified, measured: measurements[k] }]),
  ),
  notMeasured: ['browser-observed low-resolution asset load', 'browser-observed first interaction'],
};

const jsonArg = process.argv.indexOf('--json');
if (jsonArg >= 0) {
  writeFileSync(process.argv[jsonArg + 1], JSON.stringify(report, null, 2) + '\n');
}

if (over.length > 0) fail('performance budget', [...over, ``, ...detail]);
pass('performance budget', detail);
