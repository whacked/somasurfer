/**
 * DOG-133 (Atlas v2 W8a): the plan §6 browser rows, against the built page.
 *
 *   source /paperclip/qa-browser/env.sh
 *   node packages/atlas-qa/browser/w8a-acceptance-dom.mjs [--out w8a-evidence] [--only picking]
 *
 * Rows decided here, each pass | fail | unverified (never anything else):
 *   nav            both atlases one click from the landing page and from each other
 *   picking        the 40 W2 fixture structures render (pixel counts) and pick
 *                  back to their own key and `expect.name`; withheld controls do not
 *   body           the body renders a full human
 *   paper-regions  each of the 30 papers is non-empty or carries a stated reason
 *   region-papers  every linked structure round-trips through both API answers
 *
 * How a pick is judged (DOG-133 comments, CTO rule of DOG-143): 17 left/right
 * pairs share one `expect.name`, so a name match alone cannot tell a pick of
 * one side from the other. Each entry is drawn with only its category
 * isolated, and its other hemisphere hidden when it has one. Its own pixels are the difference
 * between that view with and without the entry selected (selection draws the
 * structure through whatever is in front). A pick passes only if a click on
 * one of those pixels, through the page's own pointer path, selects that
 * entry's key and the panel names `expect.name`. Clicking the same spot again
 * reaches the structure behind (DOG-192), so a pick may take several clicks on
 * one pixel; the count is recorded, and 1 means the first click. Every pick
 * found through `pickAt` is then repeated with real, slightly jittery mouse
 * taps, because the pointer path (wireCanvas) is where a tap's camera and
 * point are decided, and `pickAt` does not go through it.
 */

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ROOT, launch } from './lib.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const OUT = join(ROOT, arg('out') ?? 'w8a-evidence');
const ONLY = arg('only')?.split(',') ?? null;
const DIST = join(ROOT, 'packages', 'atlas-web', 'dist');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'packages', 'atlas-qa', 'fixtures', 'brain-structure-sample.json'), 'utf8'));
mkdirSync(join(OUT, 'shots'), { recursive: true });

// listen(0): a fixed port silently served another worktree's build once.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try {
    const body = await readFile(join(DIST, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
const rows = [];
const row = (id, status, detail, evidence = {}) => {
  if (!['pass', 'fail', 'unverified'].includes(status)) throw new Error(`bad status ${status}`);
  rows.push({ id, status, detail, evidence });
  console.log(`${status.toUpperCase().padEnd(10)} ${id}: ${detail}`);
};
const want = (id) => !ONLY || ONLY.includes(id);

async function open(search) {
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`http ${r.status()} ${r.url()}`); });
  await page.goto(BASE + search, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__atlas?.ready === true, null, { timeout: 60000 });
  // A pinned canvas height, so a shot and a click see the same pixels.
  await page.addStyleTag({ content: '[data-testid=canvas]{height:700px!important}' });
  await page.evaluate(() => window.__atlas.meshesLoaded);
  return { page, errors };
}

/**
 * A control clicked through the DOM, so its own handler runs. The pinned canvas
 * overlaps the side panel, and a pointer click there lands on the canvas.
 */
const press = (page, testid) => page.$eval(`[data-testid=${testid}]`, (el) => el.click());
const uncheck = (page, testid) => page.$eval(`[data-testid=${testid}]`, (el) => { if (el.checked && !el.disabled) el.click(); });

/** A real pointer drag on the canvas: `rotate` turns 0.008 rad per pixel. */
async function drag(page, dx, dy) {
  const b = await page.locator('[data-testid=canvas]').boundingBox();
  const x = b.x + b.width / 2; const y = b.y + b.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
}
const QUARTER = Math.round(Math.PI / 2 / 0.008);
const VIEWS = [
  { name: 'default' },
  { name: 'yaw+90', dx: QUARTER }, { name: 'yaw+180', dx: 2 * QUARTER }, { name: 'yaw-90', dx: -QUARTER },
  { name: 'from below', dy: -QUARTER }, { name: 'from above', dy: QUARTER },
];

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))));

async function shot(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  // A clip of the page, not an element shot: the element never reads as
  // "stable" while the page redraws, and the clip is the same pixels.
  const b = await page.locator('[data-testid=canvas]').boundingBox();
  return page.screenshot({ clip: { x: b.x, y: b.y, width: b.width, height: b.height }, animations: 'allow', timeout: 180000 });
}

