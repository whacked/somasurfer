/**
 * The fixture loader: what it admits, what it still refuses, and which index
 * answered.
 *
 * Three subjects, and the second is the one that keeps this file honest.
 *
 * 1. **An empty covering is admissible.** A structure with a real id, the real
 *    index's own term and no cells is "named here, painted elsewhere" —
 *    `packages/atlas-research/data/names-seed.json` says so in its `$comment`
 *    and `packages/atlas-research/test/seed.test.ts` pins it. The loader used
 *    to refuse the whole 30-paper corpus over fourteen of them.
 *
 * 2. **The relaxation did not make the check inert.** Every case below that
 *    admits something is paired with one that still refuses: no `cells` key at
 *    all, and — the failure the old check was really guarding against — EVERY
 *    structure empty, which means the names were loaded without the coverings.
 *    A loosened gate with no such pair is a gate that has quietly stopped
 *    working, and this package exists to catch that pattern in the product.
 *
 * 3. **Which index answered.** The anatomical oracle is the real asset index
 *    the page binds, not the research dataset's synthetic structure list. A
 *    ranked name list checked against invented cells is not a measurement.
 *
 * The exit-code case spawns the real CLI against a deliberately broken pair of
 * documents, because the contract is about the PROCESS: a fixture that cannot
 * be loaded exits 2 and prints UNVERIFIED. Asserting that against the source
 * text of `bin/qa-journey.mjs` would pass against a rewrite that reintroduced
 * the throw.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  ASSET_INDEX_PATHS,
  FIXTURE_REQUIREMENTS,
  anatomyIndexInput,
  emptyCoveringStructures,
  fixtureShapeProblems,
  loadAnatomyIndex,
  loadCuratedFixture,
  oracleNotes,
  tryResolveFixture,
  unmetRequirements,
  type ResearchFixture,
} from '../src/fixture.ts';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const CLI = join(PACKAGE_ROOT, 'bin', 'qa-journey.mjs');

/**
 * A scratch directory, created rather than assumed.
 *
 * `os.tmpdir()` is not guaranteed to exist: `TMPDIR` can name a run-scoped
 * directory that was removed with the run that created it, and then
 * `mkdtempSync` throws ENOENT from inside a case that has nothing to do with
 * the filesystem. `tools/check-research-dataset.mjs` records the same
 * correction for the same reason.
 */
