/**
 * The deep-link matrix, opened as real URLs in Chromium against the built page.
 *
 * The state-layer run already decides each row against the harness templates
 * the matrix was authored for. This pass asks the two questions only a browser
 * can answer, on the template the page actually binds:
 *
 *   1. Does the page SHOW what the state machine decided? Every notice the
 *      product's own `select()` raises for that URL must be a visible
 *      `[data-notice]` card, a refusal must be a visible `rejection`, and an
 *      accepted address must be printed in the panel.
 *   2. Does the link round-trip? `__atlas.href()` opened in a fresh page must
 *      restore an identical `view()`.
 *
 * The expectation is computed in Node from the same product modules over the
 * same asset payloads, so this compares the page with its own state machine and
 * not with a second model.
 *
 *   source /paperclip/qa-browser/env.sh
 *   node packages/atlas-qa/browser/deeplinks-dom.mjs [--out qa-evidence]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, assertServesOwnDist, launch, openPage, row, serve } from './lib.mjs';
import { DEEP_LINK_MATRIX, QA_URL_PARAMS } from '../src/matrix.ts';
import { realAssets, realTemplates } from '../../atlas-web/test/real-assets.js';
import { decodeView } from '../../atlas-web/src/viewer/deeplink.js';
import { createViewer } from '../../atlas-web/src/viewer/state.js';

const outArg = process.argv.indexOf('--out');
const OUT = join(ROOT, outArg > 0 ? process.argv[outArg + 1] : 'qa-evidence');
mkdirSync(OUT, { recursive: true });

/** The matrix URL without the harness-only parameters the page does not read. */
function pageUrl(url) {
  const u = new URL(url, 'http://x');
  for (const p of Object.values(QA_URL_PARAMS)) u.searchParams.delete(p);
  return `${u.pathname}${u.search}`;
}

/** What the product's own state machine decides for this URL on the real assets. */
function expected(url) {
  const viewer = createViewer({ templates: realTemplates(), nameIndex: realAssets().nameIndex });
  const search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
  const { view, problems } = decodeView(search);
  viewer.applyView(view, problems);
  const sel = viewer.state.selection;
  return {
    atlas: viewer.atlas,
    selected: sel ? { ok: sel.ok, address: sel.address ?? null, displayAddress: sel.displayAddress ?? null } : null,
    notices: (sel?.notices ?? []).map((n) => n.code),
    viewProblems: viewer.state.viewProblems ?? [],
  };
}

// QA_PORT: a fixed port has served another worktree's build (DOG-133 runs pick a free one).
const server = await serve(Number(process.env.QA_PORT ?? 8937));
await assertServesOwnDist(server.base);
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

const results = [];
const rows = DEEP_LINK_MATRIX.filter((r) => r.input.kind === 'url');
const skipped = DEEP_LINK_MATRIX.filter((r) => r.input.kind !== 'url').map((r) => `${r.id} (${r.input.kind})`);

