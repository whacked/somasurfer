/**
 * Proves the gates actually fail.
 *
 * A CI gate that has never been seen to fail is not a gate, it is decoration.
 * This breaks each thing deliberately, asserts the right gate catches it with a
 * recognisable message, and puts the repository back. It runs in CI, so the
 * gates cannot rot into always-green without this job going red.
 *
 *   node tools/verify-gates.mjs [--case <name>] [--list]
 *
 * Every mutation is reversible and every restore is in a `finally`. The script
 * refuses to start if the working tree is dirty in a file it needs to touch,
 * so an interrupted run can never be mistaken for a developer's edit.
 *
 * A few cases assert the opposite: `mustPass` means the gate is required NOT to
 * fail on a condition it is put into. A gate that fails on something that is
 * not a defect is as broken as one that passes a defect, and costs more — it
 * burns the credibility that makes a red build worth stopping for. DOG-29 was
 * exactly that: the performance gate went red on a merge commit that changed no
 * file contents, because the runner was fast. Those cases pin the fix.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { REPO_ROOT, rel } from './lib/repo.mjs';

const ALC = join(REPO_ROOT, 'packages', 'alc');
const WEB = join(REPO_ROOT, 'packages', 'atlas-web');
const ASSETS = join(REPO_ROOT, 'packages', 'atlas-assets');
const TEMPLATES = join(ASSETS, 'templates');
const GATE_TEMPLATE = join(TEMPLATES, 'gate-verify.body.json');
const AUDIT_DOC = join(REPO_ROOT, 'docs', 'alc-1-admissibility.md');
const COUNTS = join(REPO_ROOT, 'ci', 'expected-test-counts.json');
const PERF_BUDGET = join(REPO_ROOT, 'ci', 'performance-budget.json');
const DIST = join(WEB, 'dist');
const VENDOR_THREE = join(DIST, 'app', 'vendor', 'three', 'three.module.js');
const GATE_VIEWER = join(DIST, 'app', 'gate-verify-viewer.js');

/** Gzipped size of three.js tree-shaken to exactly the stage-A viewer surface, measured in DOG-36. */
const THREE_GZIP_BYTES = 126469;

/** The performance cases all need a build to measure. Say so once, clearly. */
function requireBuild() {
  if (!existsSync(join(WEB, 'dist', 'app', 'app.js'))) {
    throw new Error('dist/ is not built; run `npm run build` before verifying this case');
  }
}

/** `ci/performance-budget.json` with one budget line's limit replaced. */
function withBudgetLimit(line, limit) {
  const budget = JSON.parse(readFileSync(PERF_BUDGET, 'utf8'));
  budget.budgets[line] = { ...budget.budgets[line], limit };
  return substitute(PERF_BUDGET, JSON.stringify(budget, null, 2) + '\n');
}

/** `ci/performance-budget.json` with the renderer attribution replaced. */
function withRendererPaths(paths) {
  const budget = JSON.parse(readFileSync(PERF_BUDGET, 'utf8'));
  budget.componentAttribution = { ...budget.componentAttribution, rendererPaths: paths };
  return substitute(PERF_BUDGET, JSON.stringify(budget, null, 2) + '\n');
}

/**
 * Write a file into directories that may not exist, returning a restore that
 * removes the file and every directory it had to create — so a case that
 * invents `dist/app/vendor/three/` cannot leave the next run measuring it.
 */
function place(path, contents) {
  const made = [];
  for (let d = dirname(path); !existsSync(d); d = dirname(d)) made.push(d);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return () => {
    rmSync(path, { force: true });
    for (const d of made) rmSync(d, { recursive: true, force: true });
  };
}

/**
 * Pseudo-minified JavaScript that gzips to just over `targetGzipBytes`.
 *
 * The shape is load-bearing. A random-byte blob would not compress like a
 * renderer and a repeated line would compress far better than one, so either
 * would need a byte count nothing like the real thing to reach the same gzipped
 * size — and the gate measures gzipped size. Deterministic from `seed`, so a
 * case either reproduces or it does not.
 */
