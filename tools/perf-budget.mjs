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
 *
 * The bytes under dist/app/ are charged to two of those byte lines, not one —
 * the deferred 3D renderer to `rendererGzipBytes` and everything else to
 * `bundleGzipBytes`, per `componentAttribution.rendererPaths` in the budget
 * file, which says why (DOG-41). The split changes which line a byte is charged
 * to and nothing else: the derived lines are computed over the same total as
 * before, so nothing here got easier to pass.
 */

import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

// ---------------------------------------------------------------------------
// Component attribution. Which of the two app-side byte lines a shipped file is
// charged to. The declaration and its justification live in the budget file;
// the two rules that keep it from being a loophole are enforced here, because a
// declaration nobody checks is a comment.
// ---------------------------------------------------------------------------

const rendererPaths = budget.componentAttribution?.rendererPaths ?? [];

const badDeclaration = [];
for (const entry of rendererPaths) {
  const show = JSON.stringify(entry);
  if (typeof entry !== 'string') {
    badDeclaration.push(`rendererPaths entry ${show} is not a string.`);
    continue;
  }
  const segments = entry.split('/').filter((s) => s !== '');
  if (/[*?[\]]/.test(entry) || segments.includes('.') || segments.includes('..')) {
    badDeclaration.push(`rendererPaths entry ${show} must be a literal path: no globs, no \`.\` or \`..\` segments.`);
  } else if (segments[0] !== 'app' || segments.length < 2) {
    badDeclaration.push(`rendererPaths entry ${show} must name something strictly inside app/, e.g. "app/vendor/three".`);
    if (segments.length === 1 && segments[0] === 'app') {
      badDeclaration.push(
        `  \`app\` itself would charge the entire client bundle to the renderer's 140 KiB line and`,
        `  leave bundleGzipBytes measuring index.html alone. The application line would still be`,
        `  green forever and would be measuring nothing. That is the one thing this list cannot say.`,
      );
    }
  }
}
if (badDeclaration.length > 0) {
  fail('performance budget', [
    `componentAttribution.rendererPaths in ${rel(join(REPO_ROOT, 'ci', 'performance-budget.json'))} is not usable:`,
    ``,
    ...badDeclaration,
    ``,
    `Every shipped byte is charged to exactly one line, and which one is a budget decision.`,
    `The gate refuses rather than guess at an attribution it cannot read.`,
  ]);
}

/**
 * Segment-aware prefix match, so `app/vendor/three` covers that path and
 * anything under it and never `app/vendor/threezilla.js`.
 */
const toPosix = (p) => p.split('\\').join('/');
const isRendererPath = (distRelative) => {
  const r = toPosix(distRelative);
  return rendererPaths.some((p) => r === p || r.startsWith(`${p}/`));
};

const appFiles = filesUnder(join(DIST, 'app'), () => true);
const rendererFiles = appFiles.filter((p) => isRendererPath(relative(DIST, p)));
const bundleFiles = [
  join(DIST, 'index.html'),
  ...appFiles.filter((p) => !isRendererPath(relative(DIST, p))),
].filter((p) => existsSync(p));
const indexFiles = filesUnder(join(DIST, 'data'), () => true);
const assetFiles = filesUnder(
  join(DIST, 'assets'),
  (r) => !r.endsWith('LICENSE') && !r.endsWith('ATTRIBUTION.md'),
);

// ---------------------------------------------------------------------------
// The premise of the renderer line: the renderer is DEFERRED.
//
// A separate 140 KiB line is defensible because those bytes are not on the
// critical path — the shell paints, then dynamic import() fetches the renderer.
// Static-import it from anything on the application line and that stops being
// true: 270 KiB of eager code would pass two green lines, and the derived lines
// would not catch it either, because a renderer is only 45 ms of transfer. So
// the one claim the split rests on is checked rather than trusted.
//
// A dynamic `import('…')` is the allowed form and is deliberately not matched.
// ---------------------------------------------------------------------------

