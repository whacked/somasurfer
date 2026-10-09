/**
 * Gates the curated research data, and reports what nothing can check yet.
 *
 * Four things are asserted, and one is reported rather than asserted. The
 * difference is the point of this file.
 *
 * **Asserted, and able to go red today:**
 *
 *   1. Every committed dataset loads. `loadDataset` refuses bad URLs, bad
 *      addresses, contradictory locator fields, inferences without notes and
 *      every other schema rule, so a dataset that loads has had all of them
 *      checked.
 *   2. Every mapping that is not a `coordinates` mapping resolves against the
 *      name index the dataset declares. This is a **one-sided bound**: it says
 *      nothing about real geometry, and it still catches the whole class of
 *      curation error that matters most — a structure id that nothing knows.
 *   3. The committed JSON matches its curation source (`--check` on
 *      `scripts/author-seed.mjs`). Edited by hand, it would be silently
 *      reverted by the next regeneration.
 *   4. The gate can fail. `selfTest()` runs checks 1 and 2 against datasets
 *      broken on purpose and fails if either one passes. A gate nobody has
 *      seen go red is a gate nobody should trust, and this one is cheap enough
 *      to prove on every run.
 *
 * **Reported as UNVERIFIED, never as a pass:**
 *
 *   The stage-B criterion — *every curated finding's covering resolves to real
 *   cells and real meshes* — needs the asset pipeline's `coverings.json`, which
 *   does not exist yet. The tempting options are both wrong. Failing would make
 *   CI red for a dependency nobody on this branch can satisfy, and the red
 *   would be ignored, and then a real failure would be invisible inside it.
 *   Passing would record a check that never ran. So the gate prints UNVERIFIED
 *   with the reason and the paths it looked in, and exits zero — and the moment
 *   `coverings.json` appears at one of those paths, the same check runs for
 *   real and can fail for real.
 *
 *   Flags:
 *     --strict-geometry   turn the UNVERIFIED report into a failure. For the
 *                         release gate, once the index is expected to exist.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { REPO_ROOT, fail, pass } from './lib/repo.mjs';
import { buildNameIndex } from '../packages/alc/src/index.ts';
import { buildResearchIndex, loadDataset, validateDataset } from '../packages/atlas-research/src/index.ts';

const PKG = join(REPO_ROOT, 'packages', 'atlas-research');

/**
 * Where the asset pipeline (plan task 4) may publish the real index.
 *
 * Several candidates on purpose: the pipeline has not landed, so the exact path
 * is its decision rather than this gate's. Naming them all means whichever it
 * picks is found, and the UNVERIFIED message tells its author where to look.
 */
const REAL_INDEX_CANDIDATES = [
  'packages/atlas-assets/templates/coverings.json',
  'packages/atlas-assets/labels/coverings.json',
  'packages/atlas-assets/labels/names.json',
  'packages/atlas-web/dist/data/coverings.json',
];

/** The datasets this gate owns, each with the index it declares. */
const DATASETS = [
  {
    id: 'fixture',
    data: 'fixtures/research.fixture.json',
    names: 'fixtures/names.fixture.json',
    note: 'the 5-paper fixture the viewer and QA build against',
  },
  {
    id: 'seed',
    data: 'data/research-seed.json',
    names: 'data/names-seed.json',
    note: 'the curated seed set',
  },
];

const readJson = (relPath) => JSON.parse(readFileSync(join(PKG, relPath), 'utf8'));

function indexFrom(raw) {
  return buildNameIndex({ version: raw.version, structures: raw.structures });
}

const problems = [];
const report = [];

// ---------------------------------------------------------------------------
// 4. The gate can fail. Run first, so a broken gate is reported before its
//    results are trusted.
// ---------------------------------------------------------------------------