function syntheticModule(targetGzipBytes, seed) {
  const words = 'tenirosalcudmpghfbvwxyzkjq'.split('');
  let state = seed >>> 0;
  const next = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = () => words[Math.floor(next() * words.length)];
  const id = () => pick() + pick() + Math.floor(next() * 9999).toString(36);
  const gz = (text) => gzipSync(Buffer.from(text), { level: 9 }).length;

  // Overshoot, then binary-search a prefix: gzipped size is monotonic in the
  // number of statements, so the search lands within one statement of target.
  const parts = [];
  do {
    for (let i = 0; i < 256; i += 1) {
      parts.push(
        `function ${id()}(${id()},${id()}){const ${id()}=${id()}*${(next() * 100).toFixed(4)}+${Math.floor(next() * 1e6)};` +
          `return ${id()}?${id()}(${id()}):[${id()},${id()}].map(${id()}=>${id()}.${id()});}`,
      );
    }
  } while (gz(parts.join('\n')) < targetGzipBytes * 1.2);

  let lo = 0;
  let hi = parts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (gz(parts.slice(0, mid).join('\n')) < targetGzipBytes) lo = mid + 1;
    else hi = mid;
  }
  return parts.slice(0, lo).join('\n') + '\n';
}

const run = (script, args = []) =>
  spawnSync(process.execPath, [join(REPO_ROOT, 'tools', script), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });

/** Swap a file's contents, returning a restore function. */
function substitute(path, contents) {
  const had = existsSync(path);
  const original = had ? readFileSync(path) : null;
  writeFileSync(path, contents);
  return () => (had ? writeFileSync(path, original) : rmSync(path, { force: true }));
}

/** Move a file aside, returning a restore function. */
function hide(path) {
  const stash = `${path}.gate-verify-stash`;
  renameSync(path, stash);
  return () => renameSync(stash, path);
}

