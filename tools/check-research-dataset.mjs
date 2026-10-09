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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT, fail, pass, rel } from './lib/repo.mjs';
import { JUSTIFYING_STATUSES, renderCitationSummary } from './lib/citation-summary.mjs';
import { buildNameIndex } from '../packages/alc/src/index.ts';
import { buildResearchIndex, loadDataset, validateDataset } from '../packages/atlas-research/src/index.ts';

const PKG = join(REPO_ROOT, 'packages', 'atlas-research');

/**
 * Where the asset pipeline may publish the two halves of the real index.
 *
 * Several candidates on purpose: the exact path is the pipeline's decision
 * rather than this gate's. But the list is NOT a priority order and the gate
 * does not take the first path that exists — see `loadRealIndex`. It takes the
 * file whose *shape* it can read, because the two halves are different
 * documents with similar names:
 *
 *   names.json      `version` + `structures[]`   ids, terms, cross-references
 *   coverings.json  `indexVersion` + `coverings[]`   the cells per id
 *
 * Binding by path order was a latent bug with two distinct failure modes, and
 * both of them look like a working gate from the outside:
 *
 *   - `coverings.json` first: `buildNameIndex({ version: undefined, ... })`
 *     throws `bad_index_version` out of the middle of the gate. A stack trace
 *     is not a gate result.
 *   - `names.json` alone: it carries no `cells` at all, so every structure
 *     builds with an EMPTY covering and every mapping resolves
 *     `empty-covering`. That reads as "the curation is wrong" when what is
 *     actually wrong is that the gate was handed half an index.
 *
 * So the real index is the JOIN of the two, by `id`, and a half is reported as
 * UNVERIFIED rather than measured. `names.json` says so itself: "Load with
 * buildNameIndex({ version, structures }) after joining coverings.json by id."
 */
const REAL_INDEX_CANDIDATES = [
  'packages/atlas-assets/labels/names.json',
  'packages/atlas-assets/labels/coverings.json',
  'packages/atlas-assets/templates/names.json',
  'packages/atlas-assets/templates/coverings.json',
  'packages/atlas-web/dist/data/names.json',
  'packages/atlas-web/dist/data/coverings.json',
];

/** Where a real `TemplateSet` may be published. See `loadTemplates`. */
const TEMPLATE_DIR = 'packages/atlas-assets/templates';

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

// ---------------------------------------------------------------------------
// The real index: found by shape, built by joining the two halves.
// ---------------------------------------------------------------------------

/** `version` + `structures[]`: the half that carries ids and terms. */
const isNameIndexShape = (raw) => typeof raw?.version === 'string' && Array.isArray(raw?.structures);

/** `indexVersion` + `coverings[]`: the half that carries the cells. */
const isCoveringIndexShape = (raw) => typeof raw?.indexVersion === 'string' && Array.isArray(raw?.coverings);

/**
 * Build the real name index from whichever candidate files are present.
 *
 * Returns `{ index, names, coverings, frame }` when both halves are present and
 * agree, or `{ index: null, why: [...] }` with the reason it could not be built.
 * **Never throws for an absent or wrong-shaped file**, because "the index is not
 * here yet" and "the index is broken" are different reports and only the second
 * one is this gate's business to fail on.
 *
 * `paths` is injectable so `realIndexSelfTest` can prove the shape detection on
 * fixtures it constructs, rather than on whatever happens to be in the tree.
 */
