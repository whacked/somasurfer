/**
 * The research API contract (DOG-131): every response the static site serves
 * equals the library's answer to the same query.
 *
 *   node tools/check-research-api-contract.mjs [--dist <dir>]
 *
 * Run after the site build. `dist/` is served over HTTP at the base it was
 * built for (read from its build-manifest.json), on a port the OS picks, and
 * read back through `createStaticApiClient` starting from nothing but
 * `<base>data/atlas-index.json`. So a build at `--base /somasurfer/` is checked
 * at `/somasurfer/`, the way Pages serves it, and a link or root that only works
 * at `/` fails here.
 *
 * The library's answer is computed independently of everything that was
 * served: the seed, and a region index resolved afresh from its inputs
 * (`buildRegionIndex`, as check-crosswalk.mjs does), never the committed index
 * or the committed tree.
 *
 * Asserted, and able to go red:
 *
 *   1. For every query — the two indexes, every paper, every paper's regions,
 *      every linked region, and a paper and a region that do not exist — the
 *      served answer deep-equals the library's. A missing document is a 404,
 *      which is `null`, and equals only a `null`.
 *   2. Every served document validates (the client refuses one that does not).
 *   3. Every relative link in every served document resolves, over HTTP, under
 *      the base, to a 200.
 *   4. Every file under the two API roots in dist/ is reached by some query: no
 *      endpoint is served that the library does not answer for.
 *   5. The check can fail: before trusting a pass, it runs once against a
 *      server that alters one document, and requires a mismatch.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, normalize, relative, resolve, sep } from 'node:path';

import { REPO_ROOT, fail, pass, rel } from './lib/repo.mjs';
import { loadRegionInputs } from './lib/region-inputs.mjs';
import {
  API_ROOTS,
  apiPaths,
  buildRegionIndex,
  createResearchApi,
  createStaticApiClient,
  serialiseRegionIndex,
} from '../packages/atlas-research/src/index.ts';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const DIST = resolve(REPO_ROOT, arg('dist', join('packages', 'atlas-web', 'dist')));

if (!existsSync(join(DIST, 'build-manifest.json'))) {
  fail('research api contract', [`${rel(DIST)} is not built. Run node packages/atlas-web/build.mjs first.`]);
}
const BASE = JSON.parse(readFileSync(join(DIST, 'build-manifest.json'), 'utf8')).base;

// ---------------------------------------------------------------------------
// A static server for dist/, at BASE and nowhere else
// ---------------------------------------------------------------------------

/** `alter(path, text)` lets the self-test serve one document changed. */
function serve(alter = null) {
  const served = new Set();
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!path.startsWith(BASE)) {
      res.writeHead(404).end();
      return;
    }
    const abs = normalize(join(DIST, path.slice(BASE.length)));
    if (!abs.startsWith(DIST + sep) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const r = relative(DIST, abs).split(sep).join('/');
    served.add(r);
    let body = readFileSync(abs);
    if (alter) body = Buffer.from(alter(r, body.toString('utf8')));
    res.writeHead(200, { 'content-type': abs.endsWith('.json') ? 'application/json' : 'application/octet-stream' }).end(body);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ origin: `http://127.0.0.1:${server.address().port}`, server, served })));
}

// ---------------------------------------------------------------------------
// The library's answers, from inputs
// ---------------------------------------------------------------------------

const inputs = loadRegionInputs();
const live = buildRegionIndex(inputs);
// Through JSON, as a consumer holding the serialised index would have it.
const library = createResearchApi({
  dataset: inputs.dataset,
  regionIndex: JSON.parse(JSON.stringify(serialiseRegionIndex(live))),
});

const queries = [
  ['index', []],
  ['regionIndex', []],
  ...inputs.dataset.papers.flatMap((p) => [
    ['paper', [p.id]],
    ['paperRegions', [p.id]],
  ]),
  ...live.structures.map((s) => ['region', [s.key]]),
  // Absent on both sides: a paper nobody curated, and a shipped structure no paper reaches.
  ['paper', ['paper:no-such-paper']],
  ['paperRegions', ['paper:no-such-paper']],
];
const unlinked = inputs.representations
  .flatMap((d) => d.structures.map((s) => `${d.representation.id}/${s.id}`))
  .find((k) => !live.structures.some((s) => s.key === k));
if (unlinked) queries.push(['region', [unlinked]]);

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

/** A document's path in its tree, for resolving its links: the library's own layout. */
const pathOf = (q, a) => (q === 'index' || q === 'regionIndex' ? apiPaths.index() : apiPaths[q](a));