/** Static import specifiers: `import … from 'x'`, `import 'x'`, `export … from 'x'`. */
function staticImportSpecifiers(source) {
  const out = [];
  for (const m of source.matchAll(/(?:^|[^\w$.])(?:import|export)\s*(?:[^;'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g)) {
    out.push(m[1]);
  }
  return out;
}

/** Does a specifier written in `fromDistRelative` point into a renderer path? */
function specifierHitsRenderer(fromDistRelative, specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return isRendererPath(join(dirname(toPosix(fromDistRelative)), specifier));
  }
  // Root-relative or base-prefixed ("/app/…", "/atlas/app/…"). The deployment
  // base is configuration, not identity, so a run of matching segments anywhere
  // in the specifier is the honest comparison.
  const segments = toPosix(specifier).split('/').filter((s) => s !== '');
  return rendererPaths.some((p) => {
    const want = p.split('/').filter((s) => s !== '');
    for (let i = 0; i + want.length <= segments.length; i += 1) {
      if (want.every((w, j) => segments[i + j] === w)) return true;
    }
    return false;
  });
}

// Only meaningful once a renderer actually ships: with nothing on the renderer
// line there is nothing being excused from the application line.
const eagerRenderer = [];
if (rendererFiles.length > 0) {
  for (const p of bundleFiles) {
    const r = toPosix(relative(DIST, p));
    const source = readFileSync(p, 'utf8');
    if (r === 'index.html') {
      for (const m of source.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
        if (specifierHitsRenderer(r, m[1])) eagerRenderer.push({ file: r, spec: m[1], how: 'loaded by the page shell' });
      }
    } else if (r.endsWith('.js') || r.endsWith('.mjs')) {
      for (const spec of staticImportSpecifiers(source)) {
        if (specifierHitsRenderer(r, spec)) eagerRenderer.push({ file: r, spec, how: 'statically imported' });
      }
    }
  }
}

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
const rendererGzip = gzipBytes(rendererFiles);
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

  // The renderer's bytes are charged here in full, exactly as they were before
  // they had their own line. Splitting the component lines re-attributes a
  // byte; it does not discount one. Pessimistic, because the renderer is in
  // fact deferred — and pessimistic is the direction a budget should err in.
  const criticalPathMs =
    budget.transferModel.roundTrips.criticalPath * rttMs +
    transferMs(bundleGzip + rendererGzip + indexGzip) +
    indexParseNorm;

  return {
    bundleGzipBytes: bundleGzip,
    rendererGzipBytes: rendererGzip,
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
const EXACT_LINES = new Set(['bundleGzipBytes', 'rendererGzipBytes', 'indexGzipBytes', 'lowResAssetGzipBytes']);
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

const rows = [];
const over = [];
const notEvaluated = [];
const verdicts = {};

for (const [key, spec] of Object.entries(budget.budgets)) {
  const value = measurements[key];
  const kind = kindOf(key);
  const used = value / spec.limit;
  const exceeds = used > 1;

  // A bound only settles the question it points at. The other way round it is
  // silence, and silence is reported as silence.
  const verdict =
    kind === 'exact' || kind === 'normalised'
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
      `  ${(used * 100).toFixed(0).padStart(4)}% ${verdict === 'over' ? 'OVER' : verdict === 'not evaluated' ? 'not evaluated' : ''}`,
  );

  if (verdict === 'not evaluated') notEvaluated.push(key);

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

// Stated on every run, pass or fail. A declared renderer path that matches
// nothing is the likely typo, and it is otherwise invisible: the renderer's
// bytes would fall through to the application line, which is the safe direction
// but not the one anybody intended.
const attributionNote =
  rendererPaths.length === 0
    ? [`attribution: no renderer paths declared; every app byte is charged to bundleGzipBytes.`]
    : [
        `attribution: ${rendererPaths.join(', ')} → rendererGzipBytes` +
          ` (${rendererFiles.length} file${rendererFiles.length === 1 ? '' : 's'}),` +
          ` everything else under app/ → bundleGzipBytes`,
        ...(rendererFiles.length === 0
          ? [
              `  NOTE: the declared renderer path matches nothing in dist/. Either the renderer has`,
              `  not landed yet, or it landed elsewhere and is being charged to bundleGzipBytes.`,
            ]
          : []),
      ];

const detail = [
  `reference: ${budget.referenceMachine.label}, ${downlinkMbps} Mbit/s, ${rttMs} ms RTT`,
  ...calibrationNote,
  `raw parse: index ${indexParseMs.toFixed(1)} ms, assets ${assetParseMs.toFixed(1)} ms on this machine`,
  `files: ${bundleFiles.length} bundle, ${rendererFiles.length} renderer, ${indexFiles.length} index,` +
    ` ${assetFiles.length} asset`,
  ...attributionNote,
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
  `NOT MEASURED: the same two derived numbers in a real browser. That needs the`,
  `viewer and a headless browser in CI. Until then the ${budget.renderAllowanceMs.value} ms render allowance`,
  `in derivedFirstInteractionMs is a stated placeholder, not an observation.`,
  ``,
  `ALSO NOT MEASURED: whether the files on the renderer line are in fact a third-party`,
  `renderer. That is what componentAttribution.rendererPaths asserts, and no tool can`,
  `check it — moving application code under a declared path would buy it the renderer's`,
  `headroom. What IS checked: the path is strictly inside app/, and nothing on the`,
  `application line statically imports it. The declaration itself is reviewed, not gated.`,
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
  // `null` for a line this run could not establish. Never a zero, never a pass,
  // and deliberately not the bound: off-band these keys are named for a
  // normalised figure that was not computed, so publishing the unnormalised
  // number here would make the key a false claim about its own contents. The
  // bound is in `verdicts[key].reported`, where its kind travels with it.
  measurements: Object.fromEntries(
    Object.keys(budget.budgets).map((k) => [k, verdicts[k].verdict === 'not evaluated' ? null : measurements[k]]),
  ),
  budgets: Object.fromEntries(Object.entries(budget.budgets).map(([k, v]) => [k, v.limit])),
  utilisation: Object.fromEntries(
    Object.entries(budget.budgets).map(([k, v]) => [
      k,
      verdicts[k].verdict === 'not evaluated' ? null : Number((measurements[k] / v.limit).toFixed(3)),
    ]),
  ),
  // Which lines the numbers above can carry a verdict for, and in which
  // direction. A consumer that reads `measurements` without reading this is
  // reading a bound as if it were a measurement.
  verdicts,
  notEvaluated,
  // Which app bytes went to which line, and anything that broke the deferral
  // the renderer line depends on. A consumer comparing bundleGzipBytes across
  // commits needs this to know whether the line's meaning moved under it.
  attribution: {
    rendererPaths,
    rendererFiles: rendererFiles.map((p) => toPosix(relative(DIST, p))).sort(),
    eagerRendererImports: eagerRenderer,
  },
  notMeasured: [
    'browser-observed low-resolution asset load',
    'browser-observed first interaction',
    'that the files on the renderer line are third-party renderer code',
  ],
};

const jsonArg = process.argv.indexOf('--json');
if (jsonArg >= 0) {
  writeFileSync(process.argv[jsonArg + 1], JSON.stringify(report, null, 2) + '\n');
}

const deferral =
  eagerRenderer.length === 0
    ? []
    : [
        `the renderer is on the critical path, so it cannot have its own budget line:`,
        ...eagerRenderer.map((e) => `  ${e.file}: ${e.how} ${JSON.stringify(e.spec)}`),
        ``,
        `  rendererGzipBytes exists because those ${(rendererGzip / 1024).toFixed(1)} KiB are fetched by dynamic`,
        `  import() after the shell paints, and so are not application code competing for`,
        `  the shell's ${(budget.budgets.bundleGzipBytes.limit / 1024).toFixed(0)} KiB. Loaded eagerly they are exactly that, and the two green`,
        `  lines would be adding up to ${((bundleGzip + rendererGzip) / 1024).toFixed(1)} KiB of code before first paint.`,
        ``,
        `  Fix the load, not the budget: \`await import()\` the renderer from the viewer's`,
        `  entry point. If it genuinely must be eager, then it belongs on bundleGzipBytes`,
        `  and the renderer path should be withdrawn from componentAttribution.`,
      ];

if (over.length > 0 || deferral.length > 0) {
  const spacer = over.length > 0 && deferral.length > 0 ? [``] : [];
  fail('performance budget', [...deferral, ...spacer, ...over, ``, ...detail]);
}
pass('performance budget', detail);
