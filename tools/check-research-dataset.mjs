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
import { JUSTIFYING_STATUSES, renderCitationSummary } from './lib/citation-summary.mjs';
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

/** The citation audit's committed output. See tools/verify-research-citations.mjs. */
const CITATION_REPORT = 'data/citation-report.json';
const CITATION_SUMMARY = 'data/citation-report.md';

/**
 * Checks the committed dataset against the committed citation report, offline.
 *
 * This is the check that stops a hand-edit from quietly adding an accession,
 * which is exactly how the twelve invented UBERON ids got in before `b0d114a`
 * removed them. The rule it enforces is narrow and absolute: **no identifier
 * may exist in a dataset that this report does not justify from a named
 * source.** Not "looks plausible", not "the curator was confident" — a row, a
 * source id, and the metadata that source returned.
 *
 * A pure function of its arguments so `selfTest` can hand it deliberately
 * broken clones of the real artifacts and prove it goes red. A gate nobody has
 * watched fail is a gate nobody should trust.
 *
 * `coverageOf` is the dataset whose paper ids the report must cover EXACTLY —
 * the seed. Other datasets (the fixture) are subsets: their papers must each be
 * justified, but they do not have to account for every row.
 */
function auditCitationReport({ report, summaryMarkdown, datasets, coverageOf }) {
  const problems = [];
  const unverified = [];

  if (report?.schema !== 'citation-report/1') {
    problems.push(`${CITATION_REPORT}: expected schema "citation-report/1", got ${JSON.stringify(report?.schema)}.`);
    return { problems, unverified };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(report.retrievedOn ?? ''))) {
    problems.push(`${CITATION_REPORT}: retrievedOn must be an ISO date, got ${JSON.stringify(report.retrievedOn)}.`);
  }

  const sourceIds = new Set();
  const endpoints = [];
  for (const s of report.sources ?? []) {
    if (!s?.id || !s?.endpoint) problems.push(`${CITATION_REPORT}: a declared source is missing an id or endpoint.`);
    else {
      sourceIds.add(s.id);
      endpoints.push(...(Array.isArray(s.endpoints) && s.endpoints.length > 0 ? s.endpoints : [s.endpoint]));
    }
  }
  if (sourceIds.size === 0) problems.push(`${CITATION_REPORT}: declares no sources, so nothing in it can be attributed.`);

  const rows = Array.isArray(report.rows) ? report.rows : [];
  const byPaper = new Map();
  for (const r of rows) {
    if (byPaper.has(r.paperId)) problems.push(`${CITATION_REPORT}: duplicate row for ${r.paperId}.`);
    byPaper.set(r.paperId, r);
  }
  if (report.paperCount !== rows.length) {
    problems.push(`${CITATION_REPORT}: paperCount ${report.paperCount} but ${rows.length} rows.`);
  }

  // The tally is the number a reader quotes, so it must be the rows' tally and
  // not a stale literal left behind by an edit.
  const recomputed = {};
  for (const r of rows) recomputed[r.status] = (recomputed[r.status] ?? 0) + 1;
  for (const k of new Set([...Object.keys(recomputed), ...Object.keys(report.tally ?? {})])) {
    if ((report.tally ?? {})[k] !== recomputed[k]) {
      problems.push(
        `${CITATION_REPORT}: tally.${k} is ${JSON.stringify((report.tally ?? {})[k])} but ${recomputed[k] ?? 0} rows have that status.`,
      );
    }
  }

  // Per-row shape. A row is a point-in-time claim attributed to a named source;
  // without a date and an endpoint it is an assertion, which is the thing this
  // gate exists to refuse.
  for (const r of rows) {
    const where = `${CITATION_REPORT} row ${r.paperId}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.retrievedOn ?? ''))) {
      problems.push(`${where}: missing or malformed retrievedOn.`);
    }
    const queries = Array.isArray(r.queries) ? r.queries : [];
    if (queries.length === 0) problems.push(`${where}: records no query, so nothing supports its status.`);
    for (const q of queries) {
      if (!q?.endpoint) problems.push(`${where}: a query records no endpoint.`);
      else if (!endpoints.some((e) => q.endpoint.startsWith(e.split('?')[0]))) {
        problems.push(`${where}: query endpoint ${JSON.stringify(q.endpoint)} is not one of the declared sources.`);
      }
    }
    if (r.status === 'unverified') {
      unverified.push(`${r.paperId}: ${r.reason}`);
      continue;
    }
    if (!JUSTIFYING_STATUSES.has(r.status)) continue;

    // A justifying row must carry the metadata the source returned. A row that
    // only says "verified" is a verdict with no evidence under it.
    const returned = r.returned;
    if (!returned || typeof returned !== 'object' || Object.values(returned).every((v) => v === null)) {
      problems.push(`${where}: status ${r.status} but records no metadata returned by any source.`);
    }
    const ij = r.identifierJustified;
    if (!ij?.value || !ij?.kind) problems.push(`${where}: status ${r.status} but justifies no identifier.`);
    else if (!sourceIds.has(ij.source)) {
      problems.push(`${where}: attributes its identifier to ${JSON.stringify(ij.source)}, not a declared source.`);
    }
  }

  // Coverage: the seed's paper ids and the report's rows must be the same set.
  const cov = datasets.find((d) => d.id === coverageOf);
  if (!cov) problems.push(`internal: no dataset ${JSON.stringify(coverageOf)} to check coverage against.`);
  else {
    if (report.datasetVersion !== cov.version) {
      problems.push(
        `${CITATION_REPORT}: describes dataset version ${JSON.stringify(report.datasetVersion)} but ${cov.id}` +
          ` is ${JSON.stringify(cov.version)}. The report is stale — re-run tools/verify-research-citations.mjs.`,
      );
    }
    const ids = new Set(cov.papers.map((p) => p.id));
    const missing = [...ids].filter((id) => !byPaper.has(id));
    const extra = rows.map((r) => r.paperId).filter((id) => !ids.has(id));
    if (missing.length > 0) {
      problems.push(
        `${CITATION_REPORT}: ${missing.length} of ${ids.size} ${cov.id} papers have no row:`,
        ...missing.slice(0, 10).map((id) => `  ${id}`),
      );
    }
    if (extra.length > 0) {
      problems.push(`${CITATION_REPORT}: ${extra.length} rows name papers not in ${cov.id}: ${extra.slice(0, 10).join(', ')}.`);
    }
  }

  // The rule. Every identifier in every dataset must be justified, and an
  // identifier the report found must actually be in the dataset.
  for (const d of datasets) {
    for (const p of d.papers) {
      const row = byPaper.get(p.id);
      const asserted = p.identifier ?? { kind: 'none', value: null };
      if (asserted.kind === 'none') {
        // "The report found a DOI but the dataset says none" is a completeness
        // question, and it is only asked of the shipping dataset. A fixture
        // must stay free to assert the shapes it needs to test — the `kind:
        // "none"` rendering path among them — without being coupled to a live
        // bibliographic fact. The SAFETY direction below is not scoped: no
        // dataset may carry an identifier no source returned.
        if (d.id === coverageOf && row && JUSTIFYING_STATUSES.has(row.status)) {
          problems.push(
            `${d.id}: ${p.id} is recorded as kind "none", but the report resolved ` +
              `${row.identifierJustified?.value} for it. Adopt it (re-run the authoring script) or re-run the ` +
              `verifier — the dataset and the report disagree about what is known.`,
          );
        }
        continue;
      }
      if (!row) {
        problems.push(`${d.id}: ${p.id} carries identifier ${asserted.value} with NO row in ${CITATION_REPORT}.`);
        continue;
      }
      if (!JUSTIFYING_STATUSES.has(row.status)) {
        problems.push(
          `${d.id}: ${p.id} carries identifier ${asserted.value} but its report row is ${JSON.stringify(row.status)},` +
            ` which justifies nothing. ${row.reason ?? ''}`,
        );
        continue;
      }
      const justified = String(row.identifierJustified?.value ?? '').toLowerCase();
      if (justified !== String(asserted.value).toLowerCase()) {
        problems.push(
          `${d.id}: ${p.id} carries identifier ${JSON.stringify(asserted.value)} but the report justifies` +
            ` ${JSON.stringify(row.identifierJustified?.value)}. An identifier no named source returned.`,
        );
      }
      if (row.identifierJustified?.kind !== asserted.kind) {
        problems.push(
          `${d.id}: ${p.id} identifier kind ${JSON.stringify(asserted.kind)} but the report justifies kind` +
            ` ${JSON.stringify(row.identifierJustified?.kind)}.`,
        );
      }
    }
  }

  // The markdown is a pure function of the JSON, so drift is detectable.
  if (typeof summaryMarkdown === 'string' && summaryMarkdown !== renderCitationSummary(report)) {
    problems.push(
      `${CITATION_SUMMARY}: does not match what tools/lib/citation-summary.mjs renders from` +
        ` ${CITATION_REPORT}. It was hand-edited, or the data changed without regenerating it.`,
    );
  }

  return { problems, unverified };
}

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