for (const r of rows) {
  const url = pageUrl(r.input.url);
  const exp = expected(url);
  const { page, errors } = await openPage(context, `${server.base}${url}`);
  const seen = await page.evaluate(() => {
    const vis = (n) => !!(n && (n.offsetWidth || n.offsetHeight));
    return {
      notices: [...document.querySelectorAll('[data-notice]')].filter(vis).map((n) => n.dataset.notice),
      rejection: vis(document.querySelector('[data-testid="rejection"]'))
        ? document.querySelector('[data-testid="rejection"]').textContent.trim().slice(0, 240) : null,
      panel: document.querySelector('aside, .panel, #panel')?.textContent ?? document.body.textContent,
      atlas: window.__atlas?.viewer?.atlas ?? null,
      href: window.__atlas?.href?.() ?? null,
      view: window.__atlas ? JSON.parse(JSON.stringify(window.__atlas.view())) : null,
      boot: document.getElementById('boot-error')?.textContent?.trim() || null,
    };
  });
  const problems = [];
  if (errors.length) problems.push(`console errors: ${errors.join(' | ')}`);
  if (seen.boot) problems.push(`boot error: ${seen.boot}`);
  if (seen.atlas !== exp.atlas) problems.push(`atlas ${seen.atlas}, the state machine says ${exp.atlas}`);
  for (const code of exp.notices) {
    if (!seen.notices.includes(code)) problems.push(`the state machine raises \`${code}\` and the page shows no visible [data-notice="${code}"] (visible: ${JSON.stringify(seen.notices)})`);
  }
  if (exp.selected && exp.selected.ok === false && !seen.rejection && !exp.notices.some((c) => seen.notices.includes(c))) {
    problems.push('the address was refused and the page shows neither a rejection nor a notice');
  }
  if (exp.selected?.ok && exp.selected.address && !seen.panel.includes(exp.selected.displayAddress ?? exp.selected.address)
    && !seen.panel.includes(exp.selected.address)) {
    problems.push(`the accepted address ${exp.selected.address} is not printed in the panel`);
  }
  for (const p of exp.viewProblems) {
    // A URL problem the state machine records must be said somewhere visible.
    const said = seen.notices.length > 0 || seen.rejection;
    if (!said) problems.push(`the URL problem "${p}" is recorded and nothing is shown`);
  }
  // Round trip.
  let trip = null;
  if (seen.href) {
    const second = await openPage(context, `${server.base}${seen.href}`);
    const back = await second.page.evaluate(() => ({ view: JSON.parse(JSON.stringify(window.__atlas.view())), href: window.__atlas.href() }));
    // The link carries the camera at 0.01 precision by design, so "the same
    // view" is: every non-camera facet identical, the camera within the URL's
    // own rounding, and the link a fixed point after one trip.
    const { camera: c1, ...rest1 } = seen.view; const { camera: c2, ...rest2 } = back.view;
    const flat = (c) => [c.yaw, c.pitch, c.distance, ...c.target];
    const camOk = flat(c1).every((x, i) => Math.abs(x - flat(c2)[i]) <= 0.0051);
    trip = { href: seen.href, hrefAfter: back.href, facetsSame: JSON.stringify(rest1) === JSON.stringify(rest2), camOk, fixedPoint: back.href === seen.href };
    if (!trip.facetsSame) problems.push(`opening the page's own link ${seen.href} restores different facets: ${JSON.stringify(rest1)} vs ${JSON.stringify(rest2)}`);
    if (!trip.camOk) problems.push(`the camera after the round trip differs beyond the link's 0.01 precision: ${JSON.stringify(c1)} vs ${JSON.stringify(c2)}`);
    if (!trip.fixedPoint) problems.push(`the link is not stable: ${seen.href} reopened writes ${back.href}`);
    await second.page.close();
  } else {
    problems.push('no href to round-trip');
  }
  results.push(row(`matrix/${r.id}`, problems.length ? 'fail' : 'pass', problems.length ? problems : `shown as decided (${exp.notices.join(', ') || 'no notice'}${exp.selected?.ok === false ? ', refused' : ''}); link round-trips`,
    { mustPass: r.mustPass, url, expected: exp, seen: { ...seen, panel: undefined }, trip }));
  console.error(`[${results.length}/${rows.length}] ${results.at(-1).status} ${results.at(-1).id}`);
  await page.close();
}

// The template-defect notices are only reachable with ?template= (see
// docs/viewer-qa-surface.md). The state layer proves the decision; this proves
// the page shows it.
{
  const url = '/?template=anat-hyperkyphotic-short-wide';
  const { page, errors } = await openPage(context, `${server.base}${url}`);
  const facts = await page.evaluate(() => ({
    bound: window.__atlas.boundTemplateId('body'), requested: window.__atlas.requestedTemplate,
    notices: [...document.querySelectorAll('[data-notice]')].map((n) => n.dataset.notice),
  }));
  // The cells the viewer's own suite proves fold on this template
  // (packages/atlas-web/test/honesty.test.js, FOLDED_CELLS).
  const folded = 'BD-T07-12O-111';
  let shown = null;
  if (folded) {
    await page.goto(`${server.base}${url}&a=${encodeURIComponent(folded)}`);
    await page.waitForFunction(() => window.__atlas?.ready === true);
    shown = await page.$$eval('[data-notice]', (ns) => ns.filter((n) => n.offsetWidth || n.offsetHeight).map((n) => n.dataset.notice));
  }
  const problems = [];
  if (errors.length) problems.push(`console errors: ${errors.join(' | ')}`);
  if (facts.bound !== 'anat-hyperkyphotic-short-wide') problems.push(`?template= bound ${facts.bound}`);
  if (!shown.includes('folded')) problems.push(`${folded} folds and the page shows ${JSON.stringify(shown)}`);
  else if (shown.includes('clamped')) problems.push('folded and clamped shown together');
  results.push(row('matrix/folded-shown-in-the-page', problems.length ? 'fail' : 'pass', problems.length ? problems : `?template=anat-hyperkyphotic-short-wide&a=${folded} shows a visible folded notice and no clamped one`, { facts, folded, shown }));
  await page.close();
}

await browser.close();
server.close();
const summary = {
  pass: results.filter((x) => x.status === 'pass').length,
  fail: results.filter((x) => x.status === 'fail').length,
  unverified: results.filter((x) => x.status === 'unverified').length,
  notUrlRows: skipped,
};
writeFileSync(join(OUT, 'deeplinks-dom.json'), JSON.stringify({ summary, results }, null, 1));
for (const x of results) {
  console.log(`${x.status.toUpperCase().padEnd(10)} ${x.id}`);
  if (x.status !== 'pass') for (const d of [].concat(x.detail)) console.log(`           - ${d}`);
}
console.log(JSON.stringify(summary));
