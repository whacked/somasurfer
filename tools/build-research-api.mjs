/**
 * The static research API, v1 (DOG-131). Read packages/atlas-research/schema/api-1.md.
 *
 *   node tools/build-research-api.mjs            check (CI)
 *   node tools/build-research-api.mjs --write    regenerate the committed region tree
 *
 * Two trees, two licences, two ways of reaching dist/:
 *
 *   region tree   CC BY-SA 4.0. Joined with structure names from BY-SA asset
 *                 files, so it is asset-derived. Generated HERE, from the
 *                 committed region index, into packages/atlas-assets/api/v1/,
 *                 and byte-copied by the site build to dist/assets/api/v1/ like
 *                 any other payload. The site build never reads it, so licence
 *                 rule 6 (dist/data derives nothing from asset content) and
 *                 rule 7 (copies are byte-identical) hold unchanged.
 *   paper tree    Apache-2.0. The curated dataset alone. Emitted by the site
 *                 build (packages/atlas-web/build.mjs) to dist/data/api/v1/,
 *                 from `createPaperApi`, at every build.
 *
 * Asserted, and able to go red:
 *
 *   1. Every document of both trees validates against the schema
 *      (`validateApiDocument`), and every relative link in it lands on a
 *      document of one of the two trees.
 *   2. The two trees agree: the same papers, the same dataset version.
 *   3. The region tree answers what the live `RegionIndex` answers:
 *      `papersFor` and `regionsFor`, paper by paper and region by region,
 *      link for link. The documents are built from the serialised index, so
 *      this compares two independent query paths.
 *   4. The committed tree is exactly what the inputs produce: no file missing,
 *      none extra, none edited. And the attribution entry that ships it lists
 *      exactly its files, or rule 5 would fail on a file nobody attributed.
 *   5. The gate can fail: `selfTest()` breaks the documents and requires each
 *      check to catch it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

import { REPO_ROOT, fail, pass, rel } from './lib/repo.mjs';
import { REGION_INDEX_PATH, loadRegionInputs } from './lib/region-inputs.mjs';
import {
  API_ROOTS,
  apiDocuments,
  buildRegionIndex,
  createPaperApi,
  createRegionApi,
  createResearchApi,
  loadDataset,
  validateApiDocument,
} from '../packages/atlas-research/src/index.ts';

const ASSETS = join(REPO_ROOT, 'packages', 'atlas-assets');
/** Where the region tree is committed, inside the asset package; it ships to dist/assets/api/v1/. */
export const REGION_TREE_DIR = 'api/v1';
const TREE_ABS = join(ASSETS, REGION_TREE_DIR);
export const ATTRIBUTION_ENTRY = 'research-api-regions';

/** One serialisation for the committed files. Indented, so a review diff reads. */
export const serialiseRegionDocument = (body) => `${JSON.stringify(body, null, 1)}\n`;

const SEED = join(REPO_ROOT, 'packages', 'atlas-research', 'data', 'research-seed.json');
const json = (abs) => JSON.parse(readFileSync(abs, 'utf8'));

/** The fields of the committed region index that `serialiseRegionIndex` returns. */
function committedRegionIndex() {
  const doc = json(REGION_INDEX_PATH);
  const { datasetVersion, crosswalkVersion, representations, coverage, papers, structures, mappings } = doc;
  return { datasetVersion, crosswalkVersion, representations, coverage, papers, structures, mappings };
}

// ---------------------------------------------------------------------------
// Checks, as functions of the documents, so the self-test can feed them breakage
// ---------------------------------------------------------------------------