/** Pixels that differ between two shots, plus up to `k` points deepest inside that mask. */
function maskOf(page, a, b, k = 12) {
  return page.evaluate(async ([pa, pb, k]) => {
    const load = async (b64) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return { w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data };
    };
    const A = await load(pa); const B = await load(pb);
    if (A.w !== B.w || A.h !== B.h) return { error: `size ${A.w}x${A.h} vs ${B.w}x${B.h}` };
    const { w, h } = A; const m = new Uint8Array(w * h); let n = 0;
    for (let i = 0; i < w * h; i += 1) {
      const j = i * 4;
      if (Math.abs(A.d[j] - B.d[j]) + Math.abs(A.d[j + 1] - B.d[j + 1]) + Math.abs(A.d[j + 2] - B.d[j + 2]) > 24) { m[i] = 1; n += 1; }
    }
    // Chessboard distance to the mask edge, two passes: deepest points first.
    const dist = new Uint16Array(w * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const i = y * w + x; if (!m[i]) continue;
      const up = y > 0 ? dist[i - w] : 0; const left = x > 0 ? dist[i - 1] : 0;
      const ul = y > 0 && x > 0 ? dist[i - w - 1] : 0; const ur = y > 0 && x < w - 1 ? dist[i - w + 1] : 0;
      dist[i] = 1 + Math.min(up, left, ul, ur);
    }
    for (let y = h - 1; y >= 0; y -= 1) for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x; if (!m[i]) continue;
      const dn = y < h - 1 ? dist[i + w] : 0; const right = x < w - 1 ? dist[i + 1] : 0;
      const dl = y < h - 1 && x > 0 ? dist[i + w - 1] : 0; const dr = y < h - 1 && x < w - 1 ? dist[i + w + 1] : 0;
      dist[i] = Math.min(dist[i], 1 + Math.min(dn, right, dl, dr));
    }
    // Spread the candidates out: take the deepest, then suppress its neighbourhood.
    const order = [];
    for (let i = 0; i < w * h; i += 1) if (m[i]) order.push(i);
    order.sort((p, q) => dist[q] - dist[p]);
    const points = [];
    for (const i of order) {
      const x = i % w; const y = (i - x) / w;
      if (points.every((p) => Math.abs(p.x - x) > 6 || Math.abs(p.y - y) > 6)) points.push({ x, y, depth: dist[i] });
      if (points.length >= k) break;
    }
    return { width: w, height: h, changed: n, points };
  }, [a.toString('base64'), b.toString('base64'), k]);
}

/** Painted pixels against an all-layers-hidden view of the same camera. */
async function paintedAgainstEmpty(page, atlas) {
  const full = await shot(page);
  const ids = await page.$$eval('[data-testid^=layer-toggle-]', (ns) => ns.map((n) => n.dataset.testid));
  for (const id of ids) await uncheck(page, id);
  const empty = await shot(page);
  await press(page, 'reset-layers');
  const d = await maskOf(page, empty, full, 1);
  return { painted: d.changed, width: d.width, height: d.height, atlas, full };
}

// ---------------------------------------------------------------------------
// nav: both atlases one click away, from the landing page and from each other
// ---------------------------------------------------------------------------
if (want('nav')) {
  const { page, errors } = await open('');
  const landing = await page.evaluate(() => window.__atlas.viewer.atlas);
  const navs = await page.$$eval('[data-testid^=nav-]', (ns) => ns.map((n) => ({ id: n.dataset.testid, href: n.getAttribute('href'), text: n.textContent.trim() })));
  const steps = [];
  const clickTo = async (target) => {
    await page.click(`[data-testid=nav-${target}]`);
    await page.waitForFunction(() => window.__atlas?.ready === true, null, { timeout: 60000 });
    const atlas = await page.evaluate(() => window.__atlas.viewer.atlas);
    steps.push({ clicked: `nav-${target}`, atlas, url: page.url().replace(BASE, '/') });
    return atlas === target;
  };
  const okFromLanding = { brain: await clickTo('brain') };
  const brainToBody = await clickTo('body');
  const bodyToBrain = await clickTo('brain');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__atlas?.ready === true, null, { timeout: 60000 });
  okFromLanding.body = await clickTo('body');
  const ok = okFromLanding.brain && okFromLanding.body && brainToBody && bodyToBrain;
  row('nav', ok ? 'pass' : 'fail', `landing on ${landing}; landing→brain ${okFromLanding.brain}, landing→body ${okFromLanding.body}, brain→body ${brainToBody}, body→brain ${bodyToBrain}, one click each`, { navs, steps, errors });
  await page.close();
}

