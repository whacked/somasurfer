/**
 * Client entry. Native ES module, no build step, no dependencies.
 *
 * It does three things, all of which the real viewer will also have to do:
 * load the prebuilt index, fetch asset payloads as separate files at runtime,
 * and report the two numbers the performance budget is stated in — time to
 * low-resolution asset load, and time to first interaction.
 *
 * It deliberately does NOT import anything from the asset package. Assets
 * arrive over `fetch`, as data, which is what keeps an asset-side share-alike
 * obligation off this file. See tools/check-licence-separation.mjs.
 */

const BASE = new URL('..', import.meta.url).pathname;
const mark = (name) => performance.mark(name);
const ms = (v) => `${Math.round(v)} ms`;

const $ = (id) => document.getElementById(id);

function table(rows, headers) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

const timings = {};

mark('index-fetch-start');
const index = await fetch(`${BASE}data/atlas-index.json`).then((r) => {
  if (!r.ok) throw new Error(`index ${r.status}`);
  return r.json();
});
mark('index-ready');
timings.indexMs = performance.measure('index', 'index-fetch-start', 'index-ready').duration;

// --- frames ---------------------------------------------------------------
$('frames-out').innerHTML = table(
  index.frames.map((f) => [f.id, f.summary, f.enabled ? 'v1' : 'reserved']),
  ['frame', 'what it addresses', 'status'],
);
$('frames-out').setAttribute('aria-busy', 'false');

// --- levels ---------------------------------------------------------------
const byRegion = new Map();
for (const l of index.bodyLevels) {
  if (!byRegion.has(l.region)) byRegion.set(l.region, []);
  byRegion.get(l.region).push(l.label);
}
$('levels-out').innerHTML = table(
  [...byRegion].map(([region, labels]) => [region, labels.join(' '), labels.length]),
  ['region', 'levels', 'count'],
);
$('levels-out').setAttribute('aria-busy', 'false');

// --- assets, on demand ----------------------------------------------------
// First interaction is the click. Everything above has to be done by then for
// the page to be worth interacting with, which is why the budget measures from
// navigation start rather than from this handler.
$('load-assets').addEventListener(
  'click',
  async () => {
    const button = $('load-assets');
    button.disabled = true;
    button.textContent = 'Loading…';
    mark('assets-start');
    timings.firstInteractionMs = performance.now();

    const loaded = [];
    for (const asset of index.assets) {
      const response = await fetch(asset.path);
      if (!response.ok) {
        loaded.push([asset.path, `failed ${response.status}`, '—']);
        continue;
      }
      // Measured as bytes over the wire, not as a parsed mesh: the viewer will
      // hand this to a worker. The point here is the transfer and parse cost.
      const payload = await response.json();
      loaded.push([
        asset.path.replace(BASE, ''),
        `${(asset.bytes / 1024).toFixed(0)} KiB`,
        payload.vertexCount ? `${payload.vertexCount} vertices, ${payload.triangleCount} triangles` : 'label set',
      ]);
    }
    mark('assets-ready');
    timings.assetsMs = performance.measure('assets', 'assets-start', 'assets-ready').duration;

    button.textContent = 'Loaded';
    $('assets-out').innerHTML = table(loaded, ['file', 'size', 'contents']);
    renderPerf();
  },
  { once: true },
);

// --- perf -----------------------------------------------------------------
function renderPerf() {
  const nav = performance.getEntriesByType('navigation')[0];
  const rows = [
    ['index fetch + parse', ms(timings.indexMs)],
    ['page interactive', nav ? ms(nav.domInteractive) : 'n/a'],
    ['first interaction', timings.firstInteractionMs ? ms(timings.firstInteractionMs) : 'not yet — click above'],
    ['low-res asset load', timings.assetsMs ? ms(timings.assetsMs) : 'not yet — click above'],
  ];
  $('perf-out').innerHTML = table(rows, ['measurement', 'this browser']);
}
renderPerf();
