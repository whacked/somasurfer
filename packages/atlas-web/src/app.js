/**
 * The browser shell: DOM wiring over the viewer core.
 *
 * This file owns the DOM and nothing else. Every decision it renders — what is
 * visible, what an address resolves to, which messages apply, what the URL
 * says — is made in `viewer/`, where it is testable in Node without a browser.
 * The rule that keeps it that way: no module under `viewer/` imports this file,
 * and this file holds no state that `viewer/state.js` does not.
 *
 * ## Loading order is a requirement, not a preference
 *
 * The shell paints, then loads indexes, then loads the renderer — in that
 * order, because that is what makes the stage-A degradation criterion true:
 *
 *   1. DOM, address bar, name resolution. Needs `@gstack/alc` and the name
 *      index, and nothing else.
 *   2. Templates. A failure marks that atlas unavailable and leaves (1) working.
 *   3. The renderer, by `await import()`. A failure reports "3D view
 *      unavailable" and leaves (1) and (2) working.
 *
 * Each of those three failures has its own message, and `?fail=index,names,
 * templates,renderer` forces them, so the degraded states are demonstrable
 * rather than theoretical. QA should not have to break a server to test them.
 *
 * ## `window.__atlas`
 *
 * A deliberate, documented test handle. The §7 harness has to drive the viewer
 * and read what it concluded, and scraping rendered text for that produces
 * false passes. It exposes the state machine and the last selection; nothing in
 * the shell reads it, so it cannot drift into being a second code path.
 */

import {
  buildNameIndex,
  encodeBody,
  encodeBrainVolume,
  findStructures,
  parse,
} from './alc.js';
import { fitCamera, flyToCell, pan, rayThrough, rotate, zoom } from './viewer/camera.js';
import { decodeView, encodeView, viewHref } from './viewer/deeplink.js';
import { atlasUnavailableNotice } from './viewer/flags.js';
import { ATLAS_LAYERS, createViewer, isLayerVisible, layerOpacity } from './viewer/state.js';
import { nameIndexFrames } from './viewer/select.js';
import {
  TemplateError,
  bodySpinePolyline,
  bodySurfaceMesh,
  boundsOf,
  brainHemisphereMesh,
  levelRegion,
  meshBounds,
  pickMesh,
  validateBodyTemplate,
  validateBrainVolumeTemplate,
} from './viewer/template.js';

const BASE = new URL('..', import.meta.url).pathname;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
};
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'not placed');
const pct = (f) => `${(f * 100).toFixed(1)}%`;

const forcedFailures = (new URLSearchParams(location.search).get('fail') ?? '').split(',');
const failing = (what) => forcedFailures.includes(what);

