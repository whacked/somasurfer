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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, rel } from './lib/repo.mjs';
import { readMeshBin, writeMeshBin } from './lib/meshbin.mjs';
import { brainAssetPaths } from './lib/brain-asset-paths.mjs';

const ALC = join(REPO_ROOT, 'packages', 'alc');
const WEB = join(REPO_ROOT, 'packages', 'atlas-web');
const ASSETS = join(REPO_ROOT, 'packages', 'atlas-assets');
const TEMPLATES = join(ASSETS, 'templates');
const GATE_TEMPLATE = join(TEMPLATES, 'gate-verify.body.json');
const AUDIT_DOC = join(REPO_ROOT, 'docs', 'alc-1-admissibility.md');
const COUNTS = join(REPO_ROOT, 'ci', 'expected-test-counts.json');
const PERF_BUDGET = join(REPO_ROOT, 'ci', 'performance-budget.json');
const RESEARCH_DATA = join(REPO_ROOT, 'packages', 'atlas-research', 'data');
const RESEARCH_SEED = join(RESEARCH_DATA, 'research-seed.json');
const CITATION_REPORT = join(RESEARCH_DATA, 'citation-report.json');

/** The performance cases all need a build to measure. Say so once, clearly. */
function requireBuild() {
  if (!existsSync(join(WEB, 'dist', 'app', 'app.js'))) {
    throw new Error('dist/ is not built; run `npm run build` before verifying this case');
  }
}

/** `ci/performance-budget.json` with one budget line's limit replaced. */
function withBudgetLimit(line, limit) {
  return withBudgetLimits({ [line]: limit });
}

/**
 * Several limits at once, in a single substitution.
 *
 * One call per limit would not work: each helper re-reads the file, so the
 * second would undo the first, and `break` has only one restore function to
 * give back. A case about a PAIR of verdicts has to stage both sides together.
 */
function withBudgetLimits(limits) {
  const budget = JSON.parse(readFileSync(PERF_BUDGET, 'utf8'));
  for (const [line, limit] of Object.entries(limits)) {
    if (budget.budgets[line] === undefined) throw new Error(`no budget line named ${line} to relimit`);
    budget.budgets[line] = { ...budget.budgets[line], limit };
  }
  return substitute(PERF_BUDGET, JSON.stringify(budget, null, 2) + '\n');
}

/** `ci/performance-budget.json` with one budget line deleted outright. */
function withoutBudgetLine(line) {
  const budget = JSON.parse(readFileSync(PERF_BUDGET, 'utf8'));
  if (budget.budgets[line] === undefined) throw new Error(`no budget line named ${line} to delete`);
  delete budget.budgets[line];
  return substitute(PERF_BUDGET, JSON.stringify(budget, null, 2) + '\n');
}

/**
 * `ci/performance-budget.json` with one budget line's `unverified` block
 * changed, and optionally its limit, in a single substitution.
 *
 * Both at once rather than two chained calls: each helper re-reads the file, so
 * chaining works only by accident of ordering and gives two restore functions
 * where `break` returns one.
 */
function withUnverified(line, unverified, limit = null) {
  const budget = JSON.parse(readFileSync(PERF_BUDGET, 'utf8'));
  const spec = { ...budget.budgets[line] };
  if (unverified === null) delete spec.unverified;
  else spec.unverified = unverified;
  if (limit !== null) spec.limit = limit;
  budget.budgets[line] = spec;
  return substitute(PERF_BUDGET, JSON.stringify(budget, null, 2) + '\n');
}

