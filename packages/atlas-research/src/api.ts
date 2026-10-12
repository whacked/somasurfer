/**
 * Research API v1 (DOG-131, plan D4): the region ↔ paper queries as documents,
 * the same documents the static site serves, and a client that reads them back.
 *
 * Read `schema/api-1.md` first. It carries the layout, every field, and the
 * licence reasoning; this file is the surface.
 *
 * ## Two trees, because two licences
 *
 * A region document names structures, and the names come from BY-SA asset
 * files. So everything joined with them is BY-SA too, and ships under
 * `dist/assets/api/v1/` beside the asset licence (licence rule 6 holds
 * `dist/data/` to deriving nothing from asset content). What a paper document
 * says is the curated dataset alone, which is ours, so it stays Apache-2.0
 * under `dist/data/api/v1/`.
 *
 *   data tree (Apache-2.0)        index.json, papers/{slug}.json
 *   assets tree (CC BY-SA 4.0)    index.json, regions/{representation}/{id}.json,
 *                                 paper-regions/{slug}.json
 *
 * ## One answer, three ways to ask
 *
 * `createResearchApi()` answers from the dataset and the serialised region
 * index. `apiDocuments()` is every answer it can give, which is what
 * `tools/build-research-api.mjs` writes. `createStaticApiClient()` fetches the
 * written documents. The contract is that all three agree for every query, and
 * `tools/check-research-api-contract.mjs` checks it on a served build.
 *
 * Every link in a document is relative to that document, so the trees work
 * under any base path, and a document can be copied byte for byte.
 */

import type { serialiseRegionIndex, LinkHow, RegionLink, UnplacedCode } from './region-index.ts';
import type { Finding, Paper, ResearchDataset } from './types.ts';

export const API_SCHEMA = 'atlas-research-api/1';
export const API_VERSION = 'v1';

/** The two trees, from the site root. */
export const API_ROOTS = Object.freeze({ data: `data/api/${API_VERSION}/`, assets: `assets/api/${API_VERSION}/` });

export const API_LICENCES = Object.freeze({ data: 'Apache-2.0', assets: 'CC-BY-SA-4.0' });

export type ApiTree = keyof typeof API_ROOTS;

/** What `serialiseRegionIndex()` returns, after a JSON round trip. */
export type SerialisedRegionIndex = ReturnType<typeof serialiseRegionIndex>;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PAPER_ID = /^paper:([a-z0-9][a-z0-9-]*)$/;
const REPRESENTATION_ID = /^[a-z0-9][a-z0-9-]*$/;
const STRUCTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `paper:brodmann-1909-localisation` → `brodmann-1909-localisation`. Throws on anything else: an id is never escaped into a path. */
export function paperSlug(paperId: string): string {
  const m = PAPER_ID.exec(paperId);
  if (!m) throw new Error(`api: paper id ${JSON.stringify(paperId)} is not paper:<lowercase-slug>, so it has no path.`);
  return m[1]!;
}

function regionParts(key: string): [string, string] {
  const i = key.indexOf('/');
  const representation = key.slice(0, i);
  const structureId = key.slice(i + 1);
  if (i <= 0 || !REPRESENTATION_ID.test(representation) || !STRUCTURE_ID.test(structureId)) {
    throw new Error(`api: region key ${JSON.stringify(key)} is not <representation>/<structure id> in path-safe characters, so it has no path.`);
  }
  return [representation, structureId];
}

/** Each document's path inside its tree. */
export const apiPaths = Object.freeze({
  index: (): string => 'index.json',
  paper: (paperId: string): string => `papers/${paperSlug(paperId)}.json`,
  paperRegions: (paperId: string): string => `paper-regions/${paperSlug(paperId)}.json`,
  region: (key: string): string => {
    const [representation, structureId] = regionParts(key);
    return `regions/${representation}/${structureId}.json`;
  },
});