async function loadJson(path, what) {
  if (failing(what)) throw new Error(`forced by ?fail=${what}`);
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

/** Index paths are absolute (they carry the deploy base); fetch them as given. */
const relative = (path) => String(path).replace(BASE, '');

const ui = {
  notices: [],
  labels: true,
  renderer: null,
  regionColour: {},
  meshes: {},
  uploaded: {},
  bounds: {},
  catalogue: [],
  research: null,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const index = await loadJson('data/atlas-index.json', 'index').catch((error) => {
  // The index carries the catalogue and the attribution, so without it there
  // is no atlas at all. The one fatal failure — and it still says so in words
  // rather than leaving a blank page.
  $('boot-error').textContent =
    `The atlas index could not be loaded (${error.message}). Nothing else can be shown.`;
  $('boot-error').hidden = false;
  return null;
});
if (!index) throw new Error('atlas index unavailable');

let viewer = createViewer();
const templates = {};

// --- 1. names, which need no geometry --------------------------------------
let nameIndex = null;
try {
  nameIndex = buildNameIndex(await loadJson(relative(index.nameIndex.path), 'names'));
} catch (error) {
  ui.notices.push(atlasUnavailableNotice(`The name index could not be loaded (${error.message}).`));
}

// --- 2. templates ----------------------------------------------------------
ui.catalogue = index.templates ?? [];

async function bindBody(entry) {
  if (!entry) return;
  try {
    templates.body = validateBodyTemplate(await loadJson(relative(entry.path), 'templates'));
    ui.meshes.body = bodySurfaceMesh(templates.body);
    ui.meshes.spine = bodySpinePolyline(templates.body);
    ui.bounds.body = meshBounds(ui.meshes.body);
  } catch (error) {
    delete templates.body;
    ui.unavailableBody = error instanceof TemplateError
      ? `The body template is malformed and was refused: ${error.message}`
      : `The body template could not be loaded (${error.message}).`;
  }
}

async function bindBrain(entry) {
  if (!entry) return;
  try {
    templates.brainVolume = validateBrainVolumeTemplate(
      await loadJson(relative(entry.path), 'templates'),
    );
    ui.meshes.left = brainHemisphereMesh(templates.brainVolume, 'L');
    ui.meshes.right = brainHemisphereMesh(templates.brainVolume, 'R');
    ui.bounds.brain = boundsOf([...ui.meshes.left.corners, ...ui.meshes.right.corners]);
  } catch (error) {
    delete templates.brainVolume;
    ui.unavailableBrain = `The brain template could not be loaded (${error.message}).`;
  }
}

const bodyEntries = ui.catalogue.filter((t) => t.kind === 'body');
const brainEntries = ui.catalogue.filter((t) => t.kind === 'brainVolume');
await Promise.all([
  bindBody(bodyEntries.find((t) => t.isDefault) ?? bodyEntries[0]),
  bindBrain(brainEntries.find((t) => t.isDefault) ?? brainEntries[0]),
]);

// --- 3. the research fixture: the highlight seam, not a stage-A criterion ---
ui.research = await loadJson(relative(index.research?.path ?? 'data/research.json'), 'research')
  .catch(() => null);

viewer = createViewer({ templates, nameIndex });
if (ui.unavailableBody) viewer.markUnavailable('body', ui.unavailableBody);
if (ui.unavailableBrain) viewer.markUnavailable('brain', ui.unavailableBrain);

// Restore whatever the URL asks for, before anything is drawn.
{
  const { view, problems } = decodeView(location.search);
  viewer.applyView(view, problems);
  for (const atlas of ['body', 'brain']) {
    if (ui.bounds[atlas] && !(viewer.cameraOf(atlas).distance > 0)) {
      viewer.setCamera(fitCamera(ui.bounds[atlas]), atlas);
    }
  }
}

/** The bound template for an atlas, or undefined. */
const boundTemplate = (atlas = viewer.atlas) =>
  (atlas === 'body' ? templates.body : templates.brainVolume);

// ---------------------------------------------------------------------------
// DOM rendering
// ---------------------------------------------------------------------------

function renderNotices() {
  const box = $('notices');
  box.replaceChildren();
  const selection = viewer.state.selection;
  const all = [...ui.notices];
  if (!viewer.isAvailable()) {
    all.push(atlasUnavailableNotice(viewer.state.unavailable[viewer.atlas]));
  }
  for (const problem of viewer.state.viewProblems) {
    all.push({
      code: 'link-problem',
      severity: 'warning',
      title: 'This link was partly unusable',
      detail: problem,
    });
  }
  all.push(...(selection?.notices ?? []));

  box.hidden = all.length === 0;
  for (const notice of all) {
    const card = el('div', { className: `notice notice-${notice.severity}` });
    card.dataset.notice = notice.code;
    card.append(el('h4', { textContent: notice.title }));
    card.append(el('p', { textContent: notice.detail }));
    for (const note of notice.notes ?? []) {
      card.append(el('p', { className: 'note', textContent: note }));
    }
    if (notice.offer) {
      const offer = el('button', {
        type: 'button',
        className: 'link',
        textContent: `Show ${notice.offer} instead`,
      });
      offer.dataset.testid = 'offer-ancestor';
      offer.addEventListener('click', () => select(notice.offer, { fly: true }));
      card.append(el('p', {}, [offer]));
    } else if (notice.code === 'frame-disabled' || notice.code === 'no-template') {
      // The offer is absent because there honestly is none. Say that, rather
      // than silently omitting the control and looking like a missing feature.
      card.append(el('p', {
        className: 'note',
        textContent: 'No coarser ancestor of this address can be placed either, so there is nothing to offer.',
      }));
    }
    box.append(card);
  }
}

function renderAddressPanel() {
  const selection = viewer.state.selection;
  const panel = $('address-panel');
  panel.replaceChildren();

  if (!selection) {
    panel.append(el('p', { className: 'empty', textContent: 'Click the model, or paste an address.' }));
    return;
  }
  if (!selection.ok) {
    // A rejection changes nothing else on screen: no address, no names, no
    // camera move, no layer change. Only this message.
    const message = el('p', { className: 'rejected', textContent: selection.notices[0].detail });
    message.dataset.testid = 'rejection';
    panel.append(message);
    return;
  }

  const code = el('div', { className: 'code' });
  code.append(el('code', { textContent: selection.address, id: 'selected-address' }));
  code.append(el('span', {
    className: 'check',
    title: 'Check symbol, for reading an address aloud',
    textContent: selection.withCheck.slice(-1),
  }));
  for (const [label, value] of [
    ['Copy', () => selection.address],
    ['Copy link', () => new URL(viewHref(viewer.toView(), location.pathname), location.origin).href],
  ]) {
    const button = el('button', { type: 'button', textContent: label });
    button.dataset.testid = label === 'Copy' ? 'copy-address' : 'copy-link';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value());
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Press ⌘C';
      }
      setTimeout(() => { button.textContent = label; }, 1400);
    });
    code.append(button);
  }
  panel.append(code);
  panel.append(el('p', { className: 'readable', textContent: selection.description.readable }));

  if (selection.demoted) {
    const shown = el('p', { className: 'demoted' }, [
      'Drawn and named as ',
      el('code', { textContent: selection.displayAddress }),
      ' — this template’s limit.',
    ]);
    shown.dataset.testid = 'demoted-to';
    panel.append(shown);
  }

  const facts = el('dl', { className: 'facts' });
  facts.dataset.testid = 'cell-extent';
  const extent = selection.extentMm ?? [NaN, NaN, NaN];
  facts.append(el('dt', { textContent: 'Cell extent' }));
  facts.append(el('dd', {
    textContent: selection.extentMm && Number.isFinite(extent[0])
      ? `${fmt(extent[0], 2)} × ${fmt(extent[1], 2)} × ${fmt(extent[2], 2)} mm`
      : 'not placed in this template',
  }));
  // The millimetre centre, always. On a named frame it is corroboration; on an
  // unnamed one it is the whole answer, so it is not conditional on names.
  const centre = selection.pointMm ?? [NaN, NaN, NaN];
  facts.append(el('dt', { textContent: 'Cell centre' }));
  const centreDd = el('dd', {
    textContent: Number.isFinite(centre[0])
      ? `${fmt(centre[0], 1)}, ${fmt(centre[1], 1)}, ${fmt(centre[2], 1)} mm`
      : 'not placed in this template',
  });
  centreDd.dataset.testid = 'cell-centre';
  facts.append(centreDd);
  facts.append(el('dt', { textContent: 'Template' }));
  facts.append(el('dd', { textContent: selection.templateId ?? 'none bound' }));
  panel.append(facts);

  if (selection.elsewhere) {
    const offer = el('div', { className: 'cross-atlas' });
    offer.dataset.testid = 'cross-atlas-offer';
    offer.append(el('p', {
      textContent: `This address belongs to the ${selection.elsewhere} atlas. The view has not been changed.`,
    }));
    const go = el('button', { type: 'button', textContent: `Open ${selection.elsewhere} atlas` });
    go.dataset.testid = 'offer-open-atlas';
    go.addEventListener('click', () => openAtlas(selection.elsewhere));
    offer.append(go);
    panel.append(offer);
  }

  panel.append(renderNames(selection));
}