/** The performance gate's JSON report for this build, at a substituted calibration. */
function perfReport(calibrationMs, extra = []) {
  // TMPDIR is run-scoped and may already be gone, so make sure it exists.
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'perf-reading-'));
  const path = join(dir, 'perf.json');
  try {
    const result = run('perf-budget.mjs', ['--calibration-ms', String(calibrationMs), ...extra, '--json', path]);
    if (!existsSync(path)) throw new Error(`perf-budget wrote no report: ${result.stderr || result.stdout}`);
    return JSON.parse(readFileSync(path, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A calibration that puts this gate in the band with every parse line scaled to
 * a quarter-and-a-bit of its raw time. For cases about WHERE the gate looks, not
 * about the limits: at 120, normalised equals raw, and a slow or contended runner
 * could take the name index over its limit and turn a lookup case red.
 */
const LOOKUP_CALIBRATION_MS = 400;

/** The same, for a build somewhere other than packages/atlas-web/dist. */
const perfReportAt = (dist) => perfReport(LOOKUP_CALIBRATION_MS, ['--dist', rel(dist)]);

/**
 * What actions/configure-pages hands the Deploy job for this repository, without
 * a trailing slash, exactly as the job passes it to the build.
 */
const PAGES_BASE = '/somasurfer';
const BASE_BUILD = join(WEB, '.gate-verify-base');
const BASE_BUILD_DIST = join(BASE_BUILD, 'dist');

/**
 * Build the site again at the Pages base, beside the CI build rather than over
 * it, returning a restore function. `dist/` is gitignored at any depth, so the
 * copy never shows up as an untracked file.
 */
function buildAtPagesBase() {
  const out = spawnSync(
    process.execPath,
    [join(WEB, 'build.mjs'), '--base', PAGES_BASE, '--out', '.gate-verify-base/dist'],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
  );
  const restore = () => rmSync(BASE_BUILD, { recursive: true, force: true });
  if (out.status !== 0) {
    restore();
    throw new Error(`the build at ${PAGES_BASE} failed: ${out.stderr || out.stdout}`);
  }
  // A build that ignored --base would make both cases a second run at `/`.
  const index = JSON.parse(readFileSync(join(BASE_BUILD_DIST, 'data', 'atlas-index.json'), 'utf8'));
  if (!String(index.nameIndex?.namesPath).startsWith(`${PAGES_BASE}/`)) {
    restore();
    throw new Error(`the build at ${PAGES_BASE} emitted namesPath ${JSON.stringify(index.nameIndex?.namesPath)}`);
  }
  return restore;
}

/** The figure a line's verdict would be taken from on this runner, at that calibration. */
function perfReading(report, line) {
  const reading = report.verdicts[line]?.reported;
  if (!(reading > 0)) throw new Error(`no positive reading for ${line} to stage a limit against`);
  return reading;
}

/**
 * Limits staged from the measurement, not from a literal (DOG-120).
 *
 * A breakage that sets a line to "1 ms" or "10 ms" is only a breakage on a
 * runner whose reading sits above that literal. GitHub's runner read the raw
 * index parse at 0.9 ms and the name index build at 9.5 ms, so both cases
 * staged a limit the line was already under, and the gate rightly passed. These
 * read the line on this runner first and stage a power of ten at least 10x away
 * from the reading, which survives any run-to-run noise this gate has shown and
 * still prints as a plain number the expectations can match exactly.
 */
const limitBelow = (reading) => 10 ** Math.floor(Math.log10(reading / 10));
const limitAbove = (reading) => 10 ** Math.ceil(Math.log10(reading * 10));

/** A staged limit as perf-budget prints it, escaped for a RegExp. */
const shown = (limit) => String(Number(limit.toPrecision(2))).replace(/[.+-]/g, '\\$&');

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

const LABELS = join(ASSETS, 'labels');
const REAL_NAMES = join(LABELS, 'names.json');
const REAL_COVERINGS = join(LABELS, 'coverings.json');

/**
 * Stand up a correctly shaped real index for the seed's `real` partition.
 *
 * The asset pipeline's index is not on this branch, so without this the whole
 * partition machinery in `check-research-dataset.mjs` is unreachable in CI: the
 * gate would report UNVERIFIED, pass, and never once run the checks that decide
 * whether a crosswalk is right. A gate whose interesting half only executes
 * when a dependency happens to be present is a gate nobody has run.
 *
 * Everything is derived from the committed dataset — the version string, the
 * ids, the parent cell each curated sub-region must sit inside — so these cases
 * keep testing the real declaration rather than a copy of it that can go stale.
 *
 * The cells are invented, and that is fine here: these cases are about whether
 * the gate's *checks* fire, not about where a liver is.
 */
function standUpRealIndex({ omit = [], alsoName = [], strayFrom = null } = {}) {
  const raw = JSON.parse(readFileSync(RESEARCH_SEED, 'utf8'));
  const part = (raw.authoredAgainst.partitions ?? []).find((p) => p.status === 'real');
  if (!part) throw new Error('the seed declares no `real` partition to stand an index up for');

  // The cell a curated sub-region must be a descendant of: its own cell with
  // the last refinement digit dropped.
  const parentOf = (cell) => {
    const parts = cell.split('-');
    const digits = parts.at(-1);
    return digits.length > 1 ? `${parts.slice(0, -1).join('-')}-${digits.slice(0, -1)}` : parts.slice(0, -1).join('-');
  };
  const required = new Map();
  for (const f of raw.findings) {
    for (const m of f.mappings) {
      if (m.spatial.kind !== 'cells' || !part.structureIds.includes(m.structureId)) continue;
      required.set(m.structureId, m.spatial.cells.map(parentOf));
    }
  }

  const synthetic = (k) => `BD-T07-${String((k % 12) + 1).padStart(2, '0')}${k % 2 ? 'O' : 'I'}-${k % 8}`;
  const ids = [...part.structureIds.filter((id) => !omit.includes(id)), ...alsoName];
  const names = { version: part.nameIndexVersion, frame: 'BD', structures: [] };
  const coverings = { indexVersion: part.nameIndexVersion, frame: 'BD', coverings: [] };
  ids.forEach((id, k) => {
    names.structures.push({ id, name: `stand-in for ${id}`, source: id.startsWith('FMA') ? 'FMA' : 'SYNTHETIC' });
    const own = id === strayFrom ? [] : (required.get(id) ?? []);
    coverings.coverings.push({ id, cells: [...own, synthetic(k)] });
  });

  mkdirSync(LABELS, { recursive: true });
  const restoreNames = substitute(REAL_NAMES, `${JSON.stringify(names, null, 2)}\n`);
  const restoreCoverings = substitute(REAL_COVERINGS, `${JSON.stringify(coverings, null, 2)}\n`);
  return () => {
    restoreCoverings();
    restoreNames();
  };
}

const ATTRIBUTION = join(ASSETS, 'attribution.json');
const NC_DIR = join(ASSETS, 'nc');
const NC_STAND_IN = join(NC_DIR, 'gate-verify-allen-stand-in.json');
const LEAKED_NC = join(LABELS, 'gate-verify-nc.json');
const MERGED = join(LABELS, 'gate-verify-merged.json');

/** Long and distinctive enough for the licence gate's content probe to find. */
const NC_PAYLOAD = `${JSON.stringify(
  {
    comment: 'Written by tools/verify-gates.mjs and deleted by it. Stands in for an Allen-derived layer.',
    values: Array.from({ length: 48 }, (_, i) => (i * 7919) % 104729),
  },
  null,
  2,
)}\n`;

/**
 * Stage a non-commercial payload at `at`, with an asset-nc entry for it citing
 * the Allen source, plus any further `entries`. Returns one restore function.
 *
 * Built from the committed attribution.json, so the cases keep testing the
 * real source records: the stand-in cites `allen-brain-map` as recorded, and
 * would stop passing if that record stopped being non-commercial or cleared.
 */
function stageNc(at, entries = []) {
  const madeDir = !existsSync(NC_DIR) && at.startsWith(NC_DIR);
  mkdirSync(join(at, '..'), { recursive: true });
  const restorePayload = substitute(at, NC_PAYLOAD);
  const attribution = JSON.parse(readFileSync(ATTRIBUTION, 'utf8'));
  attribution.entries.push(
    {
      id: 'gate-verify-nc',
      title: 'Gate-verify stand-in for an Allen-derived layer',
      files: [rel(at).slice(rel(ASSETS).length + 1)],
      licence: 'Allen-Institute-ToU',
      holder: 'Allen Institute',
      source: 'Staged by tools/verify-gates.mjs',
      shareAlike: false,
      licenceClass: 'asset-nc',
      sources: ['allen-brain-map'],
    },
    ...entries,
  );
  const restoreAttribution = substitute(ATTRIBUTION, `${JSON.stringify(attribution, null, 2)}\n`);
  return () => {
    restoreAttribution();
    restorePayload();
    if (madeDir) removeIfEmpty(NC_DIR);
  };
}

/**
 * Remove a directory only if nothing is left in it. Never recursive: `nc/` is
 * where a real non-commercial layer will be authored, and an uncommitted one
 * must survive a gate run. The dirty check on `touched` already refuses to
 * start while `nc/` holds anything untracked.
 */
function removeIfEmpty(dir) {
  try {
    rmdirSync(dir);
  } catch {
    /* absent, or not empty: leave it alone */
  }
}

/** A share-alike entry for MERGED, written with `contents`, citing `sources`. */
function shareAlikeEntry(id, sources) {
  return {
    id,
    title: 'Gate-verify stand-in for a BY-SA mesh file',
    files: [rel(MERGED).slice(rel(ASSETS).length + 1)],
    licence: 'CC-BY-SA-4.0',
    holder: 'Staged by tools/verify-gates.mjs',
    source: 'Staged by tools/verify-gates.mjs',
    shareAlike: true,
    licenceClass: 'asset',
    sources,
  };
}

// ---------------------------------------------------------------------------
// Brain meshes (DOG-127).
// ---------------------------------------------------------------------------

const BRAIN = brainAssetPaths(
  JSON.parse(readFileSync(join(ASSETS, 'attribution.json'), 'utf8')).upstreamSources.find((s) => s.id === 'brainproject-brain-glb')
    .pinned.commit,
);
const BRAIN_LOW = join(ASSETS, BRAIN.lowFile);
const BRAIN_FULL = join(ASSETS, BRAIN.fullFile);
const BRAIN_STRUCTURES = join(ASSETS, BRAIN.structuresFile);
const BRAIN_REGISTRATION = join(ASSETS, 'registration', `mni-to-${BRAIN.id}.json`);
const BRAIN_QA_SAMPLE = join(REPO_ROOT, 'packages', 'atlas-qa', 'fixtures', 'brain-structure-sample.json');

/** The structure records of a committed brain file, by name, for staging against. */
function brainStructure(name) {
  const doc = JSON.parse(readFileSync(BRAIN_STRUCTURES, 'utf8'));
  const s = doc.structures.find((x) => x.name === name);
  if (!s) throw new Error(`${name} is no longer a shipped brain structure to stage this against`);
  return s;
}

/** A held structure from the generated provenance manifest, by name. */
function heldStructure(name) {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, BRAIN.provenance), 'utf8'));
  const s = manifest.structures.find((x) => x.name.trim() === name);
  if (!s || s.group === 'cleared') throw new Error(`${name} is no longer a held structure to stage this against`);
  return s;
}