/** 1 and 2: schema, links, and agreement between the trees. */
function checkDocuments(docs) {
  const problems = [];
  const at = new Set(docs.map((d) => `${API_ROOTS[d.tree]}${d.path}`));
  // Links that leave the API: only the asset attribution, which the build copies.
  const outside = new Set(['assets/ATTRIBUTION.md']);
  for (const d of docs) {
    const where = `${API_ROOTS[d.tree]}${d.path}`;
    for (const p of validateApiDocument(d.body)) problems.push(`${where}: ${p}`);
    const dir = posix.dirname(where);
    const hrefs = [];
    JSON.stringify(d.body, (k, v) => {
      if (typeof v === 'string' && /href$/i.test(k)) hrefs.push(v);
      return v;
    });
    for (const h of hrefs) {
      const target = posix.normalize(posix.join(dir, h));
      if (!at.has(target) && !outside.has(target)) problems.push(`${where}: links ${h}, which resolves to ${target}, and no document is there.`);
    }
  }
  const index = docs.find((d) => d.tree === 'data' && d.path === 'index.json')?.body;
  const regionIndex = docs.find((d) => d.tree === 'assets' && d.path === 'index.json')?.body;
  if (!index || !regionIndex) {
    problems.push('the paper index or the region index is missing.');
    return problems;
  }
  if (index.datasetVersion !== regionIndex.datasetVersion) {
    problems.push(`the trees disagree on the dataset: ${index.datasetVersion} (papers) and ${regionIndex.datasetVersion} (regions).`);
  }
  const a = index.papers.map((p) => p.id).join('\n');
  const b = regionIndex.papers.map((p) => p.paperId).join('\n');
  if (a !== b) problems.push('the paper index and the region index list different papers, or list them in a different order.');
  for (const d of docs) {
    if (d.body.datasetVersion !== index.datasetVersion) problems.push(`${API_ROOTS[d.tree]}${d.path}: dataset ${d.body.datasetVersion}, not ${index.datasetVersion}.`);
  }
  return problems;
}

/** 3: the region tree against the live index's own queries. */
function checkAgainstLiveIndex(docs, live) {
  const problems = [];
  const byPath = new Map(docs.filter((d) => d.tree === 'assets').map((d) => [d.path, d.body]));
  const regionIndex = byPath.get('index.json');
  const ids = (links) => links.map((l) => `${l.mappingId}\u0000${l.representation}/${l.structureId}`).join('\n');

  const liveKeys = live.structures.map((s) => s.key);
  const docKeys = regionIndex.regions.map((r) => r.key);
  if (liveKeys.join('\n') !== docKeys.join('\n')) {
    problems.push(`region index: lists ${docKeys.length} region(s); the live index has ${liveKeys.length} with papers.`);
  }
  for (const r of regionIndex.regions) {
    const doc = byPath.get(r.href);
    const want = live.papersFor(r.key);
    const got = doc?.papers ?? [];
    if (got.map((p) => p.paperId).join('\n') !== want.map((p) => p.paperId).join('\n')) {
      problems.push(`region ${r.key}: papers ${got.map((p) => p.paperId).join(', ')}; the live index says ${want.map((p) => p.paperId).join(', ')}.`);
      continue;
    }
    for (let i = 0; i < want.length; i += 1) {
      if (ids(got[i].links) !== ids(want[i].links)) problems.push(`region ${r.key} ← ${want[i].paperId}: the links differ from the live index's.`);
    }
  }
  for (const p of regionIndex.papers) {
    const doc = byPath.get(p.href);
    const want = live.regionsFor(p.paperId);
    const got = doc?.regions ?? [];
    if (got.map((x) => x.key).join('\n') !== want.map((x) => x.key).join('\n')) {
      problems.push(`paper ${p.paperId}: regions ${got.map((x) => x.key).join(', ') || 'none'}; the live index says ${want.map((x) => x.key).join(', ') || 'none'}.`);
      continue;
    }
    for (let i = 0; i < want.length; i += 1) {
      if (ids(got[i].links) !== ids(want[i].links)) problems.push(`paper ${p.paperId} → ${want[i].key}: the links differ from the live index's.`);
    }
    const livePaper = live.papers.find((x) => x.paperId === p.paperId);
    if (JSON.stringify(doc?.emptyBecause ?? null) !== JSON.stringify(livePaper?.emptyBecause ?? null)) {
      problems.push(`paper ${p.paperId}: its stated reasons differ from the live index's.`);
    }
  }
  return problems;
}

/** 4: the committed files, and the attribution entry that ships them. */
function committedFiles() {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(TREE_ABS, p).split('\\').join('/'));
    }
  };
  walk(TREE_ABS);
  return out.sort();
}

