/**
 * The rows only a running page can answer: clamping by a real click, every
 * `?fail=` degradation, the hand-written renderer drawing a cell on the real
 * template, and the first-interaction time the budget has only ever modelled.
 *
 *   source /paperclip/qa-browser/env.sh
 *   node packages/atlas-qa/browser/degrade-perf-dom.mjs [--out qa-evidence] [--runs 5]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, canvasPixels, diffPixels, launch, openPage, row, serve } from './lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = join(ROOT, arg('out', 'qa-evidence'));
const RUNS = Number(arg('runs', '5'));
mkdirSync(OUT, { recursive: true });

const server = await serve(8938);
const browser = await launch();
const results = [];
const visibleNotices = (page) => page.$$eval('[data-notice]', (ns) => ns
  .filter((n) => n.offsetWidth || n.offsetHeight).map((n) => n.dataset.notice));

/** The model's bounding box in canvas pixels: render minus every layer hidden. */
async function modelBox(page) {
  const full = await canvasPixels(page);
  const ids = await page.$$eval('[data-testid^="layer-toggle-"]', (ns) => ns.map((n) => n.dataset.testid));
  for (const t of ids) await page.locator(`[data-testid="${t}"]`).uncheck();
  await page.waitForTimeout(150);
  const empty = await canvasPixels(page);
  for (const t of ids) await page.locator(`[data-testid="${t}"]`).check();
  await page.waitForTimeout(150);
  return { ...(await diffPixels(page, full.png, empty.png)), box: full.box };
}

// --- clamping by a click outside the modelled body ---------------------------
// Pinned canvas height (the layout defect would otherwise put the model off
// screen) — stated in the evidence, and irrelevant to what pick() decides.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  for (const [id, side] of [['clamped-cranial', 'above'], ['clamped-caudal', 'below']]) {
    const { page, errors } = await openPage(context, `${server.base}/?fail=research`);
    const m = await modelBox(page);
    const problems = [];
    let picked = null; let shown = [];
    if (!m.bbox) problems.push('no model drawn to click beside');
    else {
      const x = (m.bbox.minX + m.bbox.maxX) / 2;
      const y = side === 'above' ? Math.max(2, m.bbox.minY - 25) : Math.min(m.height - 2, m.bbox.maxY + 25);
      await page.locator('[data-testid="canvas"]').click({ position: { x, y } });
      await page.waitForTimeout(400);
      picked = await page.evaluate(() => {
        const s = window.__atlas.viewer.state.selection;
        return s ? { ok: s.ok, address: s.address ?? null, notices: (s.notices ?? []).map((n) => ({ code: n.code, text: n.text ?? n.title ?? null })) } : null;
      });
      shown = await visibleNotices(page);
      // Observed, not unmeasurable: the click was delivered and the page did
      // nothing. `pick()` selects only on a mesh hit and passes the encoded
      // ADDRESS to select(), dropping the encoder's clamp flag, so no click can
      // raise `clamped` in the running page.
      if (!picked) problems.push(`a click ${side} the body selected nothing and showed nothing: no clamp is reported, and the matrix row expects the point addressed at the ${side === 'above' ? 'cranial' : 'caudal'} end with a notice naming it`);
      else {
        if (!shown.includes('clamped')) problems.push(`click ${side} the body → ${picked.address}, visible notices ${JSON.stringify(shown)}; expected a visible clamped notice`);
        if (shown.includes('folded')) problems.push('a clamp reported as folded');
        const end = side === 'above' ? /cranial/i : /caudal/i;
        // What the reader sees: the visible clamped card, title + detail +
        // notes. The end is named in the notes; an earlier version read only
        // the title and reported a correct build as not naming it.
        const said = (await page.$$eval('[data-notice="clamped"]', (ns) => ns
          .filter((n) => n.offsetWidth || n.offsetHeight).map((n) => n.textContent))).join(' ');
        const wrongEnd = side === 'above' ? /caudal|below/i : /cranial|above/i;
        if (shown.includes('clamped') && wrongEnd.test(said)) problems.push(`the clamp names the wrong end: ${said}`);
        if (shown.includes('clamped') && !end.test(said)) problems.push(`the clamp does not say which end: ${said}`);
      }
    }
    if (errors.length) problems.push(`console errors: ${errors.join(' | ')}`);
    results.push(row(`matrix/${id} [real click]`, problems.length ? 'fail' : 'pass',
      problems.length ? problems : `a click ${side} the body selected ${picked.address} and showed a visible clamped notice naming the end`,
      { model: m, picked, shown }));
    await page.close();
  }
  await context.close();
}