/** Names: always a ranked list, always with the index version beside it. */
function renderNames(selection) {
  const names = el('div', { className: 'names' });
  names.dataset.testid = 'names';
  if (!selection.names) {
    names.append(el('p', { className: 'empty', textContent: 'No name index is loaded.' }));
    return names;
  }

  /**
   * A frame with no index gets its own presentation, not an empty list.
   *
   * No heading citing a version — no index spoke, so quoting the `BD` index's
   * version here would borrow its provenance for a frame it says nothing
   * about. No "0 structures overlap", no fraction language, no spinner: those
   * all imply a lookup that ran and came back empty, and would read as a gap
   * about to close. What the viewer has here is a location, and it says so.
   */
  if (selection.names.covered === false) {
    names.dataset.covered = 'false';
    names.append(el('h3', { textContent: 'Location only' }));
    names.append(el('p', {
      className: 'unnamed',
      textContent: `Frame ${selection.names.frame} ships without a name index in v1, so this `
        + 'selection is a place rather than a named structure. The address and the millimetres '
        + 'above are exact.',
    }));
    names.append(el('p', {
      className: 'measure',
      textContent: 'No brain parcellation cleared licensing for redistribution, so "unnamed" is '
        + 'the shipping state here, not a gap waiting to close.',
    }));
    return names;
  }

  names.dataset.covered = 'true';
  names.append(el('h3', {}, [
    'Names ',
    el('span', {
      className: 'version',
      id: 'name-index-version',
      textContent: selection.names.indexVersion,
    }),
  ]));

  if (selection.names.matches.length === 0) {
    names.append(el('p', {
      className: 'empty',
      textContent: 'No indexed structure overlaps this cell.',
    }));
  } else {
    const list = el('ol', { className: 'ranked' });
    for (const match of selection.names.matches) {
      const row = el('li');
      row.dataset.structure = match.id;
      row.dataset.fraction = String(match.fraction);
      row.append(el('span', { className: 'fraction', textContent: pct(match.fraction) }));
      row.append(el('span', { className: 'name', textContent: match.name }));
      const bar = el('span', { className: 'bar' });
      bar.style.setProperty('--f', String(match.fraction));
      row.append(bar);
      list.append(row);
    }
    names.append(list);
  }

  if (selection.names.unclaimedFraction > 0.0005) {
    names.append(el('p', {
      className: 'unclaimed',
      textContent: `${pct(selection.names.unclaimedFraction)} of this cell is claimed by no indexed structure.`,
    }));
  }
  if (selection.names.containing.length > 0) {
    names.append(el('p', { className: 'containing' }, [
      'Contained by: ',
      selection.names.containing.map((s) => s.name).join(' › '),
    ]));
  }
  names.append(el('p', {
    className: 'measure',
    textContent: 'Fractions are dimensionless frame measure: exact, and independent of any template.',
  }));
  return names;
}

