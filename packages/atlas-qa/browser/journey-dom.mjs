/**
 * The §7 viewer journey, driven through the DOM of the built page in Chromium.
 *
 * Every action is a real input event on a real control — a click, a typed
 * address, a drag — and every observation is read off the page: the panel's
 * text and `data-*` hooks, the URL, and the canvas's own pixels. `__atlas` is
 * read for state the DOM cannot carry (camera numbers, the highlight count) and
 * is never used to drive a step, so a broken control fails its row.
 *
 *   source /paperclip/qa-browser/env.sh
 *   node packages/atlas-qa/browser/journey-dom.mjs [--out qa-evidence]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, canvasPixels, diffPixels, launch, openPage, row, serve } from './lib.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = join(ROOT, outArg > 0 ? process.argv[outArg + 1] : 'qa-evidence');
mkdirSync(OUT, { recursive: true });

const results = [];
const sourceLink = {};
const shot = async (page, name) => {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
};
const view = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__atlas.view())));
const text = (page, sel) => page.locator(sel).first().textContent().catch(() => null);
const count = (page, sel) => page.locator(sel).count();
const notices = (page) => page.$$eval('[data-notice]', (ns) => ns.map((n) => ({
  code: n.dataset.notice, visible: !!(n.offsetWidth || n.offsetHeight), text: n.textContent.trim().slice(0, 200),
})));
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const server = await serve(8933);
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const { page, errors } = await openPage(context, `${server.base}/`);

// --- 1. default body view ---------------------------------------------------
{
  const px = await canvasPixels(page);
  const framing = {};
  const v = await view(page);
  const facts = await page.evaluate(() => ({
    atlas: window.__atlas.viewer.atlas,
    renderer: window.__atlas.rendererAvailable(),
    template: window.__atlas.boundTemplateId('body'),
    labelsVisible: window.__atlas.labelsVisible('body'),
    labelsDrawn: window.__atlas.labelsDrawn(),
    heading: document.querySelector('h2, .atlas-name, header strong')?.textContent ?? null,
    url: location.href,
  }));
  const path = await shot(page, '01-default-body-view');
  const problems = [];
  if (errors.length) problems.push(`console errors on load: ${errors.join(' | ')}`);
  if (facts.atlas !== 'body') problems.push(`atlas is ${facts.atlas}, not body`);
  if (!facts.renderer) problems.push('renderer unavailable');
  if (px.colours < 16 || px.paintedFraction < 0.01) {
    problems.push(`canvas is effectively blank: ${px.painted} painted px, ${px.colours} colours`);
  }
  // "In frame": find the model by diffing against the same view with every
  // layer hidden, then ask how much of it lies inside the browser viewport —
  // what a reader sees on arrival, without scrolling.
  const ids = await page.$$eval('[data-testid^="layer-toggle-"]', (ns) => ns.map((n) => n.dataset.testid));
  for (const t of ids) await page.locator(`[data-testid="${t}"]`).uncheck();
  await page.waitForTimeout(200);
  const empty = await canvasPixels(page);
  for (const t of ids) await page.locator(`[data-testid="${t}"]`).check();
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  const model = await diffPixels(page, px.png, empty.png);
  const vp = page.viewportSize();
  framing.model = model; framing.canvasBox = px.box; framing.viewport = vp;
  if (!model.bbox) {
    problems.push('hiding every layer changed no pixel, so no model is drawn');
  } else {
    // Model rows in page coordinates, clipped to the first viewport.
    const top = px.box.y + model.bbox.minY; const bottom = px.box.y + model.bbox.maxY;
    const visible = Math.max(0, Math.min(bottom, vp.height) - Math.max(top, 0));
    framing.modelPageRows = [top, bottom];
    framing.visibleFraction = visible / Math.max(1, bottom - top);
    if (framing.visibleFraction < 0.5) {
      problems.push(`at ${vp.width}x${vp.height} the body is below the fold: the model spans page rows ${Math.round(top)}–${Math.round(bottom)} `
        + `but the viewport ends at ${vp.height}, so ${(100 * framing.visibleFraction).toFixed(0)}% of it is visible on arrival. `
        + `The canvas is ${Math.round(px.box.width)}x${Math.round(px.box.height)} CSS px — taller than the window`);
    }
  }
  if (!facts.labelsVisible || facts.labelsDrawn === 0) problems.push(`labels default: visible=${facts.labelsVisible}, drawn=${facts.labelsDrawn}`);
  results.push(row('journey/default-body-view', problems.length ? 'fail' : 'pass',
    problems.length ? problems : 'body atlas, renderer up, model painted and framed, labels on by default, no console errors',
    { ...facts, canvas: { ...px, png: undefined }, framing, view: v, screenshot: path }));
}

// --- 2. change layers -------------------------------------------------------
{
  const before = await view(page);
  const pxBefore = await canvasPixels(page);
  const toggles = await page.$$eval('[data-testid^="layer-toggle-"]', (ns) => ns.map((n) => n.dataset.testid));
  const problems = [];
  let after = before; let pxAfter = pxBefore;
  if (toggles.length < 2) {
    results.push(row('journey/change-layers', 'unverified', `only ${toggles.length} layer toggles in the DOM`));
  } else {
    const hideId = 'thoracic';
    const dimId = 'lumbar';
    await page.locator(`[data-testid="layer-toggle-${hideId}"]`).uncheck();
    const op = page.locator(`[data-testid="layer-opacity-${dimId}"]`);
    await op.fill('0.5').catch(async () => {
      await op.evaluate((n) => { n.value = '0.5'; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); });
    });
    await page.waitForTimeout(300);
    after = await view(page);
    pxAfter = await canvasPixels(page);
    const layers = await page.evaluate(() => window.__atlas.viewer.layersOf());
    if (!layers.hidden.includes(hideId)) problems.push(`hiding ${hideId} via its checkbox did not hide it: ${JSON.stringify(layers)}`);
    if (Math.abs((layers.opacity?.[dimId] ?? 1) - 0.5) > 1e-6) problems.push(`opacity ${dimId} is ${layers.opacity?.[dimId]}, expected 0.5`);
    if (!sameJSON(before.camera, after.camera)) problems.push('the camera moved on a layer change');
    if (before.address !== after.address) problems.push('a layer change changed the selection');
    const d = await diffPixels(page, pxBefore.png, pxAfter.png);
    if (!d.changed) problems.push('hiding a layer and dimming another changed no pixel on the canvas');
    const url = page.url();
    results.push(row('journey/change-layers', problems.length ? 'fail' : 'pass',
      problems.length ? problems : `hid ${hideId}, dimmed ${dimId} to 0.5 through the controls; camera and selection unchanged; canvas repainted`,
      { toggles, layers, url, screenshot: await shot(page, '02-change-layers') }));
  }
}

// --- 3. select without leaving the atlas ------------------------------------
// Two input paths: a click on the model, and a pasted address.
let selectedAddress = null;
{
  const problems = [];
  // (a) Click the painted model at its centroid.
  const px = await canvasPixels(page);
  let click = null;
  if (px.centroid) {
    await page.locator('[data-testid="canvas"]').click({ position: { x: px.centroid.x, y: px.centroid.y } });
    await page.waitForTimeout(400);
    click = await page.evaluate(() => {
      const s = window.__atlas.viewer.state.selection;
      return s ? { ok: s.ok, address: s.address ?? null, atlas: window.__atlas.viewer.atlas } : null;
    });
    if (!click?.ok) problems.push(`clicking the painted model selected nothing: ${JSON.stringify(click)}`);
    if (click && click.atlas !== 'body') problems.push('a click switched atlas');
  } else {
    problems.push('no painted pixel to click');
  }
  // (b) Paste an address into the address box — a mitsuhashi-mapped thoracic cell.
  const target = 'BD-T05-01I-4';
  await page.locator('[data-testid="address-input"]').fill(target);
  await page.locator('[data-testid="address-submit"]').click();
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => {
    const sel = window.__atlas.viewer.state.selection;
    return {
      ok: sel?.ok, address: sel?.address, atlas: window.__atlas.viewer.atlas,
      names: (sel?.names?.matches ?? []).map((m) => ({ id: m.structure?.id ?? m.structureId, fraction: m.fraction })),
      indexVersion: sel?.names?.indexVersion ?? null,
    };
  });
  selectedAddress = s.address;
  const namesEl = await page.$eval('[data-testid="names"]', (n) => ({
    covered: n.dataset.covered, text: n.textContent.replace(/\s+/g, ' ').trim().slice(0, 600),
  })).catch(() => null);
  const extent = await text(page, '[data-testid="cell-extent"]');
  const url = page.url();
  if (s.atlas !== 'body') problems.push('selecting switched atlas');
  if (!s.ok) problems.push(`pasting ${target} did not select it`);
  if (!namesEl) problems.push('no names panel');
  else {
    if (namesEl.covered !== 'true') problems.push(`names panel data-covered=${namesEl.covered}`);
    if (!/%|\d\.\d/.test(namesEl.text)) problems.push(`the names panel shows no containment fractions: "${namesEl.text}"`);
    if (s.indexVersion && !namesEl.text.includes(s.indexVersion.slice(0, 12))) problems.push('the names panel does not show the name-index version');
  }
  if (!extent) problems.push('no cell extent shown');
  if (!decodeURIComponent(url).includes(target)) problems.push(`the URL does not carry ${target}: ${url}`);
  const layers = await page.evaluate(() => window.__atlas.viewer.layersOf());
  if (!layers.hidden.includes('thoracic')) problems.push('selecting reset the layer state');
  results.push(row('journey/select-structure-without-leaving-atlas', problems.length ? 'fail' : 'pass',
    problems.length ? problems : `click-select at the model centroid → ${click?.address}; pasted ${target} → ranked names with fractions and the index version, extent shown, URL carries the address, atlas still body, layers intact`,
    { click, pasted: s, namesPanel: namesEl, extent, url, screenshot: await shot(page, '03-select') }));
}

// --- 4. explicit brain navigation -------------------------------------------
let bodySnapshot = null;
{
  const problems = [];
  // Labels OFF in the body before leaving: the default is on, so restoring the
  // default would otherwise prove nothing on the way back.
  await page.locator('[data-testid="labels-toggle"]').uncheck();
  await page.waitForTimeout(200);
  bodySnapshot = await view(page);
  bodySnapshot.labelsDrawn = await page.evaluate(() => window.__atlas.labelsDrawn());
  const pxBody = await canvasPixels(page);
  await page.locator('[data-testid="open-other-atlas"]').click();
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({ atlas: window.__atlas.viewer.atlas, url: location.href,
    template: window.__atlas.boundTemplateId('brain'), available: window.__atlas.atlasAvailable('brain') }));
  const pxBrain = await canvasPixels(page);
  if (after.atlas !== 'brain') problems.push(`atlas after Open brain atlas: ${after.atlas}`);
  if (!/atlas=brain/.test(after.url)) problems.push(`URL does not say atlas=brain: ${after.url}`);
  if (pxBrain.colours < 16) problems.push('brain canvas blank');
  // Change the brain view: drag to orbit, and hide a hemisphere.
  const cam0 = (await view(page)).camera;
  const box = await page.locator('[data-testid="canvas"]').boundingBox();
  await page.evaluate(() => window.scrollTo(0, 0));
  const gy = Math.min(box.y + box.height / 2, (box.y + page.viewportSize().height) / 2);
  await page.mouse.move(box.x + box.width / 2, gy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, gy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const cam1 = (await view(page)).camera;
  if (sameJSON(cam0, cam1)) problems.push('dragging on the brain canvas did not orbit the camera');
  await page.locator('[data-testid="layer-toggle-left"]').uncheck().catch(() => problems.push('no left-hemisphere toggle'));
  await page.locator('[data-testid="labels-toggle"]').check();
  await page.waitForTimeout(200);
  results.push(row('journey/explicit-brain-navigation', problems.length ? 'fail' : 'pass',
    problems.length ? problems : 'Open brain atlas switched to the brain, URL says atlas=brain, brain painted; drag orbited; a hemisphere hidden and labels turned on in the brain',
    { after, cam0, cam1, brainPainted: pxBrain.painted, bodyPainted: pxBody.painted, screenshot: await shot(page, '04-brain') }));
}

// --- 5. region research — BV, the real corpus -------------------------------
{
  const problems = [];
  // A coordinate-placed BV cell from the curated corpus.
  const bv = await page.evaluate(() => {
    const r = window.__atlas.research();
    for (const p of r.papers) for (const c of p.cells) if (c.atlas === 'brain') return { paper: p.id, address: c.address };
    return null;
  });
  if (!bv) {
    results.push(row('journey/region-research', 'unverified', 'no BV-placed cell in the served corpus'));
  } else {
    await page.locator('[data-testid="address-input"]').fill(bv.address);
    await page.locator('[data-testid="address-submit"]').click();
    await page.waitForTimeout(400);
    const prov = await page.$eval('[data-testid="research-provenance"]', (n) => ({ role: n.dataset.role, version: n.dataset.version }));
    const listed = await page.$$eval('[data-testid^="research-paper-"]', (ns) => ns.map((n) => n.dataset.testid.slice('research-paper-'.length)));
    const scope = await text(page, '[data-testid="research-scope"]');
    const ns = await notices(page);
    const namesEl = await page.$eval('[data-testid="names"]', (n) => ({ covered: n.dataset.covered, text: n.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) })).catch(() => null);
    const highlights = await page.evaluate(() => window.__atlas.highlightCount());
    const allHtml = await page.content();
    if (prov.role !== 'curated') problems.push(`research provenance role is ${prov.role}`);
    if (prov.version !== 'research-seed-2026.10.1') problems.push(`research version ${prov.version}`);
    if (!listed.includes(bv.paper)) problems.push(`the paper whose coordinates placed ${bv.address} (${bv.paper}) is not listed`);
    if (listed.length >= 30) problems.push('the list did not narrow');
    if (listed.some((id) => /FXP-/.test(id)) || /example\.invalid/.test(allHtml)) problems.push('fixture content on the page');
    if (highlights !== 0) problems.push(`${highlights} highlights before any paper is selected`);
    const unnamed = ns.filter((n) => n.code === 'frame-unnamed');
    if (unnamed.length !== 1) problems.push(`expected exactly one frame-unnamed notice, got ${JSON.stringify(ns.map((n) => n.code))}`);
    if (ns.some((n) => n.code === 'atlas-unavailable' || n.code === 'names-unavailable')) problems.push('a BV selection reported a failure');
    if (namesEl?.covered !== 'false') problems.push(`BV names panel data-covered=${namesEl?.covered}`);
    if (namesEl && !/Location only/i.test(namesEl.text)) problems.push(`BV names panel is not headed "Location only": "${namesEl.text}"`);
    results.push(row('journey/region-research', problems.length ? 'fail' : 'pass',
      problems.length ? problems : `BV ${bv.address}: ${listed.length} of 30 curated papers listed (${listed.join(', ')}); frame-unnamed info notice, "Location only"; nothing highlighted yet`,
      { bv, prov, listed, scope, notices: ns, namesPanel: namesEl, screenshot: await shot(page, '05-region-research-bv') }));
  }
}

// --- 6a. a paper whose mappings are all unplaceable --------------------------
{
  const problems = [];
  // Clear the selection so the full list shows; Brodmann maps only parcellation labels.
  await page.locator('[data-testid="address-input"]').fill('');
  const id = 'paper:brodmann-1909-localisation';
  // Brodmann is not in a BV-filtered list, so reach it from the unfiltered one.
  await page.goto(`${server.base}/?atlas=brain`);
  await page.waitForFunction(() => window.__atlas?.ready === true);
  await page.locator(`[data-testid="research-paper-${id}"]`).click();
  await page.waitForTimeout(400);
  const summary = await text(page, '[data-testid="reveal-summary"]');
  const rows = await page.$$eval('[data-mapping]', (ns) => ns.map((n) => ({ s: n.dataset.structure, placed: n.dataset.placed, reason: n.dataset.unresolvedReason ?? null, partition: n.dataset.partition ?? null, headline: n.querySelector('[data-testid="mapping-unresolved"]')?.textContent ?? null })));
  const highlights = await page.evaluate(() => window.__atlas.highlightCount());
  const source = await page.locator('[data-testid="research-reveal"]').textContent();
  if (rows.length !== 6) problems.push(`${rows.length} mappings listed, expected 6`);
  if (rows.some((r) => r.placed !== 'false')) problems.push('a Brodmann mapping is marked placed');
  if (rows.some((r) => !r.headline || !r.reason)) problems.push('an unresolved mapping is listed without its reason');
  if (highlights !== 0) problems.push(`${highlights} cells painted for a paper with no placeable mapping`);
  if (!/All 6 mapping\(s\)/.test(summary ?? '') || !/0 could be placed/.test(summary ?? '')) problems.push(`summary: "${summary}"`);
  sourceLink.brodmann = { links: await page.$$eval('[data-testid="research-reveal"] a[href]', (ns) => ns.map((n) => n.href)), saysNone: /no source link/i.test(source) };
  results.push(row('journey/paper-reveals-all-its-regions [brodmann 6/6 unresolved]', problems.length ? 'fail' : 'pass',
    problems.length ? problems : 'Brodmann 1909: 6 of 6 mappings listed, every one unresolved with its recorded reason, nothing painted',
    { summary, rows, highlights, screenshot: await shot(page, '06a-brodmann') }));
}

// --- 8. return to body with the previous view intact -------------------------
// Run against the SAME page history as steps 1–4: rebuild that state first.
{
  const problems = [];
  await page.goto(`${server.base}/`);
  await page.waitForFunction(() => window.__atlas?.ready === true);
  await page.locator('[data-testid="layer-toggle-thoracic"]').uncheck();
  await page.locator('[data-testid="address-input"]').fill('BD-T05-01I-4');
  await page.locator('[data-testid="address-submit"]').click();
  await page.locator('[data-testid="labels-toggle"]').uncheck();
  await page.waitForTimeout(300);
  const before = await view(page);
  const labelsDrawnBefore = await page.evaluate(() => window.__atlas.labelsDrawn());
  await page.locator('[data-testid="open-other-atlas"]').click();
  await page.waitForTimeout(400);
  const box = await page.locator('[data-testid="canvas"]').boundingBox();
  await page.evaluate(() => window.scrollTo(0, 0));
  const gy2 = Math.min(box.y + box.height / 2, (box.y + page.viewportSize().height) / 2);
  await page.mouse.move(box.x + box.width / 2, gy2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, gy2 + 40, { steps: 8 });
  await page.mouse.up();
  await page.locator('[data-testid="layer-toggle-left"]').uncheck();
  await page.locator('[data-testid="labels-toggle"]').check();
  await page.waitForTimeout(200);
  await page.locator('[data-testid="return"]').click();
  await page.waitForTimeout(500);
  const after = await view(page);
  const labelsDrawnAfter = await page.evaluate(() => window.__atlas.labelsDrawn());
  const atlas = await page.evaluate(() => window.__atlas.viewer.atlas);
  const toggleChecked = await page.locator('[data-testid="labels-toggle"]').isChecked();
  const thoracicChecked = await page.locator('[data-testid="layer-toggle-thoracic"]').isChecked();
  if (atlas !== 'body') problems.push(`atlas after Return: ${atlas}`);
  for (const k of Object.keys(before)) {
    if (!sameJSON(before[k], after[k])) problems.push(`${k} not restored: before ${JSON.stringify(before[k])}, after ${JSON.stringify(after[k])}`);
  }
  if (toggleChecked) problems.push('the labels checkbox shows ON after returning to a body view that had labels off');
  if (labelsDrawnAfter !== labelsDrawnBefore) problems.push(`label tags drawn: ${labelsDrawnBefore} before, ${labelsDrawnAfter} after`);
  if (thoracicChecked) problems.push('the thoracic layer checkbox shows visible after returning');
  if (!decodeURIComponent(page.url()).includes('BD-T05-01I-4')) problems.push(`URL lost the address: ${page.url()}`);
  results.push(row('journey/return-to-body-with-previous-view-intact', problems.length ? 'fail' : 'pass',
    problems.length ? problems : 'Return restored camera, layers, labels (off, 0 tags drawn) and selection exactly; the controls show the restored state; URL carries the address',
    { before, after, labelsDrawnBefore, labelsDrawnAfter, screenshot: await shot(page, '08-return') }));
}

// --- 6b / 7. body research: reveal under a filter, then compare --------------
{
  const problems = [];
  await page.goto(`${server.base}/?a=BD-T05-01I-4`);
  await page.waitForFunction(() => window.__atlas?.ready === true);
  await page.waitForTimeout(300);
  const listed = await page.$$eval('[data-testid^="research-paper-"]', (ns) => ns.map((n) => n.dataset.testid.slice('research-paper-'.length)));
  const id = 'paper:mitsuhashi-2009-bodyparts3d';
  if (!listed.includes(id)) problems.push(`${id} not listed under BD-T05-01I-4: ${listed.join(', ')}`);
  const pxBefore = await canvasPixels(page);
  await page.locator(`[data-testid="research-paper-${id}"]`).click();
  await page.waitForTimeout(500);
  const summary = await text(page, '[data-testid="reveal-summary"]');
  const rows = await page.$$eval('[data-mapping]', (ns) => ns.map((n) => ({ s: n.dataset.structure, placed: n.dataset.placed, partition: n.dataset.partition ?? null })));
  const outside = await count(page, '[data-outside-filter="true"]');
  const highlights = await page.evaluate(() => window.__atlas.highlightCount());
  const expectCells = await page.evaluate((pid) => window.__atlas.research().papers.find((p) => p.id === pid).cells.filter((c) => c.atlas === 'body').length, id);
  const pxReveal = await canvasPixels(page);
  sourceLink.mitsuhashi = {
    url: await page.evaluate((pid) => window.__atlas.research().papers.find((p) => p.id === pid).url, id),
    links: await page.$$eval('[data-testid="research-reveal"] a[href], [data-testid="research-list"] a[href]', (ns) => ns.map((n) => n.href)),
  };
  if (rows.length !== 9) problems.push(`${rows.length} mappings listed, expected all 9`);
  const placed = rows.filter((r) => r.placed === 'true').length;
  if (placed !== 7) problems.push(`${placed} placed, expected 7`);
  if (outside === 0) problems.push('no revealed cell is marked outside the filter, so the filter may have narrowed the paper');
  if (highlights !== expectCells) problems.push(`${highlights} highlight volumes for ${expectCells} placed body cells`);
  const dReveal = await diffPixels(page, pxBefore.png, pxReveal.png);
  if (dReveal.error) {
    // The canvas changed size: it takes the height of the side panel, and the
    // reveal list made the panel tall. Say what a reader sees at the top.
    await page.evaluate(() => window.scrollTo(0, 0));
    problems.push(`revealing the paper resized the 3D view from ${Math.round(pxBefore.box.height)} to ${Math.round(pxReveal.box.height)} CSS px tall `
      + `(the canvas takes the side panel's height), so at ${page.viewportSize().width}x${page.viewportSize().height} the model and its highlights `
      + 'are no longer in the visible part of the page. With the canvas height pinned (diagnostic only) the same reveal does paint: see diag-pinned-*.png');
  } else if (!dReveal.changed) problems.push('revealing a paper changed no pixel on the canvas');
  results.push(row('journey/paper-reveals-all-its-regions [mitsuhashi 9 listed / 7 placed under a filter]', problems.length ? 'fail' : 'pass',
    problems.length ? problems : `under filter BD-T05-01I-4: all 9 mappings listed, 7 placed, ${outside} cells marked outside the filter, ${highlights} cells painted`,
    { listed, summary, rows, outside, highlights, expectCells, revealPixelsChanged: dReveal.changed, screenshot: await shot(page, '06b-mitsuhashi') }));

  // 7. compare.
  const p7 = [];
  const button = page.locator('[data-testid="compare-papers"]');
  const label = await button.textContent().catch(() => null);
  if (!label) {
    results.push(row('journey/compare-two-papers', 'fail', 'no compare control after revealing a paper'));
  } else {
    await button.click();
    await page.waitForTimeout(500);
    const comparison = await text(page, '[data-testid="comparison"]');
    const highlights2 = await page.evaluate(() => window.__atlas.highlightCount());
    const pxCompare = await canvasPixels(page);
    // Which paper the button compared against: its label names the title.
    const against = await page.evaluate((l) => window.__atlas.research().papers
      .find((p) => l.endsWith(p.title))?.id ?? null, label);
    const model = await page.evaluate((pair) => {
      const c = window.__atlas.comparePapers(pair[0], pair[1]);
      return c ? { shared: c.shared.length, onlyA: c.onlyA.length, onlyB: c.onlyB.length, disjoint: c.disjoint } : null;
    }, [id, against]);
    const otherCells = against ? await page.evaluate((pid) => window.__atlas.research().papers.find((p) => p.id === pid).cells.filter((c) => c.atlas === 'body').length, against) : null;
    // §4 / §8: both papers painted, a distinct colour per paper, overlaps hatched.
    if (highlights2 <= highlights) {
      p7.push(`comparing against ${against} painted nothing new: ${highlights} highlight volumes before, ${highlights2} after. `
        + `The second paper (${otherCells} placed body cells) is not drawn, so there is no per-paper colour and no hatched overlap — the comparison is text only ("${comparison?.trim().slice(0, 160)}")`);
    }
    if (!comparison) p7.push('no comparison box');
    // The only pairing reachable is the next paper in the narrowed list.
    const choosable = await page.$$eval('[data-testid="compare-papers"]', (ns) => ns.length);
    results.push(row('journey/compare-two-papers', p7.length ? 'fail' : 'pass', p7.length ? p7 : 'both papers painted with overlap',
      { buttonLabel: label, against, comparison, model, highlightsBefore: highlights, highlightsAfter: highlights2, otherCells, comparePixelsChanged: (await diffPixels(page, pxReveal.png, pxCompare.png)), compareControls: choosable, screenshot: await shot(page, '07-compare') }));
  }
}

{
  const m = sourceLink.mitsuhashi ?? {}; const b = sourceLink.brodmann ?? {};
  const problems = [];
  if (m.url && !(m.links ?? []).some((h) => h === m.url)) problems.push(`Mitsuhashi 2009 has url ${m.url} and the research panel renders no link to it (links: ${JSON.stringify(m.links)})`);
  if (b && !b.saysNone) problems.push('Brodmann 1909 has no source link and the panel does not say so ("no source link recorded")');
  results.push(row('research/source-link', problems.length ? 'fail' : 'pass', problems.length ? problems : 'source links rendered; a missing one is stated', sourceLink));
}

// The DOG-74 thin and thick pairs, through the page's own model (not a UI path).
const pairs = await page.evaluate(() => [
  ['paper:mitsuhashi-2009-bodyparts3d', 'paper:rosse-2003-fma'],
  ['paper:rosse-2003-fma', 'paper:bogduk-2012-lumbar-anatomy'],
].map(([a, b]) => { const c = window.__atlas.comparePapers(a, b); return { a, b, shared: c?.shared.length ?? null, disjoint: c?.disjoint ?? null }; }));

await browser.close();
server.close();

const summary = {
  pass: results.filter((r) => r.status === 'pass').length,
  fail: results.filter((r) => r.status === 'fail').length,
  unverified: results.filter((r) => r.status === 'unverified').length,
};
writeFileSync(join(OUT, 'journey-dom.json'), JSON.stringify({ summary, results, pairs }, (k, v) => (k === 'png' ? undefined : v), 1));
for (const r of results) {
  console.log(`${r.status.toUpperCase().padEnd(10)} ${r.id}`);
  for (const d of [].concat(r.detail)) console.log(`           - ${d}`);
}
console.log('pairs', JSON.stringify(pairs));
console.log(JSON.stringify(summary));