// --- ?fail= degradations ------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const cases = [
    ['index', async (page) => {
      const boot = await page.locator('#boot-error').textContent().catch(() => null);
      return boot && boot.trim().length > 20 ? [] : [`#boot-error is ${JSON.stringify(boot)}`];
    }],
    ['names', async (page) => {
      await page.locator('[data-testid="address-input"]').fill('BD-T07-03O-531');
      await page.locator('[data-testid="address-submit"]').click();
      await page.waitForTimeout(300);
      const s = await page.evaluate(() => ({ ok: window.__atlas.viewer.state.selection?.ok, extent: !!document.querySelector('[data-testid="cell-extent"]') }));
      const p = [];
      if (!s.ok) p.push('with names failed, an address no longer selects');
      if (!s.extent) p.push('with names failed, no extent is drawn');
      return p;
    }],
    ['templates', async (page) => {
      const shown = await visibleNotices(page);
      await page.locator('[data-testid="address-input"]').fill('BD-T07-03O-531');
      await page.locator('[data-testid="address-submit"]').click();
      await page.waitForTimeout(300);
      const names = await page.locator('[data-testid="names"]').textContent().catch(() => null);
      const p = [];
      if (!shown.includes('atlas-unavailable')) p.push(`no atlas-unavailable notice (${JSON.stringify(shown)})`);
      if (!names || !/%/.test(names)) p.push(`with templates failed, the address does not resolve to names: ${JSON.stringify(names?.slice(0, 120))}`);
      return p;
    }],
    ['renderer', async (page) => {
      const msg = await page.evaluate(() => { const n = document.getElementById('canvas-message'); return n ? { code: n.dataset.notice ?? n.dataset.code ?? null, text: n.textContent.trim(), visible: !!(n.offsetWidth || n.offsetHeight) } : null; });
      await page.locator('[data-testid="address-input"]').fill('BD-T07-03O-531');
      await page.locator('[data-testid="address-submit"]').click();
      await page.waitForTimeout(300);
      const s = await page.evaluate(() => ({ ok: window.__atlas.viewer.state.selection?.ok, renderer: window.__atlas.rendererAvailable(), href: window.__atlas.href() }));
      const p = [];
      if (!msg?.visible || !/renderer-unavailable/.test(JSON.stringify(msg))) p.push(`#canvas-message: ${JSON.stringify(msg)}`);
      if (s.renderer) p.push('rendererAvailable() is true under ?fail=renderer');
      if (!s.ok) p.push('the panel no longer selects without a renderer');
      if (!/a=BD-T07-03O-531/.test(s.href ?? '')) p.push(`deep link not written: ${s.href}`);
      return p;
    }],
    ['research', async (page) => {
      const scope = await page.locator('[data-testid="research-scope"]').textContent();
      const prov = await page.$eval('[data-testid="research-provenance"]', (n) => n.dataset.role);
      const ok = await page.evaluate(() => window.__atlas.rendererAvailable());
      const p = [];
      if (!/could not be loaded/i.test(scope)) p.push(`research-scope says ${JSON.stringify(scope)}`);
      if (prov !== 'none') p.push(`provenance role ${prov}`);
      if (!ok) p.push('a research failure took the renderer down');
      return p;
    }],
  ];
  for (const [mode, check] of cases) {
    const { page, errors } = await openPage(context, `${server.base}/?fail=${mode}`, { waitReady: mode !== 'index' });
    if (mode === 'index') await page.waitForTimeout(1500);
    const problems = await check(page);
    const unexpected = errors.filter((e) => !/fail=|forced|simulated|could not be loaded/i.test(e));
    await page.screenshot({ path: join(OUT, `fail-${mode}.png`) });
    results.push(row(`degrade/fail=${mode}`, problems.length ? 'fail' : 'pass', problems.length ? problems : `degrades as documented`, { errors, unexpected }));
    await page.close();
  }
  await context.close();
}

// --- the renderer draws a selected cell, on the real template ----------------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const { page, errors } = await openPage(context, `${server.base}/?fail=research`);
  // Selecting grows the side panel and the canvas grows with it (the layout
  // defect), so two screenshots would differ in size. Record the unpinned
  // resize, then pin the height for the pixel comparison.
  const h0 = await page.evaluate(() => document.querySelector('[data-testid=canvas]').getBoundingClientRect().height);
  await page.locator('[data-testid="address-input"]').fill('BD-T07-03O-531');
  await page.locator('[data-testid="address-submit"]').click();
  await page.waitForTimeout(300);
  const h1 = await page.evaluate(() => document.querySelector('[data-testid=canvas]').getBoundingClientRect().height);
  await page.goto(`${server.base}/?fail=research`);
  await page.waitForFunction(() => window.__atlas?.ready === true);
  await page.addStyleTag({ content: '[data-testid=canvas]{height:700px!important;max-height:700px!important}' });
  await page.waitForTimeout(300);
  const before = await canvasPixels(page);
  await page.locator('[data-testid="address-input"]').fill('BD-T07-03O-531');
  await page.locator('[data-testid="address-submit"]').click();
  await page.waitForTimeout(500);
  const after = await canvasPixels(page);
  const extent = await page.locator('[data-testid="cell-extent"]').textContent().catch(() => null);
  const d = await diffPixels(page, before.png, after.png);
  const p = [];
  if (d.error) p.push(`canvas resized on selection: ${d.error}`);
  else if (!d.changed) p.push('selecting a cell changed no pixel: nothing drawn');
  if (!extent || !/×/.test(extent)) p.push(`no extent printed: ${extent}`);
  if (errors.length) p.push(`console errors: ${errors.join(' | ')}`);
  results.push(row('renderer/cell-drawn-on-the-real-template', p.length ? 'fail' : 'pass', p.length ? p : `BD-T07-03O-531 on ${await page.evaluate(() => window.__atlas.boundTemplateId('body'))}: ${d.changed} px repainted, extent ${extent}`, { diff: d, extent, unpinnedCanvasHeight: { beforeSelect: h0, afterSelect: h1 }, pinnedForMeasurement: '700px' }));
  await context.close();
}