// ---------------------------------------------------------------------------
// picking: the 40, then the withheld controls
// ---------------------------------------------------------------------------
if (want('picking')) {
  const { page, errors } = await open('?atlas=brain');
  const status = await page.evaluate(() => window.__atlas.meshStatus());
  const drawn = await page.evaluate(() => window.__atlas.structures('brain'));
  const overall = await paintedAgainstEmpty(page, 'brain');
  writeFileSync(join(OUT, 'shots', 'brain-default.png'), overall.full);
  const results = [];
  // --ids 346,74: a subset, for debugging the driver; the row then cannot pass.
  const ids = arg('ids')?.split(',').map(Number) ?? null;
  for (const e of FIXTURE.sample.filter((x) => !ids || ids.includes(x.id))) {
    const key = drawn.find((s) => s.key.endsWith(`.${e.id}`) && s.name === e.name)?.key ?? null;
    const r = { id: e.id, name: e.name, category: e.category, side: e.side, expect: e.expect.name, key };
    results.push(r);
    if (!key) { r.status = 'fail'; r.why = 'not among the drawn structures'; continue; }
    await press(page, 'reset-layers');
    await page.evaluate(() => { window.__atlas.selectStructure(null); window.__atlas.resetCamera(); });
    await press(page, `layer-isolate-${e.category}`);
    // One isolation slot (`iso=`): a second isolate replaces the first, so the
    // other hemisphere is hidden with its toggle instead.
    if (e.side === 'left' || e.side === 'right') await uncheck(page, `layer-toggle-${e.side === 'left' ? 'right' : 'left'}`);
    const layers = await page.evaluate(() => window.__atlas.viewer.layersOf());
    r.layers = layers;
    // The default camera first, then the views a user gets by dragging: a
    // structure enclosed by a sibling from one side may be clickable from another.
    r.attempts = []; r.views = [];
    for (const view of VIEWS) {
      await page.evaluate(() => window.__atlas.resetCamera());
      if (view.dx || view.dy) await drag(page, view.dx ?? 0, view.dy ?? 0);
      await page.evaluate(() => window.__atlas.selectStructure(null));
      const plain = await shot(page);
      await page.evaluate((k) => window.__atlas.selectStructure(k), key);
      const selected = await shot(page);
      const mask = await maskOf(page, plain, selected);
      await page.evaluate(() => window.__atlas.selectStructure(null));
      r.views.push({ view: view.name, ownPixels: mask.changed });
      if (!r.selectedShot && mask.changed) r.selectedShot = selected;
      for (const p of mask.points) {
        // A click again on the same spot, with the camera still, takes the next
        // structure behind (DOG-192). Up to one click per structure under the
        // pixel; a build without `under` gets the single click it supports.
        let got = await page.evaluate(([x, y]) => window.__atlas.pickAt(x, y), [p.x, p.y]);
        const under = got.under ?? null;
        let clicks = 1;
        while (got.structure !== key && under && clicks < under.length) {
          got = await page.evaluate(([x, y]) => window.__atlas.pickAt(x, y), [p.x, p.y]);
          clicks += 1;
        }
        await settle(page);
        const panel = await page.textContent('#structure-name').catch(() => null);
        r.attempts.push({ view: view.name, x: p.x, y: p.y, depth: p.depth, picked: got.structure, clicks, under, panel });
        if (got.structure === key) break;
      }
      if (r.attempts.at(-1)?.picked === key) break;
    }
    r.ownPixels = Math.max(0, ...r.views.map((v) => v.ownPixels));
    if (!r.ownPixels) { r.status = 'fail'; r.why = 'selecting it changes no pixel in any view: it does not render'; continue; }
    const hit = r.attempts.find((a) => a.picked === key);
    if (hit) {
      // Confirm through the real pointer: `pickAt` calls pick() directly and
      // skips wireCanvas, where a tap's camera and point are decided. Back to
      // the view the hit was found in, a miss in a corner to end any
      // click-again run, then the same number of slightly jittery taps.
      await page.evaluate(() => window.__atlas.resetCamera());
      const view = VIEWS.find((v) => v.name === hit.view);
      if (view.dx || view.dy) await drag(page, view.dx ?? 0, view.dy ?? 0);
      await page.evaluate(() => { window.__atlas.pickAt(2, 2); window.__atlas.selectStructure(null); });
      const b = await page.locator('[data-testid=canvas]').boundingBox();
      for (let i = 0; i < hit.clicks; i += 1) {
        await page.mouse.move(b.x + hit.x, b.y + hit.y);
        await page.mouse.down();
        await page.mouse.move(b.x + hit.x + 2, b.y + hit.y + 1);
        await page.mouse.up();
      }
      await settle(page);
      r.pointer = { taps: hit.clicks, selected: await page.evaluate(() => window.__atlas.structure()), panel: await page.textContent('#structure-name').catch(() => null) };
    }
    const label = hit ? drawn.find((s) => s.key === hit.picked)?.label : null;
    r.pickedName = label;
    r.view = hit?.view ?? null;
    r.clicksAtPixel = hit?.clicks ?? null;
    r.panel = hit?.panel ?? null;
    if (!hit) { r.status = 'fail'; r.why = `none of ${r.attempts.length} clicks on its own pixels picked it (got ${[...new Set(r.attempts.map((a) => a.picked))].join(', ')})`; continue; }
    if (label !== e.expect.name || !String(hit.panel ?? '').startsWith(e.expect.name)) { r.status = 'fail'; r.why = `picked its key but named "${label}" / panel "${hit.panel}"`; continue; }
    if (r.pointer.selected !== key || !String(r.pointer.panel ?? '').startsWith(e.expect.name)) { r.status = 'fail'; r.why = `pickAt reaches it, but ${r.pointer.taps} real taps at (${hit.x}, ${hit.y}) select ${r.pointer.selected} / panel "${r.pointer.panel}"`; continue; }
    r.status = 'pass';
    if (results.filter((x) => x.status === 'pass').length <= 3 || ['Subthalamic nucleus', 'Substantia nigra', 'Nucleus accumbens'].includes(e.expect.name)) {
      writeFileSync(join(OUT, 'shots', `pick-${e.id}-selected.png`), r.selectedShot);
    }
  }
  for (const r of results) delete r.selectedShot;
  const passed = results.filter((r) => r.status === 'pass');
  const perCategory = {};
  for (const r of results) { const c = (perCategory[r.category] ??= { sample: 0, pass: 0 }); c.sample += 1; if (r.status === 'pass') c.pass += 1; }
  const distinct = new Set(passed.map((r) => r.expect)).size;
  const firstClick = passed.filter((r) => r.clicksAtPixel === 1).length;
  console.error(results.map((r) => `${r.status} ${r.id} ${r.name} px=${r.ownPixels ?? '-'} points=${r.attempts?.length ?? '-'} clicksAtPixel=${r.clicksAtPixel ?? '-'} view=${r.view ?? '-'} ${r.why ?? ''}`).join('\n'));
  row('picking', passed.length === FIXTURE.sample.length ? 'pass' : 'fail',
    `${passed.length}/${FIXTURE.sample.length} picked back to their own key and name (${distinct} distinct structures; ${firstClick} on the first click, ${passed.length - firstClick} by clicking the same spot again); brain ${status.brain} tier, ${overall.painted} px painted against an all-hidden view`,
    { meshStatus: status, painted: overall.painted, perCategory, results: results.map(({ attempts, ...r }) => ({ ...r, clicks: attempts?.length ?? 0, attempts })), errors });

  // Withheld controls: must not be drawn, must not be pickable, and the page should say why.
  const controls = [];
  for (const c of FIXTURE.withheldControls) {
    const asDrawn = drawn.filter((s) => s.name === c.name || s.label === c.name || s.key.endsWith(`.${c.id}`) && s.key.startsWith('zanatomy'));
    await page.fill('[data-testid=search-input]', c.name);
    await settle(page);
    const results = await page.$$eval('[data-testid=search-results] li', (ns) => ns.map((n) => n.textContent.trim()));
    const scope = await page.textContent('[data-testid=search-scope]').catch(() => '');
    // "Says why" needs the name and a reason in the same visible place: every
    // stretch of visible text that names the structure, and whether it explains.
    const mentions = await page.evaluate((name) => {
      const text = document.body.innerText; const out = [];
      for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) out.push(text.slice(Math.max(0, i - 120), i + name.length + 200));
      return out;
    }, c.name);
    const saysWhy = mentions.some((m) => /held|withheld|licen[cs]e|undeclared|not (drawn|shipped)/i.test(m));
    controls.push({ id: c.id, name: c.name, reason: c.expect.reason, drawn: asDrawn.map((s) => s.key), searchResults: results, searchScope: scope, mentions, saysWhy });
  }
  await page.fill('[data-testid=search-input]', '');
  const notDrawn = controls.every((c) => c.drawn.length === 0);
  row('picking-controls', notDrawn ? 'pass' : 'fail',
    `${controls.filter((c) => c.drawn.length === 0).length}/${controls.length} withheld controls absent from the drawn and pickable set`, { controls });
  row('picking-controls-say-why', controls.every((c) => c.saysWhy) ? 'pass' : 'fail',
    `${controls.filter((c) => c.saysWhy).length}/${controls.length} withheld controls explained on the page after searching their name (${controls.map((c) => `${c.name}: ${c.mentions.length} visible mention(s), search results ${JSON.stringify(c.searchResults)}, scope ${JSON.stringify(c.searchScope)}`).join('; ')})`, { controls });
  await page.close();
}

