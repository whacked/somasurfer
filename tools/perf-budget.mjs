/**
 * Measures the built site against ci/performance-budget.json and fails if it
 * is over budget on any line.
 *
 *   node tools/perf-budget.mjs [--json out.json] [--quiet]
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
import { join, relative } from 'node:path';
import { REPO_ROOT, fail, pass, rel } from './lib/repo.mjs';
import { buildNameIndex } from '../packages/alc/src/index.ts';
import { joinNameIndex } from '../packages/atlas-web/src/viewer/nameindex.js';

const DIST = join(REPO_ROOT, 'packages', 'atlas-web', 'dist');
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
  const descriptor = JSON.parse(readFileSync(indexPath, 'utf8')).nameIndex ?? {};
  if (descriptor.source !== 'asset') {
    fail('performance budget', [
      `The atlas index declares name index source ${JSON.stringify(descriptor.source ?? null)}, not "asset".`,
      ``,
      `This gate measures the name index because app.js builds it on the critical`,
      `path, and it finds it through this descriptor rather than by hardcoding a`,
      `path. A source this does not understand means the critical-path measurement`,
      `would silently omit the name index again, which is the DOG-80 defect.`,
    ]);
  }
  const paths = [descriptor.namesPath, descriptor.coveringsPath].map((p) =>
    join(DIST, String(p ?? '').replace(/^\/+/, '')),
  );
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
const assetFiles = filesUnder(
  join(DIST, 'assets'),
  (r) => !r.endsWith('LICENSE') && !r.endsWith('ATTRIBUTION.md'),
).filter((p) => !isNameIndex(p));

/**
 * Parse cost, measured the way the client pays it: parse the JSON, then build
 * the lookup structures. Parsing alone understates it, because a mesh is not
 * useful until it is indexed.
 */
function parseMs(paths, buildLookups) {
  const sources = paths.map((p) => readFileSync(p, 'utf8'));
  let best = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const t0 = performance.now();
    let sink = 0;
    for (const text of sources) sink += buildLookups(JSON.parse(text));
    const dt = performance.now() - t0;
    if (!Number.isFinite(sink)) throw new Error('parse produced nothing');
    best = Math.min(best, dt);
  }
  return best;
}

/**
 * The index parse term: `data/*.json` plus the name index, in one timed block.
 *
 * The name index cannot go through `parseMs` because it is not per-file work —
 * `app.js` joins the two documents and builds one index from the pair, and
 * `buildNameIndex` calls `covering()` once per structure. Measuring the files
 * separately would measure neither the join nor the normalisation, which is
 * most of the cost and the whole subject of DOG-80.
 */
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

const indexParseMs = (() => {
  const dataSources = dataFiles.map((p) => readFileSync(p, 'utf8'));
  const [namesText, coveringsText] = nameIndexPaths.map((p) => readFileSync(p, 'utf8'));
  let best = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const t0 = performance.now();
    let sink = 0;
    for (const text of dataSources) sink += indexLookups(JSON.parse(text));
    // Step 1 of app.js, with the documents the build actually emitted.
    sink += buildNameIndex(joinNameIndex(JSON.parse(namesText), JSON.parse(coveringsText))).structures.length;
    const dt = performance.now() - t0;
    if (!Number.isFinite(sink) || sink <= 0) throw new Error('index parse produced nothing');
    best = Math.min(best, dt);
  }
  return best;
})();

/** Structures and cells in the index just measured, for the report. */
const nameIndexScale = (() => {
  const doc = JSON.parse(readFileSync(nameIndexPaths[1], 'utf8'));
  const coverings = doc.coverings ?? [];
  return { structures: coverings.length, cells: coverings.reduce((n, s) => n + (s.cells?.length ?? 0), 0) };
})();

const assetParseMs = parseMs(assetFiles, (value) => {
  // What a viewer does before it can draw: walk positions and indices once.
  let sink = 0;
  for (const key of ['positions', 'indices']) {
    const arr = value[key];
    if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 1) sink += arr[i];
  }
  return sink + (value.levels?.length ?? 0) + 1;
});

// ---------------------------------------------------------------------------
// Derivation onto the reference machine.
// ---------------------------------------------------------------------------

