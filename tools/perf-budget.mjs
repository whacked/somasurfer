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

/**
 * Is the scalar close enough to 1 to be worth printing as a correction?
 *
 * Outside that window the *magnitude* is not trustworthy — but the *direction*
 * still is. A machine that runs the calibration in 25 ms against a 120 ms
 * reference is certainly faster than the reference, whatever the true ratio.
 *
 * This gate used to refuse outright when the scalar fell outside the window,
 * and on 2026-10-09 that turned a healthy fast runner into a red `main` on a
 * tree byte-identical to one that had passed twice: the hosted runner came in
 * at 4.75×, just past the 4× edge. A gate whose colour depends on which runner
 * you draw is worse than no gate, because it teaches people to re-run it.
 *
 * So the verdict is now taken one-sidedly from the raw number, which needs no
 * correction at all:
 *
 *   runner faster (factor > 1): normalised >= raw, so raw over budget proves OVER
 *   runner slower (factor < 1): normalised <= raw, so raw under budget proves UNDER
 *
 * The other half of each case is genuinely unknowable from this machine. It is
 * reported as UNVERIFIED and does not decide the build, rather than being
 * guessed in either direction. Byte budgets are machine-independent and always
 * decide.
 */
const normalisationTrusted =
  speedFactor >= budget.calibration.minSpeedFactor && speedFactor <= budget.calibration.maxSpeedFactor;
const runnerFasterThanReference = speedFactor > 1;

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

/**
 * Every budgeted line, derived with parse times scaled by `parseScale`.
 * `derive(speedFactor)` is the corrected view; `derive(1)` is the raw,
 * uncorrected view, which is the one the one-sided bound is taken from.
 */
function derive(parseScale) {
  const indexParse = indexParseMs * parseScale;
  const assetParse = assetParseMs * parseScale;
  const criticalPathMs =
    budget.transferModel.roundTrips.criticalPath * rttMs + transferMs(bundleGzip + indexGzip) + indexParse;
  return {
    bundleGzipBytes: bundleGzip,
    indexGzipBytes: indexGzip,
    lowResAssetGzipBytes: assetGzip,
    indexParseMsNormalised: indexParse,
    lowResAssetParseMsNormalised: assetParse,
    derivedLowResAssetLoadMs:
      criticalPathMs + budget.transferModel.roundTrips.assets * rttMs + transferMs(assetGzip) + assetParse,
    derivedFirstInteractionMs: criticalPathMs + budget.renderAllowanceMs.value,
  };
}

const normalised = derive(speedFactor);
const uncorrected = derive(1);

// ---------------------------------------------------------------------------
// Gate.
// ---------------------------------------------------------------------------

const isBytes = (key) => key.endsWith('Bytes');
// A byte line is identical in both views; only parse-dependent lines move.
const machineIndependent = (key) => isBytes(key) || normalised[key] === uncorrected[key];
const fmt = (key, v) => (isBytes(key) ? `${(v / 1024).toFixed(1)} KiB` : `${v.toFixed(0)} ms`);

const measurements = {};
const rows = [];
const over = [];
const unverified = [];

for (const [key, spec] of Object.entries(budget.budgets)) {
  // When the correction is trusted, or the line does not depend on it, the
  // corrected number decides. Otherwise only the raw number is admissible,
  // and it decides in one direction only.
  const decideOnNormalised = normalisationTrusted || machineIndependent(key);
  const value = decideOnNormalised ? normalised[key] : uncorrected[key];
  const used = value / spec.limit;
  const conclusive = decideOnNormalised || (runnerFasterThanReference ? used > 1 : used <= 1);

  measurements[key] = decideOnNormalised ? value : null;

  const verdict = !conclusive ? 'UNVERIFIED' : used > 1 ? 'OVER' : '';
  const label = decideOnNormalised ? '' : runnerFasterThanReference ? ' (raw, lower bound)' : ' (raw, upper bound)';
  rows.push(
    `${key.padEnd(30)} ${fmt(key, value).padStart(12)} / ${fmt(key, spec.limit).padStart(12)}` +
      `  ${(used * 100).toFixed(0).padStart(4)}% ${verdict}${label}`,
  );

  if (!conclusive) {
    unverified.push(key);
    continue;
  }
  if (used > 1) {
    over.push(`${key}: ${fmt(key, value)} against a budget of ${fmt(key, spec.limit)} (${(used * 100).toFixed(0)}%).`);
    if (!decideOnNormalised) {
      over.push(`  measured raw on a machine ${speedFactor.toFixed(2)}× faster than the reference, so the`);
      over.push(`  reference number can only be larger. Over budget without needing the correction.`);
    }
    over.push(`  covers: ${spec.covers}`);
    over.push(`  why the budget is what it is: ${spec.why}`);
  }
}