function scratch(prefix: string): string {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The smallest document `fixtureShapeProblems` accepts, as a starting point. */
function minimalRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'shape-case',
    nameIndexVersion: 'shape-case-index-1',
    structures: [
      { id: 'S-PAINTED', name: 'a painted structure', atlas: 'body', cells: ['BD-T07-03O-4'] },
    ],
    papers: [
      {
        id: 'P-1',
        citation: 'Someone (2026). A paper.',
        findings: [
          {
            id: 'F-1',
            summary: 'a finding',
            regions: ['S-PAINTED'],
            cells: ['BD-T07-03O-4'],
            evidence: 'stated in the abstract',
            spatialDetail: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. An empty covering is admissible
// ---------------------------------------------------------------------------

test('a structure with an empty covering is admissible', () => {
  const raw = minimalRaw({
    structures: [
      { id: 'S-PAINTED', name: 'a painted structure', atlas: 'body', cells: ['BD-T07-03O-4'] },
      { id: 'FMA13295', name: 'diaphragm', atlas: 'body', cells: [] },
    ],
  });
  assert.deepEqual(
    fixtureShapeProblems(raw, 'case.json'),
    [],
    'a structure named with no covering is "named here, painted elsewhere" and is not a broken fixture',
  );
});

test('a structure with no `cells` key at all is still refused', () => {
  const raw = minimalRaw({
    structures: [
      { id: 'S-PAINTED', name: 'a painted structure', atlas: 'body', cells: ['BD-T07-03O-4'] },
      { id: 'S-NO-KEY', name: 'no cells key', atlas: 'body' },
    ],
  });
  const problems = fixtureShapeProblems(raw, 'case.json');
  assert.equal(problems.length, 1, `expected exactly one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /S-NO-KEY needs a cells array/);
});

test('a fixture in which NOTHING is painted is still refused — that is half an index', () => {
  const raw = minimalRaw({
    structures: [
      { id: 'FMA13295', name: 'diaphragm', atlas: 'body', cells: [] },
      { id: 'FMA7088', name: 'heart', atlas: 'body', cells: [] },
    ],
    papers: [
      {
        id: 'P-1',
        citation: 'Someone (2026). A paper.',
        findings: [
          {
            id: 'F-1',
            summary: 'a finding',
            regions: ['FMA13295'],
            cells: [],
            evidence: 'stated in the abstract',
            spatialDetail: false,
          },
        ],
      },
    ],
  });
  const problems = fixtureShapeProblems(raw, 'case.json');
  assert.ok(
    problems.some((p) => /not one of 2 structures has a single cell/.test(p)),
    'admitting SOME empty coverings must not admit a document where every structure is empty — '
    + `that is names.json loaded without coverings.json. Problems: ${JSON.stringify(problems)}`,
  );
});

test('an empty covering is still not a click target, and the reason names the structure', () => {
  // Every body structure named and none painted: the selection steps cannot be
  // put to the build, and must say which structure they would have clicked.
  const fixture = {
    id: 'unpaintable-case',
    nameIndexVersion: 'unpaintable-1',
    structures: [
      { id: 'FMA13295', name: 'diaphragm', atlas: 'body' as const, cells: [] },
      { id: 'FMA7088', name: 'heart', atlas: 'body' as const, cells: [] },
      { id: 'BRAIN-1', name: 'a brain parcel', atlas: 'brain' as const, cells: ['BV-L-100'] },
    ],
    papers: [],
    anatomy: null,
    oracle: {
      researchNames: 'case/names.json',
      anatomyIndex: null,
      paintedFromAssets: [],
      placeholderCells: ['BRAIN-1'],
      emptyCovering: ['FMA13295', 'FMA7088'],
      why: ['no asset index in this tree'],
    },
    source: { path: 'case/names.json', sha256: 'n/a', kind: 'curated' as const },
  } satisfies ResearchFixture;

  assert.deepEqual(
    emptyCoveringStructures(fixture).map((s) => s.id),
    ['FMA13295', 'FMA7088'],
  );

  const unmet = unmetRequirements(fixture);
  const reasons = unmet.get('select-structure-without-leaving-atlas') ?? [];
  assert.ok(reasons.length > 0, 'a fixture with no clickable body structure must make the selection step unverified');
  const about = reasons.find((r) => /empty covering/.test(r));
  assert.ok(about, `no reason mentioned the empty covering: ${JSON.stringify(reasons)}`);
  assert.match(about, /FMA13295 \(diaphragm\)/);
  assert.match(about, /FMA7088 \(heart\)/);
  // And why nothing painted them, which is the half a reader needs to act:
  // "the index has no row for it" and "there is no index" send you to
  // different places.
  assert.match(about, /No real anatomical index is bound in this tree|does not carry them/);
});

test('a painted body structure satisfies the requirement an empty one cannot', () => {
  const requirement = FIXTURE_REQUIREMENTS.find((r) => r.id === 'a-body-structure');
  assert.ok(requirement, 'the body-structure requirement is still declared');
  const withCells = (cells: string[][]): ResearchFixture => ({
    id: 'c',
    nameIndexVersion: 'v',
    structures: cells.map((c, i) => ({ id: `S-${i}`, name: `s${i}`, atlas: 'body' as const, cells: c })),
    papers: [],
    anatomy: null,
    oracle: {
      researchNames: 'c', anatomyIndex: null, paintedFromAssets: [], placeholderCells: [],
      emptyCovering: [], why: [],
    },
    source: { path: 'c', sha256: 'n/a', kind: 'curated' },
  });
  assert.equal(requirement.satisfied(withCells([['BD-T07-03O-4'], ['BD-T07-03O-5']])), true);
  assert.equal(
    requirement.satisfied(withCells([['BD-T07-03O-4'], []])),
    false,
    'one painted body structure and one empty one is not two selection targets',
  );
});

// ---------------------------------------------------------------------------
// 2. A fixture that will not load is UNVERIFIED, never a crash
// ---------------------------------------------------------------------------

test('a fixture that will not load exits 2 and prints UNVERIFIED, not a stack trace', () => {
  const dir = scratch('qa-unloadable-');
  try {
    // A research document whose findings map a structure the names document
    // does not have: unusable, and unusable for a reason that is the fixture's
    // and not the build's.
    writeFileSync(join(dir, 'research.json'), `${JSON.stringify({
      version: 'broken-on-purpose-1',
      papers: [{ id: 'P-1', authors: ['Someone'], year: 2026, title: 'A paper' }],
      findings: [{
        id: 'F-1',
        paperId: 'P-1',
        statement: 'a finding',
        mappings: [{ structureId: 'NOT-IN-THE-INDEX', spatial: { kind: 'region-level' } }],
      }],
    }, null, 2)}\n`);
    writeFileSync(join(dir, 'names.json'), `${JSON.stringify({
      version: 'broken-on-purpose-index-1',
      structures: [{ id: 'S-1', name: 'a structure', source: 'FMA', cells: ['BD-T07-03O-4'] }],
    }, null, 2)}\n`);

    const run = spawnSync(process.execPath, [CLI, '--strict'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ATLAS_QA_RESEARCH_DIR: dir },
    });

    assert.equal(
      run.status,
      2,
      'exit 1 is "something failed"; a fixture this harness cannot read says nothing about the product, '
      + `which is what exit 2 is for. stdout: ${run.stdout}\nstderr: ${run.stderr}`,
    );
    const output = `${run.stdout}${run.stderr}`;
    assert.match(output, /UNVERIFIED/);
    assert.match(output, /nothing was measured/);
    assert.ok(
      !/^\s+at .*loadCuratedFrom/m.test(output),
      `a verdict, not a stack trace. Got: ${output}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('`tryResolveFixture` returns the reason rather than throwing it', () => {
  const dir = scratch('qa-unloadable-result-');
  try {
    writeFileSync(join(dir, 'research.json'), `${JSON.stringify({
      version: 'broken-2',
      papers: [{ id: 'P-1', authors: ['Someone'], year: 2026, title: 'A paper' }],
      findings: [{
        id: 'F-1',
        paperId: 'P-1',
        statement: 'a finding',
        mappings: [{ structureId: 'NOT-IN-THE-INDEX', spatial: { kind: 'region-level' } }],
      }],
    })}\n`);
    writeFileSync(join(dir, 'names.json'), `${JSON.stringify({
      version: 'broken-2-index',
      structures: [{ id: 'S-1', name: 'a structure', source: 'FMA', cells: ['BD-T07-03O-4'] }],
    })}\n`);

    // Re-imported in a child process rather than mutating this one's env,
    // because `RESEARCH_DATA_DIRS` is read at module load and every other case
    // in this file shares that module.
    const probe = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      'import { tryResolveFixture } from '
      + `${JSON.stringify(join(PACKAGE_ROOT, 'src', 'fixture.ts'))};`
      + 'const r = tryResolveFixture();'
      + 'console.log(JSON.stringify({ loaded: r.fixture !== null, why: r.why }));',
    ], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ATLAS_QA_RESEARCH_DIR: dir } });

    assert.equal(probe.status, 0, `the probe itself must not throw: ${probe.stderr}`);
    const result = JSON.parse(probe.stdout.trim()) as { loaded: boolean; why: string[] };
    assert.equal(result.loaded, false);
    assert.ok(
      result.why.some((w) => /could not be loaded, so nothing was measured/.test(w)),
      `the reason must travel with the refusal: ${JSON.stringify(result.why)}`,
    );
    assert.ok(
      result.why.some((w) => /NOT-IN-THE-INDEX/.test(w)),
      `and must name what was wrong with it: ${JSON.stringify(result.why)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. The real corpus, and which index answered
// ---------------------------------------------------------------------------

test('the 30-paper corpus loads at all — the regression this file was opened for', () => {
  const fixture = loadCuratedFixture();
  assert.ok(fixture, 'the curated corpus did not load; it is committed in packages/atlas-research/data');
  assert.equal(fixture.papers.length, 30, 'the curated seed set is thirty papers');
  assert.equal(
    fixture.papers.reduce((n, p) => n + p.findings.length, 0),
    120,
    'and a hundred and twenty findings',
  );
  assert.equal(fixture.source.kind, 'curated');
});

test('every structure the corpus maps is in the index it was adapted against', () => {
  const fixture = loadCuratedFixture();
  assert.ok(fixture);
  const known = new Set(fixture.structures.map((s) => s.id));
  const mapped = new Set(fixture.papers.flatMap((p) => p.findings.flatMap((f) => f.regions)));
  const unknown = [...mapped].filter((r) => !known.has(r));
  assert.deepEqual(
    unknown,
    [],
    'the research structure list must be the one the mappings were authored against. Replacing it '
    + 'wholesale with the 57-structure asset index — which carries no BV parcel at all — would make '
    + `${unknown.length} of the corpus's regions unknown and the whole fixture unusable.`,
  );
});

test('the crosswalked body structures are painted from the real asset index', () => {
  const fixture = loadCuratedFixture();
  assert.ok(fixture);
  assert.ok(fixture.anatomy, 'the asset index is committed in this tree, so it must be bound');
  assert.equal(fixture.oracle.paintedFromAssets.length, 14, 'fourteen ids appear in both indexes');
  for (const id of fixture.oracle.paintedFromAssets) {
    const s = fixture.structures.find((x) => x.id === id);
    assert.ok(s, `${id} is reported as painted but is not in the fixture`);
    assert.ok(s.cells.length > 0, `${id} is reported as painted and has no cells`);
    assert.ok(
      s.cells.every((c) => c.startsWith('BD-')),
      `${id} was painted from the BD asset index, so its cells are BD: ${JSON.stringify(s.cells.slice(0, 3))}`,
    );
    assert.equal(s.atlas, 'body', `${id} is a body structure; deriving the atlas from [] filed it under brain`);
  }
  assert.deepEqual(
    fixture.oracle.emptyCovering,
    [],
    'with the asset index bound, nothing the corpus maps is left unpainted',
  );
});

test('anatomical names resolve against the index the page binds, not the synthetic list', () => {
  const fixture = loadCuratedFixture();
  assert.ok(fixture);
  const assetNames = JSON.parse(readFileSync(ASSET_INDEX_PATHS.names, 'utf8')) as { version: string };
  const index = anatomyIndexInput(fixture);

  assert.equal(index.version, assetNames.version, 'the oracle must declare the ASSET index version');
  assert.notEqual(
    index.version,
    fixture.nameIndexVersion,
    'and it is a different document from the research dataset\'s own index',
  );
  assert.equal(index.structures.length, 57);
  assert.ok(
    index.structures.every((s) => s.cells.every((c) => c.startsWith('BD-'))),
    'the asset index is BD only; a BV cell here means a synthetic placeholder leaked into the oracle',
  );
  const ids = new Set(index.structures.map((s) => s.id));
  assert.ok(
    !ids.has('ATLAS-LABEL:coronary-artery'),
    'the placeholder body structures must NOT be in the anatomical oracle: the build has never heard '
    + 'of them, so clicking one would report the harness\'s choice of target as a product defect',
  );
});

test('the report says which cells were measured and which were invented', () => {
  const fixture = loadCuratedFixture();
  assert.ok(fixture);
  const notes = oracleNotes(fixture).join('\n');
  assert.match(notes, /the index the page binds/);
  assert.match(notes, /INVENTED/, 'a run against placeholder cells must say so next to its verdict');
  assert.equal(
    fixture.oracle.placeholderCells.length,
    66,
    'eighty research structures less the fourteen the asset index paints',
  );
});

test('the digest covers every document that answered, not half of them', () => {
  const fixture = loadCuratedFixture();
  assert.ok(fixture);
  const researchOnly = createHash('sha256')
    .update(
      `${readFileSync(join(REPO_ROOT, 'packages/atlas-research/data/research-seed.json'), 'utf8')}\0`
      + readFileSync(join(REPO_ROOT, 'packages/atlas-research/data/names-seed.json'), 'utf8'),
    )
    .digest('hex');
  assert.notEqual(
    fixture.source.sha256,
    researchOnly,
    'a pin over the research pair alone reads the same whether or not the real index painted anything, '
    + 'so two runs with materially different oracles would claim the same input',
  );
  assert.match(fixture.source.path, /atlas-assets\/labels\/names\.json/);
  assert.match(fixture.source.path, /atlas-assets\/labels\/coverings\.json/);
});

// ---------------------------------------------------------------------------
// The join itself: each refusal, against documents these cases construct
// ---------------------------------------------------------------------------

const JOIN_VERSION = 'join-case-index-1';
const namesDoc = (version = JOIN_VERSION) => ({
  version,
  structures: [{ id: 'X-1', name: 'a structure', source: 'FMA' }],
});
const coveringsDoc = (indexVersion = JOIN_VERSION) => ({
  indexVersion,
  frame: 'BD',
  coverings: [{ id: 'X-1', cells: ['BD-T07-03O-4'] }],
});

function writeJoinCase(files: Record<string, unknown>): { names: string; coverings: string } {
  const dir = scratch('qa-join-case-');
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }
  return { names: join(dir, 'names.json'), coverings: join(dir, 'coverings.json') };
}

test('the join needs both halves, and says which one is missing', () => {
  const onlyNames = writeJoinCase({ 'names.json': namesDoc() });
  const a = loadAnatomyIndex(onlyNames);
  assert.equal(a.index, null, 'names.json alone has no cells, so every structure would resolve empty');
  assert.ok(a.why.some((w) => /coverings\.json is not in this tree/.test(w)), JSON.stringify(a.why));

  const onlyCoverings = writeJoinCase({ 'coverings.json': coveringsDoc() });
  const b = loadAnatomyIndex(onlyCoverings);
  assert.equal(b.index, null, 'coverings.json alone has no terms, so nothing can be named');
  assert.ok(b.why.some((w) => /names\.json is not in this tree/.test(w)), JSON.stringify(b.why));
});

test('the two halves must describe the same index', () => {
  const paths = writeJoinCase({
    'names.json': namesDoc(),
    'coverings.json': coveringsDoc('a-different-index-2'),
  });
  const got = loadAnatomyIndex(paths);
  assert.equal(got.index, null);
  assert.ok(
    got.why.some((w) => /attach one index's cells to another index's terms/.test(w)),
    JSON.stringify(got.why),
  );
});

test('a covering nothing can name, and a term nothing paints, are both refused', () => {
  const extraCovering = writeJoinCase({
    'names.json': namesDoc(),
    'coverings.json': { ...coveringsDoc(), coverings: [...coveringsDoc().coverings, { id: 'X-2', cells: ['BD-T07-03O-5'] }] },
  });
  const a = loadAnatomyIndex(extraCovering);
  assert.equal(a.index, null);
  assert.ok(a.why.some((w) => /covering X-2 has no entry/.test(w)), JSON.stringify(a.why));

  const extraName = writeJoinCase({
    'names.json': { ...namesDoc(), structures: [...namesDoc().structures, { id: 'X-2', name: 'unpainted', source: 'FMA' }] },
    'coverings.json': coveringsDoc(),
  });
  const b = loadAnatomyIndex(extraName);
  assert.equal(b.index, null);
  assert.ok(b.why.some((w) => /X-2 has no covering/.test(w)), JSON.stringify(b.why));
});

test('a complete pair joins, and the result carries the version and the frame', () => {
  const paths = writeJoinCase({ 'names.json': namesDoc(), 'coverings.json': coveringsDoc() });
  const got = loadAnatomyIndex(paths);
  assert.ok(got.index, `the join refused a complete pair: ${JSON.stringify(got.why)}`);
  assert.equal(got.index.version, JOIN_VERSION);
  assert.equal(got.index.frame, 'BD');
  assert.deepEqual(got.index.structures, [
    { id: 'X-1', name: 'a structure', atlas: 'body', cells: ['BD-T07-03O-4'] },
  ]);
});

test('an absent asset package is reported, never thrown', () => {
  const got = loadAnatomyIndex({
    names: join(scratch('qa-absent-'), 'names.json'),
    coverings: join(scratch('qa-absent-'), 'coverings.json'),
  });
  assert.equal(got.index, null);
  assert.equal(got.why.length, 2, `both halves named as absent: ${JSON.stringify(got.why)}`);
});