function checkCommitted(regionDocs, attribution) {
  const problems = [];
  const want = new Map(regionDocs.map((d) => [d.path, serialiseRegionDocument(d.body)]));
  const have = committedFiles();
  for (const [path, text] of want) {
    const abs = join(TREE_ABS, path);
    if (!existsSync(abs)) problems.push(`${rel(abs)} is missing.`);
    else if (readFileSync(abs, 'utf8') !== text) problems.push(`${rel(abs)} does not match what its inputs produce.`);
  }
  for (const path of have) if (!want.has(path)) problems.push(`${rel(join(TREE_ABS, path))} is not an endpoint the API answers for.`);
  const entry = attribution.entries.find((e) => e.id === ATTRIBUTION_ENTRY);
  const files = [...want.keys()].map((p) => `${REGION_TREE_DIR}/${p}`).sort();
  if (!entry) problems.push(`attribution.json has no ${ATTRIBUTION_ENTRY} entry to ship the region tree under.`);
  else if (JSON.stringify([...(entry.files ?? [])].sort()) !== JSON.stringify(files)) {
    problems.push(`attribution.json entry ${ATTRIBUTION_ENTRY} does not list exactly the region tree's ${files.length} files.`);
  }
  if (problems.length > 0) problems.push('Run node tools/build-research-api.mjs --write and review the diff.');
  return problems;
}

// ---------------------------------------------------------------------------
// 5. Self-test
// ---------------------------------------------------------------------------