/**
 * Rewrite an ATLM file through `edit`, which receives one record per structure
 * (positions, normals and structure-local indices, all copies) and returns the
 * list to write. Goes through the format's own writer, so the staged file is
 * well-formed and only the defect being staged is wrong with it.
 */
function rewriteMesh(path, edit) {
  const mesh = readMeshBin(readFileSync(path));
  const records = mesh.table.map((t) => ({
    id: t.id,
    positions: mesh.positions.slice(t.firstVertex * 3, (t.firstVertex + t.vertexCount) * 3),
    normals: mesh.normals.slice(t.firstVertex * 2, (t.firstVertex + t.vertexCount) * 2),
    indices: Uint32Array.from(mesh.indices.subarray(t.firstIndex, t.firstIndex + t.indexCount), (i) => (mesh.index32 ? i - t.firstVertex : i)),
  }));
  return substitute(path, writeMeshBin({ origin: mesh.origin, step: mesh.step, structures: edit(records) }));
}

/** Limits a case staged from the measurement, read back by its expectations. */
const staged = {};

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
    name: 'invented-identifier',
    gate: 'research dataset',
    criterion: 'CI fails if a paper carries an identifier no named source returned',
    expect: [/carries identifier .* but the report justifies/, /An identifier no named source returned/],
    describe: 'a DOI hand-edited onto a paper, of the kind that is not checkable by eye',
    // The failure mode this pins is the twelve invented UBERON accessions that
    // b0d114a removed: a plausible-looking identifier that resolves to the
    // wrong thing and looks authoritative doing it. A hand-edit is the way one
    // gets in, so a hand-edit is what this does.
    //
    // The seed is edited rather than the report, and deliberately so: this is
    // the direction that ships. The drift gate against author-seed.mjs will
    // also notice, which is fine — the assertion is on the citation message.
    break: () => {
      const raw = JSON.parse(readFileSync(RESEARCH_SEED, 'utf8'));
      const victim = raw.papers.find((p) => p.identifier.kind === 'doi');
      if (!victim) throw new Error('no paper with a DOI to re-point');
      victim.identifier = { kind: 'doi', value: '10.1038/nature99999' };
      victim.sourceUrl = `https://doi.org/${victim.identifier.value}`;
      return substitute(RESEARCH_SEED, `${JSON.stringify(raw, null, 2)}\n`);
    },
    check: () => run('check-research-dataset.mjs'),
  },
  {
    name: 'citation-report-row-dropped',
    gate: 'research dataset',
    criterion: 'CI fails if the citation report stops covering every paper it justifies',
    expect: [/papers have no row/, /carries identifier .* with NO row/],
    describe: 'a row deleted from the citation report, leaving a shipped identifier unjustified',
    // Deleting a row is the quiet way to make an awkward identifier's lack of
    // evidence disappear. Coverage is asserted both ways — every paper has a
    // row, and no row names a paper that is gone — so neither direction can be
    // satisfied by editing the other.
    break: () => {
      const raw = JSON.parse(readFileSync(CITATION_REPORT, 'utf8'));
      const i = raw.rows.findIndex((r) => r.identifierJustified);
      if (i < 0) throw new Error('no justifying row to drop');
      raw.rows.splice(i, 1);
      // Keep the bookkeeping consistent, so the gate must notice the missing
      // row itself rather than a tally that no longer adds up.
      raw.paperCount = raw.rows.length;
      raw.tally = raw.rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
      return substitute(CITATION_REPORT, `${JSON.stringify(raw, null, 2)}\n`);
    },
    check: () => run('check-research-dataset.mjs'),
  },
  {
    name: 'real-index-binds-by-shape',
    gate: 'research dataset',
    criterion: 'the gate binds the index it can read, and checks the real partition against it',
    mustPass: true,
    expect: [
      // The property the case is named for: the covering index was JOINED, not
      // mistaken for a name index. Both halves must appear.
      /joined from \S*names\.json and \S*coverings\.json/,
      /real index: \d+ structures, frame BD/,
      // And the partition was actually measured against it, rather than merely
      // reported as present. Written to match either wording of the count, but
      // it still fails if the sentence is absent — which is exactly what it
      // did at 112a97b, when a pluralisation fix changed `lie ... their` to
      // `lies ... its` and this assertion stopped matching its own message.
      /body-bd: all \d+ non-coordinate mappings resolve/,
      /curated sub-regions? (?:lie|lies) wholly inside/,
    ],
    describe: 'a correctly shaped name index and covering index, both present',
    // The must-pass case for DOG-46's correction 1. The candidate list used to
    // be a priority order with coverings.json ahead of names.json, so the gate
    // would hand `{version: undefined}` to buildNameIndex and throw. Selection
    // is by shape now, and the two halves are joined — which this proves by
    // asserting the partition was actually measured, not merely found.
    break: () => standUpRealIndex(),
    check: () => run('check-research-dataset.mjs'),
  },
  {
    name: 'real-index-only-one-half',
    gate: 'research dataset',
    criterion: 'half an index is reported, not measured, and never crashes the gate',
    mustPass: true,
    expect: [/UNVERIFIED/, /found a covering index .* but no name index/],
    describe: 'a covering index with no name index beside it',
    // The other half of correction 1. A covering index carries indexVersion and
    // coverings, so it cannot become a NameIndex; the old code would throw
    // `bad_index_version` from the middle of the run. A stack trace is not a
    // gate result, and neither is a silent pass.
    break: () => {
      const restore = standUpRealIndex();
      const hidden = hide(REAL_NAMES);
      return () => {
        hidden();
        restore();
      };
    },
    check: () => run('check-research-dataset.mjs'),
  },
  {
    name: 'real-partition-loses-a-structure',
    gate: 'research dataset',
    criterion: 'CI fails if a structure declared resolvable does not resolve',
    expect: [/declares status "real" but \d+ of/, /do not resolve against/],
    describe: 'an index that no longer carries one of the accessions the crosswalk claims',
    // The crosswalk's own failure mode: an accession that was right when it was
    // authored and is not in the index any more. Nothing else in the build
    // would notice — the dataset still loads and the id still looks plausible.
    break: () => {
      const raw = JSON.parse(readFileSync(RESEARCH_SEED, 'utf8'));
      const part = (raw.authoredAgainst.partitions ?? []).find((p) => p.status === 'real');
      return standUpRealIndex({ omit: [part.structureIds[0]] });
    },
    check: () => run('check-research-dataset.mjs'),
  },
  {
    name: 'real-index-subregion-strays',
    gate: 'research dataset',
    criterion: 'CI fails if a curated sub-region is not inside the structure it is filed under',
    expect: [/do not lie wholly inside the structure they are filed under/],
    describe: 'a sub-region cell that is not a descendant of its structure in the real index',
    // "Re-check the sub-regions against real geometry" is a check only if this
    // can fail. `dataset.ts` records the disagreement as a note rather than
    // trimming the covering — deliberately, since the curator may be right —
    // and in a `real` partition that note is a failure, because there the cells
    // were authored FROM this index.
    break: () => {
      const raw = JSON.parse(readFileSync(RESEARCH_SEED, 'utf8'));
      const part = (raw.authoredAgainst.partitions ?? []).find((p) => p.status === 'real');
      const withCells = raw.findings
        .flatMap((f) => f.mappings)
        .find((m) => m.spatial.kind === 'cells' && part.structureIds.includes(m.structureId));
      if (!withCells) throw new Error('no curated sub-region in the real partition to strand');
      return standUpRealIndex({ strayFrom: withCells.structureId });
    },
    check: () => run('check-research-dataset.mjs'),
  },
  {
    name: 'placeholder-the-index-can-name',
    gate: 'research dataset',
    criterion: 'CI fails if a declared placeholder is a structure the cleared index can name',
    expect: [/is declared a placeholder, but the real index NAMES/, /recorded reason has expired/],
    describe: 'an index that has started naming a structure the dataset calls licence-blocked',
    // The second direction, and the one that keeps a placeholder honest. A
    // placeholder partition passes because a reason is recorded; the day that
    // reason stops being true, the pass has to stop with it. Otherwise the
    // partition is a way to retire a mapping from being checked at all.
    break: () => {
      const raw = JSON.parse(readFileSync(RESEARCH_SEED, 'utf8'));
      const part = (raw.authoredAgainst.partitions ?? []).find((p) => p.status === 'placeholder');
      return standUpRealIndex({ alsoName: [part.structureIds[0]] });
    },
    check: () => run('check-research-dataset.mjs'),
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
    name: 'licence-nc-segregated-is-not-a-failure',
    gate: 'licence separation',
    criterion: 'licence separation does NOT fail on non-commercial content kept in its own directory',
    mustPass: true,
    // The citing count is the tree's plus one, so it is not pinned here: if the
    // Allen record stopped being cleared or non-commercial, rule 9 would fail
    // the run, and a `mustPass` case goes red on that alone.
    expect: [/1 asset-nc entry, none reachable in a default build/, /\d+ entries citing upstream sources, all cleared/],
    describe: 'an asset-nc entry under ncPayloadDirs, citing the Allen source, merged into nothing',
    // The committed tree has no asset-nc entry, so a green run on it says
    // nothing about rule 8. This is the constructed baseline: the rule must let
    // a correctly segregated NC layer through, or the class it exists to
    // protect could never be used.
    break: () => stageNc(NC_STAND_IN),
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'licence-nc-in-default-build',
    gate: 'licence separation',
    criterion: 'licence separation fails when non-commercial content is reachable in a default build',
    expect: [/asset-nc entry gate-verify-nc is reachable in a default build/, /off by default/],
    describe: 'an asset-nc payload filed under labels/, which every default build copies',
    break: () => stageNc(LEAKED_NC),
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'licence-nc-merged-into-share-alike',
    gate: 'licence separation',
    criterion: 'licence separation fails when non-commercial bytes are merged into a share-alike file',
    expect: [
      /share-alike entry gate-verify-merged contains bytes from asset-nc payload nc\/gate-verify-allen-stand-in\.json/,
      /merged into a BY-SA file/,
    ],
    describe: 'a correctly segregated NC payload whose bytes were also pasted into a BY-SA file',
    break: () => {
      const restoreNc = stageNc(NC_STAND_IN, [shareAlikeEntry('gate-verify-merged', ['brainproject-brain-glb'])]);
      const restoreMerged = substitute(MERGED, `{"merged": ${NC_PAYLOAD}}\n`);
      return () => {
        restoreMerged();
        restoreNc();
      };
    },
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'licence-nc-in-dist',
    gate: 'licence separation',
    criterion: 'licence separation fails when non-commercial content reaches the built artefact',
    expect: [/dist\/assets\/nc\/ exists/, /contains bytes from asset-nc payload nc\/gate-verify-allen-stand-in\.json/],
    describe: 'a build that copied the non-commercial directory into dist/assets/',
    break: () => {
      requireBuild();
      const restoreNc = stageNc(NC_STAND_IN);
      const shipped = join(WEB, 'dist', 'assets', 'nc');
      mkdirSync(shipped, { recursive: true });
      writeFileSync(join(shipped, 'gate-verify-allen-stand-in.json'), NC_PAYLOAD);
      return () => {
        rmSync(shipped, { recursive: true, force: true });
        restoreNc();
      };
    },
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'licence-uncleared-source',
    gate: 'licence separation',
    criterion: 'licence separation fails when an entry ships from an upstream source that is not cleared',
    expect: [
      /ships from upstream source zanatomy-undeclared-brain-materials, whose verdict is "not-cleared"/,
      /cannot ship from an uncleared source/,
    ],
    describe: 'a BY-SA brain mesh entry citing the Z-Anatomy materials whose licence is undeclared',
    break: () => {
      const attribution = JSON.parse(readFileSync(ATTRIBUTION, 'utf8'));
      attribution.entries.push(
        shareAlikeEntry('gate-verify-uncleared', ['brainproject-brain-glb', 'zanatomy-undeclared-brain-materials']),
      );
      const restoreAttribution = substitute(ATTRIBUTION, `${JSON.stringify(attribution, null, 2)}\n`);
      const restoreMerged = substitute(MERGED, '{"stand-in": "a cortex mesh"}\n');
      return () => {
        restoreMerged();
        restoreAttribution();
      };
    },
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'licence-third-party-entry-cites-nothing',
    gate: 'licence separation',
    criterion: 'licence separation fails when a third-party entry omits its upstream sources',
    expect: [/entry gate-verify-unsourced is not first-party .* but cites no upstream source/, /skip\s+every check/],
    describe: 'a BY-SA brain mesh entry that ships the Z-Anatomy materials and simply cites nothing',
    // The realistic failure, where `licence-uncleared-source` is the honest
    // one: an entry cannot dodge rule 9 by leaving out the source that fails it.
    break: () => {
      const attribution = JSON.parse(readFileSync(ATTRIBUTION, 'utf8'));
      const { sources: _omitted, ...unsourced } = shareAlikeEntry('gate-verify-unsourced', []);
      attribution.entries.push({ ...unsourced, holder: 'Z-Anatomy contributors; adaptation by GStack' });
      const restoreAttribution = substitute(ATTRIBUTION, `${JSON.stringify(attribution, null, 2)}\n`);
      const restoreMerged = substitute(MERGED, '{"stand-in": "a cortex mesh"}\n');
      return () => {
        restoreMerged();
        restoreAttribution();
      };
    },
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'licence-first-party-sources-not-an-array',
    gate: 'licence separation',
    criterion: 'licence separation fails when an entry\'s sources is not a list of source ids',
    expect: [/entry alc-1-level-index has `sources` "allen-brain-map"; `sources` must be an array of source ids/],
    describe: 'a first-party entry citing a non-commercial source as a bare string instead of a list',
    // First-party entries may cite nothing, so read as absent this slip would
    // skip every inheritance check: here, the NC source on a plain `asset`.
    break: () => {
      const attribution = JSON.parse(readFileSync(ATTRIBUTION, 'utf8'));
      const entry = attribution.entries.find((e) => e.id === 'alc-1-level-index');
      if (!entry || entry.holder !== 'GStack' || entry.shareAlike) {
        throw new Error('alc-1-level-index is no longer a first-party entry to stage this against');
      }
      entry.sources = 'allen-brain-map';
      return substitute(ATTRIBUTION, `${JSON.stringify(attribution, null, 2)}\n`);
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
        // The DOG-98 lines, for the regression this case already caught once.
        // DOG-80's `unverified` verdict published a raw number under a
        // `...Normalised` key off-band and this audit is what found it. The two
        // new lines are the same shape of hazard, and `nameIndexBuildUsPerCell`
        // is the worse half: it carries the correction without carrying
        // `Normalised` in its name, so it reads like a pure ratio that could not
        // be affected by the calibration. Moving either line into EXACT_LINES
        // would be a one-word diff with no other symptom.
        if (report.nameIndex?.measured === true) {
          expectNull('nameIndexBuildMsNormalised');
          expectNull('nameIndexBuildUsPerCell');
        }
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
    expect: () => [
      new RegExp(`lowResAssetParseMsNormalised: at least [\\d.]+ ms on the reference machine, against a budget of ${shown(staged.assetParse)} ms`),
      /over budget\s+here is over budget there/,
    ],
    describe: 'an asset parse budget the raw time busts, on a runner too fast to normalise',
    // The other half of the case above, and the reason it is not just a
    // suppression. Unnormalised time on a runner faster than the reference is a
    // lower bound on what the reference pays, so a line over budget here is
    // over budget there whatever the correction would have been. Dropping the
    // budget well under this runner's own reading is how a regression past that
    // bound is staged on demand.
    break: () => {
      requireBuild();
      staged.assetParse = limitBelow(perfReading(perfReport(25), 'lowResAssetParseMsNormalised'));
      return withBudgetLimit('lowResAssetParseMsNormalised', staged.assetParse);
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
  {
    name: 'perf-unverified-declaration-is-load-bearing',
    gate: 'performance budget',
    criterion: 'a line with no declaration over it gates, and goes red',
    expect: () => [
      new RegExp(`indexParseMsNormalised: at least [\\d.]+ ms on the reference machine, against a budget of ${shown(staged.indexParse)} ms`),
    ],
    describe: 'the index parse line at a budget 10x under its own reading, with no unverified declaration over it',
    // Half of what keeps `unverified` from being a suppression, and the half that
    // has to be CONSTRUCTED rather than inherited.
    //
    // This case used to delete the committed declaration on indexParseMsNormalised
    // and require red. DOG-98 deletes that declaration for good, and it was the
    // only one in the tree, so the old break degenerated into "set the limit to
    // 1 ms": still red, still passing, and no longer saying anything about a
    // declaration. A must-pass case that passes for a reason unrelated to its own
    // criterion is worse than no case, because it reads as cover.
    //
    // So the pair is staged explicitly instead. Here: no declaration, 1 ms limit,
    // red. In `perf-unverified-declaration-suppresses-a-red-line`: the same 1 ms
    // limit WITH a declaration, green and reported UNVERIFIED. Neither half
    // depends on what the committed budget file happens to contain, which is what
    // makes the conclusion — the declaration is the only difference — hold.
    //
    // 1 ms rather than the real 40 ms, deliberately: the first draft required red
    // at 40 ms, which made the case's colour depend on whether the runner's raw
    // parse happened to land above it. It wandered between 38 ms and 66 ms on one
    // machine and the case passed and failed alternately. The claim asserted here
    // is the structural one, which is deterministic.
    //
    // 1 ms was not deterministic either, only on a slower machine than GitHub's:
    // run 38122454231 read the raw parse at 0.9 ms, so the line was within its
    // 1 ms budget and this breakage passed (DOG-120). The limit is now staged
    // from this runner's own reading, an order of magnitude under it.
    break: () => {
      requireBuild();
      staged.indexParse = limitBelow(perfReading(perfReport(25), 'indexParseMsNormalised'));
      return withBudgetLimit('indexParseMsNormalised', staged.indexParse);
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', '25']),
  },
  {
    name: 'perf-unverified-declaration-suppresses-a-red-line',
    gate: 'performance budget',
    criterion: 'a declaration is what stops a line that would otherwise be red',
    mustPass: true,
    expect: () => [
      new RegExp(`indexParseMsNormalised: (?:at least |at most )?[\\d.]+ ms.*against a budget of ${shown(staged.indexParseHeld)} ms.*NOT GATED\\.`),
      /UNVERIFIED, MEASURED BUT NOT GATED:/,
      /A green result from this gate is not a statement about the line\(s\) above/,
    ],
    describe: 'the same staged budget as the case above, with an unverified declaration over it',
    // The other half of the constructed pair, and the direction that actually
    // carries the risk: a declaration has to be able to hold back a line that is
    // genuinely over, or `unverified` is decoration. Same line, same 1 ms limit,
    // and the only difference from the case above is the block — so the two cases
    // together prove the block is load-bearing without either of them depending
    // on the committed tree carrying one.
    //
    // It is `mustPass` because the gate is required NOT to fail here. That is the
    // whole claim: the declaration suppressed a red line and said so out loud.
    // The limit is staged from the reading, as above, so the line under the
    // declaration really is over; at a literal 1 ms on GitHub's runner it was not,
    // and this case passed without the declaration holding anything back.
    break: () => {
      requireBuild();
      staged.indexParseHeld = limitBelow(perfReading(perfReport(25), 'indexParseMsNormalised'));
      return withUnverified(
        'indexParseMsNormalised',
        {
          sinceIssue: 'DOG-98',
          reason: 'Staged by tools/verify-gates.mjs to prove a declaration can hold back a line that is over.',
          clearedBy: 'Nothing. This block exists only inside this gate case and is restored away after it.',
        },
        staged.indexParseHeld,
      );
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', '25']),
  },
  {
    name: 'perf-no-line-ships-ungated',
    gate: 'performance budget',
    criterion: 'the committed budget gates every line it declares, in both directions',
    mustPass: true,
    expect: [/✓ performance budget/],
    describe: 'the tree as committed, with nothing broken',
    // What replaced `perf-unverified-line-is-over-its-real-limit`.
    //
    // That case asserted the committed tree reported indexParseMsNormalised as
    // UNVERIFIED, which was true while DOG-80's declaration stood and is false
    // now that DOG-98 has deleted it. Rather than drop the case, it is inverted
    // into the claim the project actually wants to hold: v1 does not ship with a
    // budget line that is measured and not gated. A new `unverified` block is a
    // five-line diff that reads like paperwork, and this is the thing that makes
    // adding one a decision somebody has to defend here.
    //
    // A no-op `break` for the same reason the old case needed one: `audit` runs
    // while the staged breakage is still in place, so a claim about the COMMITTED
    // tree cannot be an audit hung off a case that mutates it.
    break: () => {
      requireBuild();
      return () => {};
    },
    //
    // The audit reads the report at a substituted in-band calibration. At the
    // runner's own, a runner faster than the band puts every calibrated line at
    // `not evaluated`, which is correct, and this audit then failed on GitHub run
    // 38122623958 for a property of the runner rather than of the budget
    // (DOG-120). Whether a line CAN carry a verdict is a question about the
    // committed tree, so it is asked where the runner cannot answer it instead.
    // The check below still runs at the runner's real calibration.
    audit: () => {
      const report = perfReport(120);
      const problems = [];

      const declared = Object.keys(report.unverified ?? {});
      if (declared.length > 0) {
        problems.push(`budget line(s) shipped measured-but-not-gated: ${declared.join(', ')}.`);
        problems.push(`  An unverified declaration is a terminal state for one issue, not a resting`);
        problems.push(`  state for the budget. Settle the limit and delete the block.`);
      }

      // The DOG-98 lines specifically: they exist to gate in BOTH directions,
      // and a line sitting permanently at "not evaluated" would be the DOG-80
      // defect again — a number printed, nothing able to go red over it.
      if (report.nameIndex?.measured === true) {
        for (const key of ['nameIndexBuildMsNormalised', 'nameIndexBuildUsPerCell']) {
          const line = report.verdicts[key];
          if (line === undefined) {
            problems.push(`${key} has no verdict: the line is gone, not merely over or under.`);
          } else if (line.verdict !== 'within' && line.verdict !== 'over') {
            problems.push(`${key} reports ${JSON.stringify(line.verdict)} on the committed tree.`);
            problems.push(`  This build has a name index, so both DOG-98 lines have a subject and`);
            problems.push(`  are supposed to carry a verdict in both directions.`);
          }
        }
        // The per-cell line divides by the cell count, so a report that gates
        // on it without saying what it divided by cannot be re-derived.
        if (!(report.nameIndex.cells > 0)) {
          problems.push(`nameIndex.cells is ${JSON.stringify(report.nameIndex.cells)}, so the per-cell line`);
          problems.push(`  cannot be checked against the measurement it came from.`);
        }
      }
      return problems;
    },
    check: () => run('perf-budget.mjs'),
  },
  {
    name: 'perf-unverified-needs-a-stated-reason',
    gate: 'performance budget',
    criterion: 'a line cannot stop being gated without a reason and a way back',
    expect: [
      /declared unverified without saying why: indexParseMsNormalised/,
      /needs a non-empty `reason` and a non-empty `clearedBy`/,
    ],
    describe: 'an unverified declaration with the reason emptied out',
    // The other half. Without this, `"unverified": {}` is a one-line way to turn
    // any budget line off, and the sentence explaining why would be optional.
    break: () => {
      requireBuild();
      return withUnverified('indexParseMsNormalised', { sinceIssue: 'DOG-80', reason: '  ', clearedBy: '' });
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', '25']),
  },

  // -------------------------------------------------------------------------
  // The name index's two lines (DOG-98).
  //
  // The index build was split off indexParseMsNormalised onto a line for what
  // the main thread can afford at boot and a line for what the work costs per
  // cell. That gives the budget two new ways to go quiet: a line can be deleted,
  // and the pair's one ambiguous verdict can be read as a regression when it is
  // growth. Both are cases here, because both are cheap mistakes to make under
  // pressure and neither shows up as a red build.
  // -------------------------------------------------------------------------
  {
    name: 'perf-name-index-absolute-line-cannot-be-deleted',
    gate: 'performance budget',
    criterion: 'deleting a budget line fails rather than silently dropping a measurement',
    expect: [
      /do not name the same lines/,
      /Measured with no budget line beside it: nameIndexBuildMsNormalised/,
      /deleting only the budget entry removes the check/,
    ],
    describe: 'ci/performance-budget.json with the nameIndexBuildMsNormalised line deleted',
    // The cheapest way to make a budget line stop complaining is to delete it,
    // and before DOG-98 that worked silently: the verdict loop walks the budget
    // file, so an entry with no reader printed no row, took no verdict and could
    // not go red, while the gate went on measuring the cost and exiting 0. A
    // five-line deletion in a JSON file is not a change anyone reviews as a
    // weakening of the budget, which is exactly why it has to be the gate that
    // refuses it.
    break: () => {
      requireBuild();
      return withoutBudgetLine('nameIndexBuildMsNormalised');
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', '120']),
  },
  {
    name: 'perf-name-index-per-cell-line-cannot-be-deleted',
    gate: 'performance budget',
    criterion: 'the per-cell line is no more deletable than the absolute one',
    expect: [
      /do not name the same lines/,
      /Measured with no budget line beside it: nameIndexBuildUsPerCell/,
    ],
    describe: 'ci/performance-budget.json with the nameIndexBuildUsPerCell line deleted',
    // Both lines, separately, and not one case covering "a line": the per-cell
    // line is the one with a motive. It is the only limit growth cannot consume,
    // so it is the one that reds when the index gets bigger and the one somebody
    // under deadline would reach for. A single case on the absolute line would
    // have left that unproven while looking like coverage.
    break: () => {
      requireBuild();
      return withoutBudgetLine('nameIndexBuildUsPerCell');
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', '120']),
  },
  {
    name: 'perf-name-index-absent-is-not-a-failure',
    gate: 'performance budget',
    criterion: 'a build that declares no name index is reported, not failed',
    mustPass: true,
    expect: [
      /NAME INDEX NOT IN THIS BUILD/,
      /nameIndexBuildMsNormalised\s+not in this build.*not evaluated/,
      /nameIndexBuildUsPerCell\s+not in this build.*not evaluated/,
      /not in this build at all: nameIndexBuildMsNormalised, nameIndexBuildUsPerCell/,
      /A different runner will not change that/,
    ],
    describe: 'the built atlas index with its nameIndex descriptor removed, as on a base without one',
    // `origin/main` is exactly this build: no app.js step 1, no assets/labels, no
    // `nameIndex` descriptor. Two new budget lines that have no subject there
    // could fail it, or print NaN, or quietly report 0% — and the first version
    // of DOG-80's gate did fail it, which would have reddened main's CI for a
    // reason unrelated to the integration. So absence is loud and not fatal.
    //
    // It is the sibling of DOG-29's fast-runner case and it is `mustPass` for the
    // same reason: a gate that goes red on something that is not a defect costs
    // more than one that passes a defect, because it spends the credibility that
    // makes a red build worth stopping for.
    //
    // DOG-98 verified this by hand, which is how DOG-80 verified it too. By hand
    // is not a gate: the two lines that make it breakable did not exist when the
    // hazard was last checked, and the next person to touch them will not know to
    // re-check it.
    //
    // The DESCRIPTOR is removed rather than the files, deliberately. Removing the
    // documents while leaving the descriptor pointing at them is a different
    // condition — the build has a name index and the gate cannot find it — and
    // that one is still required to fail.
    break: () => {
      requireBuild();
      const indexPath = join(WEB, 'dist', 'data', 'atlas-index.json');
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      delete index.nameIndex;
      return substitute(indexPath, JSON.stringify(index, null, 2) + '\n');
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', '120']),
  },
  {
    name: 'perf-name-index-growth-is-not-a-regression',
    gate: 'performance budget',
    criterion: 'over on the absolute line while within per-cell says the remedy is a worker, not a bigger limit',
    expect: () => [
      new RegExp(`nameIndexBuildMsNormalised: [\\d.]+ ms against a budget of ${shown(staged.nameIndexBuild)} ms`),
      /THIS IS NOT A REGRESSION, AND RAISING THE LINE IS THE WRONG FIX/,
      /so the cost of binding one/,
      /move the name index build off the critical path/,
      /in a worker, or after first interaction — not to raise this limit/,
    ],
    describe: 'the absolute name index line busted while the per-cell line is still comfortably within',
    // DOG-97 §2.4 is a decision about what to do when this pair of verdicts
    // comes up, and a decision that lives only in a document is a decision the
    // next person re-derives from two numbers or gets wrong. The remedy it names
    // — move the build off the critical path — is the one thing the obvious
    // reading of a red absolute line does not suggest, so the gate says it in
    // its own voice at the moment it is needed.
    //
    // Staged as the verdict PAIR rather than by growing the index: what the
    // message keys on is "absolute over, per-cell within", and fabricating a
    // bigger coverings.json would also move the byte lines and the cell count
    // and prove less about the branch. Both limits are moved in one
    // substitution, deliberately — the per-cell limit is raised far clear of the
    // reading so that half of the pair cannot flip on a contended runner and
    // turn a real assertion into a confusing red.
    //
    // Both are staged from this runner's reading. The absolute line used to be a
    // literal 10 ms, set against the ~43 ms this gate reads here; GitHub's runner
    // read 9.5 ms, so the line it set out to bust was within (DOG-120).
    break: () => {
      requireBuild();
      const report = perfReport(120);
      staged.nameIndexBuild = limitBelow(perfReading(report, 'nameIndexBuildMsNormalised'));
      return withBudgetLimits({
        nameIndexBuildMsNormalised: staged.nameIndexBuild,
        nameIndexBuildUsPerCell: limitAbove(perfReading(report, 'nameIndexBuildUsPerCell')),
      });
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', '120']),
  },

  // -------------------------------------------------------------------------
  // Brain meshes (DOG-127): the decimation gate, licence rule 10, rule 6 on a
  // binary payload, and the perf gate's lazy tier.
  // -------------------------------------------------------------------------
  {
    name: 'mesh-gate-reads-the-committed-files',
    gate: 'mesh assets',
    criterion: 'the mesh gate checks every shippable structure on the committed tree, not none',
    mustPass: true,
    expect: [/248 of 248 shippable structures in both tiers/, /Published error re-measured for all 248/, /QA sample 40 structures, 1 withheld control/],
    describe: 'the committed brain mesh files, unchanged',
    // A gate that found no files would also pass. This pins that it found them.
    break: () => () => {},
    check: () => run('check-mesh-assets.mjs'),
  },
  {
    name: 'mesh-structure-lost-to-decimation',
    gate: 'mesh assets',
    criterion: 'the mesh gate fails when a structure in the source manifest is missing from the low tier',
    expect: [/Subthalamic nucleus\.l \(id \d+\) is in the source manifest but missing from the low tier/],
    describe: 'a low tier with the left subthalamic nucleus decimated out of existence',
    break: () => {
      const stn = brainStructure('Subthalamic nucleus.l');
      return rewriteMesh(BRAIN_LOW, (records) => records.filter((r) => r.id !== stn.id));
    },
    check: () => run('check-mesh-assets.mjs'),
  },
  {
    name: 'mesh-structure-degenerate',
    gate: 'mesh assets',
    criterion: 'the mesh gate fails when a structure is present but degenerate in the low tier',
    expect: [/Substantia nigra\.r \(id \d+\): \d+ degenerate triangle\(s\) in the low tier/],
    describe: 'the right substantia nigra kept in the table, every vertex collapsed onto one point',
    break: () => {
      const sn = brainStructure('Substantia nigra.r');
      return rewriteMesh(BRAIN_LOW, (records) => records.map((r) => {
        if (r.id !== sn.id) return r;
        const positions = Int16Array.from(r.positions, (_, i) => r.positions[i % 3]);
        return { ...r, positions };
      }));
    },
    check: () => run('check-mesh-assets.mjs'),
  },
  {
    name: 'mesh-tract-flattened-to-a-sliver',
    gate: 'mesh assets',
    criterion: 'the mesh gate fails when a structure keeps its triangles but loses an axis',
    expect: [/Corticospinal tract\.l \(id \d+\): the low tier keeps [\d.]+ mm of its [\d.]+ mm [xyz] extent; it has collapsed toward a sliver/],
    describe: 'the left corticospinal tract squashed flat onto one plane, triangle count untouched',
    // The decimation failure a triangle floor cannot see: a thin tube simplified
    // into a ribbon has as many triangles as the floor asks for.
    break: () => {
      const cst = brainStructure('Corticospinal tract.l');
      return rewriteMesh(BRAIN_LOW, (records) => records.map((r) => {
        if (r.id !== cst.id) return r;
        // Flatten the axis with the smallest extent, so the length survives.
        const ext = [0, 1, 2].map((a) => {
          let lo = Infinity;
          let hi = -Infinity;
          for (let v = a; v < r.positions.length; v += 3) {
            lo = Math.min(lo, r.positions[v]);
            hi = Math.max(hi, r.positions[v]);
          }
          return { a, lo, span: hi - lo };
        }).sort((x, y) => x.span - y.span)[0];
        const positions = Int16Array.from(r.positions, (q, i) => (i % 3 === ext.a ? ext.lo : q));
        return { ...r, positions };
      }));
    },
    check: () => run('check-mesh-assets.mjs'),
  },
  {
    name: 'mesh-published-error-drifts',
    gate: 'mesh assets',
    criterion: 'the mesh gate fails when a published error figure is not what the files measure',
    expect: [/Nucleus accumbens\.l \(id \d+\): structures\.json publishes Hausdorff 0\.001 mm/],
    describe: 'structures.json claiming a 0.001 mm error for the left nucleus accumbens',
    break: () => {
      const doc = JSON.parse(readFileSync(BRAIN_STRUCTURES, 'utf8'));
      const s = doc.structures.find((x) => x.name === 'Nucleus accumbens.l');
      if (!s) throw new Error('Nucleus accumbens.l is no longer a shipped brain structure to stage this against');
      s.errorMm.hausdorff = 0.001;
      return substitute(BRAIN_STRUCTURES, `${JSON.stringify(doc, null, 1)}\n`);
    },
    check: () => run('check-mesh-assets.mjs'),
  },
  {
    name: 'mesh-registration-error-understated',
    gate: 'mesh assets',
    criterion: 'the mesh gate fails when the registration publishes a held-out error the fit does not give',
    expect: [/registration: red-nucleus\.l records errorMm 2; refitting gives [\d.]+/],
    describe: 'the registration file claiming a 2 mm held-out error at the left red nucleus',
    // The figure every coordinate-reported finding inherits. Understating it is
    // the failure that matters, so it is the one staged.
    break: () => {
      const reg = JSON.parse(readFileSync(BRAIN_REGISTRATION, 'utf8'));
      const rn = reg.heldOut.find((x) => x.id === 'red-nucleus.l');
      if (!rn) throw new Error('red-nucleus.l is no longer a held-out pair to stage this against');
      rn.errorMm = 2;
      return substitute(BRAIN_REGISTRATION, `${JSON.stringify(reg, null, 1)}\n`);
    },
    check: () => run('check-mesh-assets.mjs'),
  },
  {
    name: 'mesh-qa-sample-drops-a-required-nucleus',
    gate: 'mesh assets',
    criterion: 'the mesh gate fails when the QA sample loses a required nucleus or one side of a pair',
    expect: [/QA sample: the sample has 39 structures, not 40/, /QA sample: required Subthalamic nucleus\.r is not in the sample/],
    describe: 'the committed QA sample with the right subthalamic nucleus dropped',
    break: () => {
      const fixture = JSON.parse(readFileSync(BRAIN_QA_SAMPLE, 'utf8'));
      fixture.sample = fixture.sample.filter((x) => x.name !== 'Subthalamic nucleus.r');
      return substitute(BRAIN_QA_SAMPLE, `${JSON.stringify(fixture, null, 1)}\n`);
    },
    check: () => run('check-mesh-assets.mjs'),
  },
  {
    name: 'licence-rule-10-reads-the-brain-files',
    gate: 'licence separation',
    criterion: 'rule 10 checks every structure slot of the committed brain files, not none',
    mustPass: true,
    expect: [/rule 10: 3 brain file\(s\), 744 structure slot\(s\)/],
    describe: 'the committed brain mesh files and their attribution entry, unchanged',
    break: () => () => {},
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'licence-held-structure-in-cleared-file',
    gate: 'licence separation',
    criterion: 'licence separation fails when a cleared-looking brain file carries one held structure',
    expect: [
      /entry zanatomy-brain-meshes-cleared ships Precentral gyrus\.l \(id \d+\), which is held as zanatomy-undeclared-brain-materials/,
      /A file's citations do not clear what is inside it/,
    ],
    describe: 'the low tier with one slot relabelled as the left precentral gyrus, its entry citing only cleared sources',
    // The residual DOG-126 left open: every citation on the entry is cleared, so
    // rule 9 is green, and only reading the file can see what it carries.
    break: () => {
      const held = heldStructure('Precentral gyrus.l');
      let swapped = false;
      return rewriteMesh(BRAIN_LOW, (records) => records.map((r) => {
        if (swapped) return r;
        swapped = true;
        return { ...r, id: held.id };
      }));
    },
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'licence-mesh-inlined-as-base64',
    gate: 'licence separation',
    criterion: 'licence separation fails when a binary mesh is embedded in the bundle as base64',
    expect: [/contains bytes from asset payload brain\/zanatomy-2929e94\/meshes\.lowres\.bin, base64-encoded/],
    describe: 'a build that inlines the low-tier brain mesh into app.js as a base64 string',
    break: () => {
      requireBuild();
      const app = join(WEB, 'dist', 'app', 'app.js');
      const mesh = readFileSync(BRAIN_LOW).toString('base64');
      return substitute(app, `${readFileSync(app, 'utf8')}\nexport const INLINED_BRAIN = '${mesh}';\n`);
    },
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'licence-mesh-copied-outside-assets',
    gate: 'licence separation',
    criterion: 'licence separation fails when a mesh is re-emitted outside dist/assets/ under any extension',
    expect: [/dist\/app\/brain\.bin: contains bytes from asset payload brain\/zanatomy-2929e94\/meshes\.fullres\.bin\./],
    describe: 'a build that also writes the full-tier brain mesh to dist/app/brain.bin',
    // Rule 6 used to read only .js/.css/.html/.json outside the assets tree, so a
    // binary written next to the bundle was never looked at.
    break: () => {
      requireBuild();
      return substitute(join(WEB, 'dist', 'app', 'brain.bin'), readFileSync(BRAIN_FULL));
    },
    check: () => run('check-licence-separation.mjs'),
  },
  {
    name: 'perf-undeclared-lazy-tier-is-costed-as-low-res',
    gate: 'performance budget',
    criterion: 'a full-resolution tier not declared lazy is paid for on the low-resolution lines',
    expect: [/lowResBrainAssetGzipBytes: [\d.]+ KiB against a budget of 1024\.0 KiB/],
    describe: 'a built structures.json whose full tier no longer says `loading: "lazy"`',
    // The lazy classification reads a declaration, so this is its failure mode:
    // forget the declaration and the bytes land on the line that pays for them.
    break: () => {
      requireBuild();
      const shipped = join(WEB, 'dist', 'assets', BRAIN.structuresFile);
      const doc = JSON.parse(readFileSync(shipped, 'utf8'));
      delete doc.tiers.full.loading;
      return substitute(shipped, `${JSON.stringify(doc, null, 1)}\n`);
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', String(LOOKUP_CALIBRATION_MS)]),
  },

  // -------------------------------------------------------------------------
  // A non-root base (DOG-120).
  //
  // Pages builds with the base its config hands out, `/somasurfer`, and every
  // URL the atlas index emits carries it. CI builds at `/` and nothing else, so
  // the gate joined `/somasurfer/assets/...` onto dist/, failed every deploy, and
  // stayed green here. These build a second copy at the Pages base, beside the
  // one CI checked rather than over it.
  // -------------------------------------------------------------------------
  {
    name: 'perf-non-root-base-is-not-a-failure',
    gate: 'performance budget',
    criterion: 'a build at a non-root base is measured, name index included, and not failed',
    mustPass: true,
    expect: [
      /✓ performance budget/,
      /2 of them the name index/,
      /nameIndexBuildMsNormalised\s+[\d.]+ ms/,
    ],
    describe: `a build at the Pages base ${PAGES_BASE}, with nothing else wrong`,
    break: () => {
      requireBuild();
      return buildAtPagesBase();
    },
    // The console says the name index was found; the report has to say it was
    // found INSIDE this build and gated, or a lookup that fell back to some other
    // copy would read the same.
    audit: () => {
      const report = perfReportAt(BASE_BUILD_DIST);
      const problems = [];
      const expected = ['names.json', 'coverings.json'].map((f) => `${rel(BASE_BUILD_DIST)}/assets/labels/${f}`);
      if (JSON.stringify(report.nameIndex?.files) !== JSON.stringify(expected)) {
        problems.push(`nameIndex.files is ${JSON.stringify(report.nameIndex?.files)}, expected ${JSON.stringify(expected)}.`);
      }
      for (const key of ['nameIndexBuildMsNormalised', 'nameIndexBuildUsPerCell']) {
        const verdict = report.verdicts[key]?.verdict;
        if (verdict !== 'within' && verdict !== 'over') {
          problems.push(`${key} reports ${JSON.stringify(verdict)} at a non-root base; it has a subject and must gate.`);
        }
      }
      return problems;
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', String(LOOKUP_CALIBRATION_MS), '--dist', rel(BASE_BUILD_DIST)]),
  },
  {
    name: 'perf-non-root-base-still-needs-the-name-index',
    gate: 'performance budget',
    criterion: 'stripping the base does not make a missing name index pass',
    expect: [
      /points at a name index that is not in the build/,
      new RegExp(`${rel(BASE_BUILD_DIST).replace(/[.]/g, '\\.')}/assets/labels/names\\.json`),
    ],
    describe: `a build at the Pages base ${PAGES_BASE} with its names.json deleted`,
    // The other half. Without it the base-stripping above could be a lookup that
    // never fails, and the first case would read the same.
    break: () => {
      requireBuild();
      const restore = buildAtPagesBase();
      rmSync(join(BASE_BUILD_DIST, 'assets', 'labels', 'names.json'));
      return restore;
    },
    check: () => run('perf-budget.mjs', ['--calibration-ms', String(LOOKUP_CALIBRATION_MS), '--dist', rel(BASE_BUILD_DIST)]),
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
  rel(RESEARCH_SEED),
  rel(CITATION_REPORT),
  rel(REAL_NAMES),
  rel(REAL_COVERINGS),
  rel(ATTRIBUTION),
  rel(NC_STAND_IN),
  // The whole directory, so an untracked NC layer there stops the run before
  // any case writes beside it.
  rel(NC_DIR),
  rel(LEAKED_NC),
  rel(MERGED),
  rel(BRAIN_LOW),
  rel(BRAIN_FULL),
  rel(BRAIN_STRUCTURES),
  rel(BRAIN_REGISTRATION),
  rel(BRAIN_QA_SAMPLE),
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
    // A function when the expectation names a limit staged from the measurement,
    // which only exists once `break` has run.
    const expect = typeof c.expect === 'function' ? c.expect() : c.expect;
    const missing = expect.filter((re) => !re.test(output));
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
rmSync(BASE_BUILD, { recursive: true, force: true });
for (const path of [join(ALC, 'test', 'gate-verify.test.ts'), join(WEB, 'src', 'gate-verify.js'), GATE_TEMPLATE, LEAKED_NC, MERGED]) {
  rmSync(path, { force: true });
  rmSync(`${path}.gate-verify-stash`, { force: true });
}
// The stand-in is ours; anything else in `nc/` is somebody's work.
rmSync(NC_STAND_IN, { force: true });
removeIfEmpty(NC_DIR);
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