function renderLayers() {
  const box = $('layers');
  box.replaceChildren();
  const layers = viewer.layersOf();
  for (const layer of ATLAS_LAYERS[viewer.atlas]) {
    const row = el('div', { className: 'layer' });
    row.dataset.layer = layer.id;

    const toggle = el('input', { type: 'checkbox', checked: isLayerVisible(layers, layer.id) });
    toggle.dataset.testid = `layer-toggle-${layer.id}`;
    toggle.disabled = layers.isolated !== null;
    toggle.addEventListener('change', () => {
      viewer.setLayerHidden(layer.id, !toggle.checked);
      commit({ push: true });
    });
    row.append(el('label', {}, [toggle, layer.label]));

    const opacity = el('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(layerOpacity(layers, layer.id)),
      title: 'Opacity',
    });
    opacity.dataset.testid = `layer-opacity-${layer.id}`;
    opacity.addEventListener('input', () => {
      viewer.setLayerOpacity(layer.id, Number(opacity.value));
      commit({ push: false });
    });
    row.append(opacity);

    const isolated = layers.isolated === layer.id;
    const iso = el('button', {
      type: 'button',
      className: isolated ? 'iso on' : 'iso',
      textContent: isolated ? 'Un-isolate' : 'Isolate',
    });
    iso.dataset.testid = `layer-isolate-${layer.id}`;
    iso.addEventListener('click', () => {
      viewer.isolate(isolated ? null : layer.id);
      commit({ push: true });
    });
    row.append(iso);
    box.append(row);
  }
}