function selfTest(docs, live) {
  const failures = [];
  const expectRed = (what, problems, pattern) => {
    if (!problems.some((p) => pattern.test(p))) failures.push(`${what}: not caught (${problems.length} other problem(s)).`);
  };
  const mutate = (fn) => {
    const copy = structuredClone(docs);
    fn(copy);
    return copy;
  };
  const find = (copy, tree, pred) => copy.find((d) => d.tree === tree && pred(d));
  const region = (copy) => find(copy, 'assets', (d) => d.body.kind === 'region');
  const paperRegions = (copy) => find(copy, 'assets', (d) => d.body.kind === 'paper-regions' && d.body.regions.length > 0);

  expectRed(
    'a region document labelled Apache-2.0',
    checkDocuments(mutate((c) => (region(c).body.licence = 'Apache-2.0'))),
    /ships in the assets tree and is CC-BY-SA-4.0/,
  );
  expectRed(
    'a coordinate-less link labelled coordinate',
    checkDocuments(mutate((c) => (region(c).body.papers[0].links[0].how = 'coordinate'))),
    /how coordinate goes with precision mm/,
  );
  expectRed(
    'an absolute href, which breaks under a base path',
    checkDocuments(mutate((c) => (find(c, 'data', (d) => d.body.kind === 'index').body.papers[0].href = '/data/api/v1/papers/x.json'))),
    /must be a relative link/,
  );
  expectRed(
    'a link to a document that does not exist',
    checkDocuments(mutate((c) => (paperRegions(c).body.regions[0].href = '../regions/nowhere/0.json'))),
    /no document is there/,
  );
  expectRed(
    'a missing region document',
    checkDocuments(mutate((c) => c.splice(c.indexOf(region(c)), 1))),
    /no document is there/,
  );
  expectRed(
    'trees built from different dataset versions',
    checkDocuments(mutate((c) => (find(c, 'assets', (d) => d.body.kind === 'region-index').body.datasetVersion = 'other'))),
    /the trees disagree on the dataset/,
  );
  expectRed(
    'a field the schema does not name',
    checkDocuments(mutate((c) => (region(c).body.extra = 1))),
    /which the schema does not name/,
  );
  expectRed(
    'a paper with no region and no stated reason',
    checkDocuments(mutate((c) => (find(c, 'assets', (d) => d.body.kind === 'paper-regions' && d.body.regions.length === 0).body.emptyBecause = []))),
    /exactly one of the two/,
  );
  expectRed(
    'a region document that lost a paper the live index has',
    checkAgainstLiveIndex(
      mutate((c) => {
        const r = find(c, 'assets', (d) => d.body.kind === 'region' && d.body.papers.length > 1) ?? region(c);
        r.body.papers.pop();
      }),
      live,
    ),
    /the live index says/,
  );
  expectRed(
    'a paper-regions document with a link swapped',
    checkAgainstLiveIndex(mutate((c) => (paperRegions(c).body.regions[0].links[0].mappingId = 'map:other')), live),
    /the links differ from the live index's/,
  );
  return failures;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const write = process.argv.includes('--write');
const problems = [];

const dataset = loadDataset(json(SEED));
const regionIndex = committedRegionIndex();
// Throws on a region index built from another dataset or listing other papers.
const api = createResearchApi({ dataset, regionIndex });
const docs = apiDocuments(api);
const paperDocs = apiDocuments(createPaperApi(dataset));
const regionDocs = apiDocuments(createRegionApi(regionIndex));
if (JSON.stringify(paperDocs) !== JSON.stringify(docs.filter((d) => d.tree === 'data'))) {
  problems.push('createPaperApi answers differently from createResearchApi; the build would emit a paper tree the check never saw.');
}

// The live index: the same inputs check-crosswalk.mjs resolves, queried directly.
const live = buildRegionIndex(loadRegionInputs());

const selfFailures = selfTest(docs, live);
if (selfFailures.length > 0) fail('research api', ['self-test: the gate cannot go red on:', ...selfFailures.map((f) => `  ${f}`)]);

problems.push(...checkDocuments(docs));
problems.push(...checkAgainstLiveIndex(docs, live));

const ATTRIBUTION = join(ASSETS, 'attribution.json');
const report = [];
if (write) {
  rmSync(TREE_ABS, { recursive: true, force: true });
  for (const d of regionDocs) {
    const abs = join(TREE_ABS, d.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, serialiseRegionDocument(d.body));
  }
  const attribution = json(ATTRIBUTION);
  const entry = attribution.entries.find((e) => e.id === ATTRIBUTION_ENTRY);
  if (!entry) {
    problems.push(`attribution.json has no ${ATTRIBUTION_ENTRY} entry. Add it by hand (licence, holder, sources); --write only maintains its file list.`);
  } else {
    entry.files = regionDocs.map((d) => `${REGION_TREE_DIR}/${d.path}`).sort();
    writeFileSync(ATTRIBUTION, `${JSON.stringify(attribution, null, 2)}\n`);
    writeFileSync(join(ASSETS, 'ATTRIBUTION.md'), execFileSync(process.execPath, [join(REPO_ROOT, 'tools', 'render-attribution.mjs')]));
  }
  report.push(`wrote ${regionDocs.length} document(s) under ${rel(TREE_ABS)}, and the ${ATTRIBUTION_ENTRY} file list.`);
} else {
  problems.push(...checkCommitted(regionDocs, json(ATTRIBUTION)));
}

if (problems.length > 0) fail('research api', problems);

const kinds = (xs) => Object.entries(Object.groupBy(xs, (d) => d.body.kind)).map(([k, v]) => `${v.length} ${k}`).join(', ');
const emptyPapers = regionDocs.filter((d) => d.body.kind === 'paper-regions' && d.body.regions.length === 0).length;
pass('research api', [
  'self-test: red on a region document labelled Apache-2.0, a link whose how and precision disagree, an absolute href,',
  '  a dangling link, a missing document, trees from different datasets, an unnamed field, a paper with nothing and no',
  '  reason, and a region tree that lost a paper or swapped a link against the live index.',
  `paper tree (Apache-2.0, emitted by the site build to dist/${API_ROOTS.data}): ${kinds(paperDocs)}.`,
  `region tree (CC BY-SA 4.0, ${rel(TREE_ABS)} → dist/${API_ROOTS.assets}): ${kinds(regionDocs)}.`,
  `  ${emptyPapers} paper(s) reach no region; each document says why.`,
  `schema: all ${docs.length} documents validate, and every link lands on a document.`,
  `live index: papersFor and regionsFor agree with every region and paper-regions document, link for link.`,
  ...(write ? report : [`committed: ${rel(TREE_ABS)} matches its inputs, and attribution entry ${ATTRIBUTION_ENTRY} lists exactly its files.`]),
]);