function loadRealIndex(paths = REAL_INDEX_CANDIDATES.map((p) => join(REPO_ROOT, p))) {
  const found = { names: [], coverings: [], unreadable: [] };

  for (const path of paths) {
    if (!existsSync(path)) continue;
    let raw;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      found.unreadable.push(`${rel(path)}: not JSON (${e.message})`);
      continue;
    }
    if (isNameIndexShape(raw)) found.names.push({ path, raw });
    else if (isCoveringIndexShape(raw)) found.coverings.push({ path, raw });
    else {
      found.unreadable.push(
        `${rel(path)}: neither a name index (version + structures[]) nor a covering index (indexVersion + coverings[])`,
      );
    }
  }

  const why = [...found.unreadable];
  if (found.names.length === 0 && found.coverings.length === 0) {
    return { index: null, why: ['no name index and no covering index are present.'] };
  }
  if (found.names.length === 0) {
    return {
      index: null,
      why: [
        ...why,
        `found a covering index (${found.coverings.map((c) => rel(c.path)).join(', ')}) but no name index.`,
        '  A covering index carries `indexVersion` and `coverings` — the cells, with no terms. It cannot be',
        '  built into a NameIndex on its own, and feeding it to buildNameIndex() would throw rather than report.',
      ],
    };
  }
  if (found.coverings.length === 0) {
    return {
      index: null,
      why: [
        ...why,
        `found a name index (${found.names.map((n) => rel(n.path)).join(', ')}) but no covering index.`,
        '  A name index carries ids and terms but NO cells, so building from it alone would give every',
        '  structure an empty covering and report every mapping as `empty-covering`. That is a false',
        '  negative dressed as a curation error, so it is refused rather than measured.',
      ],
    };
  }
  if (found.names.length > 1 || found.coverings.length > 1) {
    return {
      index: null,
      why: [
        ...why,
        'more than one index of the same shape is present, so which one the dataset was authored against is ambiguous:',
        ...found.names.map((n) => `    name index:     ${rel(n.path)}`),
        ...found.coverings.map((c) => `    covering index: ${rel(c.path)}`),
      ],
    };
  }

  const names = found.names[0];
  const coverings = found.coverings[0];
  if (coverings.raw.indexVersion !== names.raw.version) {
    return {
      index: null,
      why: [
        ...why,
        `the two halves describe different indexes: ${rel(names.path)} is version` +
          ` ${JSON.stringify(names.raw.version)} but ${rel(coverings.path)} declares indexVersion` +
          ` ${JSON.stringify(coverings.raw.indexVersion)}.`,
        '  Joining them would attach one index\'s cells to another index\'s terms.',
      ],
    };
  }

  // The join. Both directions are checked: a term with no cells would resolve
  // empty, and cells with no term would be geometry nothing can name.
  const cellsById = new Map();
  for (const c of coverings.raw.coverings ?? []) {
    if (typeof c?.id !== 'string') {
      why.push(`${rel(coverings.path)}: a covering entry has no id.`);
      continue;
    }
    if (cellsById.has(c.id)) why.push(`${rel(coverings.path)}: duplicate covering for ${c.id}.`);
    cellsById.set(c.id, Array.isArray(c.cells) ? c.cells : []);
  }

  const structures = [];
  const unnamed = new Set(cellsById.keys());
  for (const s of names.raw.structures) {
    if (typeof s?.id !== 'string') {
      why.push(`${rel(names.path)}: a structure entry has no id.`);
      continue;
    }
    unnamed.delete(s.id);
    if (!cellsById.has(s.id)) {
      why.push(`${rel(names.path)}: structure ${s.id} ("${s.name}") has no covering in ${rel(coverings.path)}.`);
      continue;
    }
    structures.push({ id: s.id, name: s.name, source: s.source, cells: cellsById.get(s.id) });
  }
  for (const id of unnamed) {
    why.push(`${rel(coverings.path)}: covering ${id} has no entry in ${rel(names.path)}, so nothing can name it.`);
  }

  if (why.length > 0) return { index: null, why };

  let index;
  try {
    index = buildNameIndex({ version: names.raw.version, structures });
  } catch (e) {
    return { index: null, why: [`the joined index did not build: ${e.message}`] };
  }
  return {
    index,
    names: rel(names.path),
    coverings: rel(coverings.path),
    frame: coverings.raw.frame ?? null,
  };
}

/**
 * The real `TemplateSet`, if the asset pipeline has published one.
 *
 * Read as plain JSON data: this is CI tooling, not a shipped package, so
 * reading an asset file here is not a dependency of our code on an asset
 * licence — the same reasoning `tools/audit-real-template.mjs` records, and the
 * boundary `tools/check-licence-separation.mjs` enforces for the packages.
 */
