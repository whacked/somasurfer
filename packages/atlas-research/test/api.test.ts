/**
 * The research API (DOG-131), on a synthetic world small enough to read.
 *
 * The real trees are gated by tools/build-research-api.mjs (schema, the live
 * index, drift) and tools/check-research-api-contract.mjs (served over HTTP at
 * the build's base). These cases pin the same promises where every input is
 * visible, including the link kinds the real data has none of today: there is
 * no coordinate link and no HCP-MMP1 → structure link in the committed index.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  API_ROOTS,
  apiDocuments,
  apiHref,
  apiPaths,
  buildRegionIndex,
  createPaperApi,
  createRegionApi,
  createResearchApi,
  createStaticApiClient,
  paperSlug,
  REPRESENTATIONS,
  serialiseRegionIndex,
  validateApiDocument,
  type ApiDocument,
  type Crosswalk,
  type RegionIndex,
  type RepresentationData,
  type ResearchApi,
  type SerialisedRegionIndex,
} from '../src/index.ts';
import type { Finding, Paper, RegionMapping, ResearchDataset, SpatialDetail } from '../src/types.ts';

const rep = (id: string) => REPRESENTATIONS.find((r) => r.id === id)!;
const PROV = { assertedBy: 'test', assertedOn: '2026-10-12', basis: 'published-text', confidence: 'high' } as const;
const REGION: SpatialDetail = { kind: 'region-level', reason: 'test' };
const PUTAMEN_L_MNI = [-26, 1, 0] as const;

function mapping(id: string, scheme: string, term: string, label: string, spatial: SpatialDetail = REGION): RegionMapping {
  return {
    id,
    structureId: term,
    structureIdSource: scheme,
    structureLabel: label,
    spatial,
    evidence: { summary: 'test', kind: 'abstract', locator: null, locatorStatus: 'not-recorded' },
    provenance: PROV,
  };
}
const paper = (id: string): Paper => ({
  id,
  title: `Title of ${id}`,
  authors: ['A'],
  year: 2001,
  venue: 'V',
  identifier: { kind: 'none', value: null },
  sourceUrl: null,
  provenance: PROV,
});
const finding = (id: string, paperId: string, mappings: RegionMapping[]): Finding => ({
  id,
  paperId,
  statement: id,
  topics: [],
  mappings,
  provenance: PROV,
});

/** Four papers: a term link on both sides, a crosswalk link, a coordinate link, and one that reaches nothing. */
function dataset(): ResearchDataset {
  return {
    schema: 'research/1',
    version: 'test-1',
    structureIdSources: ['FMA', 'HCP-MMP1', 'ATLAS-LABEL'],
    authoredAgainst: { status: 'fixture', nameIndexVersion: 'test' },
    curation: { curatedBy: 't', curatedOn: '2026-10-12', method: 't', citationCheck: 't', notRecorded: [] },
    papers: ['paper:term', 'paper:hcp', 'paper:coord', 'paper:held'].map(paper),
    findings: [
      finding('finding:term', 'paper:term', [
        mapping('map:putamen', 'ATLAS-LABEL', 'ATLAS-LABEL:putamen', 'putamen'),
        mapping('map:heart', 'FMA', 'FMA7088', 'heart'),
      ]),
      finding('finding:hcp', 'paper:hcp', [mapping('map:a4', 'HCP-MMP1', 'HCP-MMP1:A4', 'Auditory area 4')]),
      finding('finding:coord', 'paper:coord', [
        mapping('map:in', 'HCP-MMP1', 'HCP-MMP1:4', 'Primary motor cortex (area 4)', {
          kind: 'coordinates',
          space: 'MNI152',
          frame: 'BV',
          pointsMm: [PUTAMEN_L_MNI],
          digits: 4,
        }),
      ]),
      finding('finding:held', 'paper:held', [mapping('map:precentral', 'ATLAS-LABEL', 'ATLAS-LABEL:precentral-gyrus', 'precentral gyrus')]),
    ],
  };
}