/** How many tests the conformance suite runs as the tree stands right now. */
function observedTestCount() {
  const suite = JSON.parse(readFileSync(COUNTS, 'utf8')).suites.find((s) => s.id === 'alc-conformance');
  const out = spawnSync(process.execPath, ['--test', '--test-reporter=tap', suite.pattern], {
    cwd: join(REPO_ROOT, suite.packageDir),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  const m = /^# tests (\d+)$/m.exec(out.stdout ?? '');
  if (!m) throw new Error('could not read a baseline test count from the TAP summary');
  return Number(m[1]);
}

const CASES = [
  {
    name: 'conformance-fails',
    gate: 'test count',
    criterion: 'CI fails if conformance fails',
    expect: [/tests failed/, /not ok/],
    describe: 'a conformance test that asserts something false',
    break: () =>
      substitute(
        join(ALC, 'test', 'gate-verify.test.ts'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { parse } from '../src/index.ts';",
          '',
          '// Written by tools/verify-gates.mjs and deleted by it. If you are reading',
          '// this in a committed file, that script was interrupted: delete it.',
          "test('gate verification: a broken conformance expectation', () => {",
          "  assert.equal(parse('BD-T07-03O-531').frame, 'BV');",
          '});',
          '',
        ].join('\n'),
      ),
    check: () => run('check-test-count.mjs'),
  },
  {
    name: 'tests-stop-being-discovered',
    gate: 'test count',
    criterion: 'CI fails if fewer tests than expected ran',
    expect: [/ran \d+ tests, expected at least \d+/, /Do not lower minTests/],
    describe: 'a test file that quietly stops being picked up',
    // The floor is pinned to the count observed right now rather than to the
    // committed 37, so this case keeps demonstrating the right thing as tests
    // are added. Hiding a file is the realistic failure: nobody edits the
    // floor downward, tests just stop being found.
    break: () => {
      const observed = observedTestCount();
      const config = JSON.parse(readFileSync(COUNTS, 'utf8'));
      config.suites = config.suites.map((s) =>
        s.id === 'alc-conformance' ? { ...s, minTests: observed } : s,
      );
      const restoreCounts = substitute(COUNTS, JSON.stringify(config, null, 2) + '\n');
      const restoreFile = hide(join(ALC, 'test', 'compare.test.ts'));
      return () => {
        restoreFile();
        restoreCounts();
      };
    },
    check: () => run('check-test-count.mjs'),
  },
  {
    name: 'zero-tests-run-silently',
    gate: 'test count',
    criterion: 'the dangerous case: zero tests run and the exit code is zero',
    expect: [/ran 0 tests, expected at least \d+/, /stopped being discovered/],
    describe: 'a test pattern that matches no files at all',
    // Measured on Node 24.21: `node --test 'test/*.nope.ts'` runs 0 tests and
    // exits 0. Nothing but the count distinguishes that from a clean run, which
    // is the entire argument for this gate.
    break: () => {
      const config = JSON.parse(readFileSync(COUNTS, 'utf8'));
      config.suites = config.suites.map((s) =>
        s.id === 'alc-conformance' ? { ...s, pattern: 'test/*.nope.ts' } : s,
      );
      return substitute(COUNTS, JSON.stringify(config, null, 2) + '\n');
    },
    check: () => run('check-test-count.mjs'),
  },
  {
    name: 'historical-broken-glob',
    gate: 'test count',
    criterion: 'the original bug: `node --test test/`',
    expect: [/1 of 1 tests failed/, /not ok/],
    describe: 'the `node --test test/` invocation that ran 0 of 37 real tests',
    // On Node 24.21 this does not run zero tests quietly: it treats the
    // directory as one test case, fails it, and exits 1. Still zero real tests,
    // and still caught — but through the failure path, not the count. Pinned as
    // its own case so a future Node changing this behaviour shows up here
    // rather than in a surprise green build.
    break: () => {
      const config = JSON.parse(readFileSync(COUNTS, 'utf8'));
      config.suites = config.suites.map((s) => (s.id === 'alc-conformance' ? { ...s, pattern: 'test/' } : s));
      return substitute(COUNTS, JSON.stringify(config, null, 2) + '\n');
    },
    check: () => run('check-test-count.mjs'),
  },
  {
    name: 'audit-report-drift',
    gate: 'audit report drift',
    criterion: 'CI fails if the generated audit report differs from the committed one',
    expect: [/has drifted from the code that generates it/, /first difference at byte/],
    describe: 'one edited number in the published admissibility report',
    break: () => {
      const text = readFileSync(AUDIT_DOC, 'utf8');
      // Change a measured utilisation. This is exactly the drift that matters:
      // the document still reads as authoritative and is now a false claim.
      const edited = text.replace(/\*\*0\.\d\d\*\*/, '**0.42**');
      if (edited === text) throw new Error('could not find a utilisation figure to edit');
      return substitute(AUDIT_DOC, edited);
    },
    check: () => run('check-audit-drift.mjs'),
  },
  {
    name: 'template-folds-non-locally',
    gate: 'body template audit',
    criterion: 'the template gate catches a fold that auditBodyTemplate() clears',
    expect: [
      /fold scan FAILS: \d+\/\d+ probed point\(s\) not claimed by exactly one level/,
      /auditBodyTemplate\(\) CLEARED this template/,
    ],
    describe: 'a body template whose skin folds while the per-level audit calls it admissible',
    // The case that justifies the third check in audit-real-template.mjs. These
    // clinical parameters — 70 degree thoracic kyphosis, wide waist, reduced
    // stature — produce a template that auditBodyTemplate() clears and that
    // measureRoundTrip({ samplesPerLevel: 200 }) also clears, yet whose anterior
    // thoracic skin decodes as T01, several levels away. Asserting on the
    // CLEARED line is the point: it only prints when the other two checks found
    // nothing, so this case cannot silently degrade into a demonstration that
    // the audit works.
    break: async () => {
      const { buildAnatomicalBodyTemplate, ADULT_P50 } = await import(
        '../packages/alc/src/testing/anatomicalTemplates.ts'
      );
      const template = buildAnatomicalBodyTemplate({
        ...ADULT_P50,
        id: 'gate-verify-non-local-fold',
        thoracicKyphosisDeg: 70,
        lumbarLordosisDeg: 38,
        radialScale: 1.45,
        axialScale: 0.88,
      });
      const hadDir = existsSync(TEMPLATES);
      if (!hadDir) mkdirSync(TEMPLATES, { recursive: true });
      writeFileSync(GATE_TEMPLATE, JSON.stringify(template, null, 2) + '\n');
      return () => {
        rmSync(GATE_TEMPLATE, { force: true });
        if (!hadDir) rmSync(TEMPLATES, { recursive: true, force: true });
      };
    },
    check: () => run('audit-real-template.mjs'),
  },
  {
    name: 'licence-dependency-edge',
    gate: 'licence separation',
    criterion: 'licence separation fails on a deliberate violation (dependency)',
    expect: [/code package declares `dependencies\.@gstack\/atlas-assets`/, /build-time dependency on the asset licence/],
    describe: 'a code package taking a package.json dependency on the asset package',
    break: () => {
      const manifest = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8'));
      manifest.dependencies = { ...manifest.dependencies, '@gstack/atlas-assets': '*' };
      return substitute(join(WEB, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    },
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'licence-import-edge',
    gate: 'licence separation',
    criterion: 'licence separation fails on a deliberate violation (import)',
    expect: [/imports .* from asset package/, /links the asset into our bundle/],
    describe: 'a code package importing geometry straight out of the asset package',
    break: () =>
      substitute(
        join(WEB, 'src', 'gate-verify.js'),
        [
          '// Written by tools/verify-gates.mjs and deleted by it.',
          "import shell from '../../atlas-assets/geometry/placeholder-body-shell.lowres.json';",
          'export default shell;',
          '',
        ].join('\n'),
      ),
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'licence-inlined-bytes',
    gate: 'licence separation',
    criterion: 'licence separation fails when asset bytes are embedded in the bundle',
    expect: [/contains bytes from asset payload/, /derivative of it/],
    describe: 'a build that stringifies a mesh into the shipped JavaScript',
    break: () => {
      const dist = join(WEB, 'dist');
      if (!existsSync(join(dist, 'app', 'app.js'))) {
        throw new Error('dist/ is not built; run `npm run build` before verifying this case');
      }
      const mesh = readFileSync(join(ASSETS, 'geometry', 'placeholder-body-shell.lowres.json'), 'utf8');
      const app = readFileSync(join(dist, 'app', 'app.js'), 'utf8');
      return substitute(join(dist, 'app', 'app.js'), `${app}\nexport const INLINED_MESH = ${mesh};\n`);
    },
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'perf-fast-runner-is-not-a-failure',
    gate: 'performance budget',
    criterion: 'the performance gate does NOT fail merely because the runner is fast',
    mustPass: true,
    expect: [
      /speed factor 4\.80, OUTSIDE \[0\.25, 4\]/,
      /lowResAssetParseMsNormalised\s+≥.*not evaluated/,
      /NOT EVALUATED THIS RUN/,
      /A green result here is not a statement about those lines/,
    ],
    describe: 'a runner 4.8× faster than the reference, the DOG-29 case, with nothing else wrong',
    // The report contract, checked on the same run. The console output is for a
    // human; this is for whatever reads the JSON, and it is the half that can
    // regress without anyone noticing.
    audit: () => {
      const dir = mkdtempSync(join(tmpdir(), 'perf-report-'));
      const path = join(dir, 'perf.json');
      try {
        run('perf-budget.mjs', ['--calibration-ms', '25', '--json', path]);
        const report = JSON.parse(readFileSync(path, 'utf8'));
        const problems = [];
        const expectNull = (key) => {
          if (report.measurements[key] !== null) {
            problems.push(`measurements.${key} is ${JSON.stringify(report.measurements[key])}, expected null:`);
            problems.push(`  off-band this key is named for a normalised figure that was not computed.`);
          }
          if (report.utilisation[key] !== null) {
            problems.push(`utilisation.${key} is ${JSON.stringify(report.utilisation[key])}, expected null.`);
          }
          if (typeof report.verdicts[key]?.reported !== 'number') {
            problems.push(`verdicts.${key}.reported is not a number; the bound was lost, not relocated.`);
          }
        };
        expectNull('indexParseMsNormalised');
        expectNull('lowResAssetParseMsNormalised');
        if (report.calibration.decisionBasis !== 'one-sided-bound-from-raw') {
          problems.push(`calibration.decisionBasis is ${JSON.stringify(report.calibration.decisionBasis)}.`);
        }
        // Byte lines are exact on any runner, so nulling them would be a
        // different bug: the fallback silently swallowing what it should gate.
        if (typeof report.measurements.bundleGzipBytes !== 'number') {
          problems.push(`measurements.bundleGzipBytes is not a number; byte lines must survive a bad calibration.`);
        }
        return problems;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // 25 ms against the 120 ms reference is the reading GitHub's runner
    // actually produced on run 37890971145, which failed `gate` on a merge
    // commit that changed no file contents. The build is clean here; the only
    // unusual thing is the hardware. A red build would be a lie about the code.
    break: () => {
      requireBuild();
      return () => {};
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', '25']),
  },
  {
    name: 'perf-fast-runner-still-gates-on-certainty',
    gate: 'performance budget',
    criterion: 'off-band parse lines are still gated where the unnormalised time alone proves it',
    expect: [
      /lowResAssetParseMsNormalised: at least \d+ ms on the reference machine, against a budget of 1 ms/,
      /over budget\s+here is over budget there/,
    ],
    describe: 'an asset parse budget the raw time busts, on a runner too fast to normalise',
    // The other half of the case above, and the reason it is not just a
    // suppression. Unnormalised time on a runner faster than the reference is a
    // lower bound on what the reference pays, so a line over budget here is
    // over budget there whatever the correction would have been. Dropping the
    // budget to 1 ms is how a regression past that bound is staged on demand.
    break: () => {
      requireBuild();
      return withBudgetLimit('lowResAssetParseMsNormalised', 1);
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', '25']),
  },
  {
    name: 'perf-byte-budgets-survive-a-bad-calibration',
    gate: 'performance budget',
    criterion: 'byte budgets stay hard when the calibration is useless',
    expect: [/bundleGzipBytes: [\d.]+ KiB against a budget of 1\.0 KiB/, /OUTSIDE \[0\.25, 4\]/],
    describe: 'a bundle over its byte budget on a runner too fast to normalise parse times',
    // Bytes never touch the calibration, so a runner off the band cannot excuse
    // them. This is the case that keeps the fallback from quietly becoming a
    // way to ship an oversized bundle on fast hardware.
    break: () => {
      requireBuild();
      return withBudgetLimit('bundleGzipBytes', 1024);
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', '25']),
  },

  // -------------------------------------------------------------------------
  // The budget's two app-side byte lines (DOG-41).
  //
  // Splitting the renderer onto `rendererGzipBytes` gave the budget a second
  // line and therefore two new ways to be wrong: the new line might not fire,
  // and the attribution deciding which line a byte lands on might be abusable.
  // The last case is the one the split exists for, and it is a `mustPass`: a
  // realistic viewer has to be green, or the split did not work and the next
  // person's instinct will be to widen 150 KiB instead.
  // -------------------------------------------------------------------------
  {
    name: 'renderer-over-its-own-budget',
    gate: 'performance budget',
    criterion: 'the renderer line fires when the renderer grows',
    expect: [
      /rendererGzipBytes: 15\d\.\d KiB against a budget of 140\.0 KiB/,
      /tree-shaken to the stage-A viewer surface/,
    ],
    describe: 'a renderer 10 KiB past its line, in a declared renderer path',
    // The point of a second line is that it is a real ceiling, not a parking
    // space. 150 KiB of renderer reds rendererGzipBytes and nothing else: the
    // derived lines have the headroom to absorb it, which is exactly why the
    // byte line has to be the thing that catches it.
    break: () => {
      requireBuild();
      return place(VENDOR_THREE, syntheticModule(154 * 1024, 41001));
    },
    check: () => run('perf-budget.mjs'),
  },
  {
    name: 'renderer-line-swallows-the-application',
    gate: 'performance budget',
    criterion: 'the attribution cannot make the application line vacuous',
    expect: [/must name something strictly inside app\//, /measuring index\.html alone/],
    describe: 'componentAttribution declaring all of `app` to be the renderer',
    // The abuse the split invites. One word in the budget file charges the
    // entire client bundle to the renderer's 140 KiB and leaves
    // bundleGzipBytes measuring the page shell alone — permanently green,
    // permanently meaningless, and a one-line diff that reads like a tidy-up.
    break: () => withRendererPaths(['app']),
    check: () => run('perf-budget.mjs'),
  },
  {
    name: 'renderer-loaded-eagerly',
    gate: 'performance budget',
    criterion: 'the renderer line is void if the renderer is on the critical path',
    expect: [
      /the renderer is on the critical path, so it cannot have its own budget line/,
      /app\.js: statically imported "\.\/vendor\/three\/three\.module\.js"/,
    ],
    describe: 'the renderer static-imported by the page shell instead of deferred',
    // The hole that would make the whole split a lie. rendererGzipBytes is
    // defensible only because those bytes arrive after first paint; eagerly
    // imported they are application code, and two green lines would be
    // certifying 270 KiB on the critical path. The derived lines do not catch
    // this — a renderer is only 45 ms of transfer — so this check is the only
    // thing standing behind the claim the second line rests on.
    break: () => {
      requireBuild();
      const removeVendor = place(VENDOR_THREE, syntheticModule(THREE_GZIP_BYTES, 41002));
      const app = join(DIST, 'app', 'app.js');
      const restoreApp = substitute(
        app,
        `import * as THREE from './vendor/three/three.module.js';\n${readFileSync(app, 'utf8')}`,
      );
      return () => {
        restoreApp();
        removeVendor();
      };
    },
    check: () => run('perf-budget.mjs'),
  },
  {
    name: 'realistic-viewer-stays-green',
    gate: 'performance budget',
    criterion: 'the case the split exists for: a real stage-A viewer passes',
    mustPass: true,
    expect: [
      /rendererGzipBytes\s+12\d\.\d KiB \/\s+140\.0 KiB\s+8\d%/,
      /bundleGzipBytes\s+2\d\.\d KiB \/\s+150\.0 KiB\s+1\d%/,
      /derivedFirstInteractionMs\s+7\d\d ms \/\s+3500 ms/,
      /attribution: app\/vendor\/three → rendererGzipBytes \(1 file\)/,
    ],
    describe: "the measured viewer: 126.5 KiB of deferred three.js and 24 KiB of the viewer's own code",
    // Both figures are from DOG-36: the renderer is three.js tree-shaken to the
    // stage-A surface, and 24 KiB gzipped is the viewer code that surface was
    // chosen for — address bar, flag messages, layer panel, structure search,
    // deep links, cross-atlas restore. Under the old single line this exact
    // tree measured 112% and red. If this case ever goes red again, the fix is
    // in tools/perf-budget.mjs or in the viewer, and is not a larger number.
    //
    // The calibration is pinned to the reference value so the speed factor is
    // exactly 1 and the derived lines are quoted as normalised numbers. Without
    // it this case asserts something the runner decides: a GitHub runner reads
    // ~25 ms, lands outside [0.25, 4], and DOG-29 correctly reports
    // derivedFirstInteractionMs as a `≥` bound instead — at which point the
    // assertion below fails on a gate that behaved perfectly. That is DOG-29's
    // own lesson pointed at a new case, and it cost a red PR to notice. What
    // this case is for is byte attribution and the derived total, neither of
    // which is a claim about how fast the machine running it is.
    break: () => {
      requireBuild();
      const removeVendor = place(VENDOR_THREE, syntheticModule(THREE_GZIP_BYTES, 41003));
      const removeViewer = place(
        GATE_VIEWER,
        `// Deferred, which is the premise rendererGzipBytes rests on.\n` +
          `export const load = () => import('./vendor/three/three.module.js');\n` +
          syntheticModule(24 * 1024, 41004),
      );
      return () => {
        removeViewer();
        removeVendor();
      };
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', '120']),
  },
];

// ---------------------------------------------------------------------------

if (process.argv.includes('--list')) {
  for (const c of CASES) console.log(`${c.name.padEnd(30)} ${c.gate.padEnd(22)} ${c.criterion}`);
  process.exit(0);
}

const only = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null;
const selected = only ? CASES.filter((c) => c.name === only) : CASES;
if (selected.length === 0) {
  console.error(`no case named ${only}. Try --list.`);
  process.exit(1);
}

// Refuse to run on a tree that is already dirty where we are about to write.
const touched = [
  rel(join(ALC, 'test', 'gate-verify.test.ts')),
  rel(join(ALC, 'test', 'compare.test.ts')),
  rel(COUNTS),
  rel(AUDIT_DOC),
  rel(join(WEB, 'package.json')),
  rel(join(WEB, 'src', 'gate-verify.js')),
  rel(GATE_TEMPLATE),
  rel(PERF_BUDGET),
];
const status = spawnSync('git', ['status', '--porcelain', '--', ...touched], { cwd: REPO_ROOT, encoding: 'utf8' });
if (status.status === 0 && status.stdout.trim()) {
  console.error('\n✗ verify gates: uncommitted changes in files this script mutates:\n');
  console.error(status.stdout);
  console.error('Commit or stash them first, so a restore cannot lose your work.\n');
  process.exit(1);
}

let failures = 0;

for (const c of selected) {
  let restore = () => {};
  let verdict;
  try {
    // Awaited so a case may load the frame implementation lazily: nothing is
    // imported for a run that does not select the case that needs it.
    restore = await c.break();
    const result = c.check();
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const missing = c.expect.filter((re) => !re.test(output));
    // A case may also assert on something the console output cannot carry — the
    // shape of the JSON report, say. Problems come back as lines.
    const audited = c.audit ? await c.audit() : [];
    if (c.mustPass && result.status !== 0) {
      verdict = { ok: false, why: `the gate FAILED. It should have passed on ${c.describe}.`, output };
    } else if (!c.mustPass && result.status === 0) {
      verdict = { ok: false, why: `the gate PASSED. It should have failed on ${c.describe}.`, output };
    } else if (missing.length > 0) {
      verdict = {
        ok: false,
        why:
          `the gate ${c.mustPass ? 'passed' : 'failed'}, but without the expected explanation: ` +
          missing.map(String).join(', '),
        output,
      };
    } else if (audited.length > 0) {
      verdict = {
        ok: false,
        why: `the gate behaved, but its report did not:\n      ${audited.join('\n      ')}`,
      };
    } else {
      const headline = output
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('✗') && !l.startsWith('✓'));
      verdict = { ok: true, headline };
    }
  } catch (error) {
    verdict = { ok: false, why: `the mutation itself threw: ${error.message}` };
  } finally {
    restore();
  }

  const staged = c.mustPass ? 'allowed:' : 'broke:  ';
  if (verdict.ok) {
    console.log(`✓ ${c.name}`);
    console.log(`    ${staged} ${c.describe}`);
    console.log(`    gate:    ${c.gate} → ${verdict.headline}`);
  } else {
    failures += 1;
    console.error(`✗ ${c.name}`);
    console.error(`    ${staged} ${c.describe}`);
    console.error(`    ${verdict.why}`);
    if (verdict.output) {
      console.error(
        verdict.output
          .split('\n')
          .slice(0, 12)
          .map((l) => `      ${l}`)
          .join('\n'),
      );
    }
  }
}

// A failed restore is worse than a failed case: leave nothing behind.
for (const path of [
  join(ALC, 'test', 'gate-verify.test.ts'),
  join(WEB, 'src', 'gate-verify.js'),
  GATE_TEMPLATE,
  GATE_VIEWER,
]) {
  rmSync(path, { force: true });
  rmSync(`${path}.gate-verify-stash`, { force: true });
}
// A synthetic renderer left in dist/ would be charged to rendererGzipBytes on
// the next run, which would measure this script rather than the build. dist/
// being gitignored does not make it harmless: the perf gate reads dist/.
rmSync(join(DIST, 'app', 'vendor'), { recursive: true, force: true });
// A stray template here would make the next CI run audit a deliberately broken
// one, so remove the directory too if we were the only reason it existed.
if (existsSync(TEMPLATES)) {
  try {
    rmSync(TEMPLATES, { recursive: false });
  } catch {
    /* not empty: a real template lives here. Leave it alone. */
  }
}
const leftover = spawnSync('git', ['status', '--porcelain', '--', ...touched], { cwd: REPO_ROOT, encoding: 'utf8' });
if (leftover.status === 0 && leftover.stdout.trim()) {
  console.error('\n✗ verify gates: the tree was not restored cleanly:\n');
  console.error(leftover.stdout);
  failures += 1;
}

console.log('');
const breakages = selected.filter((c) => !c.mustPass).length;
const allowances = selected.length - breakages;
if (failures > 0) {
  console.error(`✗ verify gates: ${failures} of ${selected.length} gate(s) did not behave as designed.\n`);
  process.exit(1);
}
console.log(
  `✓ verify gates: ${breakages} deliberate breakage(s), ${breakages} caught` +
    (allowances > 0 ? `; ${allowances} non-defect(s), ${allowances} let through.\n` : '.\n'),
);