function loadTemplates(dir = join(REPO_ROOT, TEMPLATE_DIR)) {
  const templates = {};
  const sources = {};
  const problems = [];
  if (!existsSync(dir)) return { templates, sources, problems };
  for (const file of readdirSync(dir).sort()) {
    const slot = file.endsWith('.body.json') ? 'body' : file.endsWith('.brain-volume.json') ? 'brainVolume' : null;
    if (slot === null) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (templates[slot] === undefined) {
        templates[slot] = raw;
        sources[slot] = `${TEMPLATE_DIR}/${file}`;
      }
    } catch (e) {
      problems.push(`${TEMPLATE_DIR}/${file}: not readable as a template (${e.message}).`);
    }
  }
  return { templates, sources, problems };
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

  // A dataset naming a structure the index does not have must report it. The
  // id keeps its own namespace: `structureIdSource` is cross-checked against
  // the prefix now, and a dataset wrong in two ways would be refused for the
  // other one and prove nothing about resolution.
  const badStructure = structuredClone(base);
  const victim = badStructure.findings[0].mappings[0];
  victim.structureId = `${victim.structureIdSource}:not-a-real-structure`;
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
 * Proves the gate binds the real index by SHAPE, not by path order.
 *
 * Hermetic on purpose: every case writes its own pair of files to a temp
 * directory, so these run — and can fail — on a branch where the asset
 * pipeline's index is nowhere in the tree. A must-pass case that only
 * exercises itself once the dependency lands is a case nobody has run.
 *
 * The first case is the one the latent bug would have failed: `coverings.json`
 * listed FIRST, which is the order the real candidate list used to have.
 */