function renderChrome() {
  $('atlas-name').textContent = viewer.atlas === 'body' ? 'Body atlas' : 'Brain atlas';
  document.body.dataset.atlas = viewer.atlas;

  const other = viewer.atlas === 'body' ? 'brain' : 'body';
  const open = $('open-other-atlas');
  open.textContent = `Open ${other} atlas`;
  open.onclick = () => openAtlas(other);

  const back = $('return');
  back.hidden = !viewer.canReturn;
  if (viewer.canReturn) back.textContent = `Back to ${viewer.returnTarget} atlas`;
  back.onclick = () => {
    viewer.returnToPrevious();
    afterAtlasChange();
  };

  const bound = boundTemplate();
  const entry = ui.catalogue.find((t) => t.id === bound?.id);
  const caveat = $('template-caveat');
  caveat.textContent = entry?.caveat ?? '';
  caveat.classList.toggle('inadmissible', entry?.admissible === false);
  $('template-id').textContent = bound?.id ?? 'none bound';

  const limit = bound?.maxUsefulDigits;
  const precision = $('precision');
  if (Number.isFinite(limit)) {
    // The cap comes off the BOUND template every time, never a literal: the
    // real pipeline's templates declare their own, derived from mesh
    // resolution, and DOG-35's body template declares 2.
    precision.max = String(limit);
    if (Number(precision.value) > limit) precision.value = String(limit);
    $('precision-note').textContent = `This template justifies at most ${limit} refinement digits.`;
  } else {
    $('precision-note').textContent = 'No template is bound, so no precision is justified.';
  }
  $('precision-value').textContent = precision.value;
  $('labels-toggle').checked = ui.labels;

  // Structure search spans every indexed frame, which on the brain atlas means
  // it finds body structures and nothing local. Said plainly, because a search
  // box that returns ribs while you are looking at a brain otherwise looks
  // broken rather than correctly scoped.
  const searchable = [...nameIndexFrames(nameIndex)];
  const localFrame = viewer.atlas === 'body' ? 'BD' : 'BV';
  $('search-scope').textContent = searchable.length === 0
    ? 'No name index is loaded, so there is nothing to search.'
    : searchable.includes(localFrame)
      ? `Searching ${searchable.join(', ')}.`
      : `No names exist for ${localFrame}, so results come from ${searchable.join(', ')} and `
        + 'selecting one will not leave this atlas.';
}

// ---------------------------------------------------------------------------
// Scene assembly: viewer state -> renderer draw list
// ---------------------------------------------------------------------------

function scene() {
  const canvas = $('canvas');
  const layers = viewer.layersOf();
  const solids = [];
  const lines = [];

  if (viewer.atlas === 'body' && ui.uploaded.body) {
    for (const layer of ATLAS_LAYERS.body) {
      if (layer.id === 'spine') continue;
      const ranges = ui.uploaded.body.levels
        .filter((l) => l.region === layer.id)
        .map((l) => ({
          firstTriangle: l.firstTriangle,
          triangleCount: l.triangleCount,
          colour: ui.regionColour[layer.id] ?? ui.regionColour.other,
        }));
      if (ranges.length === 0) continue;
      solids.push({
        mesh: ui.uploaded.body,
        ranges,
        visible: isLayerVisible(layers, layer.id),
        opacity: layerOpacity(layers, layer.id),
      });
    }
    if (ui.uploaded.spine) {
      lines.push({
        ...ui.uploaded.spine,
        colour: ui.regionColour.spine,
        visible: isLayerVisible(layers, 'spine'),
        opacity: layerOpacity(layers, 'spine'),
      });
    }
  }

  if (viewer.atlas === 'brain') {
    for (const id of ['left', 'right']) {
      const uploaded = ui.uploaded[id];
      if (!uploaded) continue;
      solids.push({
        mesh: uploaded,
        ranges: [{
          firstTriangle: 0,
          triangleCount: uploaded.count / 3,
          colour: ui.regionColour[id],
        }],
        visible: isLayerVisible(layers, id),
        opacity: layerOpacity(layers, id),
      });
    }
  }

  return {
    camera: viewer.cameraOf(),
    width: Math.max(1, canvas.clientWidth),
    height: Math.max(1, canvas.clientHeight),
    solids,
    lines,
    cell: ui.uploaded.cell,
  };
}