function selfTest() {
  const base = readJson('fixtures/research.fixture.json');
  const names = indexFrom(readJson('fixtures/names.fixture.json'));
  const failures = [];

  // A dataset with a hostile link must not load.
  const badLink = structuredClone(base);
  badLink.papers[0].sourceUrl = 'javascript:alert(1)';
  if (validateDataset(badLink).dataset !== null) {
    failures.push('a dataset with a `javascript:` source URL loaded; check 1 cannot go red.');
  }

  // A dataset naming a structure the index does not have must report it.
  const badStructure = structuredClone(base);
  badStructure.findings[0].mappings[0].structureId = 'ATLAS-LABEL:not-a-real-structure';
  const loaded = validateDataset(badStructure).dataset;
  if (loaded === null) {
    failures.push('the unknown-structure fixture failed to load, so check 2 was not exercised.');
  } else {
    const idx = buildResearchIndex({ dataset: loaded, names });
    const hit = idx.unresolved.find((m) => m.unresolvedReason === 'unknown-structure');
    if (!hit) failures.push('an unknown structure id resolved anyway; check 2 cannot go red.');
    else if (hit.covering.cells.length > 0) failures.push('an unresolved mapping still carried geometry.');
  }
  return failures;
}

const selfTestFailures = selfTest();
if (selfTestFailures.length > 0) {
  problems.push('the gate itself cannot detect the failures it exists for:', ...selfTestFailures.map((f) => `  ${f}`));
} else {
  report.push('self-test: the gate goes red on a hostile link and on an unknown structure id.');
}

// ---------------------------------------------------------------------------
// 1 and 2. Load, then resolve against the declared index.
// ---------------------------------------------------------------------------

const resolved = [];

for (const spec of DATASETS) {
  const label = `${spec.id} (${spec.data})`;
  let dataset;
  try {
    dataset = loadDataset(readJson(spec.data));
  } catch (e) {
    problems.push(`${label}: did not load.`, ...String(e.message).split('\n').map((l) => `  ${l}`));
    continue;
  }

  const names = indexFrom(readJson(spec.names));
  if (names.version !== dataset.authoredAgainst.nameIndexVersion) {
    // Not cosmetic: a resolution is only reproducible against the index it was
    // authored for, and every browse result pins both versions.
    problems.push(
      `${label}: declares nameIndexVersion ${JSON.stringify(dataset.authoredAgainst.nameIndexVersion)}` +
        ` but ${spec.names} is version ${JSON.stringify(names.version)}.`,
    );
    continue;
  }

  const index = buildResearchIndex({ dataset, names });
  const mappings = index.mappings;
  const byPrecision = {};
  for (const m of mappings) byPrecision[m.precision] = (byPrecision[m.precision] ?? 0) + 1;

  // The one-sided bound: anything other than a coordinates mapping must resolve.
  const mustResolve = mappings.filter((m) => m.precision !== 'coordinates');
  const unresolvedNonCoordinate = mustResolve.filter((m) => m.resolution !== 'resolved');
  if (unresolvedNonCoordinate.length > 0) {
    problems.push(
      `${label}: ${unresolvedNonCoordinate.length} of ${mustResolve.length} non-coordinate mappings did not resolve.`,
    );
    for (const m of unresolvedNonCoordinate.slice(0, 10)) {
      problems.push(`  ${m.mappingId}: ${m.unresolvedReason} — ${m.notes.join('; ')}`);
    }
  }

  const coordinates = mappings.filter((m) => m.precision === 'coordinates');
  const awaitingTemplate = coordinates.filter((m) => m.unresolvedReason === 'no-template');

  // Citation honesty, as a number rather than an impression.
  const withIdentifier = dataset.papers.filter((p) => p.identifier.kind !== 'none').length;
  const locatorRecorded = mappings.filter((m) => m.evidence.locatorStatus === 'recorded').length;
  const inferred = mappings.filter((m) => m.provenance.basis === 'curator-inference').length;

  report.push(
    `${spec.id}: ${dataset.papers.length} papers, ${dataset.findings.length} findings, ` +
      `${mappings.length} mappings ${JSON.stringify(byPrecision)} — ${spec.note}`,
    `  resolved against ${names.version}: ${mustResolve.length - unresolvedNonCoordinate.length}/${mustResolve.length} non-coordinate mappings`,
    `  coordinates awaiting a template: ${awaitingTemplate.length}/${coordinates.length}`,
    `  identifiers recorded: ${withIdentifier}/${dataset.papers.length} — 0 machine-verified, by design (links are rendered, never fetched)`,
    `  evidence locators recorded: ${locatorRecorded}/${mappings.length}; curator inferences: ${inferred} (each with a note, enforced at load)`,
  );

  resolved.push({ spec, dataset, index });
}