const crosswalk = (): Crosswalk => ({
  schema: 'atlas-crosswalk/1',
  version: 'cw-test',
  assertedBy: 't',
  assertedOn: '2026-10-12',
  entries: [
    { term: 'ATLAS-LABEL:putamen', label: 'putamen', how: 'exact-term', completeness: 'same', targets: [{ representation: 'zanatomy-gross-anatomy', label: 'Putamen' }] },
    {
      term: 'HCP-MMP1:A4',
      label: 'Auditory area 4',
      how: 'crosswalk',
      completeness: 'overlaps',
      targets: [{ representation: 'zanatomy-gross-anatomy', label: 'Superior temporal gyrus' }],
      why: 'A4 lies on the superior temporal gyrus',
    },
    {
      term: 'HCP-MMP1:4',
      label: 'Primary motor cortex (area 4)',
      how: 'crosswalk',
      completeness: 'overlaps',
      targets: [{ representation: 'zanatomy-gross-anatomy', label: 'Precentral gyrus' }],
      why: 'area 4 lies on the precentral gyrus',
    },
    { term: 'ATLAS-LABEL:precentral-gyrus', label: 'precentral gyrus', how: 'exact-term', completeness: 'same', targets: [{ representation: 'zanatomy-gross-anatomy', label: 'Precentral gyrus' }] },
  ],
});

const brain: RepresentationData = {
  representation: rep('zanatomy-gross-anatomy'),
  version: 'test-brain',
  structures: [
    { id: '10', name: 'Putamen.l', label: 'Putamen', side: 'left' },
    { id: '11', name: 'Putamen.r', label: 'Putamen', side: 'right' },
    { id: '20', name: 'Superior temporal gyrus.l', label: 'Superior temporal gyrus', side: 'left' },
    { id: '99', name: 'Thalamus.l', label: 'Thalamus', side: 'left' },
  ],
  held: [{ name: 'Precentral gyrus.l', label: 'Precentral gyrus', side: 'left', because: 'undeclared material' }],
  locate: (p) =>
    Math.hypot(p[0] - PUTAMEN_L_MNI[0], p[1] - PUTAMEN_L_MNI[1], p[2] - PUTAMEN_L_MNI[2]) < 5
      ? { inside: [{ id: '10', depthMm: 2 }], nearest: { id: '10', distanceMm: 2 } }
      : { inside: [], nearest: null },
  coordinatePrecision: { mm: 8.55, basis: 'held-out error at the red nucleus' },
};
const body: RepresentationData = {
  representation: rep('bodyparts3d-bd'),
  version: 'test-body',
  structures: [{ id: 'FMA7088', name: 'heart', label: 'heart', side: null }],
  held: [],
};

const live = (): RegionIndex => buildRegionIndex({ dataset: dataset(), crosswalk: crosswalk(), representations: [brain, body] });
/** As a consumer holds it: through JSON. */
const serialised = (): SerialisedRegionIndex => JSON.parse(JSON.stringify(serialiseRegionIndex(live())));
const api = (): ResearchApi => createResearchApi({ dataset: dataset(), regionIndex: serialised() });

// ---------------------------------------------------------------------------

test('the synthetic world reaches every link kind, so no case below is vacuous', () => {
  const links = live().mappings.flatMap((o) => o.links);
  assert.deepEqual([...new Set(links.map((l) => l.how))].sort(), ['coordinate', 'crosswalk', 'exact-term']);
  assert.ok(live().papers.some((p) => p.regions.length === 0 && p.emptyBecause.length > 0), 'a paper with a stated reason and no region');
});

test('every document the API serves validates against the schema', () => {
  const docs = apiDocuments(api());
  // 1 index + 4 papers; 1 region index + 4 regions (both putamens, the STG, the
  // heart; the coordinate lands in the left putamen too) + 4 paper-regions.
  assert.equal(docs.filter((d) => d.tree === 'data').length, 5);
  assert.equal(docs.filter((d) => d.tree === 'assets').length, 9);
  for (const d of docs) assert.deepEqual(validateApiDocument(JSON.parse(JSON.stringify(d.body))), [], `${d.tree}/${d.path}`);
});

test('each tree carries its own licence: the paper tree Apache-2.0, the region tree CC BY-SA 4.0', () => {
  for (const d of apiDocuments(api())) assert.equal(d.body.licence, d.tree === 'data' ? 'Apache-2.0' : 'CC-BY-SA-4.0', `${d.tree}/${d.path}`);
  // And the paper half never needs the region index: what the site build emits under dist/data/.
  const half = apiDocuments(createPaperApi(dataset()));
  assert.deepEqual(half, apiDocuments(api()).filter((d) => d.tree === 'data'));
  assert.ok(!JSON.stringify(half).includes('Putamen'), 'a structure name reached the Apache-2.0 tree');
});