function draw() {
  if (ui.renderer) {
    try {
      ui.renderer.render(scene());
    } catch (error) {
      ui.renderer = null;
      showCanvasMessage(`The 3D view stopped: ${error.message}`, 'renderer-failed');
    }
  }
  renderLabels();
}

function showCanvasMessage(text, code) {
  const box = $('canvas-message');
  box.textContent = text;
  box.dataset.notice = code;
  box.hidden = false;
}

/**
 * Labels as a DOM overlay rather than in GL.
 *
 * Text in a WebGL scene means a glyph atlas and a pile of code; text in the DOM
 * is selectable, visible to a screen reader and styleable for free. The cost is
 * that labels are not occluded by geometry — which for level markers along a
 * spine is what you want anyway, since the point of the label is to find the
 * level you cannot currently see.
 */
function renderLabels() {
  const box = $('labels');
  box.replaceChildren();
  box.hidden = !ui.labels;
  if (!ui.labels || !ui.renderer) return;

  const canvas = $('canvas');
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const camera = viewer.cameraOf();
  const layers = viewer.layersOf();

  if (viewer.atlas === 'body' && templates.body && ui.meshes.spine) {
    templates.body.slabs.forEach((slab, i) => {
      if (!isLayerVisible(layers, levelRegion(slab.label))) return;
      const at = ui.renderer.projectPoint(ui.meshes.spine[i], camera, width, height);
      if (!at) return;
      const tag = el('span', { className: 'label', textContent: slab.label });
      tag.dataset.level = slab.label;
      tag.style.left = `${at[0]}px`;
      tag.style.top = `${at[1]}px`;
      box.append(tag);
    });
  }

  if (viewer.atlas === 'brain' && templates.brainVolume) {
    for (const [id, hemisphere] of [['left', 'L'], ['right', 'R']]) {
      if (!isLayerVisible(layers, id)) continue;
      const mesh = ui.meshes[id];
      if (!mesh) continue;
      const centre = boundsOf(mesh.corners).centre;
      const at = ui.renderer.projectPoint(centre, camera, width, height);
      if (!at) continue;
      const tag = el('span', { className: 'label', textContent: `BV-${hemisphere}` });
      tag.dataset.level = `BV-${hemisphere}`;
      tag.style.left = `${at[0]}px`;
      tag.style.top = `${at[1]}px`;
      box.append(tag);
    }
  }
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function uploadSelectedCell() {
  if (ui.uploaded.cell) ui.renderer?.release(ui.uploaded.cell);
  ui.uploaded.cell = null;
  const selection = viewer.state.selection;
  if (selection?.ok && selection.cell && ui.renderer) {
    ui.uploaded.cell = ui.renderer.uploadCell(selection.cell);
  }
}

function select(input, { fly = false, push = true } = {}) {
  const model = viewer.select(input);
  if (model.ok) {
    uploadSelectedCell();
    if (fly && model.cell) {
      viewer.setCamera(flyToCell(viewer.cameraOf(), meshBounds(model.cell)));
    }
  }
  commit({ push });
  return model;
}

function openAtlas(atlas) {
  viewer.openAtlas(atlas);
  afterAtlasChange();
}

function afterAtlasChange() {
  const atlas = viewer.atlas;
  if (ui.bounds[atlas] && !(viewer.cameraOf(atlas).distance > 0)) {
    viewer.setCamera(fitCamera(ui.bounds[atlas]), atlas);
  }
  uploadSelectedCell();
  commit({ push: true });
}

/** Re-render everything and sync the URL. One funnel, so nothing drifts. */
function commit({ push = false } = {}) {
  renderChrome();
  renderLayers();
  renderAddressPanel();
  renderNotices();
  draw();
  const href = viewHref(viewer.toView(), location.pathname);
  if (href !== location.pathname + location.search) {
    if (push) history.pushState(null, '', href);
    else history.replaceState(null, '', href);
  }
  if (window.__atlas) window.__atlas.selection = viewer.state.selection;
}

/**
 * Click -> address.
 *
 * The millimetre point goes back through the frame's own encoder, never through
 * the level the triangle belongs to. `encodeBody` is what produces the flags,
 * including `folded` — which is exactly the case where the triangle's level and
 * the frame's answer differ, so trusting the triangle would hide the one defect
 * the flag exists to show.
 */
function pick(event) {
  const canvas = $('canvas');
  const rect = canvas.getBoundingClientRect();
  const ray = rayThrough(
    viewer.cameraOf(),
    event.clientX - rect.left,
    event.clientY - rect.top,
    Math.max(1, canvas.clientWidth),
    Math.max(1, canvas.clientHeight),
  );
  const bound = boundTemplate();
  if (!bound) return;
  // Always clamped to the bound template's own limit; never a literal.
  const digits = Math.min(bound.maxUsefulDigits, Number($('precision').value));

  if (viewer.atlas === 'body') {
    const hit = ui.meshes.body && pickMesh(ui.meshes.body, ray.origin, ray.direction);
    if (!hit) return;
    select(encodeBody(bound, hit.pointMm, digits).address, { push: true });
    return;
  }

  let best = null;
  for (const id of ['left', 'right']) {
    const mesh = ui.meshes[id];
    if (!mesh) continue;
    const hit = pickMesh(mesh, ray.origin, ray.direction);
    if (hit && (!best || hit.distanceMm < best.distanceMm)) best = hit;
  }
  if (best) select(encodeBrainVolume(bound, best.pointMm, digits).address, { push: true });
}

function wireCanvas() {
  const canvas = $('canvas');
  let drag = null;

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, moved: 0, button: event.button, shift: event.shiftKey };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    const camera = viewer.cameraOf();
    viewer.setCamera(
      drag.button === 2 || drag.shift
        ? pan(camera, dx / Math.max(1, canvas.clientWidth), dy / Math.max(1, canvas.clientHeight))
        : rotate(camera, dx * 0.008, -dy * 0.008),
    );
    drag.x = event.clientX;
    drag.y = event.clientY;
    draw();
  });
  canvas.addEventListener('pointerup', (event) => {
    const travelled = drag && drag.moved > 4;
    drag = null;
    // A camera move is not a selection. Only a click without travel picks.
    if (travelled) commit({ push: false });
    else pick(event);
  });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    viewer.setCamera(
      zoom(viewer.cameraOf(), event.deltaY > 0 ? 1.12 : 1 / 1.12, ui.bounds[viewer.atlas]),
    );
    commit({ push: false });
  }, { passive: false });

  new ResizeObserver(() => draw()).observe(canvas);
}