async function compare(origin, served = new Set()) {
  const problems = [];
  const indexUrl = `${origin}${BASE}data/atlas-index.json`;
  const res = await fetch(indexUrl);
  if (!res.ok) return { problems: [`${indexUrl} answered ${res.status}.`], answered: 0, hrefs: 0, reached: new Set() };
  const roots = (await res.json()).researchApi;
  for (const [k, tree] of [['dataRoot', 'data'], ['assetsRoot', 'assets']]) {
    if (roots?.[k] !== `${BASE}${API_ROOTS[tree]}`) problems.push(`atlas-index.json researchApi.${k} is ${JSON.stringify(roots?.[k])}, not ${BASE}${API_ROOTS[tree]}.`);
  }
  if (problems.length > 0) return { problems, answered: 0, hrefs: 0, reached: new Set() };

  const client = createStaticApiClient({
    dataRoot: `${origin}${roots.dataRoot}`,
    assetsRoot: `${origin}${roots.assetsRoot}`,
    transport: (url) => fetch(url),
  });
  const urls = new Map();
  let answered = 0;
  for (const [q, args] of queries) {
    const want = library[q](...args);
    let got;
    try {
      got = await client[q](...args);
    } catch (err) {
      problems.push(`${q}(${args.join(', ')}): the served document was refused: ${err.message}`);
      continue;
    }
    if (!isDeepStrictEqual(got, want)) {
      problems.push(`${q}(${args.join(', ')}): the served answer differs from the library's${want === null ? ' (the library has none)' : got === null ? ' (404)' : ''}.`);
      continue;
    }
    if (got !== null) answered += 1;
    // Where this document was served from, for its relative links.
    if (got !== null) {
      const tree = ['index', 'paper'].includes(q) ? 'dataRoot' : 'assetsRoot';
      const docUrl = new URL(pathOf(q, args[0]), `${origin}${roots[tree]}`).href;
      JSON.stringify(got, (k, v) => {
        if (typeof v === 'string' && /href$/i.test(k)) urls.set(new URL(v, docUrl).href, docUrl);
        return v;
      });
    }
  }
  // What the queries reached, before link-following adds anything.
  const reached = new Set(served);
  for (const [url, from] of urls) {
    const r = await fetch(url);
    if (!r.ok) problems.push(`${from} links ${url}, which answered ${r.status}.`);
  }
  return { problems, answered, hrefs: urls.size, reached };
}

/** Every file under the two roots in dist/. */
function apiFiles() {
  const out = [];
  for (const root of Object.values(API_ROOTS)) {
    const walk = (d) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(relative(DIST, p).split(sep).join('/'));
      }
    };
    walk(join(DIST, root));
  }
  return out.sort();
}

// 5. Self-test first: a server that serves one region document with a link
//    dropped must produce a mismatch, or a pass below means nothing.
{
  const target = `${API_ROOTS.assets}${apiPaths.region(live.structures[0].key)}`;
  const { origin, server } = await serve((path, text) => {
    if (path !== target) return text;
    const doc = JSON.parse(text);
    doc.papers[0].links.pop();
    if (doc.papers[0].links.length === 0) doc.papers[0].links.push({ ...JSON.parse(text).papers[0].links[0], mappingId: 'map:altered' });
    return JSON.stringify(doc);
  });
  const { problems } = await compare(origin);
  server.close();
  if (!problems.some((p) => p.startsWith(`region(${live.structures[0].key})`))) {
    fail('research api contract', [`self-test: ${target} served altered, and the check found no difference. It cannot go red.`]);
  }
}

const { origin, server, served } = await serve();
const { problems, answered, hrefs, reached } = await compare(origin, served);
server.close();

const files = apiFiles();
const unreached = files.filter((f) => !reached.has(f));
for (const f of unreached) problems.push(`${f} is in dist/ and no query reached it: an endpoint the library does not answer for.`);

if (problems.length > 0) fail('research api contract', problems);

pass('research api contract', [
  `served ${rel(DIST)} at base ${BASE} on ${origin}, and read it back from ${BASE}data/atlas-index.json alone.`,
  `${queries.length} queries: ${answered} documents equal the library's answer, ${queries.length - answered} absent on both sides (404 = null).`,
  `  the library answered from the seed and a region index resolved afresh from its inputs, not from anything served.`,
  `${hrefs} distinct relative links followed under ${BASE}, all 200.`,
  `every one of the ${files.length} files under ${API_ROOTS.data} and ${API_ROOTS.assets} was reached by a query.`,
  `self-test: a region document served with a link dropped is caught.`,
]);