test('region → papers and paper → regions agree with the live index, link for link', () => {
  const index = live();
  const a = api();
  for (const s of index.structures) {
    const doc = a.region(s.key)!;
    assert.deepEqual(
      doc.papers.map((p) => [p.paperId, p.links.map((l) => l.mappingId)]),
      index.papersFor(s.key).map((p) => [p.paperId, p.links.map((l) => l.mappingId)]),
      s.key,
    );
  }
  for (const p of index.papers) {
    const doc = a.paperRegions(p.paperId)!;
    assert.deepEqual(
      doc.regions.map((r) => [r.key, r.links.map((l) => l.mappingId)]),
      index.regionsFor(p.paperId).map((r) => [r.key, r.links.map((l) => l.mappingId)]),
      p.paperId,
    );
    assert.deepEqual(doc.emptyBecause, p.emptyBecause);
  }
});

test('the two directions round-trip through the documents themselves', () => {
  const a = api();
  for (const r of a.regionIndex().regions) {
    for (const p of a.region(r.key)!.papers) {
      const back = a.paperRegions(p.paperId)!.regions.find((x) => x.key === r.key);
      assert.ok(back, `${p.paperId} → ${r.key} has no way back`);
      assert.deepEqual(back.links, p.links);
    }
  }
});

test('a coordinate link keeps its millimetres and point, and an HCP-MMP1 link keeps its area name', () => {
  const coord = api().paperRegions('paper:coord')!.regions.flatMap((r) => r.links);
  assert.ok(coord.length > 0 && coord.every((l) => l.how !== 'exact-term'));
  const placed = coord.find((l) => l.how === 'coordinate')!;
  assert.equal(placed.precision.kind, 'mm');
  assert.ok(placed.precision.kind === 'mm' && placed.precision.mm >= 8.55);
  assert.deepEqual(placed.coordinate?.mniMm, [...PUTAMEN_L_MNI]);
  const hcp = api().paperRegions('paper:hcp')!.regions.flatMap((r) => r.links);
  assert.ok(hcp.length > 0);
  for (const l of hcp) {
    assert.equal(l.how, 'crosswalk');
    assert.deepEqual(l.source, { scheme: 'HCP-MMP1', term: 'HCP-MMP1:A4', label: 'Auditory area 4' });
  }
});

test('a paper that reaches nothing says why; an unknown paper or an unlinked region is null', () => {
  const a = api();
  const held = a.paperRegions('paper:held')!;
  assert.deepEqual(held.regions, []);
  assert.deepEqual(held.emptyBecause.map((e) => e.code), ['structure-held']);
  assert.deepEqual(a.regionIndex().papers.find((p) => p.paperId === 'paper:held')!.emptyBecause, ['structure-held']);
  assert.equal(a.paper('paper:nobody'), null);
  assert.equal(a.paperRegions('paper:nobody'), null);
  assert.equal(a.region('zanatomy-gross-anatomy/99'), null, 'a shipped structure no paper reaches has no document');
});

