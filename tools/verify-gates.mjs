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
import { join } from 'node:path';
import { REPO_ROOT, rel } from './lib/repo.mjs';

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
  const budget = JSON.parse(readFileSync(PERF_BUDGET, 'utf8'));
  budget.budgets[line] = { ...budget.budgets[line], limit };
  return substitute(PERF_BUDGET, JSON.stringify(budget, null, 2) + '\n');
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
    expect: [/real index: \d+ structures, frame BD/, /body-bd: all \d+ non-coordinate mappings resolve/, /lie wholly inside their structure/],
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
for (const path of [join(ALC, 'test', 'gate-verify.test.ts'), join(WEB, 'src', 'gate-verify.js'), GATE_TEMPLATE]) {
  rmSync(path, { force: true });
  rmSync(`${path}.gate-verify-stash`, { force: true });
}
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