const calibrationLines = normalisationTrusted
  ? [
      `calibration: ${observedCalibrationMs.toFixed(0)} ms here vs ${budget.calibration.referenceMs} ms reference` +
        ` → parse times scaled by ${speedFactor.toFixed(2)}`,
    ]
  : [
      `calibration: ${observedCalibrationMs.toFixed(0)} ms here vs ${budget.calibration.referenceMs} ms reference` +
        ` → ${speedFactor.toFixed(2)}×, outside` +
        ` [${budget.calibration.minSpeedFactor}, ${budget.calibration.maxSpeedFactor}]`,
      `NORMALISATION WITHHELD: at this distance the correction would be doing more`,
      `work than the measurement, so no scaled parse number is reported. The` +
        ` direction is`,
      `still sound — this machine is ${runnerFasterThanReference ? 'faster' : 'slower'} than the reference — so parse lines` +
        ` are judged`,
      `from the raw number, which is a ${runnerFasterThanReference ? 'lower' : 'upper'} bound on the reference number.`,
      `That proves ${runnerFasterThanReference ? 'OVER budget but never under' : 'under budget but never over'}; the other half reads UNVERIFIED and does`,
      `not decide the build. Byte lines are machine-independent and always decide.`,
    ];

const unverifiedLines =
  unverified.length === 0
    ? []
    : [
        ``,
        `UNVERIFIED on this machine (${unverified.length}): ${unverified.join(', ')}.`,
        `Not a pass and not a failure — run the gate on a machine within` +
          ` [${budget.calibration.minSpeedFactor}, ${budget.calibration.maxSpeedFactor}]×`,
        `of the reference for a verdict on those lines.`,
      ];

const detail = [
  `reference: ${budget.referenceMachine.label}, ${downlinkMbps} Mbit/s, ${rttMs} ms RTT`,
  ...calibrationLines,
  `raw parse: index ${indexParseMs.toFixed(1)} ms, assets ${assetParseMs.toFixed(1)} ms on this machine`,
  `files: ${bundleFiles.length} bundle, ${indexFiles.length} index, ${assetFiles.length} asset`,
  ``,
  ...rows,
  ...unverifiedLines,
  ``,
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
    normalisationTrusted,
    // How each line was judged, so a consumer never has to infer it from the numbers.
    decisionBasis: normalisationTrusted ? 'normalised' : 'one-sided-bound-from-raw',
  },
  raw: { indexParseMs, assetParseMs },
  // null where the line could not be established from this machine. Consumers
  // must not read a null as a zero or as a pass.
  measurements,
  uncorrected,
  unverified,
  budgets: Object.fromEntries(Object.entries(budget.budgets).map(([k, v]) => [k, v.limit])),
  utilisation: Object.fromEntries(
    Object.entries(budget.budgets).map(([k, v]) => [
      k,
      measurements[k] === null ? null : Number((measurements[k] / v.limit).toFixed(3)),
    ]),
  ),
  notMeasured: ['browser-observed low-resolution asset load', 'browser-observed first interaction'],
};

const jsonArg = process.argv.indexOf('--json');
if (jsonArg >= 0) {
  writeFileSync(process.argv[jsonArg + 1], JSON.stringify(report, null, 2) + '\n');
}

if (over.length > 0) fail('performance budget', [...over, ``, ...detail]);
pass('performance budget', detail);