// ---------------------------------------------------------------------------
// body: a full human
// ---------------------------------------------------------------------------
if (want('body')) {
  const { page, errors } = await open('?atlas=body');
  await page.waitForFunction(() => !['pending', 'loading'].includes(window.__atlas.meshStatus().body), null, { timeout: 90000 });
  const status = await page.evaluate(() => window.__atlas.meshStatus());
  const st = await page.evaluate(() => window.__atlas.structures('body'));
  const categories = {}; for (const s of st) categories[s.category] = (categories[s.category] ?? 0) + 1;
  const has = (re) => st.filter((s) => re.test(s.name)).map((s) => s.name).slice(0, 4);
  const regions = {
    head: has(/skull|cranium|frontal bone|occipital bone|mandible|parietal bone/i),
    thorax: has(/rib|sternum|lung|heart/i),
    pelvis: has(/hip bone|ilium|sacrum|pelvi/i),
    arm: has(/humerus|radius|ulna/i),
    hand: has(/metacarpal|phalan.*hand|hand|finger/i),
    leg: has(/femur|tibia|fibula/i),
    foot: has(/calcane|talus|metatarsal|foot|toe/i),
  };
  const overall = await paintedAgainstEmpty(page, 'body');
  writeFileSync(join(OUT, 'shots', 'body-default.png'), overall.full);
  const box = await page.evaluate(() => window.__atlas.view());
  const missing = Object.entries(regions).filter(([, v]) => v.length === 0).map(([k]) => k);
  const ok = missing.length === 0 && overall.painted > 0.02 * overall.width * overall.height && status.body !== 'failed';
  row('body', ok ? 'pass' : 'fail', `${st.length} body structures (${status.body} tier), head-to-foot regions present: ${Object.keys(regions).filter((k) => regions[k].length).join(', ')}${missing.length ? `; MISSING ${missing.join(', ')}` : ''}; ${overall.painted} px painted against an all-hidden view`,
    { meshStatus: status, categories, regions, painted: overall.painted, view: box, errors });
  await page.close();
}