function wireControls() {
  $('address-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = $('address-input').value.trim();
    if (raw.length > 0) select(raw, { fly: true, push: true });
  });

  $('reset-camera').addEventListener('click', () => {
    if (ui.bounds[viewer.atlas]) viewer.setCamera(fitCamera(ui.bounds[viewer.atlas]));
    commit({ push: false });
  });
  $('reset-layers').addEventListener('click', () => {
    viewer.resetLayers();
    commit({ push: true });
  });
  $('labels-toggle').addEventListener('change', (event) => {
    ui.labels = event.target.checked;
    renderLabels();
  });
  $('precision').addEventListener('input', () => {
    $('precision-value').textContent = $('precision').value;
  });

  const search = $('search-input');
  const results = $('search-results');
  search.addEventListener('input', () => {
    results.replaceChildren();
    if (!nameIndex || search.value.trim().length < 2) return;
    for (const structure of findStructures(search.value, nameIndex, 12)) {
      const cells = coveringOf(structure.id);
      const row = el('li');
      const go = el('button', { type: 'button', className: 'link', textContent: structure.name });
      go.dataset.structure = structure.id;
      go.addEventListener('click', () => {
        // A structure's covering is many cells. Select its first — the
        // coarsest after normalisation — and say how many there are, rather
        // than implying the structure is one cell.
        if (cells.length > 0) select(cells[0], { fly: true, push: true });
        results.replaceChildren();
      });
      row.append(go);
      row.append(el('span', {
        className: 'muted',
        textContent: ` ${cells.length} cell${cells.length === 1 ? '' : 's'}`,
      }));
      results.append(row);
    }
  });

  addEventListener('popstate', () => {
    const { view, problems } = decodeView(location.search);
    viewer.applyView(view, problems);
    if (ui.bounds[viewer.atlas] && !(viewer.cameraOf().distance > 0)) {
      viewer.setCamera(fitCamera(ui.bounds[viewer.atlas]));
    }
    uploadSelectedCell();
    commit({ push: false });
  });
}

