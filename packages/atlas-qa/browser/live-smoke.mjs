/**
 * DOG-135 (Atlas v2 W8b): post-deploy smoke of the live Pages site, not localhost.
 *
 *   source /paperclip/qa-browser/env.sh
 *   node packages/atlas-qa/browser/live-smoke.mjs --sha <deployed sha> [--dist packages/atlas-web/dist] [--out w8b-evidence]
 *
 * `--dist` is a build of `--sha` with `--base /somasurfer/`, made by whoever
 * runs this (the Pages workflow's two bundle steps, then
 * `node packages/atlas-web/build.mjs --base /somasurfer/`).
 *
 * The first five rows are DOG-40's v1 live smoke (`dog-40-release/live-smoke.mjs`),
 * carried over unchanged in substance. The v2 rows:
 *   deployed-sha    the github-pages deployment record names `--sha`, `main` is
 *                   at it, and every file of the local build is served byte for byte
 *   nav             both atlases one click from the landing page and from each other
 *   brain-pick      a real pointer tap on the brain selects a structure and the panel names it
 *   region-papers   a structure's "Papers on this structure" → click a paper → that
 *                   paper is revealed, and its paper→regions lists the structure back
 *   paper-regions   a paper in the research list → its structures → click one →
 *                   that structure is selected, named and in the address bar
 *   api-paper       one paper document fetched from the live static API, valid, and
 *                   the same document the index links
 *   api-region      one region document likewise, agreeing with the paper's paper→regions
 *
 * Each row is pass | fail | unverified, never anything else.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, launch, openPage, canvasPixels } from './lib.mjs';
import { validateApiDocument } from '../../atlas-research/src/index.ts';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const LIVE = arg('url') ?? 'https://whacked.github.io/somasurfer/';
const REPO = arg('repo') ?? 'whacked/somasurfer';
const SHA = arg('sha');
const DIST = join(ROOT, arg('dist') ?? join('packages', 'atlas-web', 'dist'));
const OUT = join(ROOT, arg('out') ?? 'w8b-evidence');
mkdirSync(join(OUT, 'shots'), { recursive: true });

const rows = [];
const row = (id, status, detail, evidence = {}) => {
  if (!['pass', 'fail', 'unverified'].includes(status)) throw new Error(`bad status ${status}`);
  rows.push({ id, status, detail, evidence });
  console.log(`${status.toUpperCase().padEnd(10)} ${id}: ${[].concat(detail).join(' | ')}`);
};
const rec = (id, problems, detail, evidence) => row(id, problems.length ? 'fail' : 'pass', problems.length ? problems : detail, evidence);
// Software WebGL redraws slowly: a shot never reads as idle, and takes long.
const SLOW = { animations: 'allow', timeout: 180000 };
const shotTo = (name, png) => writeFileSync(join(OUT, 'shots', name), png);
// Element shots only: a full-viewport capture of this page takes 14-35 s under
// SwiftShader while the page itself holds 60 fps, and a canvas shot takes 0.5 s.
// A shot is evidence, not a verdict, so one that fails is said and skipped.
async function snap(page, selector, name) {
  const png = await page.locator(selector).first().screenshot(SLOW).catch((e) => { console.error(`shot ${name} skipped: ${e.message.split('\n')[0]}`); return null; });
  if (png) shotTo(name, png);
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))));
// A tap at canvas pixels through the real pointer: down, a 2 px wobble, up. Not
// locator.click(), which waits for a "stable" element and the canvas redraws.
async function tap(page, at) {
  const c = await page.locator('[data-testid=canvas]').boundingBox();
  const x = c.x + at.x; const y = c.y + at.y;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 2, y + 1); await page.mouse.up();
}
const visibleNotices = (page) => page.$$eval('[data-notice]', (ns) => ns.filter((n) => n.offsetWidth || n.offsetHeight).map((n) => n.dataset.notice));

// ---------------------------------------------------------------------------
// deployed-sha: the record, the branch, and the bytes
// ---------------------------------------------------------------------------
{
  const p = [];
  const gh = (path) => fetch(`https://api.github.com/repos/${REPO}/${path}`, { headers: { accept: 'application/vnd.github+json' } }).then((r) => r.json());
  const deployments = await gh('deployments?environment=github-pages&per_page=1').catch((e) => ({ error: e.message }));
  const latest = Array.isArray(deployments) ? deployments[0] : null;
  const statuses = latest ? await gh(`deployments/${latest.id}/statuses?per_page=1`).catch(() => []) : [];
  const main = await gh('commits/main').catch((e) => ({ error: e.message }));
  if (!SHA) p.push('no --sha given: nothing to confirm the deployment against');
  if (!latest) p.push(`no github-pages deployment record: ${JSON.stringify(deployments).slice(0, 200)}`);
  else if (latest.sha !== SHA) p.push(`latest github-pages deployment is ${latest.sha}, not ${SHA}`);
  if (statuses[0]?.state !== 'success') p.push(`deployment ${latest?.id} status is ${statuses[0]?.state}`);
  if (main.sha !== SHA) p.push(`main is at ${main.sha}, not ${SHA}`);

  // Every file the local build of SHA emits, against what the site serves.
  const walk = (dir) => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
  const files = walk(DIST).map((f) => relative(DIST, f)).sort();
  const differ = []; const hash = (b) => createHash('sha256').update(b).digest('hex');
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(files.slice(i, i + 8).map(async (f) => {
      const r = await fetch(new URL(f.split('/').map(encodeURIComponent).join('/'), LIVE)).catch((e) => ({ ok: false, status: e.message }));
      const served = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
      if (!served || hash(served) !== hash(readFileSync(join(DIST, f)))) differ.push({ file: f, status: r.status, servedBytes: served?.length ?? null, localBytes: statSync(join(DIST, f)).size });
    }));
  }
  const manifest = JSON.parse(readFileSync(join(DIST, 'build-manifest.json'), 'utf8'));
  if (manifest.base !== '/somasurfer/') p.push(`--dist was built with base ${manifest.base}, not /somasurfer/`);
  if (files.length === 0) p.push(`--dist ${DIST} is empty`);
  if (differ.length) p.push(`${differ.length}/${files.length} built files differ from the live site: ${differ.slice(0, 5).map((d) => `${d.file} (${d.status})`).join(', ')}`);
  rec('deployed-sha', p, `github-pages deployment ${latest?.id} at ${latest?.sha?.slice(0, 7)} (${statuses[0]?.state}, ${latest?.created_at}); main at ${main.sha?.slice(0, 7)}; all ${files.length} files of a local --base /somasurfer/ build of it served byte for byte`,
    { sha: SHA, deployment: latest && { id: latest.id, sha: latest.sha, created_at: latest.created_at, state: statuses[0]?.state }, main: main.sha, files: files.length, differ });
}

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// The runner has 2 cores shared with other agents, and SwiftShader renders on
// them: a page load or a frame can take far longer than Playwright's 30 s.
context.setDefaultTimeout(180000);
context.setDefaultNavigationTimeout(180000);

// ---------------------------------------------------------------------------
// v1 rows (DOG-40)
// ---------------------------------------------------------------------------
const sel = (page) => page.evaluate(() => {
  const s = window.__atlas.viewer.state.selection;
  return s ? {
    ok: s.ok, address: s.address ?? null, atlas: window.__atlas.viewer.atlas,
    names: (s.names?.matches ?? []).map((m) => ({ id: m.structure?.id ?? m.structureId ?? m.id ?? m.name ?? JSON.stringify(m).slice(0, 80), fraction: m.fraction })),
  } : null;
});

// 1. The default body view loads.
const { page, errors } = await openPage(context, `${LIVE}?atlas=body`);
await page.evaluate(() => window.__atlas.meshesLoaded);
const boot = await page.evaluate(() => ({
  ready: window.__atlas?.ready === true, atlas: window.__atlas.viewer.atlas,
  template: window.__atlas.boundTemplateId('body'), renderer: window.__atlas.rendererAvailable(),
  base: document.baseURI, meshStatus: window.__atlas.meshStatus(),
}));
const px = await canvasPixels(page);
shotTo('1-body-view.png', px.png);
{
  const p = [];
  if (!boot.ready) p.push('window.__atlas.ready never became true');
  if (boot.atlas !== 'body') p.push(`?atlas=body opened ${boot.atlas}`);
  if (!boot.renderer) p.push('renderer unavailable');
  if (px.painted < 5000) p.push(`canvas painted only ${px.painted} px`);
  if (errors.length) p.push(`console errors: ${errors.join(' | ')}`);
  rec('body-view-loads', p, `body atlas on ${boot.template} (${boot.meshStatus.body} tier), ${px.painted} px painted in ${px.colours} colours`, { boot, painted: px.painted, bbox: px.bbox });
}

// 2. One click yields an address with a ranked name list.
let clicked = null;
{
  const p = [];
  // Not every cell is overlapped by an indexed structure, and the page says so,
  // so click a grid over the painted model and keep the first ranked list.
  // It stops at the first: on this runner, a dozen fast taps back to back stall SwiftShader's frames for
  // tens of seconds, though the page's own work per pick stays ~0.2 s.
  const b = px.bbox;
  sweep: for (const fy of [0.3, 0.4, 0.5, 0.6, 0.7, 0.2, 0.8]) {
    for (const fx of [0.5, 0.45, 0.55, 0.4, 0.6]) {
      if (clicked) break sweep;
      const x = b.minX + fx * (b.maxX - b.minX); const y = b.minY + fy * (b.maxY - b.minY);
      await tap(page, { x, y });
      await settle(page);
      const s = await sel(page);
      const notices = await visibleNotices(page);
      if (!clicked && s?.ok && s.names.length >= 2 && notices.length === 0) clicked = { ...s, at: { x, y }, notices };
    }
  }
  if (clicked) {
    await tap(page, clicked.at);
    await settle(page);
  }
  clicked = clicked ?? await sel(page);
  const namesEl = await page.$eval('[data-testid="names"]', (n) => ({ covered: n.dataset.covered, text: n.textContent.replace(/\s+/g, ' ').trim().slice(0, 400) })).catch(() => null);
  await snap(page, '[data-testid=canvas]', '2-click.png');
  await snap(page, '[data-testid=names]', '2-click-names.png');
  if (!clicked?.ok || !clicked.address) p.push(`click selected nothing: ${JSON.stringify(clicked)}`);
  if (!clicked?.names?.length) p.push('no ranked names for the clicked cell');
  else {
    const f = clicked.names.map((n) => n.fraction);
    if (f.some((x, i) => i && x > f[i - 1])) p.push(`names not ranked by fraction: ${f}`);
  }
  if (!namesEl || !namesEl.text) p.push('names panel empty or missing');
  rec('click-gives-address-and-ranked-names', p, `${clicked?.address} → ${clicked?.names?.length} names, top ${clicked?.names?.[0]?.id} (${clicked?.names?.[0]?.fraction})`, { clicked, namesEl });
}

// 3. One pasted deep link restores the same view.
{
  const p = [];
  // __atlas.href() is path-relative; the link a user copies is the address bar.
  const rel = await page.evaluate(() => window.__atlas.href());
  const bar = page.url();
  const href = new URL(rel, LIVE).href;
  if (href !== bar) p.push(`address bar ${bar} differs from __atlas.href() ${href}`);
  const before = await page.evaluate(() => JSON.parse(JSON.stringify(window.__atlas.view())));
  const second = await openPage(context, href);
  const after = await second.page.evaluate(() => JSON.parse(JSON.stringify(window.__atlas.view())));
  const reSel = await sel(second.page);
  await snap(second.page, '[data-testid=canvas]', '3-deep-link-restored.png');
  if (!href.startsWith(LIVE)) p.push(`href ${href} is not on the live site`);
  // The link carries the camera at 2 decimals by design, so "the same view" is:
  // the reopened page reproduces the identical link, and everything else in
  // view() is equal exactly.
  const reHref = new URL(await second.page.evaluate(() => window.__atlas.href()), LIVE).href;
  if (reHref !== href) p.push(`reopened page's link ${reHref} != ${href}`);
  const strip = (v) => ({ ...v, camera: undefined });
  if (JSON.stringify(strip(before)) !== JSON.stringify(strip(after))) p.push(`view differs after round-trip: ${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  const cb = before.camera; const ca = after.camera;
  const close = (x, y) => Math.abs(x - y) <= 0.005 + 1e-9;
  if (![cb.yaw, cb.pitch, cb.distance, ...cb.target].every((x, i) => close(x, [ca.yaw, ca.pitch, ca.distance, ...ca.target][i]))) p.push(`camera beyond link precision: ${JSON.stringify(cb)} vs ${JSON.stringify(ca)}`);
  if (reSel?.address !== clicked?.address) p.push(`selection ${reSel?.address} != ${clicked?.address}`);
  if (second.errors.length) p.push(`console errors: ${second.errors.join(' | ')}`);
  rec('pasted-deep-link-restores-view', p, `${href} reopened in a fresh page restores an identical view() and selection ${reSel?.address}`, { href, before, after });
  await second.page.close();
}

// 4. The attribution is present on the live site, and its files are served.
{
  const p = [];
  const a = await page.evaluate(() => {
    const dl = document.querySelector('dl.attribution');
    const r = dl?.getBoundingClientRect();
    return {
      text: dl?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      visible: !!r && r.width > 0 && r.height > 0 && getComputedStyle(dl).visibility !== 'hidden',
      status: document.querySelector('#attribution-status')?.textContent.trim() ?? null,
      links: [...document.querySelectorAll('.attribution-links a[href]')].map((n) => n.href),
    };
  });
  await page.locator('dl.attribution').scrollIntoViewIfNeeded().catch(() => {});
  await snap(page, 'dl.attribution', '4-attribution.png');
  if (!a.visible) p.push('attribution not visible');
  if (!/DBCLS/.test(a.text ?? '')) p.push('no DBCLS credit in the attribution');
  if (!/BodyParts3D/.test(a.text ?? '')) p.push('no BodyParts3D credit');
  const served = {};
  for (const l of a.links) { const r = await context.request.get(l); served[l] = r.status(); if (r.status() !== 200) p.push(`${l} → ${r.status()}`); }
  if (!a.links.some((l) => /LICENSE/.test(l)) || !a.links.some((l) => /ATTRIBUTION/.test(l))) p.push(`licence/attribution links missing: ${a.links}`);
  rec('attribution-present-on-live-site', p, `visible; DBCLS + BodyParts3D credited; ${Object.keys(served).length} links all 200`, { ...a, text: a.text?.slice(0, 600), served });
}

// 5. §11: addresses issued on one template stay valid on every other body template.
{
  const p = [];
  const ids = await page.evaluate(async () => {
    const idx = await (await fetch(new URL('data/atlas-index.json', document.baseURI))).json();
    return idx.templates.filter((t) => t.kind === 'body').map((t) => t.id);
  });
  // Only an address the live site itself issued on its default template: the
  // clicked one. Every extra address is a full page load per template.
  const issued = [clicked?.address].filter(Boolean);
  const table = [];
  for (const t of ids) {
    for (const addr of issued) {
      const { page: q, errors: e } = await openPage(context, `${LIVE}?atlas=body&template=${encodeURIComponent(t)}&a=${encodeURIComponent(addr)}`);
      const r = await q.evaluate(() => ({
        bound: window.__atlas.boundTemplateId('body'),
        sel: window.__atlas.viewer.state.selection ? { ok: window.__atlas.viewer.state.selection.ok, address: window.__atlas.viewer.state.selection.address ?? null } : null,
        rejection: document.querySelector('[data-testid="rejection"]')?.offsetParent ? document.querySelector('[data-testid="rejection"]').textContent.trim().slice(0, 160) : null,
      }));
      table.push({ template: t, address: addr, ...r });
      if (r.bound !== t) p.push(`?template=${t} bound ${r.bound}`);
      if (!r.sel?.ok || r.sel.address !== addr) p.push(`${addr} on ${t}: ${JSON.stringify(r.sel)} ${r.rejection ?? ''}`);
      if (e.length) p.push(`${t}/${addr} console errors: ${e.join(' | ')}`);
      await q.close();
    }
  }
  rec('s11-addresses-survive-every-template', p, `${issued.length} addresses × ${ids.length} body templates: every one selects, unchanged, on every template`, { templates: ids, issued, table });
}
await page.close();

// ---------------------------------------------------------------------------
// nav: both atlases one click away, from the landing page and from each other
// ---------------------------------------------------------------------------
{
  const { page, errors } = await openPage(context, LIVE);
  const landing = await page.evaluate(() => window.__atlas.viewer.atlas);
  const steps = [];
  const clickTo = async (target) => {
    await page.click(`[data-testid=nav-${target}]`);
    await page.waitForFunction(() => window.__atlas?.ready === true, null, { timeout: 60000 });
    const atlas = await page.evaluate(() => window.__atlas.viewer.atlas);
    steps.push({ clicked: `nav-${target}`, atlas, url: page.url() });
    return atlas === target;
  };
  const fromLanding = { brain: await clickTo('brain') };
  const brainToBody = await clickTo('body');
  const bodyToBrain = await clickTo('brain');
  await page.evaluate(() => window.__atlas.meshesLoaded);
  await snap(page, '[data-testid=canvas]', '6-nav-brain.png');
  await page.goto(LIVE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__atlas?.ready === true, null, { timeout: 60000 });
  fromLanding.body = await clickTo('body');
  const p = [];
  if (!fromLanding.brain) p.push('landing → brain did not open the brain atlas');
  if (!fromLanding.body) p.push('landing → body did not open the body atlas');
  if (!brainToBody) p.push('brain → body failed');
  if (!bodyToBrain) p.push('body → brain failed');
  if (steps.some((s) => !s.url.startsWith(LIVE))) p.push(`a nav link left the live site: ${steps.map((s) => s.url).join(', ')}`);
  if (errors.length) p.push(`console errors: ${errors.join(' | ')}`);
  rec('nav', p, `landing on ${landing}; landing→brain, landing→body, brain→body, body→brain, one click each, all on ${LIVE}`, { landing, steps, errors });
  await page.close();
}

// ---------------------------------------------------------------------------
// brain-pick: a real tap on the brain selects a structure, and the panel names it
// ---------------------------------------------------------------------------
async function openBrain() {
  const opened = await openPage(context, `${LIVE}?atlas=brain`);
  // A pinned canvas height, so a shot and a click see the same pixels.
  await opened.page.addStyleTag({ content: '[data-testid=canvas]{height:700px!important}' });
  await opened.page.evaluate(() => window.__atlas.meshesLoaded);
  await settle(opened.page);
  return opened;
}
let picked = null;
{
  const { page, errors } = await openBrain();
  const status = await page.evaluate(() => window.__atlas.meshStatus());
  const drawn = await page.evaluate(() => window.__atlas.structures('brain'));
  const bpx = await canvasPixels(page);
  shotTo('7-brain-default.png', bpx.png);
  const tries = [];
  const b = bpx.bbox;
  if (b) {
    for (const fy of [0.5, 0.4, 0.6, 0.3, 0.7]) {
      for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7]) {
        const x = b.minX + fx * (b.maxX - b.minX); const y = b.minY + fy * (b.maxY - b.minY);
        await tap(page, { x, y });
        await settle(page);
        const key = await page.evaluate(() => window.__atlas.structure());
        const panel = await page.textContent('#structure-name').catch(() => null);
        tries.push({ fx, fy, key, panel });
        if (key) { picked = { key, panel, at: { x, y }, ...drawn.find((s) => s.key === key) }; break; }
      }
      if (picked) break;
    }
  }
  if (picked) { await snap(page, '[data-testid=canvas]', '7-brain-pick.png'); await snap(page, '[data-testid=structure-panel]', '7-brain-pick-panel.png'); }
  const p = [];
  if (status.brain === 'failed') p.push(`brain meshes failed: ${JSON.stringify(status)}`);
  if (bpx.painted < 5000) p.push(`brain canvas painted only ${bpx.painted} px`);
  if (!picked) p.push(`${tries.length} taps over the painted brain selected no structure`);
  else {
    if (!picked.name) p.push(`tap selected ${picked.key}, which is not among the drawn brain structures`);
    if (!picked.panel || picked.panel.trim() !== (picked.title ?? picked.name)) p.push(`tap selected ${picked.key} (${picked.title ?? picked.name}) but the panel reads ${JSON.stringify(picked.panel)}`);
  }
  if (errors.length) p.push(`console errors: ${errors.join(' | ')}`);
  rec('brain-pick', p, `${drawn.length} brain structures drawn (${status.brain} tier), ${bpx.painted} px; tap ${tries.length} selected ${picked?.key}, panel "${picked?.panel}"`, { meshStatus: status, drawn: drawn.length, tries, picked });
  await page.close();
}

// ---------------------------------------------------------------------------
// region-papers: structure panel → a paper → that paper revealed, structure listed back
// ---------------------------------------------------------------------------
const answer = (page, fn, argv) => page.waitForFunction(([fn, a]) => {
  const got = window.__atlas[fn](a);
  return got && got.status !== 'pending' && got.pending !== true ? got : false;
}, [fn, argv], { timeout: 30000, polling: 100 }).then((h) => h.jsonValue()).catch((e) => ({ driverError: e.message }));

let journeyPaper = null; let journeyRegion = null;
{
  const p = [];
  const { page, errors } = await openBrain();
  // The structure the tap picked, if papers link it; otherwise the first drawn
  // brain structure that has some. Selection is set through the page's own
  // selectStructure (the path a pick ends in); the journey under test is the
  // panel, from there on.
  const linked = await page.evaluate(() => window.__atlas.structures('brain').filter((s) => s.regionKey));
  const order = [...linked.filter((s) => s.key === picked?.key), ...linked.filter((s) => s.key !== picked?.key)];
  let s = null; let listed = null;
  for (const c of order) {
    const got = await answer(page, 'regionPapers', c.regionKey);
    if (Array.isArray(got) && got.length) { s = c; listed = got; break; }
  }
  if (!s) p.push(`none of ${linked.length} drawn brain structures with a region key lists any paper`);
  else {
    journeyRegion = s;
    await page.evaluate((k) => window.__atlas.selectStructure(k), s.key);
    const box = page.locator('[data-testid=region-papers]');
    await page.waitForSelector('[data-testid=region-papers][data-state=listed]', { timeout: 30000 }).catch(() => {});
    const state = await box.getAttribute('data-state').catch(() => null);
    const inPanel = await page.$$eval('[data-testid=region-papers] .region-paper[data-paper]', (ns) => ns.map((n) => n.dataset.paper));
    if (state !== 'listed') p.push(`"Papers on this structure" for ${s.key} is ${state}, not listed`);
    const want = listed.map((x) => x.paperId);
    if (JSON.stringify([...inPanel].sort()) !== JSON.stringify([...want].sort())) p.push(`panel lists ${inPanel} but the region document lists ${want}`);
    await box.scrollIntoViewIfNeeded().catch(() => {});
    await snap(page, '[data-testid=region-papers]', '8-region-papers.png');
    journeyPaper = inPanel[0] ?? null;
    if (journeyPaper) {
      await page.$eval(`[data-testid=region-papers] .region-paper[data-paper="${journeyPaper}"] button`, (b) => b.click());
      await page.waitForSelector('[data-testid=paper-regions][data-state]', { timeout: 30000 }).catch(() => {});
      await page.waitForFunction(() => document.querySelector('[data-testid=paper-regions]')?.dataset.state !== 'loading', null, { timeout: 30000 }).catch(() => {});
      const revealed = await page.$$eval('[data-testid=research-list] li.selected', (ns) => ns.map((n) => n.dataset.paper));
      const back = await page.$$eval('[data-testid=paper-regions] .paper-region[data-region]', (ns) => ns.map((n) => n.dataset.region));
      if (JSON.stringify(revealed) !== JSON.stringify([journeyPaper])) p.push(`clicking ${journeyPaper} revealed ${JSON.stringify(revealed)}`);
      if (!back.includes(s.regionKey)) p.push(`${journeyPaper}'s paper→regions lists ${back}, not ${s.regionKey}`);
      await page.locator('[data-testid=research-reveal]').scrollIntoViewIfNeeded().catch(() => {});
      await snap(page, '[data-testid=research-reveal]', '8-region-papers-paper-revealed.png');
    }
  }
  if (errors.length) p.push(`console errors: ${errors.join(' | ')}`);
  rec('region-papers', p, `${journeyRegion?.key} (${journeyRegion?.regionKey}) panel lists ${journeyPaper ? 'its papers' : 'nothing'}; clicking ${journeyPaper} reveals it, and its structures list ${journeyRegion?.regionKey} back`, { structure: journeyRegion, paper: journeyPaper, errors });
  await page.close();
}

// ---------------------------------------------------------------------------
// paper-regions: research list → a paper → one of its structures → selected
// ---------------------------------------------------------------------------
let regionsPaper = null;
{
  const p = [];
  const { page, errors } = await openBrain();
  const papers = await page.evaluate(() => window.__atlas.research().papers.map((x) => x.id));
  let target = null;
  for (const id of [journeyPaper, ...papers].filter(Boolean)) {
    const got = await answer(page, 'paperRegions', id);
    const r = (got.regions ?? []).find((x) => x.atlas === 'brain' && x.structures.length);
    if (r) { target = { id, region: r }; break; }
  }
  if (!target) p.push(`none of ${papers.length} papers maps to a drawn brain structure`);
  else {
    regionsPaper = target.id;
    const urlBefore = page.url();
    await page.$eval(`[data-testid="research-paper-${target.id}"]`, (b) => b.click());
    await page.waitForSelector('[data-testid=paper-regions][data-state=listed]', { timeout: 30000 }).catch(() => {});
    const state = await page.getAttribute('[data-testid=paper-regions]', 'data-state').catch(() => null);
    if (state !== 'listed') p.push(`paper→regions for ${target.id} is ${state}, not listed`);
    const rowSel = `[data-testid=paper-regions] .paper-region[data-region="${target.region.key}"] button`;
    await snap(page, '[data-testid=paper-regions]', '9-paper-regions.png');
    const has = await page.$(rowSel);
    if (!has) p.push(`${target.id}'s structures have no clickable row for ${target.region.key}`);
    else {
      await page.$eval(rowSel, (b) => b.click());
      await settle(page);
      const got = await page.evaluate(() => window.__atlas.structure());
      const panel = await page.textContent('#structure-name').catch(() => null);
      const drawn = await page.evaluate((k) => window.__atlas.structures('brain').find((s) => s.key === k), target.region.structures[0]);
      const url = page.url();
      if (got !== target.region.structures[0]) p.push(`clicking ${target.region.key} selected ${got}, not ${target.region.structures[0]}`);
      if (panel?.trim() !== (drawn?.title ?? drawn?.name)) p.push(`panel reads ${JSON.stringify(panel)}, not ${drawn?.title ?? drawn?.name}`);
      if (url === urlBefore) p.push('the address bar did not change, so the selection cannot be linked');
      target.selected = got; target.panel = panel; target.url = url;
      await snap(page, '[data-testid=canvas]', '9-paper-regions-structure-selected.png');
      await snap(page, '[data-testid=structure-panel]', '9-paper-regions-structure-panel.png');
    }
  }
  if (errors.length) p.push(`console errors: ${errors.join(' | ')}`);
  rec('paper-regions', p, `${target?.id} → ${target?.region.key} → selected ${target?.selected}, panel "${target?.panel?.trim()}", ${target?.url}`, { target, errors });
  await page.close();
}
await browser.close();

// ---------------------------------------------------------------------------
// The static API, one document of each kind, as any client would fetch it
// ---------------------------------------------------------------------------
const getJson = async (url) => {
  const r = await fetch(url);
  const text = await r.text();
  let doc = null; try { doc = JSON.parse(text); } catch { /* reported below */ }
  return { url, status: r.status, type: r.headers.get('content-type'), cors: r.headers.get('access-control-allow-origin'), doc };
};
let paperDoc = null;
{
  const p = [];
  const index = await getJson(new URL('data/api/v1/index.json', LIVE));
  const id = regionsPaper ?? journeyPaper ?? index.doc?.papers?.[0]?.id;
  const entry = index.doc?.papers?.find((x) => x.id === id);
  if (index.status !== 200 || index.doc?.kind !== 'index') p.push(`data/api/v1/index.json → ${index.status}, kind ${index.doc?.kind}`);
  if (!entry) p.push(`index lists no ${id}`);
  else {
    paperDoc = await getJson(new URL(entry.href, index.url));
    const problems = paperDoc.doc ? validateApiDocument(paperDoc.doc) : ['not JSON'];
    if (paperDoc.status !== 200) p.push(`${paperDoc.url} → ${paperDoc.status}`);
    if (!/json/.test(paperDoc.type ?? '')) p.push(`${paperDoc.url} served as ${paperDoc.type}`);
    if (problems.length) p.push(`invalid: ${problems.join('; ')}`);
    if (paperDoc.doc?.kind !== 'paper' || paperDoc.doc?.paper?.id !== id) p.push(`got kind ${paperDoc.doc?.kind} id ${paperDoc.doc?.paper?.id}, wanted paper ${id}`);
  }
  rec('api-paper', p, `${paperDoc?.url} → ${paperDoc?.status} ${paperDoc?.type}, kind paper, id ${paperDoc?.doc?.paper?.id}, valid against atlas-research-api/1 (CORS ${paperDoc?.cors ?? 'none'})`,
    { url: paperDoc?.url, status: paperDoc?.status, type: paperDoc?.type, cors: paperDoc?.cors, id: paperDoc?.doc?.paper?.id, title: paperDoc?.doc?.paper?.title });
}
{
  const p = [];
  const regionIndex = await getJson(new URL('assets/api/v1/index.json', LIVE));
  const key = journeyRegion?.regionKey ?? regionIndex.doc?.regions?.[0]?.key;
  const entry = regionIndex.doc?.regions?.find((r) => r.key === key);
  let region = null;
  if (regionIndex.status !== 200 || regionIndex.doc?.kind !== 'region-index') p.push(`assets/api/v1/index.json → ${regionIndex.status}, kind ${regionIndex.doc?.kind}`);
  if (!entry) p.push(`region index lists no ${key}`);
  else {
    region = await getJson(new URL(entry.href, regionIndex.url));
    const problems = region.doc ? validateApiDocument(region.doc) : ['not JSON'];
    if (region.status !== 200) p.push(`${region.url} → ${region.status}`);
    if (!/json/.test(region.type ?? '')) p.push(`${region.url} served as ${region.type}`);
    if (problems.length) p.push(`invalid: ${problems.join('; ')}`);
    if (region.doc?.kind !== 'region' || region.doc?.key !== key) p.push(`got kind ${region.doc?.kind} key ${region.doc?.key}, wanted region ${key}`);
    const papers = (region.doc?.papers ?? []).map((x) => x.paperId);
    if (JSON.stringify([...papers].sort()) !== JSON.stringify([...entry.paperIds].sort())) p.push(`region document lists ${papers}, its index entry ${entry.paperIds}`);
    // And the other direction, through the documents' own links: region →
    // paper, and that paper's index entry → its paper-regions → this region.
    const dataIndex = await getJson(new URL('data/api/v1/index.json', LIVE));
    for (const link of region.doc?.papers ?? []) {
      const paper = await getJson(new URL(link.href, region.url));
      if (paper.status !== 200 || paper.doc?.paper?.id !== link.paperId) p.push(`${region.url}'s link to ${link.paperId} → ${paper.status}, id ${paper.doc?.paper?.id}`);
      const regionsHref = dataIndex.doc?.papers?.find((x) => x.id === link.paperId)?.regionsHref;
      const back = regionsHref ? await getJson(new URL(regionsHref, dataIndex.url)) : null;
      if (!(back?.doc?.regions ?? []).some((r) => r.key === key)) p.push(`${link.paperId}'s paper-regions does not list ${key} back`);
    }
  }
  rec('api-region', p, `${region?.url} → ${region?.status} ${region?.type}, kind region, key ${region?.doc?.key}, ${region?.doc?.papers?.length} papers, valid; each paper's paper-regions lists it back (CORS ${region?.cors ?? 'none'})`,
    { url: region?.url, status: region?.status, type: region?.type, cors: region?.cors, key: region?.doc?.key, papers: region?.doc?.papers?.map((x) => x.paperId) });
}

const summary = { url: LIVE, sha: SHA, at: new Date().toISOString(), pass: rows.filter((r) => r.status === 'pass').length, fail: rows.filter((r) => r.status === 'fail').length, unverified: rows.filter((r) => r.status === 'unverified').length };
writeFileSync(join(OUT, 'live-smoke.json'), `${JSON.stringify({ summary, rows }, null, 1)}\n`);
console.log(JSON.stringify(summary));
process.exit(summary.fail ? 1 : summary.unverified ? 2 : 0);