// ---------------------------------------------------------------------------
// 3. The committed JSON matches its curation source.
// ---------------------------------------------------------------------------

{
  const script = join(PKG, 'scripts', 'author-seed.mjs');
  const run = spawnSync(process.execPath, [script, '--check'], { cwd: PKG, encoding: 'utf8' });
  if (run.status !== 0) {
    problems.push('the committed seed data has drifted from its curation source:');
    for (const line of `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n')) {
      problems.push(`  ${line.trim()}`);
    }
  } else {
    report.push('drift: data/ matches scripts/author-seed.mjs.');
  }
}

// ---------------------------------------------------------------------------
// The stage-B criterion: reported, not asserted, until the index exists.
// ---------------------------------------------------------------------------

const realIndexPath = REAL_INDEX_CANDIDATES.map((p) => join(REPO_ROOT, p)).find((p) => existsSync(p));
const strictGeometry = process.argv.includes('--strict-geometry');

if (!realIndexPath) {
  const message = [
    'UNVERIFIED: no curated mapping has been checked against real geometry.',
    `  The asset pipeline's coverings index is not present. Looked in:`,
    ...REAL_INDEX_CANDIDATES.map((p) => `    ${p}`),
    '  Every dataset above declares `authoredAgainst.status: "fixture"`, which is accurate:',
    '  the cells come from a synthetic index and encode no measurement. Stage B is to',
    '  re-author the mappings against the real index, which means crosswalking the',
    '  ATLAS-LABEL placeholder namespace onto that index\'s accessions.',
    '  This is reported rather than failed on purpose: a red build for a dependency this',
    '  branch cannot satisfy would be ignored, and a real failure would then be invisible',
    '  inside it. Run with --strict-geometry once the index is expected to exist.',
  ];
  if (strictGeometry) {
    problems.push(...message.map((l) => l.replace(/^UNVERIFIED/, 'FAILED')));
  } else {
    report.push(...message);
  }
} else {
  const raw = JSON.parse(readFileSync(realIndexPath, 'utf8'));
  const realNames = indexFrom(raw);
  for (const { spec, dataset } of resolved) {
    const index = buildResearchIndex({ dataset, names: realNames });
    const mustResolve = index.mappings.filter((m) => m.precision !== 'coordinates');
    const bad = mustResolve.filter((m) => m.resolution !== 'resolved');
    if (bad.length > 0) {
      problems.push(
        `${spec.id}: ${bad.length} of ${mustResolve.length} mappings do not resolve against the real index` +
          ` (${realIndexPath.slice(REPO_ROOT.length + 1)}, version ${realNames.version}).`,
      );
      for (const m of bad.slice(0, 15)) problems.push(`  ${m.mappingId}: ${m.unresolvedReason}`);
    } else {
      report.push(
        `${spec.id}: all ${mustResolve.length} non-coordinate mappings resolve against the real index` +
          ` (version ${realNames.version}).`,
      );
    }
    if (dataset.authoredAgainst.status !== 'real') {
      report.push(
        `${spec.id}: resolves against the real index but still declares status "fixture".` +
          ' Flip it once the mappings are re-authored rather than merely found to resolve.',
      );
    }
  }
}

if (problems.length > 0) fail('research dataset', problems);
pass('research dataset', report);