// --- first interaction, measured -------------------------------------------
// Network shaped to the budget's own reference: 25 Mbit/s, 40 ms RTT. CPU and
// GPU are this runner's, with SwiftShader standing in for a GPU — slower than
// any real one, so a reading under the limit is a genuine "within" and a
// reading over it is not by itself a breach.
const timings = [];
for (let i = 0; i < RUNS; i += 1) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 40, downloadThroughput: (25e6 / 8), uploadThroughput: (5e6 / 8),
  });
  await page.addInitScript(() => {
    let v;
    Object.defineProperty(window, '__atlas', {
      configurable: true,
      get() { return v; },
      set(x) { v = x; window.__qaReadyAt = performance.now(); },
    });
  });
  await page.goto(`${server.base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__atlas?.ready === true, null, { timeout: 60000 });
  // The first click, the moment the page can take one: on the painted model.
  const m = await canvasPixels(page);
  const target = m.box ? { x: m.width / 2, y: Math.min(m.height - 5, 900 - m.box.y - 120) } : { x: 400, y: 600 };
  const clickAt = await page.evaluate(() => performance.now());
  await page.locator('[data-testid="canvas"]').click({ position: target });
  await page.waitForFunction(() => window.__atlas.viewer.state.selection !== null, null, { timeout: 10000 }).catch(() => {});
  const t = await page.evaluate((c) => {
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource');
    const lastByte = Math.max(0, ...res.map((r) => r.responseEnd));
    return {
      readyMs: window.__qaReadyAt,
      clickHandledMs: performance.now() - c,
      selected: window.__atlas.viewer.state.selection?.address ?? null,
      lastResourceEndMs: lastByte,
      afterLastByteMs: window.__qaReadyAt - lastByte,
      transferKB: Math.round(res.reduce((n, r) => n + (r.transferSize || 0), 0) / 1024),
      domContentLoadedMs: nav?.domContentLoadedEventEnd ?? null,
      resources: res.length,
    };
  }, clickAt);
  t.firstInteractionMs = t.readyMs + t.clickHandledMs;
  timings.push(t);
  await context.close();
}
{
  const limit = 3500;
  const vals = timings.map((t) => t.firstInteractionMs).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const worst = vals[vals.length - 1];
  const after = timings.map((t) => t.afterLastByteMs).sort((a, b) => a - b);
  const status = worst <= limit ? 'pass' : 'unverified';
  results.push(row('perf/derivedFirstInteractionMs [measured]', status,
    worst <= limit
      ? `measured navigation start → first click handled: median ${median.toFixed(0)} ms, worst ${worst.toFixed(0)} ms of ${RUNS} cold loads at 25 Mbit/s / 40 ms RTT, against a ${limit} ms limit. One-sided: a software-GL runner reading under the limit is within. Boot work after the last byte (index build + template parse + first paint) median ${after[Math.floor(after.length / 2)].toFixed(0)} ms, against the 600 ms render allowance the budget assumed`
      : `worst ${worst.toFixed(0)} ms exceeds ${limit} ms on a software-GL runner; not a breach by itself (slower than the reference machine), not a pass`,
    { limit, runs: timings }));
}

await browser.close();
server.close();
const summary = {
  pass: results.filter((x) => x.status === 'pass').length,
  fail: results.filter((x) => x.status === 'fail').length,
  unverified: results.filter((x) => x.status === 'unverified').length,
};
writeFileSync(join(OUT, 'degrade-perf-dom.json'), JSON.stringify({ summary, results }, (k, v) => (k === 'png' ? undefined : v), 1));
for (const x of results) {
  console.log(`${x.status.toUpperCase().padEnd(10)} ${x.id}`);
  for (const d of [].concat(x.detail)) console.log(`           - ${d}`);
}
console.log(JSON.stringify(summary));