test('refuses a region index built from another dataset, or listing other papers', () => {
  const other = { ...serialised(), datasetVersion: 'test-2' };
  assert.throws(() => createResearchApi({ dataset: dataset(), regionIndex: other }), /built from dataset "test-2", not "test-1"/);
  const fewer = { ...serialised(), papers: serialised().papers.slice(1) };
  assert.throws(() => createResearchApi({ dataset: dataset(), regionIndex: fewer }), /list different papers \(only in the dataset: paper:term/);
});

test('answers are fresh objects: mutating one changes no later answer', () => {
  const a = api();
  const first = a.region('zanatomy-gross-anatomy/10')!;
  (first.papers[0]!.links[0] as { structureName: string }).structureName = 'changed';
  (a.paper('paper:term')!.paper as { title: string }).title = 'changed';
  assert.equal(a.region('zanatomy-gross-anatomy/10')!.papers[0]!.links[0]!.structureName, 'Putamen.l');
  assert.equal(a.paper('paper:term')!.paper.title, 'Title of paper:term');
});

// ---------------------------------------------------------------------------
// Paths and links
// ---------------------------------------------------------------------------

test('paths are derived from ids only when the id is already path-safe', () => {
  assert.equal(paperSlug('paper:brodmann-1909-localisation'), 'brodmann-1909-localisation');
  assert.equal(apiPaths.region('bodyparts3d-bd/FMA7088'), 'regions/bodyparts3d-bd/FMA7088.json');
  for (const bad of ['p:x', 'paper:A', 'paper:../x', 'paper:a/b', 'paper:', 'paper:a%2fb']) {
    assert.throws(() => paperSlug(bad), /has no path/, bad);
  }
  for (const bad of ['rep/../x', 'rep/a/b', '/x', 'rep/', 'Rep/x', 'rep/.x']) {
    assert.throws(() => apiPaths.region(bad), /has no path/, bad);
  }
});

test('every link is relative and lands on its document under any base, including /somasurfer/', () => {
  const docs = apiDocuments(api());
  const at = new Set(docs.map((d) => `${API_ROOTS[d.tree]}${d.path}`));
  for (const base of ['https://h/', 'https://h/somasurfer/']) {
    for (const d of docs) {
      const self = new URL(`${API_ROOTS[d.tree]}${d.path}`, base);
      JSON.stringify(d.body, (k, v) => {
        if (typeof v === 'string' && /href$/i.test(k)) {
          assert.ok(!v.startsWith('/') && !/^[a-z]+:/i.test(v), `${v} is not relative`);
          const target = new URL(v, self).href;
          assert.ok(target.startsWith(base), `${v} from ${self.href} leaves ${base}`);
          const inSite = target.slice(base.length);
          assert.ok(at.has(inSite) || inSite === 'assets/ATTRIBUTION.md', `${v} from ${d.tree}/${d.path} lands on ${inSite}`);
        }
        return v;
      });
    }
  }
  assert.equal(apiHref({ tree: 'data', path: 'papers/x.json' }, { tree: 'assets', path: 'paper-regions/x.json' }), '../../../../assets/api/v1/paper-regions/x.json');
  assert.equal(apiHref({ tree: 'assets', path: 'index.json' }, { tree: 'assets', path: 'regions/r/1.json' }), 'regions/r/1.json');
});

// ---------------------------------------------------------------------------
// The validator goes red
// ---------------------------------------------------------------------------

test('the validator refuses each way a document can be wrong', () => {
  const a = api();
  const broken = (doc: ApiDocument, edit: (d: any) => void) => {
    const copy = structuredClone(doc) as any;
    edit(copy);
    return validateApiDocument(copy);
  };
  // The right putamen: reached by an exact-term link only.
  const region = a.region('zanatomy-gross-anatomy/11')!;
  const coord = a.paperRegions('paper:coord')!;
  const cases: [string, string[], RegExp][] = [
    ['a region document labelled Apache-2.0', broken(region, (d) => (d.licence = 'Apache-2.0')), /ships in the assets tree and is CC-BY-SA-4.0/],
    ['an unnamed field', broken(region, (d) => (d.extra = 1)), /`extra`, which the schema does not name/],
    ['a missing field', broken(region, (d) => delete d.structureName), /is missing `structureName`/],
    ['an absolute href', broken(region, (d) => (d.papers[0].href = '/data/api/v1/papers/term.json')), /must be a relative link/],
    ['an href with a scheme', broken(region, (d) => (d.papers[0].href = 'https://x/y.json')), /must be a relative link/],
    ['an exact-term link with millimetres', broken(region, (d) => (d.papers[0].links[0].precision = { kind: 'mm', mm: 1, basis: 'x' })), /how exact-term goes with precision exact/],
    [
      'a coordinate link with no point',
      broken(coord, (d) => delete d.regions.find((r: any) => r.links.some((l: any) => l.how === 'coordinate')).links.find((l: any) => l.how === 'coordinate').coordinate),
      /carries `coordinate` exactly when how is coordinate/,
    ],
    ['a link under the wrong region', broken(region, (d) => (d.papers[0].links[0].structureId = '10')), /links another paper or another region/],
    ['a paper with no region and no reason', broken(a.paperRegions('paper:held')!, (d) => (d.emptyBecause = [])), /exactly one of the two/],
    ['an unsorted paper list', broken(a.regionIndex(), (d) => d.regions.reverse()), /must be sorted/],
    ['an unknown kind', broken(region, (d) => (d.kind = 'regions')), /kind "regions" is not one of/],
  ];
  for (const [what, problems, pattern] of cases) assert.ok(problems.some((p) => pattern.test(p)), `${what}: ${problems.join(' | ') || 'passed'}`);
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** An in-memory static host: the documents at their roots under `base`, as JSON text, as Pages would serve them. */
function host(base: string, docs: ReturnType<typeof apiDocuments>, alter: (url: string, text: string) => string | number = (_, t) => t) {
  const files = new Map(docs.map((d) => [`https://h${base}${API_ROOTS[d.tree]}${d.path}`, JSON.stringify(d.body)]));
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    const text = files.get(url);
    const out = text === undefined ? 404 : alter(url, text);
    return typeof out === 'number'
      ? { ok: false, status: out, json: async () => null }
      : { ok: true, status: 200, json: async () => JSON.parse(out) };
  };
  return { fetch, asked, roots: { dataRoot: `https://h${base}${API_ROOTS.data}`, assetsRoot: `https://h${base}${API_ROOTS.assets}` } };
}

test('the client answers every query exactly as the library does, under /somasurfer/', async () => {
  const a = api();
  const h = host('/somasurfer/', apiDocuments(a));
  const c = createStaticApiClient({ ...h.roots, transport: h.fetch });
  assert.deepEqual(await c.index(), a.index());
  assert.deepEqual(await c.regionIndex(), a.regionIndex());
  for (const p of dataset().papers) {
    assert.deepEqual(await c.paper(p.id), a.paper(p.id));
    assert.deepEqual(await c.paperRegions(p.id), a.paperRegions(p.id));
  }
  for (const r of a.regionIndex().regions) assert.deepEqual(await c.region(r.key), a.region(r.key));
  assert.equal(await c.region('zanatomy-gross-anatomy/99'), null);
  assert.equal(await c.paper('paper:nobody'), null);
  assert.ok(h.asked.every((u) => u.startsWith('https://h/somasurfer/')), 'a request left the base');
});

test('the client refuses a document that does not validate, a server error, and a root without its slash', async () => {
  const a = api();
  const tampered = host('/', apiDocuments(a), (url, text) => (url.endsWith('/regions/zanatomy-gross-anatomy/10.json') ? text.replace('"CC-BY-SA-4.0"', '"Apache-2.0"') : text));
  await assert.rejects(createStaticApiClient({ ...tampered.roots, transport: tampered.fetch }).region('zanatomy-gross-anatomy/10'), /is not a valid region document/);
  const down = host('/', apiDocuments(a), () => 503);
  await assert.rejects(createStaticApiClient({ ...down.roots, transport: down.fetch }).paper('paper:term'), /answered 503/);
  const missing = host('/', []);
  await assert.rejects(createStaticApiClient({ ...missing.roots, transport: missing.fetch }).index(), /the data index is missing \(404\)/);
  assert.throws(() => createStaticApiClient({ dataRoot: 'https://h/data/api/v1', assetsRoot: 'https://h/assets/api/v1/', transport: down.fetch }), /must end in "\/"/);
  // An id that would leave its root is refused before anything is requested.
  const watched = host('/', apiDocuments(a));
  const c = createStaticApiClient({ ...watched.roots, transport: watched.fetch });
  await assert.rejects(c.paper('paper:../../x'), /has no path/);
  await assert.rejects(c.region('zanatomy-gross-anatomy/../../../x'), /has no path/);
  await assert.rejects(c.paperRegions('https://evil.example/x'), /has no path/);
  assert.deepEqual(watched.asked, []);
  // A paper document served where a region document is expected is refused by kind, not accepted as data.
  const swapped = host('/', apiDocuments(a), (url, text) => (url.endsWith('/paper-regions/term.json') ? JSON.stringify(a.paper('paper:term')) : text));
  await assert.rejects(createStaticApiClient({ ...swapped.roots, transport: swapped.fetch }).paperRegions('paper:term'), /expected kind paper-regions/);
});

test('the region half alone answers what the joined API answers', () => {
  const half = createRegionApi(serialised());
  const a = api();
  assert.deepEqual(half.regionIndex(), a.regionIndex());
  for (const p of dataset().papers) assert.deepEqual(half.paperRegions(p.id), a.paperRegions(p.id));
});