/** A link from one document to another, both named by tree and path. Relative, so no base path is baked in. */
export function apiHref(from: { tree: ApiTree; path: string }, to: { tree: ApiTree; path: string }): string {
  const fromDir = `${API_ROOTS[from.tree]}${from.path}`.split('/').slice(0, -1);
  const target = `${API_ROOTS[to.tree]}${to.path}`.split('/');
  let common = 0;
  while (common < fromDir.length && common < target.length - 1 && fromDir[common] === target[common]) common += 1;
  return [...fromDir.slice(common).map(() => '..'), ...target.slice(common)].join('/');
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

interface Head<K extends string, T extends ApiTree> {
  readonly schema: typeof API_SCHEMA;
  readonly kind: K;
  readonly licence: (typeof API_LICENCES)[T];
}

/** `data/api/v1/index.json`: every paper, and where the region tree is. */
export interface ApiIndex extends Head<'index', 'data'> {
  readonly datasetVersion: string;
  readonly papers: readonly {
    readonly id: string;
    readonly title: string;
    readonly year: number;
    readonly href: string;
    readonly regionsHref: string;
  }[];
  readonly regionIndex: { readonly href: string; readonly licence: typeof API_LICENCES.assets };
}

/** `data/api/v1/papers/{slug}.json`: the paper, its findings and their curated mappings, verbatim. */
export interface ApiPaper extends Head<'paper', 'data'> {
  readonly datasetVersion: string;
  readonly paper: Paper;
  readonly findings: readonly Finding[];
  readonly regions: { readonly href: string; readonly licence: typeof API_LICENCES.assets };
}

/** `assets/api/v1/index.json`: every linked region, every paper's outcome, and the coverage. */
export interface ApiRegionIndex extends Head<'region-index', 'assets'> {
  readonly attributionHref: string;
  readonly datasetVersion: string;
  readonly crosswalkVersion: string;
  readonly representations: SerialisedRegionIndex['representations'];
  readonly coverage: SerialisedRegionIndex['coverage'];
  readonly regions: readonly {
    readonly key: string;
    readonly representation: string;
    readonly structureId: string;
    readonly structureName: string;
    readonly paperIds: readonly string[];
    readonly href: string;
  }[];
  readonly papers: readonly {
    readonly paperId: string;
    readonly regionKeys: readonly string[];
    /** Present exactly when `regionKeys` is empty. */
    readonly emptyBecause: readonly UnplacedCode[];
    readonly href: string;
  }[];
}

/** `assets/api/v1/regions/{representation}/{id}.json`: region → papers. */
export interface ApiRegion extends Head<'region', 'assets'> {
  readonly datasetVersion: string;
  readonly crosswalkVersion: string;
  readonly key: string;
  readonly representation: string;
  readonly structureId: string;
  readonly structureName: string;
  readonly papers: readonly { readonly paperId: string; readonly href: string; readonly links: readonly RegionLink[] }[];
}

/** `assets/api/v1/paper-regions/{slug}.json`: paper → regions, or the stated reasons there are none. */
export interface ApiPaperRegions extends Head<'paper-regions', 'assets'> {
  readonly datasetVersion: string;
  readonly crosswalkVersion: string;
  readonly paperId: string;
  readonly paperHref: string;
  readonly regions: readonly { readonly key: string; readonly structureName: string; readonly href: string; readonly links: readonly RegionLink[] }[];
  readonly emptyBecause: SerialisedRegionIndex['papers'][number]['emptyBecause'];
}

export type ApiDocument = ApiIndex | ApiPaper | ApiRegionIndex | ApiRegion | ApiPaperRegions;

/** The queries, answered locally. `null` is "no such paper" or "no paper links this region"; the static API answers 404. */
export interface ResearchApi {
  index(): ApiIndex;
  paper(paperId: string): ApiPaper | null;
  regionIndex(): ApiRegionIndex;
  region(key: string): ApiRegion | null;
  paperRegions(paperId: string): ApiPaperRegions | null;
}

/** The same queries, over HTTP. */
export type ResearchApiClient = { [K in keyof ResearchApi]: (...args: Parameters<ResearchApi[K]>) => Promise<ReturnType<ResearchApi[K]>> };

// ---------------------------------------------------------------------------
// Local answers
// ---------------------------------------------------------------------------

const head = <K extends string, T extends ApiTree>(kind: K, tree: T): Head<K, T> => ({
  schema: API_SCHEMA,
  kind,
  licence: API_LICENCES[tree],
});

const sorted = (xs: Iterable<string>) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const fresh = <T>(x: T): T => structuredClone(x) as T;

const at = {
  index: { tree: 'data', path: apiPaths.index() },
  regionIndex: { tree: 'assets', path: apiPaths.index() },
  paper: (id: string) => ({ tree: 'data', path: apiPaths.paper(id) }),
  paperRegions: (id: string) => ({ tree: 'assets', path: apiPaths.paperRegions(id) }),
  region: (key: string) => ({ tree: 'assets', path: apiPaths.region(key) }),
} as const;

export type PaperApi = Pick<ResearchApi, 'index' | 'paper'>;
export type RegionApi = Pick<ResearchApi, 'regionIndex' | 'region' | 'paperRegions'>;

/**
 * The Apache-2.0 half: the dataset alone. Separate so the site build can emit
 * it without reading the region index, which is asset-derived.
 */
export function createPaperApi(dataset: ResearchDataset): PaperApi {
  const papers = new Map(dataset.papers.map((p) => [p.id, p]));
  const findings = new Map<string, Finding[]>();
  for (const f of dataset.findings) (findings.get(f.paperId) ?? findings.set(f.paperId, []).get(f.paperId)!).push(f);
  return {
    index: () => ({
      ...head('index', 'data'),
      datasetVersion: dataset.version,
      papers: dataset.papers.map((p) => ({
        id: p.id,
        title: p.title,
        year: p.year,
        href: apiHref(at.index, at.paper(p.id)),
        regionsHref: apiHref(at.index, at.paperRegions(p.id)),
      })),
      regionIndex: { href: apiHref(at.index, at.regionIndex), licence: API_LICENCES.assets },
    }),

    paper: (paperId) => {
      const p = papers.get(paperId);
      if (!p) return null;
      return {
        ...head('paper', 'data'),
        datasetVersion: dataset.version,
        paper: fresh(p),
        findings: fresh(findings.get(paperId) ?? []),
        regions: { href: apiHref(at.paper(paperId), at.paperRegions(paperId)), licence: API_LICENCES.assets },
      };
    },
  };
}

/** The CC BY-SA half: the serialised region index alone. */
export function createRegionApi(ri: SerialisedRegionIndex): RegionApi {
  const outcomes = new Map(ri.papers.map((p) => [p.paperId, p]));
  // key → paperId → links, and paperId → key → links, both in mapping order.
  const byRegion = new Map<string, Map<string, RegionLink[]>>();
  const byPaper = new Map<string, Map<string, RegionLink[]>>();
  for (const o of ri.mappings) {
    for (const l of o.links) {
      const k = `${l.representation}/${l.structureId}`;
      const r = byRegion.get(k) ?? byRegion.set(k, new Map()).get(k)!;
      (r.get(l.paperId) ?? r.set(l.paperId, []).get(l.paperId)!).push(l);
      const p = byPaper.get(l.paperId) ?? byPaper.set(l.paperId, new Map()).get(l.paperId)!;
      (p.get(k) ?? p.set(k, []).get(k)!).push(l);
    }
  }
  const structures = new Map(ri.structures.map((s) => [s.key, s]));
  for (const k of byRegion.keys()) {
    if (!structures.has(k)) throw new Error(`api: links reach ${k}, which the region index does not list among its structures.`);
  }
  for (const k of byPaper.keys()) {
    if (!outcomes.has(k)) throw new Error(`api: links name paper ${k}, which the region index does not list among its papers.`);
  }

  return {
    regionIndex: () => ({
      ...head('region-index', 'assets'),
      // dist/assets/ATTRIBUTION.md, which the build copies beside every asset.
      attributionHref: '../../ATTRIBUTION.md',
      datasetVersion: ri.datasetVersion,
      crosswalkVersion: ri.crosswalkVersion,
      representations: fresh(ri.representations),
      coverage: fresh(ri.coverage),
      regions: sorted(byRegion.keys()).map((key) => {
        const s = structures.get(key)!;
        return {
          key,
          representation: s.representation,
          structureId: s.structureId,
          structureName: s.structureName,
          paperIds: sorted(byRegion.get(key)!.keys()),
          href: apiHref(at.regionIndex, at.region(key)),
        };
      }),
      papers: ri.papers.map((p) => ({
        paperId: p.paperId,
        regionKeys: sorted(byPaper.get(p.paperId)?.keys() ?? []),
        emptyBecause: [...new Set(p.emptyBecause.map((e) => e.code))].sort(),
        href: apiHref(at.regionIndex, at.paperRegions(p.paperId)),
      })),
    }),

    region: (key) => {
      const linked = byRegion.get(key);
      if (!linked) return null;
      const s = structures.get(key)!;
      return {
        ...head('region', 'assets'),
        datasetVersion: ri.datasetVersion,
        crosswalkVersion: ri.crosswalkVersion,
        key,
        representation: s.representation,
        structureId: s.structureId,
        structureName: s.structureName,
        papers: sorted(linked.keys()).map((paperId) => ({
          paperId,
          href: apiHref(at.region(key), at.paper(paperId)),
          links: fresh(linked.get(paperId)!),
        })),
      };
    },

    paperRegions: (paperId) => {
      const outcome = outcomes.get(paperId);
      if (!outcome) return null;
      const linked = byPaper.get(paperId) ?? new Map<string, RegionLink[]>();
      return {
        ...head('paper-regions', 'assets'),
        datasetVersion: ri.datasetVersion,
        crosswalkVersion: ri.crosswalkVersion,
        paperId,
        paperHref: apiHref(at.paperRegions(paperId), at.paper(paperId)),
        regions: sorted(linked.keys()).map((key) => ({
          key,
          structureName: structures.get(key)!.structureName,
          href: apiHref(at.paperRegions(paperId), at.region(key)),
          links: fresh(linked.get(key)!),
        })),
        emptyBecause: fresh(outcome.emptyBecause),
      };
    },
  };
}

/**
 * Both halves, over a dataset and the region index built from it.
 *
 * Refuses a region index built from another dataset, or listing other papers:
 * the join would pair one corpus's papers with another's links, and nothing
 * downstream could tell. Every answer is a fresh plain object, safe to
 * serialise or mutate.
 */
export function createResearchApi(input: { dataset: ResearchDataset; regionIndex: SerialisedRegionIndex }): ResearchApi {
  const { dataset, regionIndex: ri } = input;
  if (ri.datasetVersion !== dataset.version) {
    throw new Error(
      `api: the region index was built from dataset ${JSON.stringify(ri.datasetVersion)}, not ${JSON.stringify(dataset.version)}. ` +
        'Regenerate it (node tools/check-crosswalk.mjs --write) before building the API.',
    );
  }
  const inDataset = sorted(dataset.papers.map((p) => p.id));
  const inIndex = sorted(ri.papers.map((p) => p.paperId));
  if (inDataset.join('\n') !== inIndex.join('\n')) {
    throw new Error(
      `api: the dataset and the region index list different papers ` +
        `(only in the dataset: ${inDataset.filter((x) => !inIndex.includes(x)).join(', ') || 'none'}; ` +
        `only in the index: ${inIndex.filter((x) => !inDataset.includes(x)).join(', ') || 'none'}).`,
    );
  }
  return { ...createPaperApi(dataset), ...createRegionApi(ri) };
}

/**
 * Every document an API serves, by tree and path. What the build writes, and
 * the list the contract check walks: a document missing from here is a 404,
 * and a file on disk not in here is an endpoint nobody answers for. Given one
 * half, it lists that half's tree.
 */
export function apiDocuments(api: PaperApi | RegionApi | ResearchApi): { tree: ApiTree; path: string; body: ApiDocument }[] {
  const out: { tree: ApiTree; path: string; body: ApiDocument | null }[] = [];
  if ('index' in api) {
    const index = api.index();
    out.push(
      { tree: 'data', path: apiPaths.index(), body: index },
      ...index.papers.map((p) => ({ tree: 'data' as const, path: apiPaths.paper(p.id), body: api.paper(p.id) })),
    );
  }
  if ('regionIndex' in api) {
    const regionIndex = api.regionIndex();
    out.push(
      { tree: 'assets', path: apiPaths.index(), body: regionIndex },
      ...regionIndex.regions.map((r) => ({ tree: 'assets' as const, path: apiPaths.region(r.key), body: api.region(r.key) })),
      ...regionIndex.papers.map((p) => ({ tree: 'assets' as const, path: apiPaths.paperRegions(p.paperId), body: api.paperRegions(p.paperId) })),
    );
  }
  for (const d of out) if (!d.body) throw new Error(`api: the index lists ${d.tree}/${d.path}, and its query answers nothing.`);
  return out as { tree: ApiTree; path: string; body: ApiDocument }[];
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The static API, read over HTTP. `dataRoot` and `assetsRoot` are the two
 * tree roots as absolute URLs (`atlas-index.json` publishes both under the
 * site's base). A 404 is `null`, as the local answer is; any other failure,
 * and any document that does not validate, throws.
 */
export function createStaticApiClient(options: { dataRoot: string; assetsRoot: string; fetch?: Fetch }): ResearchApiClient {
  const doFetch: Fetch = options.fetch ?? ((url) => globalThis.fetch(url));
  const roots: Record<ApiTree, string> = { data: options.dataRoot, assets: options.assetsRoot };
  for (const [tree, root] of Object.entries(roots)) {
    if (!root.endsWith('/')) throw new Error(`api: ${tree}Root ${JSON.stringify(root)} must end in "/".`);
  }
  async function get<T extends ApiDocument>(tree: ApiTree, path: string, kind: T['kind']): Promise<T | null> {
    const url = new URL(path, roots[tree]).href;
    const res = await doFetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`api: GET ${url} answered ${res.status}.`);
    const body = await res.json();
    const problems = validateApiDocument(body);
    if ((body as { kind?: unknown })?.kind !== kind) problems.unshift(`expected kind ${kind}.`);
    if (problems.length > 0) throw new Error(`api: ${url} is not a valid ${kind} document:\n  ${problems.join('\n  ')}`);
    return body as T;
  }
  const must = <T>(x: T | null, what: string): T => {
    if (x === null) throw new Error(`api: ${what} is missing (404).`);
    return x;
  };
  return {
    index: async () => must(await get<ApiIndex>('data', apiPaths.index(), 'index'), 'the data index'),
    paper: (id) => get<ApiPaper>('data', apiPaths.paper(id), 'paper'),
    regionIndex: async () => must(await get<ApiRegionIndex>('assets', apiPaths.index(), 'region-index'), 'the region index'),
    region: (key) => get<ApiRegion>('assets', apiPaths.region(key), 'region'),
    paperRegions: (id) => get<ApiPaperRegions>('assets', apiPaths.paperRegions(id), 'paper-regions'),
  };
}

// ---------------------------------------------------------------------------
// Validation: schema/api-1.md, executable
// ---------------------------------------------------------------------------

const HOWS: readonly LinkHow[] = ['exact-term', 'crosswalk', 'coordinate'];
const UNPLACED_CODES: readonly UnplacedCode[] = [
  'structure-held',
  'not-in-representation',
  'no-crosswalk-entry',
  'representation-absent',
  'space-not-registered',
  'frame-has-no-mesh',
  'no-locator',
  'coordinate-outside-shipped-structures',
];

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Everything wrong with an API document, as lines. Empty means it conforms to
 * `schema/api-1.md`. Unknown fields are errors: a field the schema does not
 * name is one no consumer was promised.
 */
export function validateApiDocument(doc: unknown): string[] {
  const problems: string[] = [];
  const say = (where: string, what: string) => problems.push(`${where}: ${what}`);

  const fields = (x: unknown, where: string, required: readonly string[], optional: readonly string[] = []): x is Obj => {
    if (!isObj(x)) {
      say(where, `is ${Array.isArray(x) ? 'an array' : typeof x}, expected an object.`);
      return false;
    }
    for (const k of required) if (!(k in x)) say(where, `is missing \`${k}\`.`);
    for (const k of Object.keys(x)) if (!required.includes(k) && !optional.includes(k)) say(where, `has \`${k}\`, which the schema does not name.`);
    return true;
  };
  const str = (x: unknown, where: string, nonEmpty = true) => {
    if (typeof x !== 'string' || (nonEmpty && x.length === 0)) say(where, `must be a ${nonEmpty ? 'non-empty ' : ''}string.`);
  };
  const num = (x: unknown, where: string) => {
    if (typeof x !== 'number' || !Number.isFinite(x)) say(where, 'must be a finite number.');
  };
  const arr = (x: unknown, where: string, each: (v: unknown, w: string) => void) => {
    if (!Array.isArray(x)) say(where, 'must be an array.');
    else x.forEach((v, i) => each(v, `${where}[${i}]`));
  };
  const href = (x: unknown, where: string, ext: '.json' | '.md' = '.json') => {
    if (typeof x !== 'string' || !x.endsWith(ext) || /^[a-z][a-z0-9+.-]*:|^\/|\\|\/\/|(^|\/)\.(\/|$)/i.test(x)) {
      say(where, `must be a relative link to a ${ext} document (no scheme, no leading /, no ./), got ${JSON.stringify(x)}.`);
    }
  };
  const sortedUnique = (x: unknown, where: string) => {
    if (Array.isArray(x)) {
      for (let i = 1; i < x.length; i += 1) if (!(String(x[i - 1]) < String(x[i]))) say(where, 'must be sorted and without duplicates.');
    }
  };
  const link = (l: unknown, where: string) => {
    if (!fields(l, where, ['mappingId', 'findingId', 'paperId', 'representation', 'structureId', 'structureName', 'side', 'sideFromSource', 'how', 'precision', 'source'], ['crosswalk', 'coordinate'])) return;
    for (const k of ['mappingId', 'findingId', 'paperId', 'representation', 'structureId', 'structureName']) str(l[k], `${where}.${k}`);
    if (!(l.side === null || ['left', 'right', 'median'].includes(l.side as string))) say(`${where}.side`, 'must be left, right, median or null.');
    if (typeof l.sideFromSource !== 'boolean') say(`${where}.sideFromSource`, 'must be a boolean.');
    if (!HOWS.includes(l.how as LinkHow)) say(`${where}.how`, `must be one of ${HOWS.join(', ')}.`);
    const p = l.precision;
    if (isObj(p)) {
      if (p.kind === 'exact') fields(p, `${where}.precision`, ['kind']);
      else if (p.kind === 'approximate') fields(p, `${where}.precision`, ['kind', 'why']) && str(p.why, `${where}.precision.why`);
      else if (p.kind === 'mm') {
        if (fields(p, `${where}.precision`, ['kind', 'mm', 'basis'])) {
          num(p.mm, `${where}.precision.mm`);
          str(p.basis, `${where}.precision.basis`);
        }
      } else say(`${where}.precision.kind`, 'must be exact, approximate or mm.');
      // The pairing is the point of `how`: a coordinate is never exact, a crosswalk never exact.
      const want = { 'exact-term': 'exact', crosswalk: 'approximate', coordinate: 'mm' }[l.how as LinkHow];
      if (want && p.kind !== want) say(where, `how ${String(l.how)} goes with precision ${want}, not ${String(p.kind)}.`);
    } else say(`${where}.precision`, 'must be an object.');
    if (fields(l.source, `${where}.source`, ['scheme', 'term', 'label'])) {
      for (const k of ['scheme', 'term', 'label']) str((l.source as Obj)[k], `${where}.source.${k}`);
    }
    if (l.crosswalk !== undefined && fields(l.crosswalk, `${where}.crosswalk`, ['completeness', 'heldTargets'])) {
      const c = l.crosswalk as Obj;
      if (!['same', 'parts', 'overlaps'].includes(c.completeness as string)) say(`${where}.crosswalk.completeness`, 'must be same, parts or overlaps.');
      arr(c.heldTargets, `${where}.crosswalk.heldTargets`, (v, w) => str(v, w));
    }
    if ((l.how === 'coordinate') !== (l.coordinate !== undefined)) say(where, 'carries `coordinate` exactly when how is coordinate.');
    if (l.coordinate !== undefined && fields(l.coordinate, `${where}.coordinate`, ['from', 'mniMm', 'depthMm'], ['address'])) {
      const c = l.coordinate as Obj;
      if (!['coordinates', 'cell'].includes(c.from as string)) say(`${where}.coordinate.from`, 'must be coordinates or cell.');
      if (!Array.isArray(c.mniMm) || c.mniMm.length !== 3) say(`${where}.coordinate.mniMm`, 'must be three numbers.');
      else c.mniMm.forEach((v, i) => num(v, `${where}.coordinate.mniMm[${i}]`));
      num(c.depthMm, `${where}.coordinate.depthMm`);
      if (c.address !== undefined) str(c.address, `${where}.coordinate.address`);
    }
  };
  const emptyBecause = (x: unknown, where: string) =>
    arr(x, where, (e, w) => {
      if (!fields(e, w, ['code', 'detail', 'mappingIds'])) return;
      if (!UNPLACED_CODES.includes(e.code as UnplacedCode)) say(`${w}.code`, `must be one of ${UNPLACED_CODES.join(', ')}.`);
      str(e.detail, `${w}.detail`);
      arr(e.mappingIds, `${w}.mappingIds`, (v, ww) => str(v, ww));
    });
  const licenceRef = (x: unknown, where: string) => {
    if (fields(x, where, ['href', 'licence'])) {
      href(x.href, `${where}.href`);
      if (x.licence !== API_LICENCES.assets) say(`${where}.licence`, `must be ${API_LICENCES.assets}.`);
    }
  };

  const KINDS: Record<string, { tree: ApiTree; required: readonly string[] }> = {
    index: { tree: 'data', required: ['datasetVersion', 'papers', 'regionIndex'] },
    paper: { tree: 'data', required: ['datasetVersion', 'paper', 'findings', 'regions'] },
    'region-index': {
      tree: 'assets',
      required: ['attributionHref', 'datasetVersion', 'crosswalkVersion', 'representations', 'coverage', 'regions', 'papers'],
    },
    region: { tree: 'assets', required: ['datasetVersion', 'crosswalkVersion', 'key', 'representation', 'structureId', 'structureName', 'papers'] },
    'paper-regions': { tree: 'assets', required: ['datasetVersion', 'crosswalkVersion', 'paperId', 'paperHref', 'regions', 'emptyBecause'] },
  };
  if (!isObj(doc)) return ['document: must be an object.'];
  const kind = KINDS[doc.kind as string];
  if (!kind) return [`document: kind ${JSON.stringify(doc.kind)} is not one of ${Object.keys(KINDS).join(', ')}.`];
  const d = doc;
  if (!fields(d, String(d.kind), ['schema', 'kind', 'licence', ...kind.required])) return problems;
  if (d.schema !== API_SCHEMA) say('schema', `must be ${API_SCHEMA}.`);
  if (d.licence !== API_LICENCES[kind.tree]) {
    say('licence', `a ${String(d.kind)} document ships in the ${kind.tree} tree and is ${API_LICENCES[kind.tree]}, not ${JSON.stringify(d.licence)}.`);
  }
  str(d.datasetVersion, 'datasetVersion');
  if (kind.tree === 'assets') str(d.crosswalkVersion, 'crosswalkVersion');

  switch (d.kind) {
    case 'index':
      arr(d.papers, 'papers', (p, w) => {
        if (!fields(p, w, ['id', 'title', 'year', 'href', 'regionsHref'])) return;
        str(p.id, `${w}.id`);
        str(p.title, `${w}.title`);
        num(p.year, `${w}.year`);
        href(p.href, `${w}.href`);
        href(p.regionsHref, `${w}.regionsHref`);
      });
      licenceRef(d.regionIndex, 'regionIndex');
      break;
    case 'paper':
      if (fields(d.paper, 'paper', ['id', 'title', 'authors', 'year', 'venue', 'identifier', 'sourceUrl', 'provenance'])) {
        str(d.paper.id, 'paper.id');
        str(d.paper.title, 'paper.title');
      }
      arr(d.findings, 'findings', (f, w) => {
        if (!fields(f, w, ['id', 'paperId', 'statement', 'topics', 'mappings', 'provenance'])) return;
        if (isObj(d.paper) && f.paperId !== d.paper.id) say(`${w}.paperId`, `is ${JSON.stringify(f.paperId)}, not this paper.`);
        arr(f.mappings, `${w}.mappings`, (m, mw) => {
          fields(m, mw, ['id', 'structureId', 'structureIdSource', 'structureLabel', 'spatial', 'evidence', 'provenance']);
        });
      });
      licenceRef(d.regions, 'regions');
      break;
    case 'region-index':
      href(d.attributionHref, 'attributionHref', '.md');
      arr(d.representations, 'representations', (r, w) => {
        if (fields(r, w, ['id', 'version'])) {
          str(r.id, `${w}.id`);
          str(r.version, `${w}.version`);
        }
      });
      fields(d.coverage, 'coverage', ['mappings', 'papers']);
      arr(d.regions, 'regions', (r, w) => {
        if (!fields(r, w, ['key', 'representation', 'structureId', 'structureName', 'paperIds', 'href'])) return;
        for (const k of ['key', 'representation', 'structureId', 'structureName']) str(r[k], `${w}.${k}`);
        if (r.key !== `${String(r.representation)}/${String(r.structureId)}`) say(`${w}.key`, 'must be representation/structureId.');
        arr(r.paperIds, `${w}.paperIds`, (v, ww) => str(v, ww));
        sortedUnique(r.paperIds, `${w}.paperIds`);
        if (Array.isArray(r.paperIds) && r.paperIds.length === 0) say(`${w}.paperIds`, 'is empty; a listed region has at least one paper.');
        href(r.href, `${w}.href`);
      });
      sortedUnique(Array.isArray(d.regions) ? d.regions.map((r) => (isObj(r) ? r.key : '')) : null, 'regions[].key');
      arr(d.papers, 'papers', (p, w) => {
        if (!fields(p, w, ['paperId', 'regionKeys', 'emptyBecause', 'href'])) return;
        str(p.paperId, `${w}.paperId`);
        arr(p.regionKeys, `${w}.regionKeys`, (v, ww) => str(v, ww));
        sortedUnique(p.regionKeys, `${w}.regionKeys`);
        arr(p.emptyBecause, `${w}.emptyBecause`, (v, ww) => {
          if (!UNPLACED_CODES.includes(v as UnplacedCode)) say(ww, `must be one of ${UNPLACED_CODES.join(', ')}.`);
        });
        const n = Array.isArray(p.regionKeys) ? p.regionKeys.length : -1;
        const e = Array.isArray(p.emptyBecause) ? p.emptyBecause.length : -1;
        if ((n === 0) !== (e > 0)) say(w, 'has regions or a stated reason for none, exactly one of the two.');
        href(p.href, `${w}.href`);
      });
      break;
    case 'region':
      for (const k of ['key', 'representation', 'structureId', 'structureName']) str(d[k], k);
      if (d.key !== `${String(d.representation)}/${String(d.structureId)}`) say('key', 'must be representation/structureId.');
      arr(d.papers, 'papers', (p, w) => {
        if (!fields(p, w, ['paperId', 'href', 'links'])) return;
        str(p.paperId, `${w}.paperId`);
        href(p.href, `${w}.href`);
        arr(p.links, `${w}.links`, (l, lw) => {
          link(l, lw);
          if (isObj(l) && (l.paperId !== p.paperId || `${String(l.representation)}/${String(l.structureId)}` !== d.key)) {
            say(lw, 'links another paper or another region than the one it is listed under.');
          }
        });
        if (Array.isArray(p.links) && p.links.length === 0) say(`${w}.links`, 'is empty; a listed paper is reached by at least one link.');
      });
      sortedUnique(Array.isArray(d.papers) ? d.papers.map((p) => (isObj(p) ? p.paperId : '')) : null, 'papers[].paperId');
      if (Array.isArray(d.papers) && d.papers.length === 0) say('papers', 'is empty; a region with no paper has no document.');
      break;
    case 'paper-regions':
      str(d.paperId, 'paperId');
      href(d.paperHref, 'paperHref');
      arr(d.regions, 'regions', (r, w) => {
        if (!fields(r, w, ['key', 'structureName', 'href', 'links'])) return;
        str(r.key, `${w}.key`);
        str(r.structureName, `${w}.structureName`);
        href(r.href, `${w}.href`);
        arr(r.links, `${w}.links`, (l, lw) => {
          link(l, lw);
          if (isObj(l) && (l.paperId !== d.paperId || `${String(l.representation)}/${String(l.structureId)}` !== r.key)) {
            say(lw, 'links another paper or another region than the one it is listed under.');
          }
        });
        if (Array.isArray(r.links) && r.links.length === 0) say(`${w}.links`, 'is empty; a listed region is reached by at least one link.');
      });
      sortedUnique(Array.isArray(d.regions) ? d.regions.map((r) => (isObj(r) ? r.key : '')) : null, 'regions[].key');
      emptyBecause(d.emptyBecause, 'emptyBecause');
      if (Array.isArray(d.regions) && Array.isArray(d.emptyBecause) && (d.regions.length === 0) !== (d.emptyBecause.length > 0)) {
        say('paper-regions', 'has regions or a stated reason for none, exactly one of the two.');
      }
      break;
  }
  return problems;
}