function coveringOf(structureId) {
  const at = nameIndex.structures.findIndex((s) => s.id === structureId);
  return at < 0 ? [] : [...nameIndex.coverings[at].cells];
}

// ---------------------------------------------------------------------------
// Paint, then load the renderer
// ---------------------------------------------------------------------------

$('attribution-status').textContent = index.attribution?.packageLicenceStatus === 'pending'
  ? `Asset licence pending ${index.attribution.packageLicenceDecision}. First-party placeholder geometry only.`
  : 'Asset licences as listed in the footer.';

wireCanvas();
wireControls();
$('shell').hidden = false;
commit({ push: false });

try {
  if (failing('renderer')) throw new Error('forced by ?fail=renderer');
  const module = await import('./viewer/renderer.js');
  ui.regionColour = module.REGION_COLOURS;
  ui.renderer = module.createRenderer($('canvas'));
  if (ui.meshes.body) ui.uploaded.body = ui.renderer.uploadSurface(ui.meshes.body);
  if (ui.meshes.spine) ui.uploaded.spine = ui.renderer.uploadPolyline(ui.meshes.spine);
  if (ui.meshes.left) ui.uploaded.left = ui.renderer.uploadSurface(ui.meshes.left);
  if (ui.meshes.right) ui.uploaded.right = ui.renderer.uploadSurface(ui.meshes.right);
  uploadSelectedCell();
  $('canvas-message').hidden = true;
} catch (error) {
  // The shell keeps working. This is the stage-A degradation criterion, and it
  // is the whole reason the renderer is imported here rather than at the top.
  showCanvasMessage(
    `The 3D view is unavailable (${error.message}). Addresses still parse, still resolve to names, `
    + 'and deep links still work.',
    'renderer-unavailable',
  );
}

commit({ push: false });

/** The documented test handle. See the module header. */
window.__atlas = {
  viewer,
  select: (address, options) => select(address, options),
  openAtlas,
  returnToPrevious: () => {
    viewer.returnToPrevious();
    afterAtlasChange();
  },
  resetCamera: () => {
    if (ui.bounds[viewer.atlas]) viewer.setCamera(fitCamera(ui.bounds[viewer.atlas]));
    commit({ push: false });
  },
  view: () => viewer.toView(),
  href: () => viewHref(viewer.toView(), location.pathname),
  encodeView,
  parse,
  templateIds: () => ui.catalogue.map((t) => t.id),
  boundTemplateId: (atlas) => boundTemplate(atlas)?.id ?? null,
  maxUsefulDigits: (atlas) => boundTemplate(atlas)?.maxUsefulDigits ?? null,
  nameIndexVersion: nameIndex?.version ?? null,
  rendererAvailable: () => Boolean(ui.renderer),
  atlasAvailable: (atlas) => viewer.isAvailable(atlas),
  research: () => ui.research,
  selection: viewer.state.selection,
  ready: true,
};
