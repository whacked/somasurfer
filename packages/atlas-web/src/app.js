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
import { fitCamera, flyToCell, missPoint, pan, rayThrough, rotate, zoom } from './viewer/camera.js';
import { decodeView, encodeView, viewHref } from './viewer/deeplink.js';
import { atlasUnavailableNotice, nameIndexProvenanceNotice } from './viewer/flags.js';
import { joinNameIndex, nameIndexSourceTemplate } from './viewer/nameindex.js';
import { curatedModel } from './viewer/corpus.js';
import { comparePapers, papersOverlapping, researchModel, revealPaper } from './viewer/research.js';
import { nameIndexFrames, selectAddress } from './viewer/select.js';
import { ATLAS_LAYERS, createViewer, isLayerVisible, layerOpacity } from './viewer/state.js';
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

/** Set once the renderer module loads; highlights are not drawn before that. */
let GROUP_COLOURS = [];

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

/**
 * Shell-only state: the things that are not part of the view.
 *
 * Label visibility used to be here, as `ui.labels`. It is in the viewer now —
 * it is one of the facets a link restores, so it has to be somewhere the state
 * machine and the URL can both see. Anything left in here is either a loaded
 * asset or a transient of the DOM, and nothing in here belongs in a deep link.
 */
const ui = {
  notices: [],
  renderer: null,
  regionColour: {},
  meshes: {},
  uploaded: {},
  bounds: {},
  catalogue: [],
  research: null,
  researchError: null,
  /** Paper id whose mappings are revealed, or null. */
  revealed: null,
  comparedTo: null,
  comparison: null,
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
//
// Two documents with two different shapes, joined by id. Neither is a name
// index on its own, so the join is explicit and validated — see
// `viewer/nameindex.js`, which also explains why a version mismatch between
// them is refused rather than reconciled.
let nameIndex = null;
let nameIndexSource = null;
try {
  const descriptor = index.nameIndex ?? {};
  if (descriptor.source !== 'asset') {
    throw new Error(
      `the atlas index declares an unknown name index source ${JSON.stringify(descriptor.source ?? null)}`,
    );
  }
  const [namesDoc, coveringsDoc] = await Promise.all([
    loadJson(relative(descriptor.namesPath), 'names'),
    loadJson(relative(descriptor.coveringsPath), 'names'),
  ]);
  nameIndex = buildNameIndex(joinNameIndex(namesDoc, coveringsDoc));
  nameIndexSource = nameIndexSourceTemplate(coveringsDoc);
} catch (error) {
  ui.notices.push(atlasUnavailableNotice(`The name index could not be loaded (${error.message}).`));
}

// --- 2. templates ----------------------------------------------------------
ui.catalogue = index.templates ?? [];

/**
 * Which template to bind, by id, from `?template=`.
 *
 * The catalogue ships the synthetic templates alongside the real ones because
 * three of `locate()`'s five findings need a template that produces them and
 * the real body template produces none of the three — it is admissible, it
 * does not fold, and it realises every level it claims. Without a way to bind
 * `anat-hyperkyphotic-short-wide`, the `folded` message is reachable only in
 * the suite, and QA cannot see it in a running build.
 *
 * Read straight off the query string rather than through `deeplink.js`, and
 * deliberately NOT part of the encoded view. Which template is bound is a
 * property of the build you loaded, not of the view you are looking at; if it
 * round-tripped through `encodeView` then every link anyone copied would pin a
 * template id, and the deep-link matrix would have to prove that a link made
 * against a retired template still restores the same view. It cannot.
 */
const requestedTemplate = new URLSearchParams(location.search).get('template');

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

/** The requested entry of a kind, else that kind's default. */
const entryFor = (entries) =>
  (requestedTemplate ? entries.find((t) => t.id === requestedTemplate) : undefined)
  ?? entries.find((t) => t.isDefault)
  ?? entries[0];

if (requestedTemplate && !ui.catalogue.some((t) => t.id === requestedTemplate)) {
  // Named but unknown. Said out loud rather than silently falling back, or the
  // reader concludes the template they asked for is what they are looking at.
  ui.notices.push({
    code: 'template-unknown',
    severity: 'warning',
    title: 'That template is not in this build',
    detail: `No template with id ${JSON.stringify(requestedTemplate)} is in the catalogue, so the `
      + 'default is bound instead. The template actually in use is named in the atlas panel.',
  });
}

await Promise.all([bindBody(entryFor(bodyEntries)), bindBrain(entryFor(brainEntries))]);

// The name index's cells were sampled against one body's meshes. Binding a
// different body still resolves — fractions are frame measure, so they stay
// exact — but the structure boundaries then describe anatomy that is not on
// screen, and that has to be said. Unreachable in the default build, where the
// bound body IS the template the index was derived from; reachable the moment
// `?template=` binds another.
if (nameIndex && nameIndexSource && templates.body && templates.body.id !== nameIndexSource) {
  ui.notices.push(nameIndexProvenanceNotice(nameIndexSource, templates.body.id));
}

// --- 3. the research corpus, RESOLVED HERE against the real name index ------
//
// Validated at load, like every other fetched document: a malformed mapped
// address must surface here rather than inside a render loop. A failure costs
// the research panel and nothing else.
//
// Two shapes arrive through this one slot, and `role` is the discriminator:
//
//   curated   a `research/1` dataset — papers, findings, structure ids, no
//             geometry. The geometry is decided HERE, by `curatedModel()`,
//             against the name index joined above and both bound templates.
//             It cannot be decided in the build: resolving a structure id
//             means reading the index, the index is an asset payload, and rule
//             6 holds `dist/data/` to deriving nothing from asset content.
//   fixture   a pre-resolved document, carrying cells. Still what the viewer's
//             own suite drives, no longer what the page serves.
//
// The templates are passed deliberately and it is worth 3 mappings and 2
// papers: without a BV template the three `coordinates` mappings resolve
// `no-template`, and a locus we cannot place is not the same claim as a region.
try {
  const doc = await loadJson(relative(index.research?.path ?? 'data/research.json'), 'research');
  ui.research = doc?.role === 'curated'
    ? curatedModel(doc, { names: nameIndex, templates })
    : researchModel(doc);
} catch (error) {
  ui.research = null;
  ui.researchError = `The research index could not be loaded (${error.message}). `
    + 'Addresses, names and geometry are unaffected.';
}

/**
 * What the page resolved, against what the build said it would.
 *
 * This comparison is the only thing that can tell a broken join from an honest
 * one. 20 of the 30 curated papers have no placed geometry at all, so a paper
 * list with nothing painted is the CORRECT rendering for two thirds of the
 * corpus — and is pixel-for-pixel what a join that silently resolved nothing
 * would produce. Without a number, the two are indistinguishable; with one,
 * the disagreement is a notice instead of a shrug.
 *
 * Reported, not enforced. A mismatch means the declaration is stale or the join
 * changed, and neither is a reason to withhold the research panel from a reader
 * — but it is a reason not to let a §7 row report pass on it.
 */
if (ui.research?.role === 'curated') {
  const declared = index.research?.expectedResolution ?? null;
  const measured = ui.research.resolution;
  if (declared && declared.againstNameIndexVersion !== ui.research.nameIndexVersion) {
    ui.notices.push({
      code: 'research-index-mismatch',
      severity: 'warning',
      title: 'The research counts were measured against a different index',
      detail: `This build declares its expected resolution against `
        + `${declared.againstNameIndexVersion}, but the index actually loaded is `
        + `${ui.research.nameIndexVersion}. The mappings below are resolved against the loaded `
        + 'index; the declared counts describe a different one and should not be compared.',
    });
  } else if (declared && declared.resolvedMappings !== measured.mappings.resolved) {
    ui.notices.push({
      code: 'research-resolution-drift',
      severity: 'warning',
      title: 'Fewer mappings resolved than this build expected',
      detail: `The build declares ${declared.resolvedMappings} of ${measured.mappings.total} `
        + `mappings resolvable against this index; ${measured.mappings.resolved} actually did. `
        + 'Papers with no geometry are expected here — most of this corpus has none — so this is '
        + 'reported as a count rather than inferred from an empty panel.',
    });
  }
}

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
  /**
   * An address that lives in the other atlas has no millimetres HERE.
   *
   * The viewer withholds them, so these read from `elsewhereCell` and say
   * whose answer they are. "not placed in this template" would be the wrong
   * sentence twice over: a template did place this cell, and the reason the
   * numbers are not this view's is not the reason that sentence reports.
   */
  const away = selection.elsewhere ? ` in the ${selection.elsewhere} atlas` : '';
  const placed = selection.elsewhereCell ?? selection;
  const extent = placed.extentMm ?? [NaN, NaN, NaN];
  facts.append(el('dt', { textContent: 'Cell extent' }));
  facts.append(el('dd', {
    textContent: placed.extentMm && Number.isFinite(extent[0])
      ? `${fmt(extent[0], 2)} × ${fmt(extent[1], 2)} × ${fmt(extent[2], 2)} mm${away}`
      : 'not placed in this template',
  }));
  // The millimetre centre, always. On a named frame it is corroboration; on an
  // unnamed one it is the whole answer, so it is not conditional on names.
  const centre = placed.pointMm ?? [NaN, NaN, NaN];
  facts.append(el('dt', { textContent: 'Cell centre' }));
  const centreDd = el('dd', {
    textContent: Number.isFinite(centre[0])
      ? `${fmt(centre[0], 1)}, ${fmt(centre[1], 1)}, ${fmt(centre[2], 1)} mm${away}`
      : 'not placed in this template',
  });
  centreDd.dataset.testid = 'cell-centre';
  facts.append(centreDd);
  facts.append(el('dt', { textContent: 'Template' }));
  facts.append(el('dd', { textContent: placed.templateId ?? 'none bound' }));
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

/**
 * The research panel: which papers mapped here, and what one paper mapped.
 *
 * Two lists with deliberately different rules, and the difference is the whole
 * point (see `viewer/research.js`):
 *
 *   the LIST    narrowed by the current selection. A paper that mapped nothing
 *               near here is not shown.
 *   the REVEAL  every mapping of the selected paper, including ones outside
 *               the current selection and ones in the other atlas. Nothing is
 *               withheld; cells outside the filter are marked, and the count
 *               is stated so the user can see that the filter was ignored on
 *               purpose rather than wonder what it did.
 */
function renderResearch() {
  const scope = $('research-scope');
  const provenance = $('research-provenance');
  const list = $('research-list');
  const reveal = $('research-reveal');
  list.replaceChildren();
  reveal.replaceChildren();

  if (!ui.research) {
    provenance.textContent = '';
    provenance.dataset.role = 'none';
    scope.textContent = ui.researchError
      ?? 'No research index is loaded, so no papers can be shown.';
    return;
  }

  // The corpus, named. Written before the counts for the same reason the name
  // index version is written beside a name list rather than under it: the
  // reader needs to know what they are reading before they read it, and a
  // fixture paper is indistinguishable from a real one row by row.
  //
  // `dataset.role` carries the machine-readable half, so the §7 harness can
  // assert which corpus a row measured instead of inferring it from a paper
  // id — the false green DOG-68 exists to close.
  provenance.dataset.role = ui.research.role;
  provenance.dataset.version = ui.research.version;
  provenance.textContent = ui.research.role === 'fixture'
    ? `${ui.research.version} — ${ui.research.caveat}`
    : `${ui.research.version} — curated corpus. Every mapping carries its own provenance; `
      + 'open a paper to read it.';

  const selection = viewer.state.selection;
  const filter = selection?.ok ? selection.displayAddress : null;
  const found = papersOverlapping(ui.research, filter);

  scope.textContent = filter
    ? `${found.length} of ${ui.research.papers.length} papers mapped something overlapping `
      + `${filter}. Selecting one shows all of its mappings, including any outside this region.`
    : `${ui.research.papers.length} papers. Select an address to narrow the list.`;

  for (const { paper, matching } of found) {
    const row = el('li');
    row.dataset.paper = paper.id;
    const open = el('button', { type: 'button', className: 'link', textContent: paper.title });
    open.dataset.testid = `research-paper-${paper.id}`;
    open.addEventListener('click', () => {
      ui.revealed = ui.revealed === paper.id ? null : paper.id;
      uploadHighlights();
      commit({ push: false });
    });
    row.append(open);
    row.append(el('span', {
      className: 'muted',
      textContent: ` ${paper.year ?? '—'}${matching.length > 0 ? `, ${matching.length} here` : ''}`
        + `${paper.atlases.length > 1 ? ', both atlases' : ''}`,
    }));
    if (ui.revealed === paper.id) row.classList.add('selected');
    list.append(row);
  }

  if (ui.revealed === null) return;
  const revealed = revealPaper(ui.research, ui.revealed, filter);
  if (!revealed) return;

  reveal.append(el('h3', { textContent: revealed.paper.title }));
  reveal.append(el('p', {
    className: 'muted',
    textContent: [revealed.paper.venue, revealed.paper.year].filter(Boolean).join(', '),
  }));

  // Said before the list, because a reader scanning a list of regions needs to
  // know up front that it is the paper's whole set and not a filtered view.
  const summary = el('p', { className: 'reveal-summary' });
  summary.dataset.testid = 'reveal-summary';
  summary.textContent = revealed.mappings.length > 0
    // Curated: the mapping count is the paper's claim, and the placed count is
    // what this index could locate. Said as two numbers, because collapsing
    // them would present a paper as having mapped only what we can draw.
    ? `All ${revealed.mappings.length} mapping(s) of this paper are listed; `
      + `${revealed.mappings.length - revealed.unresolvedMappings} could be placed against this `
      + `name index and ${revealed.unresolvedMappings} could not, each saying why. `
      + `${revealed.outsideFilter} of the placed region(s) are outside the current selection`
      + `${revealed.atlases.length > 1 ? ', and this paper maps in both atlases' : ''}. `
      + 'A filter narrows the list of papers, never a paper’s own mappings.'
    : `All ${revealed.cells.length} mapped region(s) of this paper are listed, `
      + `including ${revealed.outsideFilter} outside the current selection`
      + `${revealed.atlases.length > 1 ? ' and mappings in both atlases' : ''}. `
      + 'A filter narrows the list of papers, never a paper’s own mappings.';
  reveal.append(summary);

  const cellList = (cellsOf) => {
    const cells = el('ul', { className: 'cells' });
    for (const cell of cellsOf) {
      const cellRow = el('li');
      cellRow.dataset.cell = cell.address;
      if (cell.withinFilter === false) cellRow.dataset.outsideFilter = 'true';
      const go = el('button', { type: 'button', className: 'link', textContent: cell.address });
      go.dataset.testid = `reveal-cell-${cell.address}`;
      // Selecting a revealed cell is a selection like any other, so it never
      // switches the atlas — a brain mapping offers the explicit move instead.
      go.addEventListener('click', () => select(cell.address, { fly: true, push: true }));
      cellRow.append(go);
      if (cell.atlas !== viewer.atlas) {
        cellRow.append(el('span', {
          className: 'muted',
          textContent: ` in the ${cell.atlas} atlas`,
        }));
      }
      if (cell.withinFilter === false) {
        cellRow.append(el('span', { className: 'muted', textContent: ' outside this region' }));
      }
      cells.append(cellRow);
    }
    return cells;
  };

  /**
   * One curated mapping: what it claims, and either where it is or why not.
   *
   * An unresolved mapping is a row like any other. It is listed, it is
   * described, and it has no cell list — nothing is placed that the index did
   * not place, so there is nothing here to click and nothing to paint. The
   * reason comes from the dataset's own partition and never says "unknown
   * structure"; `viewer/corpus.js` has the argument.
   */
  const mappingRow = (mapping) => {
    const row = el('li', { className: mapping.placed ? 'mapping' : 'mapping unresolved' });
    row.dataset.mapping = mapping.id;
    row.dataset.structure = mapping.structureId;
    row.dataset.placed = String(mapping.placed);

    row.append(el('span', { className: 'structure-label', textContent: mapping.structureLabel }));
    row.append(el('span', { className: 'muted', textContent: ` ${mapping.structureId}` }));
    if (!mapping.labelFromIndex) {
      // A curated label rendered identically to an index name is a quiet
      // upgrade of one to the other. Five of the placed mappings are in this
      // state: real extent, a name no cleared index carries.
      const curated = el('span', {
        className: 'muted',
        textContent: ' — name from the curator, not from the index',
      });
      curated.dataset.testid = 'label-not-from-index';
      row.append(curated);
    }

    if (mapping.placed) {
      row.append(cellList(mapping.cells));
      return row;
    }

    row.dataset.unresolvedReason = mapping.unresolved.reason;
    if (mapping.unresolved.partitionId) row.dataset.partition = mapping.unresolved.partitionId;
    const why = el('p', { className: 'region-only', textContent: mapping.unresolved.headline });
    why.dataset.testid = 'mapping-unresolved';
    row.append(why);
    if (mapping.unresolved.detail) {
      // The partition's recorded reason, verbatim and in full. In a `details`
      // because it is a paragraph — the licence position is a paragraph — but
      // present on the page rather than linked away to a document.
      const more = el('details');
      more.append(el('summary', { textContent: 'Why this cannot be placed in v1' }));
      more.append(el('p', { className: 'muted', textContent: mapping.unresolved.detail }));
      row.append(more);
    }
    return row;
  };

  const findings = el('ul', { className: 'findings' });
  for (const finding of revealed.findings) {
    const item = el('li');
    item.dataset.finding = finding.id;
    item.append(el('span', { className: 'finding-label', textContent: finding.label }));

    // A curated finding is rendered at its mapping level, so a paper with no
    // geometry at all still shows every structure it claimed.
    if (finding.mappings) {
      const mappings = el('ul', { className: 'mappings' });
      for (const mapping of finding.mappings) mappings.append(mappingRow(mapping));
      item.append(mappings);
      findings.append(item);
      continue;
    }

    if (!finding.placed) {
      // An unplaceable report is shown as one. Dropping it would let the atlas
      // imply the literature is more spatially precise than it is.
      const why = el('p', { className: 'region-only', textContent: finding.regionOnly });
      why.dataset.testid = 'region-only';
      item.append(why);
      findings.append(item);
      continue;
    }

    item.append(cellList(finding.cells));
    findings.append(item);
  }
  reveal.append(findings);

  // Compare against the next paper in the narrowed list, which is the cheapest
  // honest form of "compare papers": one explicit pair, by overlap.
  const others = found.map((f) => f.paper.id).filter((id) => id !== ui.revealed);
  if (others.length > 0) {
    const against = ui.comparedTo && others.includes(ui.comparedTo) ? ui.comparedTo : others[0];
    const button = el('button', {
      type: 'button',
      textContent: `Compare with ${ui.research.papers.find((p) => p.id === against).title}`,
    });
    button.dataset.testid = 'compare-papers';
    button.addEventListener('click', () => {
      ui.comparedTo = against;
      ui.comparison = comparePapers(ui.research, ui.revealed, against);
      commit({ push: false });
    });
    reveal.append(button);
  }

  if (ui.comparison && ui.comparison.a.id === ui.revealed) {
    const box = el('div', { className: 'comparison' });
    box.dataset.testid = 'comparison';
    box.append(el('p', {
      textContent: ui.comparison.disjoint
        ? `No mapping of ${ui.comparison.a.id} overlaps any mapping of ${ui.comparison.b.id}. `
          + 'They report different places, rather than not having been compared.'
        : `${ui.comparison.shared.length} overlapping pair(s) of regions, `
          + `${ui.comparison.onlyA.length} only in ${ui.comparison.a.id}, `
          + `${ui.comparison.onlyB.length} only in ${ui.comparison.b.id}.`,
    }));
    for (const pair of ui.comparison.shared.slice(0, 8)) {
      box.append(el('p', { className: 'pair', textContent: `${pair.a.address} ↔ ${pair.b.address}` }));
    }
    reveal.append(box);
  }
}

/**
 * Upload the revealed paper's cells as highlight volumes.
 *
 * Only the cells of the CURRENT atlas are uploaded, because a `BV` cell has no
 * geometry in the body template and there is nothing to draw. That is a
 * rendering fact, not a filter: every mapping is still listed in the panel,
 * and the ones belonging elsewhere say so.
 */
function uploadHighlights() {
  for (const h of ui.uploaded.highlights ?? []) ui.renderer?.release(h.cell);
  ui.uploaded.highlights = [];
  if (ui.revealed === null || !ui.research || !ui.renderer) return;

  const selection = viewer.state.selection;
  const revealed = revealPaper(ui.research, ui.revealed, selection?.ok ? selection.displayAddress : null);
  if (!revealed) return;

  let group = 0;
  for (const finding of revealed.findings) {
    const colour = GROUP_COLOURS[group % GROUP_COLOURS.length];
    group += 1;
    for (const cell of finding.cells) {
      if (cell.atlas !== viewer.atlas) continue;
      let mesh = null;
      try {
        mesh = cellMeshForHighlight(cell.address);
      } catch {
        // A mapping the bound template cannot place is simply not drawn. It is
        // still in the panel, which is where the user would look for it.
        continue;
      }
      if (!mesh) continue;
      ui.uploaded.highlights.push({
        cell: ui.renderer.uploadCell(mesh),
        colour,
        // Outside the filter is drawn fainter, never hidden.
        alpha: cell.withinFilter === false ? 0.13 : 0.26,
      });
    }
  }
}

/** The drawable mesh for a highlighted address, in the bound templates. */
function cellMeshForHighlight(address) {
  const model = selectAddress(address, { templates });
  return model.ok ? model.cell : null;
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
  // Read off the viewer, not off the checkbox's own last value: arriving by
  // deep link, or returning from the brain atlas, can both change this without
  // anyone having clicked it.
  $('labels-toggle').checked = viewer.labelsOf();

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
    highlights: ui.uploaded.highlights ?? [],
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
 * is selectable and styleable for free. The cost is that labels are not
 * occluded by geometry — which for level markers along a spine is what you want
 * anyway, since the point of the label is to find the level you cannot
 * currently see.
 *
 * The overlay stays `aria-hidden`, and that is not an oversight to fix later. A
 * label here carries its meaning in where it sits on a canvas nobody reading by
 * screen reader can see; flattened into the accessibility tree it is 29
 * context-free level codes between the canvas and the address panel. The
 * non-visual route to the same information is the address panel's ranked names
 * and the structure search, which are real DOM with real text.
 *
 * Visibility is `viewer.labelsOf()`, per atlas and in the URL — see the header
 * of `viewer/state.js` for why it is not a field on `ui`.
 */
function renderLabels() {
  const box = $('labels');
  box.replaceChildren();
  const showing = viewer.labelsOf();
  box.hidden = !showing;
  if (!showing || !ui.renderer) return;

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

function select(input, { fly = false, push = true, encodeFlags } = {}) {
  const model = viewer.select(input, { encodeFlags });
  if (model.ok) {
    uploadSelectedCell();
    // The filter moved, so the faint/bright split on the highlights moved.
    uploadHighlights();
    // There is deliberately no `elsewhere` branch here: an address living in
    // the other atlas comes back from the viewer with no `cell`, so there is
    // nothing to upload and nothing to fly to. Keeping the rule in the viewer
    // instead of copying it into the shell is the point — a second copy is how
    // this panel came to say "the view has not been changed" while the camera
    // was already at the other atlas's coordinates (DOG-75).
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
  uploadHighlights();
  commit({ push: true });
}

/** Re-render everything and sync the URL. One funnel, so nothing drifts. */
function commit({ push = false } = {}) {
  renderChrome();
  renderLayers();
  renderAddressPanel();
  renderResearch();
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
    if (!ui.meshes.body) return;
    // A miss is not ignored: it is encoded where it points, and the encoder's
    // flags ride along so the clamp it raises reaches the user (DOG-116).
    const hit = pickMesh(ui.meshes.body, ray.origin, ray.direction);
    const enc = encodeBody(bound, hit ? hit.pointMm : missPoint(ray, ui.bounds.body), digits);
    select(enc.address, { push: true, encodeFlags: enc.flags });
    return;
  }

  let best = null;
  for (const id of ['left', 'right']) {
    const mesh = ui.meshes[id];
    if (!mesh) continue;
    const hit = pickMesh(mesh, ray.origin, ray.direction);
    if (hit && (!best || hit.distanceMm < best.distanceMm)) best = hit;
  }
  // Address only, unlike the body: the hemisphere mesh's vertices sit on the
  // template's own boundary, so about half of all on-surface hits encode as
  // `clamped` by rounding alone, and carrying that would be a false warning.
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
    viewer.setLabels(event.target.checked);
    // Through the one funnel, so the URL gains or loses `labels=0` with the
    // toggle. Pushed rather than replaced: it is a deliberate change to the
    // view, so Back should undo it, the same as hiding a layer.
    commit({ push: true });
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
  GROUP_COLOURS = module.GROUP_COLOURS;
  ui.renderer = module.createRenderer($('canvas'));
  if (ui.meshes.body) ui.uploaded.body = ui.renderer.uploadSurface(ui.meshes.body);
  if (ui.meshes.spine) ui.uploaded.spine = ui.renderer.uploadPolyline(ui.meshes.spine);
  if (ui.meshes.left) ui.uploaded.left = ui.renderer.uploadSurface(ui.meshes.left);
  if (ui.meshes.right) ui.uploaded.right = ui.renderer.uploadSurface(ui.meshes.right);
  uploadSelectedCell();
  uploadHighlights();
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
  /**
   * Labels, through the same path the checkbox takes.
   *
   * Deliberately not `viewer.setLabels` straight: a hook that skipped `commit`
   * would report the new state while the overlay and the URL still showed the
   * old one, and a QA pass on that proves nothing about the page.
   */
  setLabels: (visible) => {
    viewer.setLabels(visible);
    commit({ push: true });
    return viewer.labelsOf();
  },
  labelsVisible: (atlas) => viewer.labelsOf(atlas),
  /** How many label tags the overlay is actually showing, so "on" is checkable. */
  labelsDrawn: () => document.getElementById('labels').childElementCount,
  view: () => viewer.toView(),
  href: () => viewHref(viewer.toView(), location.pathname),
  encodeView,
  parse,
  templateIds: () => ui.catalogue.map((t) => t.id),
  boundTemplateId: (atlas) => boundTemplate(atlas)?.id ?? null,
  maxUsefulDigits: (atlas) => boundTemplate(atlas)?.maxUsefulDigits ?? null,
  nameIndexVersion: nameIndex?.version ?? null,
  /** The template the name index was sampled against, per `coverings.json`. */
  nameIndexSourceTemplate: nameIndexSource,
  /** What `?template=` asked for, so QA can prove the request was honoured. */
  requestedTemplate,
  rendererAvailable: () => Boolean(ui.renderer),
  atlasAvailable: (atlas) => viewer.isAvailable(atlas),
  research: () => ui.research,
  /**
   * Which corpus the page is actually serving — one call, no inference.
   *
   * DOG-68: a §7 row that drove the page, found a fixture paper and reported
   * **pass** would be measuring the invented corpus while the Node-side oracle
   * measured the curated seed set, and nothing in the surface made the two
   * distinguishable without recognising a paper id. A row can now name its
   * dataset, and a row that forgot to is visibly a row that did not ask.
   *
   * `null` rather than a guess when the document failed to load: "no corpus"
   * and "the fixture corpus" are different results and must not print alike.
   *
   * On a curated corpus the counts alone are not enough to judge a row by.
   * Twenty of the thirty papers have no placed geometry, so `resolution` —
   * measured from the join that just ran, not declared — is what tells an
   * honestly empty panel from a broken one. `nameIndexVersion` is carried for
   * the same reason it is carried beside every name list: a resolution is only
   * true relative to the index it came from.
   */
  researchCorpus: () => (ui.research
    ? {
      version: ui.research.version,
      role: ui.research.role,
      caveat: ui.research.caveat,
      paperCount: ui.research.papers.length,
      findingCount: ui.research.papers.reduce((n, p) => n + p.findings.length, 0),
      /** Curated only; `null` on a pre-resolved fixture, which has no join. */
      nameIndexVersion: ui.research.nameIndexVersion ?? null,
      resolution: ui.research.resolution ?? null,
      partitions: ui.research.partitions ?? null,
    }
    : null),
  /** What the build said it was going to serve, for comparison with the above. */
  researchDeclared: () => index.research ?? null,
  /** Stage B: the research panel, so QA can drive the paper journey. */
  revealPaper: (paperId) => {
    ui.revealed = paperId;
    uploadHighlights();
    commit({ push: false });
    return revealPaper(ui.research, paperId, viewer.state.selection?.displayAddress ?? null);
  },
  papersHere: () => papersOverlapping(
    ui.research,
    viewer.state.selection?.ok ? viewer.state.selection.displayAddress : null,
  ).map((f) => f.paper.id),
  comparePapers: (a, b) => comparePapers(ui.research, a, b),
  highlightCount: () => (ui.uploaded.highlights ?? []).length,
  selection: viewer.state.selection,
  ready: true,
};