const { downlinkMbps, rttMs } = budget.referenceMachine.network;
const bytesPerMs = (downlinkMbps * 1e6) / 8 / 1000;
const transferMs = (bytes) => bytes / bytesPerMs;

const bundleGzip = gzipBytes(bundleFiles);
const indexGzip = gzipBytes(indexFiles);
const assetGzip = gzipBytes(assetFiles);

/**
 * Every line, as a function of the factor the parse times are scaled by. Called
 * with `speedFactor` to get the figures for the reference machine, and with 1
 * to get the unnormalised figures the one-sided bounds are built from.
 */
function linesScaledBy(parseFactor) {
  const indexParseNorm = indexParseMs * parseFactor;
  const assetParseNorm = assetParseMs * parseFactor;

  const criticalPathMs =
    budget.transferModel.roundTrips.criticalPath * rttMs + transferMs(bundleGzip + indexGzip) + indexParseNorm;

  return {
    bundleGzipBytes: bundleGzip,
    indexGzipBytes: indexGzip,
    lowResAssetGzipBytes: assetGzip,
    indexParseMsNormalised: indexParseNorm,
    lowResAssetParseMsNormalised: assetParseNorm,
    derivedLowResAssetLoadMs:
      criticalPathMs + budget.transferModel.roundTrips.assets * rttMs + transferMs(assetGzip) + assetParseNorm,
    derivedFirstInteractionMs: criticalPathMs + budget.renderAllowanceMs.value,
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
const EXACT_LINES = new Set(['bundleGzipBytes', 'indexGzipBytes', 'lowResAssetGzipBytes']);
const CALIBRATED_LINES = new Set([
  'indexParseMsNormalised',
  'lowResAssetParseMsNormalised',
  'derivedLowResAssetLoadMs',
  'derivedFirstInteractionMs',
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
const fmt = (key, v) => (isBytes(key) ? `${(v / 1024).toFixed(1)} KiB` : `${v.toFixed(0)} ms`);

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
 */
const kindOf = (key) => {
  if (EXACT_LINES.has(key)) return 'exact';
  if (band === 'in') return 'normalised';
  return band === 'faster' ? 'at-least' : 'at-most';
};

const SIGIL = { exact: ' ', normalised: ' ', 'at-least': '≥', 'at-most': '≤' };

/**
 * True when the line's figure is a one-sided bound rather than the quantity its
 * key names. The JSON report nulls these, and every sentence printed about them
 * has to say "at least"/"at most" rather than "measured".
 */
const isBound = (key) => {
  const kind = kindOf(key);
  return kind === 'at-least' || kind === 'at-most';
};

const rows = [];
const over = [];
const notEvaluated = [];
const unverified = [];
const verdicts = {};

for (const [key, spec] of Object.entries(budget.budgets)) {
  const value = measurements[key];
  const kind = kindOf(key);
  const used = value / spec.limit;
  const exceeds = used > 1;

  // A bound only settles the question it points at. The other way round it is
  // silence, and silence is reported as silence.
  const verdict = UNVERIFIED_LINES.has(key)
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
    `${key.padEnd(30)} ${(SIGIL[kind] + fmt(key, value)).padStart(13)} / ${fmt(key, spec.limit).padStart(12)}` +
      `  ${(used * 100).toFixed(0).padStart(4)}% ` +
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
  `raw parse: index ${indexParseMs.toFixed(1)} ms, assets ${assetParseMs.toFixed(1)} ms on this machine`,
  `  the index term includes the name index app.js builds on the critical path:`
    + ` ${nameIndexScale.structures} structures, ${nameIndexScale.cells} cells`,
  `files: ${bundleFiles.length} bundle, ${indexFiles.length} index (${nameIndexPaths.length} of them the name index), ${assetFiles.length} asset`,
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
  `NOT MEASURED: the same two derived numbers in a real browser. That needs the`,
  `viewer and a headless browser in CI. Until then the ${budget.renderAllowanceMs.value} ms render allowance`,
  `in derivedFirstInteractionMs is a stated placeholder, not an observation.`,
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
  raw: { indexParseMs, assetParseMs },
  // The index parse term is not just JSON.parse any more, so what it covered is
  // part of the report rather than something a reader has to infer from a key.
  nameIndex: { ...nameIndexScale, files: nameIndexPaths.map((p) => rel(p)), countedAs: 'index' },
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