/**
 * Deliberate breakage for the citation gate, against clones of the REAL report
 * and the REAL seed — not a toy pair. Each case is a way the rule could be
 * defeated by hand, and each must be detected.
 */
function citationSelfTest() {
  const failures = [];
  const report = readJson(CITATION_REPORT);
  const seed = readJson('data/research-seed.json');
  const summary = readFileSync(join(PKG, CITATION_SUMMARY), 'utf8');
  const dsOf = (raw) => [{ id: 'seed', papers: raw.papers, version: raw.version }];

  const expectRed = (label, mutate) => {
    const r = structuredClone(report);
    const s = structuredClone(seed);
    const md = mutate(r, s);
    const { problems } = auditCitationReport({
      report: r,
      summaryMarkdown: md ?? renderCitationSummary(r),
      datasets: dsOf(s),
      coverageOf: 'seed',
    });
    if (problems.length === 0) failures.push(`${label}: the gate did not notice.`);
  };

  // The baseline must be green, or every case below proves nothing.
  {
    const { problems } = auditCitationReport({
      report,
      summaryMarkdown: summary,
      datasets: dsOf(seed),
      coverageOf: 'seed',
    });
    if (problems.length > 0) {
      failures.push(`the committed artifacts do not pass their own audit: ${problems[0]}`);
    }
  }

  // 1. An identifier appears on a paper the report leaves unresolved. This is
  //    the invented-accession case, and the whole reason the gate exists.
  expectRed('an invented identifier on an unresolved paper', (r, s) => {
    const row = r.rows.find((x) => x.status === 'unresolved');
    const paper = s.papers.find((p) => p.id === row.paperId);
    paper.identifier = { kind: 'doi', value: '10.9999/invented' };
  });

  // 2. An identifier silently changed to a different DOI the report never saw.
  expectRed('an identifier swapped for one no source returned', (r, s) => {
    const paper = s.papers.find((p) => p.identifier.kind === 'doi');
    paper.identifier = { kind: 'doi', value: '10.1038/not-the-one-returned' };
  });

  // 3. A row deleted, so a real identifier loses its justification.
  expectRed('a dropped row leaving an identifier unjustified', (r) => {
    r.rows.splice(
      r.rows.findIndex((x) => x.status === 'verified'),
      1,
    );
    // Keep the bookkeeping self-consistent, so the only thing wrong is the
    // missing row. Otherwise this case would pass for the wrong reason — a
    // tally mismatch — and prove nothing about coverage.
    r.paperCount = r.rows.length;
    r.tally = r.rows.reduce((a, x) => ({ ...a, [x.status]: (a[x.status] ?? 0) + 1 }), {});
  });

  // 4. A fabricated row: the verdict with no evidence under it.
  expectRed('a verified row carrying no returned metadata', (r) => {
    const row = r.rows.find((x) => x.status === 'verified');
    row.returned = null;
  });

  // 5. A row attributed to a source the report does not declare.
  expectRed('an identifier attributed to an undeclared source', (r) => {
    r.rows.find((x) => x.identifierJustified).identifierJustified.source = 'vibes';
  });

  // 6. A stale report, still describing an older dataset version.
  expectRed('a report describing a different dataset version', (r) => {
    r.datasetVersion = 'research-seed-1999.1.1';
  });

  // 7. A hand-edited tally, which is the number a reader quotes.
  expectRed('a tally that disagrees with the rows', (r) => {
    r.tally = { ...r.tally, verified: (r.tally.verified ?? 0) + 7 };
  });

  // 8. A hand-edited summary, claiming something the data does not say.
  expectRed('a summary edited away from its data', (r) => {
    return `${renderCitationSummary(r)}\n\nAll 30 papers were independently verified by a human.\n`;
  });

  return failures;
}