function realIndexSelfTest() {
  const failures = [];
  const dir = mkdtempSync(join(tmpdir(), 'research-gate-index-'));
  const write = (name, value) => {
    const path = join(dir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  };

  const VERSION = 'self-test-index-1';
  const namesDoc = (version = VERSION) => ({
    version,
    structures: [{ id: 'FMA9968', name: 'seventh thoracic vertebra', source: 'FMA' }],
  });
  const coveringsDoc = (indexVersion = VERSION) => ({
    indexVersion,
    frame: 'BD',
    coverings: [{ id: 'FMA9968', cells: ['BD-T07-05I-5', 'BD-T07-12I-2'] }],
  });

  try {
    // 1. The must-pass case. Both halves present, the unreadable shape first.
    {
      const coverings = write('coverings.json', coveringsDoc());
      const names = write('names.json', namesDoc());
      const got = loadRealIndex([coverings, names]);
      if (got.index === null) {
        failures.push(`both halves present but no index was built: ${(got.why ?? []).join(' ')}`);
      } else if (got.index.version !== VERSION) {
        failures.push(`the joined index took its version from the wrong half: ${JSON.stringify(got.index.version)}.`);
      } else if (got.index.structures.length !== 1 || got.index.structures[0].id !== 'FMA9968') {
        failures.push('the joined index did not carry the name half\'s structures.');
      } else if (got.index.coverings[0].cells.length === 0) {
        failures.push(
          'the joined index carried a structure with no cells, so the covering half was not joined in. ' +
            'This is the false negative the shape detection exists to prevent.',
        );
      }
    }

    // 2. The covering half alone: reported, not thrown. buildNameIndex() would
    //    have raised `bad_index_version` from the middle of the gate.
    {
      const got = loadRealIndex([write('coverings.json', coveringsDoc())]);
      if (got.index !== null) failures.push('a covering index alone produced an index; it carries no terms.');
      else if (!(got.why ?? []).some((l) => /no name index/.test(l))) {
        failures.push(`the covering-half-only reason does not say a name index is missing: ${(got.why ?? [])[0]}`);
      }
    }

    // 3. The name half alone. This is the quiet one: it builds without error and
    //    every structure resolves empty, which reads as bad curation.
    {
      const got = loadRealIndex([write('names.json', namesDoc())]);
      if (got.index !== null) failures.push('a name index alone produced an index; it carries no cells.');
      else if (!(got.why ?? []).some((l) => /no covering index/.test(l))) {
        failures.push(`the name-half-only reason does not say a covering index is missing: ${(got.why ?? [])[0]}`);
      }
    }

    // 4. Two halves of different indexes must never be joined.
    {
      const got = loadRealIndex([
        write('names.json', namesDoc()),
        write('coverings.json', coveringsDoc('a-different-index-2')),
      ]);
      if (got.index !== null) failures.push('two halves with different versions were joined anyway.');
    }

    // 5. A term with no cells, and cells nothing can name. Both are index bugs
    //    rather than curation bugs, and both must stop the measurement.
    {
      const names = namesDoc();
      names.structures.push({ id: 'FMA7197', name: 'liver', source: 'FMA' });
      const got = loadRealIndex([write('names.json', names), write('coverings.json', coveringsDoc())]);
      if (got.index !== null) failures.push('a structure with no covering was indexed as if it had one.');
    }
    {
      const coverings = coveringsDoc();
      coverings.coverings.push({ id: 'FMA7197', cells: ['BD-T10-10O-1'] });
      const got = loadRealIndex([write('names.json', namesDoc()), write('coverings.json', coverings)]);
      if (got.index !== null) failures.push('a covering with no name was indexed as if something named it.');
    }

    // 6. Nothing present at all is the ordinary pre-landing state: no index, no
    //    complaint about broken files.
    {
      const got = loadRealIndex([join(dir, 'absent.json')]);
      if (got.index !== null) failures.push('an index was built from no files at all.');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
  const onDisk = readJson(CITATION_REPORT);
  const dsOf = (raw) => [{ id: 'seed', papers: raw.papers, version: raw.version }];

  /**
   * A report and dataset that agree with each other BY CONSTRUCTION.
   *
   * The shape is the real report's — same sources, same row fields, same
   * endpoints — so the cases below exercise realistic input. But the dataset is
   * synthesised from the rows, and the tally and summary are recomputed, so the
   * pair is internally consistent no matter what state the working tree is in.
   *
   * That independence is the point. An earlier version used the committed
   * artifacts directly and asserted they audit clean, which coupled this
   * self-test to the tree: `tools/verify-gates.mjs` mutates these very files on
   * purpose, and any mid-edit dataset would make the gate announce "the gate
   * itself cannot detect the failures it exists for" — accusing the gate of
   * being inert when the data was simply half-written, and sending the reader
   * to the wrong file. Whether the COMMITTED artifacts are consistent is the
   * main check's job, and it reports that in its own words.
   */
  const consistentPair = () => {
    const report = structuredClone(onDisk);
    report.paperCount = report.rows.length;
    report.tally = report.rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
    const seed = {
      version: report.datasetVersion,
      papers: report.rows.map((r) => ({
        id: r.paperId,
        identifier:
          JUSTIFYING_STATUSES.has(r.status) && r.identifierJustified
            ? { kind: r.identifierJustified.kind, value: r.identifierJustified.value }
            : { kind: 'none', value: null },
      })),
    };
    return { report, seed };
  };

  // The baseline is green by construction. If it is not, the audit function
  // itself is wrong, and that is worth saying before any case below is trusted.
  {
    const { report, seed } = consistentPair();
    const { problems } = auditCitationReport({
      report,
      summaryMarkdown: renderCitationSummary(report),
      datasets: dsOf(seed),
      coverageOf: 'seed',
    });
    if (problems.length > 0) {
      failures.push(`a report and dataset that agree by construction did not audit clean: ${problems[0]}`);
    }
  }

  const expectRed = (label, mutate) => {
    const { report, seed } = consistentPair();
    const md = mutate(report, seed);
    const { problems } = auditCitationReport({
      report,
      summaryMarkdown: md ?? renderCitationSummary(report),
      datasets: dsOf(seed),
      coverageOf: 'seed',
    });
    if (problems.length === 0) failures.push(`${label}: the gate did not notice.`);
  };

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

const selfTestFailures = [...selfTest(), ...citationSelfTest(), ...realIndexSelfTest()];
if (selfTestFailures.length > 0) {
  problems.push('the gate itself cannot detect the failures it exists for:', ...selfTestFailures.map((f) => `  ${f}`));
} else {
  report.push(
    'self-test: the gate goes red on a hostile link and on an unknown structure id,',
    '  and on all eight ways to defeat the citation rule — an invented identifier, a swapped one,',
    '  a dropped row, a verdict with no evidence, an undeclared source, a stale report version,',
    '  a hand-edited tally and a hand-edited summary.',
    '  It also binds the real index by shape rather than by path order: a covering index listed',
    '  first is joined, not mistaken for a name index, and half an index is reported, not measured.',
  );
}

// ---------------------------------------------------------------------------
// 1 and 2. Load, then resolve against the declared index.
// ---------------------------------------------------------------------------

const resolved = [];

/** The real index and the real templates, looked for once. */
const real = loadRealIndex();
const { templates, sources: templateSources, problems: templateProblems } = loadTemplates();
problems.push(...templateProblems);
const strictGeometry = process.argv.includes('--strict-geometry');

if (real.index === null) {
  const message = [
    "UNVERIFIED: the asset pipeline's index could not be built, so nothing below has been",
    '  checked against real geometry:',
    ...real.why.map((l) => `    ${l}`),
    '  Looked in:',
    ...REAL_INDEX_CANDIDATES.map((p) => `    ${p}`),
    '  Reported rather than failed on purpose: a red build for a dependency this branch',
    '  cannot satisfy would be ignored, and a real failure would then be invisible inside',
    '  it. Run with --strict-geometry once the index is expected to exist.',
  ];
  if (strictGeometry) problems.push(...message.map((l) => l.replace(/^UNVERIFIED/, 'FAILED')));
  else report.push(...message);
} else {
  report.push(
    `real index: ${real.index.structures.length} structures, frame ${real.frame ?? 'unstated'}, version ${real.index.version}`,
    `  joined from ${real.names} and ${real.coverings}`,
  );
}
if (Object.keys(templateSources).length > 0) {
  report.push(
    `templates: ${Object.entries(templateSources)
      .map(([slot, path]) => `${slot} <- ${path}`)
      .join(', ')}`,
  );
}

/**
 * The partition verdict, for one partition of one dataset.
 *
 * A `real` partition must resolve, strictly, and a `cells` mapping in one must
 * lie wholly inside the structure it is filed under — which is the only form in
 * which "re-check the sub-regions against real geometry" is a check rather than
 * a claim.
 *
 * A `placeholder` partition is checked in BOTH directions, and the second one
 * is the point. Its ids must resolve against the placeholder index, so a
 * mistyped id is still caught. And they must **not** resolve against the real
 * index, because the recorded reason says no cleared index can name them: the
 * day one can, that reason has expired and the mapping is owed a crosswalk. A
 * gate that cannot measure must not fail, and must not silently pass either.
 */
function checkPartition({ label, part, index, where, isReal }) {
  const ids = new Set(part.structureIds);
  const mine = index.mappings.filter((m) => ids.has(m.structureId));
  const nonCoordinate = mine.filter((m) => m.precision !== 'coordinates');
  const bad = nonCoordinate.filter((m) => m.resolution !== 'resolved');

  if (part.status === 'real') {
    if (bad.length > 0) {
      problems.push(
        `${label}: partition ${part.id} declares status "real" but ${bad.length} of` +
          ` ${nonCoordinate.length} of its non-coordinate mappings do not resolve against` +
          ` ${where} (version ${index.nameIndexVersion}).`,
      );
      for (const m of bad.slice(0, 15)) problems.push(`  ${m.mappingId} (${m.structureId}): ${m.unresolvedReason}`);
      return;
    }
    // Sub-regions, re-checked. `dataset.ts` records the disagreement as a note
    // rather than trimming the covering; in a `real` partition that note is a
    // failure, because the cells were authored FROM this index.
    const strays = mine.filter(
      (m) => m.precision === 'cells' && m.notes.some((n) => /lie inside|entirely outside/.test(n)),
    );
    if (strays.length > 0) {
      problems.push(
        `${label}: partition ${part.id} has ${strays.length} curated sub-region(s) that do not lie wholly` +
          ` inside the structure they are filed under, in ${where}:`,
      );
      for (const m of strays) problems.push(`  ${m.mappingId}: ${m.notes.join('; ')}`);
      return;
    }
    const subRegions = mine.filter((m) => m.precision === 'cells').length;
    report.push(
      `  ${part.id}: all ${nonCoordinate.length} non-coordinate mappings resolve against ${where}` +
        `${subRegions > 0 ? `, and all ${subRegions} curated sub-region(s) lie wholly inside their structure` : ''}.`,
    );
    return;
  }

  if (bad.length > 0) {
    problems.push(
      `${label}: partition ${part.id} has ${bad.length} of ${nonCoordinate.length} mappings that do not` +
        ` resolve against the index it declares (${where}).`,
    );
    for (const m of bad.slice(0, 10)) problems.push(`  ${m.mappingId} (${m.structureId}): ${m.unresolvedReason}`);
    return;
  }
  if (isReal) return; // the second direction is checked by the caller, once
  report.push(
    `  ${part.id}: ${nonCoordinate.length} mapping(s) on declared placeholders, resolved against ${where}.`,
    `    recorded reason: ${part.reason}`,
  );
}

for (const spec of DATASETS) {
  const label = `${spec.id} (${spec.data})`;
  let dataset;
  try {
    dataset = loadDataset(readJson(spec.data));
  } catch (e) {
    problems.push(`${label}: did not load.`, ...String(e.message).split('\n').map((l) => `  ${l}`));
    continue;
  }

  const declared = indexFrom(readJson(spec.names));
  const available = new Map([[declared.version, { index: declared, where: spec.names }]]);
  if (real.index !== null) {
    available.set(real.index.version, { index: real.index, where: `${real.names} + ${real.coverings}` });
  }

  /** Resolutions are cached: `coveringIntersect` is quadratic and this is CI. */
  const indexes = new Map();
  const resolveAgainst = (names) => {
    if (!indexes.has(names.version)) indexes.set(names.version, buildResearchIndex({ dataset, names, templates }));
    return indexes.get(names.version);
  };

  const partitions = dataset.authoredAgainst.partitions ?? null;
  const index = resolveAgainst(declared);
  const mappings = index.mappings;
  const byPrecision = {};
  for (const m of mappings) byPrecision[m.precision] = (byPrecision[m.precision] ?? 0) + 1;

  // Citation honesty, as a number rather than an impression.
  const withIdentifier = dataset.papers.filter((p) => p.identifier.kind !== 'none').length;
  const locatorRecorded = mappings.filter((m) => m.evidence.locatorStatus === 'recorded').length;
  const inferred = mappings.filter((m) => m.provenance.basis === 'curator-inference').length;
  report.push(
    `${spec.id}: ${dataset.papers.length} papers, ${dataset.findings.length} findings, ` +
      `${mappings.length} mappings ${JSON.stringify(byPrecision)} — ${spec.note}`,
    `  identifiers recorded: ${withIdentifier}/${dataset.papers.length}, each justified by a named source in ${CITATION_REPORT}`,
    `  evidence locators recorded: ${locatorRecorded}/${mappings.length}; curator inferences: ${inferred} (each with a note, enforced at load)`,
  );

  if (partitions === null) {
    // One index names the whole dataset. The one-sided bound, as before:
    // anything other than a coordinates mapping must resolve.
    if (declared.version !== dataset.authoredAgainst.nameIndexVersion) {
      // Not cosmetic: a resolution is only reproducible against the index it
      // was authored for, and every browse result pins both versions.
      problems.push(
        `${label}: declares nameIndexVersion ${JSON.stringify(dataset.authoredAgainst.nameIndexVersion)}` +
          ` but ${spec.names} is version ${JSON.stringify(declared.version)}.`,
      );
      continue;
    }
    const mustResolve = mappings.filter((m) => m.precision !== 'coordinates');
    const bad = mustResolve.filter((m) => m.resolution !== 'resolved');
    if (bad.length > 0) {
      problems.push(`${label}: ${bad.length} of ${mustResolve.length} non-coordinate mappings did not resolve.`);
      for (const m of bad.slice(0, 10)) {
        problems.push(`  ${m.mappingId}: ${m.unresolvedReason} — ${m.notes.join('; ')}`);
      }
    } else {
      report.push(
        `  resolved against ${declared.version}: ${mustResolve.length}/${mustResolve.length} non-coordinate mappings`,
      );
    }
  } else {
    // An index shipped beside the dataset that no partition claims is an index
    // nothing resolves through — a leftover, and the kind that gets loaded by
    // a consumer anyway.
    if (!partitions.some((p) => p.nameIndexVersion === declared.version)) {
      problems.push(
        `${label}: ships ${spec.names} (version ${JSON.stringify(declared.version)}) but no partition` +
          ' declares that version, so nothing resolves through it.',
      );
    }

    for (const part of partitions) {
      const bound = available.get(part.nameIndexVersion);
      if (bound === undefined) {
        const message = [
          `UNVERIFIED: ${label}: partition ${part.id} (status ${part.status}) declares index` +
            ` ${JSON.stringify(part.nameIndexVersion)}, which is not present in this tree.`,
          `  ${part.structureIds.length} structure(s) in it have not been checked against the index they name.`,
        ];
        if (strictGeometry) problems.push(...message.map((l) => l.replace(/^UNVERIFIED/, 'FAILED')));
        else report.push(...message);
        continue;
      }
      checkPartition({
        label,
        part,
        index: resolveAgainst(bound.index),
        where: bound.where,
        isReal: false,
      });

      // The second direction, for placeholders only, and only when there is a
      // real index to be wrong about.
      //
      // The predicate is "the index can NAME it", not "the mapping resolved".
      // Those come apart for a `cells` mapping, which resolves from its own
      // curated cells whether or not anything knows the structure they are
      // filed under — so resolution here would report every curated sub-region
      // as a crosswalk waiting to happen. `structureLabelFromIndex` is the
      // claim that actually expires the recorded reason.
      if (part.status === 'placeholder' && real.index !== null && real.index.version !== part.nameIndexVersion) {
        const ids = new Set(part.structureIds);
        const nowNamed = resolveAgainst(real.index)
          .mappings.filter((m) => ids.has(m.structureId))
          .filter((m) => m.structureLabelFromIndex);
        if (nowNamed.length > 0) {
          problems.push(
            `${label}: partition ${part.id} is declared a placeholder, but the real index NAMES` +
              ` ${nowNamed.length} of its structures (${real.names}, version ${real.index.version}).`,
            '  The recorded reason has expired. Crosswalk them and move them to a `real` partition —',
            '  a placeholder that a cleared index can name is a mapping pointing at a label instead of',
            '  at the structure the label names.',
            ...nowNamed.slice(0, 10).map((m) => `    ${m.mappingId} (${m.structureId}) -> ${m.structureLabel}`),
          );
        }
      }
    }

    // Coordinates are a separate contract: they are placed by a TEMPLATE, not
    // named by an index, and in this dataset they are BV — where there is no
    // name index at all. So the check is two-sided in a different way: the
    // geometry must resolve once a template exists, and the name must NOT.
    const coordinates = mappings.filter((m) => m.precision === 'coordinates');
    if (coordinates.length > 0) {
      const frames = new Set(dataset.findings.flatMap((f) => f.mappings).filter((m) => m.spatial.kind === 'coordinates').map((m) => m.spatial.frame));
      const haveAll = [...frames].every((f) => (f === 'BD' ? templates.body : templates.brainVolume) !== undefined);
      if (!haveAll) {
        const message = [
          `UNVERIFIED: ${spec.id}: ${coordinates.length} coordinate mapping(s) in frame(s)` +
            ` ${[...frames].join(', ')} have no template to place them.`,
          '  Not shown as region-level and not resolved: a locus we cannot place is a different claim',
          `  from a region. Publish a template under ${TEMPLATE_DIR}/ and this starts checking.`,
        ];
        if (strictGeometry) problems.push(...message.map((l) => l.replace(/^UNVERIFIED/, 'FAILED')));
        else report.push(...message);
      } else {
        const stuck = coordinates.filter((m) => m.resolution !== 'resolved');
        if (stuck.length > 0) {
          problems.push(
            `${spec.id}: ${stuck.length} of ${coordinates.length} coordinate mappings did not resolve even with` +
              ' a template for their frame:',
            ...stuck.map((m) => `  ${m.mappingId}: ${m.unresolvedReason} — ${m.notes.join('; ')}`),
          );
        }
        // The contract: cells, never a name. Checked against the real index,
        // because that is the only index whose naming claim matters.
        const named =
          real.index === null
            ? []
            : resolveAgainst(real.index)
                .mappings.filter((m) => m.precision === 'coordinates')
                .filter((m) => m.structureLabelFromIndex);
        if (named.length > 0) {
          problems.push(
            `${spec.id}: ${named.length} coordinate mapping(s) took a name from the real index.`,
            '  The expected contract is coordinates ONLY: these are BV addresses, and there is no BV name',
            '  index (docs/asset-licensing.md §4). If this index now names them, the dataset should say so',
            '  rather than leaving them in a placeholder partition.',
            ...named.slice(0, 5).map((m) => `    ${m.mappingId} -> ${m.structureLabel}`),
          );
        } else if (stuck.length === 0) {
          report.push(
            `  coordinates: all ${coordinates.length} resolve through the template to cells and to NO name,` +
              ' which is the pinned contract for a frame with no name index.',
          );
        }
      }
    }
  }

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

if (problems.length > 0) fail('research dataset', problems);
pass('research dataset', report);
