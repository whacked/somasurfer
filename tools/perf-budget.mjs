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
 */

import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, fail, pass, rel } from './lib/repo.mjs';

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

// Best of three: we want the machine's capability, not the scheduler's mood.
const observedCalibrationMs = Math.min(calibrationMs(), calibrationMs(), calibrationMs());
const speedFactor = budget.calibration.referenceMs / observedCalibrationMs;

if (speedFactor > budget.calibration.maxSpeedFactor || speedFactor < budget.calibration.minSpeedFactor) {
  fail('performance budget', [
    `Calibration workload took ${observedCalibrationMs.toFixed(0)} ms; the reference machine takes` +
      ` ${budget.calibration.referenceMs} ms.`,
    `Speed factor ${speedFactor.toFixed(2)} is outside` +
      ` [${budget.calibration.minSpeedFactor}, ${budget.calibration.maxSpeedFactor}].`,
    ``,
    `This machine is too far from the reference for the correction to mean anything:`,
    `the normalisation would be doing more work than the measurement. Byte budgets`,
    `would still be valid, but reporting a normalised parse time from here would be`,
    `a number dressed up as a measurement, so the gate refuses rather than guesses.`,
  ]);
}

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
const indexFiles = filesUnder(join(DIST, 'data'), () => true);
const assetFiles = filesUnder(
  join(DIST, 'assets'),
  (r) => !r.endsWith('LICENSE') && !r.endsWith('ATTRIBUTION.md'),
);

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

const indexParseMs = parseMs(indexFiles, (value) => {
  // What app.js does: index frames by id and group levels by region.
  const frames = new Map((value.frames ?? []).map((f) => [f.id, f]));
  const byRegion = new Map();
  for (const l of value.bodyLevels ?? []) {
    if (!byRegion.has(l.region)) byRegion.set(l.region, []);
    byRegion.get(l.region).push(l.label);
  }
  return frames.size + byRegion.size;
});

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

const indexParseNorm = indexParseMs * speedFactor;
const assetParseNorm = assetParseMs * speedFactor;

const criticalPathMs =
  budget.transferModel.roundTrips.criticalPath * rttMs + transferMs(bundleGzip + indexGzip) + indexParseNorm;

const derivedLowResAssetLoadMs =
  criticalPathMs + budget.transferModel.roundTrips.assets * rttMs + transferMs(assetGzip) + assetParseNorm;

const derivedFirstInteractionMs = criticalPathMs + budget.renderAllowanceMs.value;

// ---------------------------------------------------------------------------
// Gate.
// ---------------------------------------------------------------------------

const measurements = {
  bundleGzipBytes: bundleGzip,
  indexGzipBytes: indexGzip,
  lowResAssetGzipBytes: assetGzip,
  indexParseMsNormalised: indexParseNorm,
  lowResAssetParseMsNormalised: assetParseNorm,
  derivedLowResAssetLoadMs,
  derivedFirstInteractionMs,
};

const isBytes = (key) => key.endsWith('Bytes');
const fmt = (key, v) => (isBytes(key) ? `${(v / 1024).toFixed(1)} KiB` : `${v.toFixed(0)} ms`);

const rows = [];
const over = [];
for (const [key, spec] of Object.entries(budget.budgets)) {
  const value = measurements[key];
  const used = value / spec.limit;
  rows.push(
    `${key.padEnd(30)} ${fmt(key, value).padStart(12)} / ${fmt(key, spec.limit).padStart(12)}` +
      `  ${(used * 100).toFixed(0).padStart(4)}% ${used > 1 ? 'OVER' : ''}`,
  );
  if (used > 1) {
    over.push(`${key}: ${fmt(key, value)} against a budget of ${fmt(key, spec.limit)} (${(used * 100).toFixed(0)}%).`);
    over.push(`  covers: ${spec.covers}`);
    over.push(`  why the budget is what it is: ${spec.why}`);
  }
}

const detail = [
  `reference: ${budget.referenceMachine.label}, ${downlinkMbps} Mbit/s, ${rttMs} ms RTT`,
  `calibration: ${observedCalibrationMs.toFixed(0)} ms here vs ${budget.calibration.referenceMs} ms reference` +
    ` → parse times scaled by ${speedFactor.toFixed(2)}`,
  `raw parse: index ${indexParseMs.toFixed(1)} ms, assets ${assetParseMs.toFixed(1)} ms on this machine`,
  `files: ${bundleFiles.length} bundle, ${indexFiles.length} index, ${assetFiles.length} asset`,
  ``,
  ...rows,
  ``,
  `NOT MEASURED: the same two derived numbers in a real browser. That needs the`,
  `viewer and a headless browser in CI. Until then the ${budget.renderAllowanceMs.value} ms render allowance`,
  `in derivedFirstInteractionMs is a stated placeholder, not an observation.`,
];

const report = {
  schema: 'performance-measurement/1',
  referenceMachine: budget.referenceMachine,
  calibration: { observedMs: observedCalibrationMs, referenceMs: budget.calibration.referenceMs, speedFactor },
  raw: { indexParseMs, assetParseMs },
  measurements,
  budgets: Object.fromEntries(Object.entries(budget.budgets).map(([k, v]) => [k, v.limit])),
  utilisation: Object.fromEntries(
    Object.entries(budget.budgets).map(([k, v]) => [k, Number((measurements[k] / v.limit).toFixed(3))]),
  ),
  notMeasured: ['browser-observed low-resolution asset load', 'browser-observed first interaction'],
};

const jsonArg = process.argv.indexOf('--json');
if (jsonArg >= 0) {
  writeFileSync(process.argv[jsonArg + 1], JSON.stringify(report, null, 2) + '\n');
}

if (over.length > 0) fail('performance budget', [...over, ``, ...detail]);
pass('performance budget', detail);