const selfTestFailures = [...selfTest(), ...citationSelfTest()];
if (selfTestFailures.length > 0) {
  problems.push('the gate itself cannot detect the failures it exists for:', ...selfTestFailures.map((f) => `  ${f}`));
} else {
  report.push(
    'self-test: the gate goes red on a hostile link and on an unknown structure id,',
    '  and on all eight ways to defeat the citation rule — an invented identifier, a swapped one,',
    '  a dropped row, a verdict with no evidence, an undeclared source, a stale report version,',
    '  a hand-edited tally and a hand-edited summary.',
  );
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
    `  identifiers recorded: ${withIdentifier}/${dataset.papers.length}, each justified by a named source in ${CITATION_REPORT}`,
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
// 5. Every identifier is justified by a named source in the citation report.
// ---------------------------------------------------------------------------

{
  const citationReport = readJson(CITATION_REPORT);
  const summaryMarkdown = readFileSync(join(PKG, CITATION_SUMMARY), 'utf8');
  const audited = resolved.map(({ spec, dataset }) => ({
    id: spec.id,
    papers: dataset.papers,
    version: dataset.version,
  }));

  const { problems: citationProblems, unverified } = auditCitationReport({
    report: citationReport,
    summaryMarkdown,
    datasets: audited,
    coverageOf: 'seed',
  });

  if (citationProblems.length > 0) problems.push(...citationProblems);
  else {
    const justified = citationReport.rows.filter((r) => r.identifierJustified).length;
    const none = citationReport.rows.length - justified;
    report.push(
      `citations: all ${citationReport.rows.length} seed papers have a row in ${CITATION_REPORT}` +
        ` (retrieved ${citationReport.retrievedOn}); ${JSON.stringify(citationReport.tally)}.`,
      `  ${justified} identifiers each justified by a named source; ${none} papers carry none.`,
      `  no dataset carries an identifier this report does not justify — checked, not asserted.`,
    );
  }

  // Rows that could not be checked are reported, never counted as verified and
  // never allowed to read as a clean absence. They do not fail the build: the
  // network is not this gate's dependency to guarantee. An identifier sitting
  // on an unverified row is a different matter and fails above, because then
  // nothing justifies it.
  if (unverified.length > 0) {
    report.push(
      `UNVERIFIED: ${unverified.length} citation${unverified.length === 1 ? '' : 's'} could not be checked when the`,
      '  report was generated. This is not evidence the citations are bad — it is the absence of a',
      '  check. Re-run `node tools/verify-research-citations.mjs` with network access.',
      ...unverified.map((u) => `    ${u}`),
    );
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