// ---------------------------------------------------------------------------
// paper → regions, and region → papers round-trips
// ---------------------------------------------------------------------------
const answer = (page, fn, argv) => page.waitForFunction(([fn, a]) => {
  const got = window.__atlas[fn](a);
  return got && got.status !== 'pending' && got.pending !== true ? got : false;
}, [fn, argv], { timeout: 30000, polling: 100 }).then((h) => h.jsonValue()).catch((e) => ({ driverError: e.message }));

if (want('paper-regions') || want('region-papers')) {
  const { page, errors } = await open('?atlas=brain');
  const papers = await page.evaluate(() => window.__atlas.research().papers.map((p) => p.id));
  const forward = {};
  for (const id of papers) forward[id] = await answer(page, 'paperRegions', id);
  writeFileSync(join(OUT, 'paper-regions.json'), `${JSON.stringify(forward, null, 1)}\n`);
  if (want('paper-regions')) {
    const per = papers.map((id) => {
      const f = forward[id];
      const regions = f.regions ?? [];
      const reasons = f.emptyBecause ?? [];
      return {
        id,
        regions: regions.length,
        drawnStructures: regions.flatMap((r) => r.structures ?? []).length,
        undrawnRegions: regions.filter((r) => !(r.structures ?? []).length).map((r) => r.key),
        reasons,
        failure: f.driverError ?? f.error ?? (f.none ? 'not listed in the region index' : null),
      };
    });
    const nonEmpty = per.filter((p) => p.regions > 0).length;
    const bad = per.filter((p) => p.failure || (p.regions === 0 && (!Array.isArray(p.reasons) || p.reasons.length === 0)));
    row('paper-regions', papers.length === 30 && bad.length === 0 ? 'pass' : 'fail',
      `${papers.length} papers; ${nonEmpty} with structures, ${per.length - nonEmpty - bad.length} empty with a stated reason, ${bad.length} empty with none${bad.length ? ` (${bad.map((b) => b.id).join(', ')})` : ''}`, { per, errors });
  }
  if (want('region-papers')) {
    // Every structure either atlas draws that has a region document.
    const linked = await page.evaluate(() => ['brain', 'body'].flatMap((a) => window.__atlas.structures(a).filter((s) => s.regionKey).map((s) => ({ atlas: a, key: s.key, regionKey: s.regionKey, name: s.name }))));
    const problems = []; const checked = []; const unlinked = [];
    const inverted = {};
    for (const s of linked) {
      const got = await answer(page, 'regionPapers', s.regionKey);
      inverted[s.regionKey] = got;
      // `none`: the region index lists no document for it, i.e. nothing links
      // to it. Not a round-trip failure, unless a paper claims it (below).
      if (got?.none) { unlinked.push(s.key); continue; }
      if (!Array.isArray(got)) problems.push(`${s.regionKey} (${s.key}): no region→papers answer: ${JSON.stringify(got)}`);
      const listed = new Set((Array.isArray(got) ? got : []).map((p) => p.paperId));
      checked.push({ ...s, papers: [...listed] });
      for (const pid of listed) {
        const f = forward[pid];
        const back = (f?.regions ?? []).some((r) => r.key === s.regionKey);
        if (!back) problems.push(`${s.regionKey} lists ${pid}, but ${pid}'s paper→regions does not list ${s.key}`);
      }
    }
    for (const [pid, f] of Object.entries(forward)) {
      for (const r of f.regions ?? []) {
        const s = checked.find((x) => x.regionKey === r.key);
        if (!s) {
          const drawnUnlinked = linked.find((x) => x.regionKey === r.key);
          if (drawnUnlinked) problems.push(`${pid} lists ${r.key}, which the page draws as ${drawnUnlinked.key}, but the region index has no document for it`);
          // "This build does not draw it" is the paper→regions answer's to make,
          // not the page's: a region that names structures and has no drawn
          // structure carrying its key is a broken link, not an absence.
          else if ((r.structures ?? []).length) problems.push(`${pid} lists ${r.key} as drawn by ${JSON.stringify(r.structures)}, but no structure the page draws carries region key ${r.key}`);
          continue;
        }
        if (!s.papers.includes(pid)) problems.push(`${pid} lists ${r.key}, but its region→papers does not list ${pid}`);
      }
    }
    writeFileSync(join(OUT, 'region-papers.json'), `${JSON.stringify(inverted, null, 1)}\n`);
    const withPapers = checked.filter((c) => c.papers.length > 0).length;
    row('region-papers', checked.length > 0 && problems.length === 0 ? 'pass' : (checked.length === 0 ? 'unverified' : 'fail'),
      `${checked.length} drawn structures with a region document (${withPapers} with papers; ${unlinked.length} more carry a region key that nothing links to); ${problems.length} round-trip mismatches`, { problems, checked, unlinkedCount: unlinked.length, errors });
  }
  await page.close();
}

writeFileSync(join(OUT, 'browser-rows.json'), `${JSON.stringify({ base: 'dist served on 127.0.0.1:0', fixture: 'packages/atlas-qa/fixtures/brain-structure-sample.json', rows }, null, 1)}\n`);
await browser.close();
server.close();
process.exit(rows.some((r) => r.status === 'fail') ? 1 : rows.some((r) => r.status === 'unverified') ? 2 : 0);
