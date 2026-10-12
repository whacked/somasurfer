/** The browser shell: DOM wiring over the viewer core. Loading order, `?fail=` and `window.__atlas`: docs/viewer-shell.md. */

import {
  buildNameIndex,
  bvLocalToMm,
  encodeBody,
  encodeBrainVolume,
  findStructures,
  parse,
} from './alc.js';
import { fitCamera, flyToCell, missPoint, pan, rayThrough, rotate, zoom } from './viewer/camera.js';
import { decodeView, encodeView, viewHref } from './viewer/deeplink.js';
import { atlasUnavailableNotice, nameIndexProvenanceNotice } from './viewer/flags.js';
import { joinNameIndex, nameIndexSourceTemplate } from './viewer/nameindex.js';
import { curatedModel, paperSource } from './viewer/corpus.js';
import { comparePapers, comparisonLayers, papersOverlapping, researchModel, revealPaper } from './viewer/research.js';
import { boundsOfStructures, meshSetFrom, pickStructure, searchStructures } from './viewer/meshset.js';
import { nameIndexFrames, selectAddress } from './viewer/select.js';
import { ATLAS_LAYERS, createViewer, isLayerVisible, layerOpacity, structureLayers } from './viewer/state.js';
import {
  TemplateError,
  bodySpinePolyline,
  boundsOf,
  levelRegion,
  meshBounds,
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
let PAPER_COLOURS = [];

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

/** Shell-only state: loaded assets and DOM transients, nothing a link restores (docs/viewer-shell.md). */
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
  /** Decoded mesh sets per atlas (viewer/meshset.js), each with `gpu` once uploaded. */
  sets: { body: [], brain: [] },
  meshStatus: { body: 'pending', brain: 'pending' },
  /** Per atlas, the camera last fitted automatically, so arriving meshes may refit it. */
  autoFit: {},
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

// --- 0. anatomy meshes (DOG-129), fetched now and decoded once the renderer is
// up. The URL's atlas goes first, so a brain link is not queued behind the body.
// Geometry is never on the path to an address: a failure here costs the meshes.
const meshEntries = index.meshSets ?? [];
const fetches = new Map();
const once = (key, start) => fetches.get(key) ?? fetches.set(key, start()).get(key);
const setDocs = (entry) => once(entry.id, async () => {
  const [structures, labels, registration] = await Promise.all(['structures', 'labels', 'registration']
    .map((k) => (entry[k] ? loadJson(relative(entry[k]), 'meshes') : null)));
  return { structures, labels, registration };
});
const tierBytes = (entry, tier) => once(`${entry.id}/${tier}`, async () => {
  const file = (await setDocs(entry)).structures.tiers?.[tier]?.file;
  if (!file) return null;
  const response = await fetch(`${BASE}assets/${file}`);
  if (!response.ok) throw new Error(`${file} returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
});
for (const entry of meshEntries.filter((e) => e.atlas === decodeView(location.search).view.atlas)) {
  tierBytes(entry, 'low').catch(() => {});
}

// --- 1. names, which need no geometry (docs/viewer-shell.md)
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

/** Which template to bind, by id, from `?template=`. (docs/viewer-shell.md) */
const requestedTemplate = new URLSearchParams(location.search).get('template');

async function bindBody(entry) {
  if (!entry) return;
  try {
    templates.body = validateBodyTemplate(await loadJson(relative(entry.path), 'templates'));
    ui.meshes.spine = bodySpinePolyline(templates.body);
    // Until the meshes arrive: the spine, widened by the frame's widest radius.
    const spine = boundsOf(ui.meshes.spine);
    ui.bounds.body = { ...spine, radius: spine.radius + Math.max(...templates.body.slabs.flatMap((s) => s.surfaceRadiiMm)) };
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
    // The frame's two hemisphere boxes: label anchors, and bounds until the meshes arrive.
    const box = (h, k) => bvLocalToMm(templates.brainVolume, h, { a: k & 1, b: (k >> 1) & 1, c: (k >> 2) & 1 });
    ui.hemispheres = ['L', 'R'].map((h) => [h, boundsOf([...Array(8).keys()].map((k) => box(h, k)))]);
    ui.bounds.brain = boundsOf(ui.hemispheres.flatMap(([, b]) => [b.lo, b.hi]));
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

// The name index's cells were sampled against one body's meshes. (docs/viewer-shell.md)
if (nameIndex && nameIndexSource && templates.body && templates.body.id !== nameIndexSource) {
  ui.notices.push(nameIndexProvenanceNotice(nameIndexSource, templates.body.id));
}

// --- 3. the research corpus, resolved here against the real name index (docs/viewer-shell.md)
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

/** What the page resolved, against what the build said it would. (docs/viewer-shell.md) */
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
  for (const atlas of ['body', 'brain']) fitIfUnset(atlas);
}

/** Fit the camera to an atlas that has none yet, remembering it was automatic. */
function fitIfUnset(atlas) {
  if (ui.bounds[atlas] && !(viewer.cameraOf(atlas).distance > 0)) {
    ui.autoFit[atlas] = viewer.setCamera(fitCamera(ui.bounds[atlas]), atlas);
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
  const all = [...ui.notices, ...(ui.meshNotices?.[viewer.atlas] ? [ui.meshNotices[viewer.atlas]] : [])];
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
  /** An address that lives in the other atlas has no millimetres HERE. (docs/viewer-shell.md) */
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

  /** A frame with no index gets its own presentation, not an empty list. (docs/viewer-shell.md) */
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

/** The research panel: the list is narrowed by the selection, a revealed paper never is (docs/viewer-shell.md). */
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

  // The corpus, named before anything is listed (docs/viewer-shell.md).
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
      // A different paper ends the comparison rather than re-anchoring it.
      if (!comparing()) ui.comparison = null;
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

  // Where to read the paper, or the sentence saying there is nowhere. The
  // provenance line tells the reader to open a paper to read it, so a missing
  // link and a link that was never drawn must not look the same (DOG-117). A
  // fixture paper has no citation; it gets the same check under its title.
  const source = paperSource(revealed.paper);
  const cite = el('p', { className: 'citation' });
  cite.dataset.testid = 'research-source';
  if (revealed.paper.citation) cite.append(revealed.paper.citation, ' ');
  if (source.href) {
    const link = el('a', {
      href: source.href, rel: source.rel, target: source.target, textContent: source.href,
    });
    link.dataset.testid = 'research-source-link';
    cite.append(link);
  } else {
    const none = el('span', { className: 'muted', textContent: `No source link: ${source.unlinkedReason}.` });
    none.dataset.testid = 'research-source-missing';
    cite.append(none);
  }
  reveal.append(cite);

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

  /** One curated mapping: what it claims, and either where it is or why not (docs/viewer-shell.md). */
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

  // Compare against any other paper in the narrowed list, chosen here. The
  // pair is drawn — one colour per paper, the overlap hatched in both — and
  // summarised in words beneath.
  const others = found.map((f) => f.paper.id).filter((id) => id !== ui.revealed);
  if (others.length > 0) {
    const titleOf = (id) => ui.research.papers.find((p) => p.id === id).title;
    let against = ui.comparedTo && others.includes(ui.comparedTo) ? ui.comparedTo : others[0];
    const choose = el('select', { title: 'Paper to compare with' });
    choose.dataset.testid = 'compare-against';
    for (const id of others) choose.append(el('option', { value: id, textContent: titleOf(id) }));
    choose.value = against;
    const button = el('button', { type: 'button', textContent: `Compare with ${titleOf(against)}` });
    button.dataset.testid = 'compare-papers';
    choose.addEventListener('change', () => {
      against = choose.value;
      button.textContent = `Compare with ${titleOf(against)}`;
    });
    button.addEventListener('click', () => compareWith(against));
    reveal.append(el('div', { className: 'compare' }, [choose, button]));
  }

  if (comparing()) {
    const { a, b } = ui.comparison;
    const box = el('div', { className: 'comparison' });
    box.dataset.testid = 'comparison';
    box.dataset.a = a.id;
    box.dataset.b = b.id;
    const swatch = (colour, hatch) => {
      const rgb = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`;
      const node = el('span', { className: 'swatch' });
      node.style.background = hatch
        ? `repeating-linear-gradient(135deg, ${rgb(colour)} 0 3px, ${rgb(hatch)} 3px 6px)`
        : rgb(colour);
      return node;
    };
    const [colourA, colourB] = PAPER_COLOURS;
    const legend = el('ul', { className: 'legend' });
    legend.dataset.testid = 'comparison-legend';
    if (colourA) {
      legend.append(el('li', {}, [swatch(colourA), ` ${a.title}`]));
      legend.append(el('li', {}, [swatch(colourB), ` ${b.title}`]));
      legend.append(el('li', {}, [swatch(colourA, colourB), ' Both: the cells where their mappings intersect']));
    } else {
      legend.append(el('li', { textContent: 'The 3D view is unavailable, so the comparison is shown in words only.' }));
    }
    box.append(legend);
    box.append(el('p', {
      textContent: ui.comparison.disjoint
        ? `No mapping of ${a.id} overlaps any mapping of ${b.id}. `
          + 'They report different places, rather than not having been compared.'
        : `${ui.comparison.shared.length} overlapping pair(s) of regions, `
          + `${ui.comparison.onlyA.length} only in ${a.id}, `
          + `${ui.comparison.onlyB.length} only in ${b.id}.`,
    }));
    for (const pair of ui.comparison.shared.slice(0, 8)) {
      box.append(el('p', { className: 'pair', textContent: `${pair.a.address} ↔ ${pair.b.address}` }));
    }
    const stop = el('button', { type: 'button', className: 'link', textContent: 'Stop comparing' });
    stop.dataset.testid = 'stop-comparing';
    stop.addEventListener('click', () => compareWith(null));
    box.append(stop);
    reveal.append(box);
  }
}

/** A comparison is live only while its first paper is the revealed one. */
const comparing = () => Boolean(ui.comparison && ui.comparison.a.id === ui.revealed);

function compareWith(paperId) {
  ui.comparedTo = paperId;
  ui.comparison = paperId === null ? null : comparePapers(ui.research, ui.revealed, paperId);
  uploadHighlights();
  commit({ push: false });
}

/** Upload the revealed paper's cells as highlight volumes — or, while two papers are compared, both papers' cells in one colour each and their covering intersection hatched in both. (docs/viewer-shell.md) */
function uploadHighlights() {
  for (const h of ui.uploaded.highlights ?? []) ui.renderer?.release(h.cell);
  ui.uploaded.highlights = [];
  if (ui.revealed === null || !ui.research || !ui.renderer) return;

  const selection = viewer.state.selection;
  const filter = selection?.ok ? selection.displayAddress : null;

  const add = (cell, highlight) => {
    if (cell.atlas !== viewer.atlas) return;
    let mesh = null;
    try {
      mesh = cellMeshForHighlight(cell.address);
    } catch {
      // A mapping the bound template cannot place is simply not drawn. It is
      // still in the panel, which is where the user would look for it.
      return;
    }
    if (!mesh) return;
    ui.uploaded.highlights.push({
      cell: ui.renderer.uploadCell(mesh),
      address: cell.address,
      // Outside the filter is drawn fainter, never hidden.
      alpha: cell.withinFilter === false ? 0.13 : 0.26,
      ...highlight,
    });
  };

  if (comparing()) {
    const layers = comparisonLayers(ui.research, ui.revealed, ui.comparedTo, filter);
    if (!layers) return;
    const [colourA, colourB] = PAPER_COLOURS;
    const source = (c) => ({ paperId: c.paperId, findingId: c.findingId, findingLabel: c.findingLabel });
    for (const cell of layers.cells.a) add(cell, { role: 'a', colour: colourA, sources: [source(cell)] });
    for (const cell of layers.cells.b) add(cell, { role: 'b', colour: colourB, sources: [source(cell)] });
    // Drawn last and stronger, so the shared region reads through both fills.
    for (const cell of layers.overlap) {
      add(cell, {
        role: 'overlap',
        colour: colourA,
        hatch: colourB,
        alpha: 0.5,
        sources: [...cell.a, ...cell.b],
      });
    }
    return;
  }

  const revealed = revealPaper(ui.research, ui.revealed, filter);
  if (!revealed) return;
  let group = 0;
  for (const finding of revealed.findings) {
    const colour = GROUP_COLOURS[group % GROUP_COLOURS.length];
    group += 1;
    const sources = [{ paperId: revealed.paper.id, findingId: finding.id, findingLabel: finding.label }];
    for (const cell of finding.cells) add(cell, { role: 'reveal', colour, sources });
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
  let axis = null;
  for (const layer of ATLAS_LAYERS[viewer.atlas]) {
    if (layer.axis !== axis) {
      axis = layer.axis;
      box.append(el('h3', { textContent: { region: 'Regions (by spine level)', hemisphere: 'Hemispheres', category: 'Systems' }[axis] }));
    }
    const row = el('div', { className: 'layer' });
    row.dataset.layer = layer.id;

    const toggle = el('input', { type: 'checkbox', checked: isLayerVisible(layers, layer.id) });
    toggle.dataset.testid = `layer-toggle-${layer.id}`;
    toggle.disabled = layers.isolated !== null && ATLAS_LAYERS[viewer.atlas].some((l) => l.id === layers.isolated && l.axis === axis);
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

  for (const atlas of ['body', 'brain']) {
    if (atlas === viewer.atlas) $(`nav-${atlas}`).setAttribute('aria-current', 'page');
    else $(`nav-${atlas}`).removeAttribute('aria-current');
  }

  // Search finds the structures drawn here, then index names for addresses,
  // which on the brain atlas are body names: said, so a rib in a brain search
  // reads as scoped rather than broken.
  const drawn = ui.sets[viewer.atlas].reduce((n, set) => n + set.structures.length, 0);
  const searchable = [...nameIndexFrames(nameIndex)];
  const localFrame = viewer.atlas === 'body' ? 'BD' : 'BV';
  $('search-scope').textContent = `${drawn} structures drawn in this atlas`
    + (searchable.length === 0 ? '; no name index is loaded.'
      : searchable.includes(localFrame) ? `, then ${searchable.join(', ')} names.`
        : `, then ${searchable.join(', ')} names; no names exist for ${localFrame}, and choosing one of those will not leave this atlas.`);
}

const layerLabel = (id) => Object.values(ATLAS_LAYERS).flat().find((l) => l.id === id)?.label ?? id;

/** The selected mesh structure: its name, what it is, and how far to trust where it is drawn. */
function renderStructure() {
  const box = $('structure-panel');
  box.replaceChildren();
  const key = viewer.structureOf();
  box.hidden = key === null;
  if (key === null) return;
  const s = ui.sets[viewer.atlas].flatMap((set) => set.structures).find((x) => x.key === key);
  box.dataset.structureKey = key;
  if (!s) {
    box.append(el('p', {
      className: 'muted',
      textContent: ['pending', 'loading'].includes(ui.meshStatus[viewer.atlas])
        ? `Structure ${key}: loading the ${viewer.atlas} meshes…`
        : `Structure ${key} is not drawn in the ${viewer.atlas} atlas of this build.`,
    }));
    return;
  }
  box.append(el('h3', { id: 'structure-name', textContent: s.title }));
  box.append(el('p', { className: 'muted', textContent: `${layerLabel(s.category)} · ${s.set}${s.lobe ? ` · ${s.labelSet}` : ''}` }));
  if (s.placedBy) {
    box.append(el('p', {
      className: 'note',
      textContent: `Drawn in MNI space through ${s.placedBy.registration}, whose held-out error is `
        + `${s.placedBy.errorMm} mm: an address clicked on this surface is no closer to the anatomy than that.`,
    }));
  }
  if (s.lobe) {
    box.append(el('p', { className: 'note', textContent: 'A first-party lobe label drawn from landmarks; how precisely its boundary lies is unstated.' }));
  }
  const clear = el('button', { type: 'button', className: 'link', textContent: 'Clear structure' });
  clear.addEventListener('click', () => {
    viewer.selectStructure(null);
    commit({ push: true });
  });
  box.append(clear);
}

// ---------------------------------------------------------------------------
// Scene assembly: viewer state -> renderer draw list
// ---------------------------------------------------------------------------

function scene() {
  const canvas = $('canvas');
  const layers = viewer.layersOf();
  const solids = [];
  const lines = [];

  let xray = null;
  for (const set of ui.sets[viewer.atlas]) {
    if (!set.gpu) continue;
    // One draw per run of equally opaque, same-coloured structures: the sets
    // are laid out by layer, so a frame is a few dozen draws, not 1,605.
    const byOpacity = new Map();
    for (const s of set.structures) {
      // The selected structure keeps its layer's opacity, so a faded skin stays
      // faded. Opaque or hidden, an x-ray pass shows it through what is in front.
      const chosen = s.key === viewer.structureOf();
      const colour = chosen ? ui.palette.chosen : ui.palette[s.lobe ? s.label : s.category] ?? ui.palette.other;
      const { visible, opacity } = structureLayers(layers, s);
      if (chosen && (!visible || opacity >= 1)) {
        xray = { mesh: set.gpu, ranges: [{ firstTriangle: s.firstTriangle, triangleCount: s.triangleCount, colour }] };
      }
      if (!visible || !(opacity > 0)) continue;
      if (!byOpacity.has(opacity)) byOpacity.set(opacity, []);
      const ranges = byOpacity.get(opacity);
      const last = ranges[ranges.length - 1];
      if (last && last.colour === colour && last.firstTriangle + last.triangleCount === s.firstTriangle) last.triangleCount += s.triangleCount;
      else ranges.push({ firstTriangle: s.firstTriangle, triangleCount: s.triangleCount, colour });
    }
    for (const [opacity, ranges] of byOpacity) solids.push({ mesh: set.gpu, ranges, visible: true, opacity });
  }
  if (viewer.atlas === 'body' && ui.uploaded.spine) {
    lines.push({
      ...ui.uploaded.spine,
      colour: ui.regionColour.spine,
      visible: isLayerVisible(layers, 'spine'),
      opacity: layerOpacity(layers, 'spine'),
    });
  }

  return {
    camera: viewer.cameraOf(),
    width: Math.max(1, canvas.clientWidth),
    height: Math.max(1, canvas.clientHeight),
    solids,
    lines,
    xray,
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

/** Labels as a DOM overlay rather than in GL. (docs/viewer-shell.md) */
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

  if (viewer.atlas === 'brain' && ui.hemispheres) {
    for (const [hemisphere, bounds] of ui.hemispheres) {
      if (!isLayerVisible(layers, hemisphere === 'L' ? 'left' : 'right')) continue;
      const at = ui.renderer.projectPoint(bounds.centre, camera, width, height);
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
    // No `elsewhere` branch: the viewer withholds a cross-atlas cell, so nothing is flown to (DOG-75, docs/viewer-shell.md).
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
  fitIfUnset(atlas);
  loadMeshes(atlas, 'low').then(() => loadMeshes(atlas, 'full'));
  uploadSelectedCell();
  uploadHighlights();
  commit({ push: true });
}

/** Re-render everything and sync the URL. One funnel, so nothing drifts. */
function commit({ push = false } = {}) {
  renderChrome();
  renderLayers();
  renderAddressPanel();
  renderStructure();
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

/** Click -> address. (docs/viewer-shell.md) */
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

  // No geometry, nothing to click: an address is still a paste away.
  if (!ui.sets[viewer.atlas].some((set) => set.gpu)) return;
  // A layer faded below half is see-through to the pointer, so a faded skin
  // lets you click the organ behind it.
  const layers = viewer.layersOf();
  const hit = pickStructure(ui.sets[viewer.atlas], ray.origin, ray.direction, (s) => {
    const { visible, opacity } = structureLayers(layers, s);
    return visible && opacity >= 0.5;
  });
  viewer.selectStructure(hit?.structure.key ?? null);

  // The address comes from the frame's own encoder, never the structure, so its flags reach the user (docs/viewer-shell.md).
  if (viewer.atlas === 'body') {
    const enc = encodeBody(bound, hit ? hit.pointMm : missPoint(ray, ui.bounds.body), digits);
    select(enc.address, { push: true, encodeFlags: enc.flags });
  } else if (hit) {
    const enc = encodeBrainVolume(bound, hit.pointMm, digits);
    select(enc.address, { push: true, encodeFlags: enc.flags });
  } else {
    commit({ push: true });
  }
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
  // The top-level nav. Real links, so they open in a new tab as `?atlas=`;
  // a plain click is the explicit move, with the route back.
  for (const atlas of ['body', 'brain']) {
    $(`nav-${atlas}`).addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      openAtlas(atlas);
    });
  }

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
    if (search.value.trim().length < 2) return;
    // Structures drawn in this atlas first: choosing one selects and frames it.
    for (const s of searchStructures(ui.sets[viewer.atlas].flatMap((set) => set.structures), search.value, 8)) {
      const go = el('button', { type: 'button', className: 'link', textContent: s.title });
      go.dataset.structureKey = s.key;
      go.addEventListener('click', () => {
        viewer.selectStructure(s.key);
        viewer.setCamera(flyToCell(viewer.cameraOf(), s));
        results.replaceChildren();
        commit({ push: true });
      });
      results.append(el('li', {}, [go, el('span', { className: 'muted', textContent: ` ${layerLabel(s.category)}` })]));
    }
    if (!nameIndex) return;
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
    fitIfUnset(viewer.atlas);
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
  ui.palette = module.ANATOMY_COLOURS;
  GROUP_COLOURS = module.GROUP_COLOURS;
  PAPER_COLOURS = module.PAPER_COLOURS;
  ui.renderer = module.createRenderer($('canvas'));
  if (ui.meshes.spine) ui.uploaded.spine = ui.renderer.uploadPolyline(ui.meshes.spine);
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

/** One tier of an atlas's mesh sets, decoded and uploaded, replacing what was drawn. (docs/viewer-shell.md) */
function loadMeshes(atlas, tier) {
  return ui.renderer ? once(`drawn:${atlas}/${tier}`, () => drawTier(atlas, tier)) : Promise.resolve();
}

async function drawTier(atlas, tier) {
  const entries = meshEntries.filter((e) => e.atlas === atlas);
  if (tier === 'low') ui.meshStatus[atlas] = entries.length === 0 ? 'none' : 'loading';
  const failed = [];
  await Promise.all(entries.map(async (entry) => {
    try {
      const bytes = await tierBytes(entry, tier);
      if (!bytes) return;
      const mesh = meshSetFrom(entry, await setDocs(entry), bytes, templates.body);
      mesh.tier = tier;
      mesh.gpu = ui.renderer.uploadSurface(mesh);
      const at = ui.sets[atlas].findIndex((m) => m.id === entry.id);
      // Never trade a full tier back for a low one.
      if (at >= 0 && ui.sets[atlas][at].tier === 'full') return ui.renderer.release(mesh.gpu);
      if (at >= 0) ui.renderer.release(ui.sets[atlas][at].gpu);
      ui.sets[atlas].splice(at >= 0 ? at : ui.sets[atlas].length, at >= 0 ? 1 : 0, mesh);
    } catch (error) {
      failed.push(`${entry.id} (${error.message})`);
    }
  }));
  if (failed.length > 0) {
    (ui.meshNotices ??= {})[atlas] = {
      code: 'meshes-unavailable',
      severity: 'warning',
      title: `Some ${atlas} anatomy could not be drawn`,
      detail: `The ${tier}-resolution meshes of ${failed.join(', ')} failed to load. Addresses still `
        + 'parse and resolve to names, and cells are still drawn at their true extent.',
    };
  }
  if (ui.sets[atlas].length > 0) {
    ui.meshStatus[atlas] = ui.sets[atlas].every((m) => m.tier === 'full' || !ui.fullTiers?.has(m.id)) ? 'full' : 'low';
    // The brain is framed on the BV template's box, not on the arteries and
    // nerves that run far below it; the body on all of its anatomy.
    if (atlas === 'body' || !ui.hemispheres) ui.bounds[atlas] = boundsOfStructures(ui.sets[atlas].flatMap((m) => m.structures));
    // An automatic fit is refitted to the anatomy; a camera from a link or a drag is left alone.
    if (ui.autoFit[atlas] && ui.autoFit[atlas] === viewer.cameraOf(atlas)) {
      ui.autoFit[atlas] = viewer.setCamera(fitCamera(ui.bounds[atlas]), atlas);
    }
  } else if (tier === 'low') {
    ui.meshStatus[atlas] = entries.length === 0 ? 'none' : 'failed';
  }
  commit({ push: false });
}

const meshesLoaded = (async () => {
  if (!ui.renderer) {
    ui.meshStatus = { body: 'no-renderer', brain: 'no-renderer' };
    return;
  }
  const docs = await Promise.allSettled(meshEntries.map(setDocs));
  // Sets that declare a full tier at all: the ICBM cortex ships only a low one.
  ui.fullTiers = new Set(meshEntries.filter((e, i) => docs[i].value?.structures.tiers?.full).map((e) => e.id));
  const first = viewer.atlas;
  await loadMeshes(first, 'low');
  await loadMeshes(first === 'body' ? 'brain' : 'body', 'low');
  await loadMeshes(viewer.atlas, 'full');
})().catch(() => {});

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
  /** Labels, through the same path the checkbox takes. (docs/viewer-shell.md) */
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
  /** Which corpus the page is actually serving — one call, no inference. (docs/viewer-shell.md) */
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
  /** Compare the revealed paper with `paperId` (null stops), as the button does. */
  compareWith: (paperId) => {
    compareWith(paperId);
    return ui.comparison;
  },
  /** What is drawn, each volume with its paper and finding; no GL handles. */
  highlights: () => (ui.uploaded.highlights ?? []).map(({ cell, ...h }) => h),
  highlightCount: () => (ui.uploaded.highlights ?? []).length,
  selection: viewer.state.selection,
  /** DOG-129: which tier each atlas is drawing, and the selected mesh structure. */
  meshStatus: () => ({ ...ui.meshStatus }),
  meshesLoaded,
  structures: (atlas = viewer.atlas) => ui.sets[atlas].flatMap((set) => set.structures.map((s) => ({ key: s.key, name: s.name, title: s.title, label: s.label, category: s.category, parts: s.parts }))),
  structure: () => viewer.structureOf(),
  selectStructure: (key) => {
    viewer.selectStructure(key);
    commit({ push: true });
    return viewer.structureOf();
  },
  /** A click at canvas CSS pixels, through the same path a pointer takes. */
  pickAt: (x, y) => {
    const rect = $('canvas').getBoundingClientRect();
    pick({ clientX: rect.left + x, clientY: rect.top + y });
    return { structure: viewer.structureOf(), address: viewer.state.selection?.address ?? null };
  },
  ready: true,
};
