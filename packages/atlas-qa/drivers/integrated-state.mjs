/**
 * A `ViewerDriver` over the integrated build's viewer, for `qa-journey --build`.
 *
 * ## What this drives, and what it therefore cannot say
 *
 * It binds the modules the shipped page binds — `viewer/state.js`,
 * `viewer/select.js`, `viewer/research.js`, `viewer/deeplink.js`,
 * `viewer/camera.js` — against the real asset payloads, through the same
 * validators `app.js` runs them through. That is deliberate and it is the
 * difference between this and a parallel model: the state machine here IS the
 * one the page renders from, and the templates and name index here ARE the
 * bytes the page fetches.
 *
 * What it does **not** touch is `app.js`: the panel, the research list and the
 * highlight draw path. There is no browser in this runner, so nothing below
 * observes a rendered pixel. Every verdict this driver produces is a verdict
 * about the state layer of the integrated build and about nothing else, which
 * is why `buildId` says so out loud — the runner prints it next to every row,
 * and a reader six weeks from now must not be able to mistake this for a pass
 * over the DOM.
 *
 * ## Capabilities are declared from what the build actually has
 *
 * `labels` is absent: there is no label state in `state.js`, none in
 * `ATLAS_LAYERS`, and `encodeView` has no parameter for it. Rather than
 * no-op `setLabels` and let the label assertions sail through unexamined —
 * precisely the false green `capabilities()` exists to prevent — the
 * capability is withheld and every row needing it reports `unverified`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { realAssets, realTemplates } from '../../atlas-web/test/real-assets.js';
import { buildNameIndex, encodeBody, encodeBrainVolume, parse, samePlace, findStructures }
  from '../../alc/src/index.ts';
import { flyToCell, rotate, zoom } from '../../atlas-web/src/viewer/camera.js';
import { meshBounds } from '../../atlas-web/src/viewer/template.js';
import { QA_URL_PARAMS } from '../src/matrix.ts';
import { templateSet } from '../src/templates.ts';
import { decodeView, encodeView, viewHref } from '../../atlas-web/src/viewer/deeplink.js';
import { comparePapers, papersOverlapping, researchModel, revealPaper }
  from '../../atlas-web/src/viewer/research.js';
import { ATLAS_LAYERS, createViewer, isLayerVisible, layerOpacity }
  from '../../atlas-web/src/viewer/state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..', 'atlas-web');

const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * The research document the *page* serves, not the one the oracle reads.
 *
 * These are two different datasets on this ref and conflating them is how a
 * row reports a pass over five synthetic papers while claiming thirty real
 * ones. `datasetVersion` is exported on the driver so every research row can
 * name which one it measured.
 */
function pageResearch() {
  const index = json(join(WEB, 'dist', 'data', 'atlas-index.json'));
  const rel = (index.research?.path ?? '/data/research.json').replace(/^\//, '');
  const doc = json(join(WEB, 'dist', rel));
  return { doc, version: doc.version ?? index.research?.version ?? null };
}

/**
 * The fallback half of a `no-template` / `frame-disabled` notice.
 *
 * `offer` set means a coarser address can be placed and is on offer; `offer`
 * null means the notice declares there is nothing coarser to offer. Two states,
 * two codes, and neither is silence — a refusal that said nothing about the
 * fallback would be the dead end plan §4 is avoiding, and must be visible as a
 * missing message rather than as an absent assertion.
 */
function offerMessage(notice) {
  return notice.offer
    ? { code: 'coarsest_ancestor_offered', severity: 'notice', text: String(notice.offer) }
    : {
      code: 'no_ancestor_resolvable',
      severity: 'notice',
      text: 'No coarser ancestor of this address can be placed either, so there is nothing to offer.',
    };
}

/** Viewer notice -> harness MESSAGE_CODE. Returns [] where no code fits. */
function toMessages(notices) {
  const out = [];
  for (const n of notices ?? []) {
    const sev = n.severity === 'error' ? 'error' : 'notice';
    // The notes are part of the message, not decoration: for a clamp they are
    // the only place that names which end of the column was passed.
    const text = [n.title, n.detail, ...(n.notes ?? [])].filter(Boolean).join(' — ');
    const push = (code) => out.push({ code, severity: sev, text });

    switch (n.code) {
      case 'over-precise': push('over_precise'); break;
      case 'folded': push('folded'); break;
      case 'homology-variant': push('homology_variant'); break;
      case 'homology-absent': push('homology_absent'); break;
      case 'atlas-unavailable': push('assets_unavailable'); break;
      // The fallback slot, in the build's own terms. `flags.js` puts
      // `coarsestResolvable()`'s answer on the notice as `offer`, and `app.js`
      // branches on exactly that field: an offer button when it is set, and
      // "No coarser ancestor of this address can be placed either, so there is
      // nothing to offer." when it is null (app.js:297-313). So both states are
      // declared by the state layer and rendered by the shell, and the two
      // harness codes read the same field the shell reads.
      //
      // What this cannot say is that the sentence reached the screen — nothing
      // in this runner observes the DOM, which is what `buildId` says out loud.
      case 'no-template':
        push('no_template');
        out.push(offerMessage(n));
        break;
      case 'frame-disabled':
        push('frame_disabled');
        out.push(offerMessage(n));
        break;
      case 'clamped': {
        // The contract requires cranial and caudal to stay distinct, and the
        // viewer emits ONE code for both — plus a third situation ("outside
        // the modelled body surface") that names no end at all. Which end it
        // was survives only inside English note prose, so recovering it here
        // means matching on that prose. Done explicitly and narrowly, and
        // filed as a defect rather than hidden: where no end is named, no
        // clamp code is emitted and the row reports `unverified` instead of
        // quietly picking one.
        const notes = (n.notes ?? []).join(' ').toLowerCase();
        if (notes.includes('cranial')) push('clamped_cranial');
        else if (notes.includes('caudal')) push('clamped_caudal');
        break;
      }
      case 'rejected': {
        const code = n.alcCode;
        if (code === 'bad_level') push('rejected_level');
        else if (code === 'check_failed') push('rejected_check');
        else if (code === 'too_long') push('rejected_too_long');
        else push('rejected_grammar');
        break;
      }
      // 'frame-unnamed', 'names-other-template' and 'names-unavailable' have no
      // code in the harness's closed MESSAGE_CODES set. They are deliberately
      // NOT mapped onto a neighbouring code: `frame-unnamed` is the licensed
      // "BV ships without names" contract, which is not a fault and is not any
      // of the faults the set can express. Emitting nothing keeps them out of
      // the assertions rather than making one of them read as a resolution
      // notice that fired.
      default: break;
    }
  }
  return out;
}

/** The harness fixture's papers, in the shape `researchModel` validates. */
function fixtureResearchDoc(fixture) {
  return {
    version: fixture.nameIndexVersion ?? 'qa-fixture',
    papers: (fixture.papers ?? []).map((p) => ({
      id: p.id,
      title: p.citation ?? p.id,
      url: p.sourceUrl ?? null,
      findings: (p.findings ?? []).map((f) => ({
        id: f.id,
        label: f.summary ?? f.id,
        cells: f.cells ?? [],
        // A finding with no spatial detail must stay visible as a marker, not
        // be given a position. `regionOnly` is how research.js says that.
        regionOnly: f.spatialDetail === false ? (f.regions ?? []).join(', ') || 'region-level only' : null,
      })),
    })),
  };
}

export default async function createDriver(options = {}) {
  const fixture = options.fixture ?? null;
  const { nameIndex: realNameIndex } = realAssets();
  const { doc: pageDoc, version: pageDatasetVersion } = pageResearch();

  /**
   * Which template set is bound.
   *
   * The matrix selects it per row with `?qa_template=`, because three of
   * `locate()`'s findings need a template that produces them and the real body
   * template produces none of the three. So the rows that are about *behaviour*
   * run against the fixture templates the matrix was authored for, and
   * `real-assets` binds the shipped payloads for the rows that are about those.
   * Either way the code under test is the product's own `select.js` / `state.js`
   * / `research.js` — only the data under them changes.
   */
  const setFor = (choice) =>
    choice === 'real-assets' ? realTemplates() : templateSet(choice);

  /**
   * The name index and research corpus must come from the same world as the
   * templates, or a row asserts against a structure the bound index has never
   * heard of. Against the fixture templates that means the fixture's own
   * structures and papers; against the shipped assets it means the real index
   * and the dataset the PAGE serves.
   */
  const indexFor = (c) => {
    if (c === 'real-assets' || !fixture) return realNameIndex;
    return buildNameIndex({
      version: fixture.nameIndexVersion ?? 'qa-fixture',
      structures: fixture.structures ?? [],
    });
  };
  const researchFor = (c) =>
    researchModel(c === 'real-assets' || !fixture ? pageDoc : fixtureResearchDoc(fixture));

  let choice = options.templates ?? 'real-assets';
  let templates = setFor(choice);
  let nameIndex = indexFor(choice);
  let research = researchFor(choice);
  let viewer = createViewer({ templates, nameIndex });

  const rebind = (next) => {
    if (next === choice) return;
    choice = next;
    templates = setFor(choice);
    nameIndex = indexFor(choice);
    research = researchFor(choice);
    viewer = createViewer({ templates, nameIndex });
  };

  /**
   * Select, then fly — the two halves of what the shell does on a selection.
   *
   * `app.js` flies with `flyToCell(camera, meshBounds(model.cell))`. Leaving the
   * fly out here would make every `camera: 'flies-to-cell'` row fail against a
   * build that does it correctly, which is a false defect and the most
   * expensive kind of driver bug.
   */
  const selectAndFly = (address, { fly = true } = {}) => {
    const model = viewer.select(address);
    // With the geometry gone there is no mesh to look at, so flying would
    // present an empty viewport as a result. Addresses and names still resolve.
    if (fly && model.ok && model.cell && viewer.isAvailable(viewer.atlas)) {
      viewer.setCamera(flyToCell(viewer.cameraOf(), meshBounds(model.cell)));
    }
    return model;
  };

  let filter = null;
  let selectedPaperIds = [];
  let lastRejected = null;

  const layerIds = (atlas) => ATLAS_LAYERS[atlas].map((l) => l.id);

  /** The addresses a filter refers to: a structure's covering, or the address itself. */
  const filterAddresses = (value) => {
    if (!value) return [];
    const src = (fixture?.structures ?? []).find((x) => x.id === value);
    const idx = (nameIndex.structures ?? []).find((x) => x.id === value);
    const cells = src?.cells ?? idx?.cells ?? null;
    if (Array.isArray(cells) && cells.length > 0) {
      return cells.map((c) => (typeof c === 'string' ? c : c?.address)).filter(Boolean);
    }
    try { parse(value); return [value]; } catch { return []; }
  };

  const layersView = () => {
    const atlas = viewer.atlas;
    const l = viewer.layersOf(atlas);
    const out = {};
    for (const id of layerIds(atlas)) {
      out[id] = { visible: isLayerVisible(l, id), opacity: layerOpacity(l, id) };
    }
    return out;
  };

  const cellOf = (sel) => {
    if (!viewer.isAvailable(viewer.atlas)) return null;
    // A variant level resolves but has NO millimetres — `extentMm` comes back
    // as [null,null,null]. That array is truthy, so testing it alone reports a
    // drawn cell for the one case whose whole point is that nothing is drawn.
    if (!sel?.ok || !Array.isArray(sel.extentMm) || !sel.extentMm.every(Number.isFinite)) return null;
    const digitsOf = (a) => {
      try { return parse(a).digits.length; } catch { return 0; }
    };
    return {
      kind: 'extent',
      extentMm: [...sel.extentMm],
      addressDigits: digitsOf(sel.address),
      displayedDigits: digitsOf(sel.displayAddress ?? sel.address),
    };
  };

  const namesOf = (sel) => {
    if (!sel?.ok || !sel.names || sel.names.covered !== true) return null;
    return (sel.names.matches ?? []).map((m) => ({
      structureId: m.id, name: m.name, fraction: m.fraction,
    }));
  };

  const highlightsOf = () => {
    const out = [];
    const [a, b] = selectedPaperIds;
    const comparison = a && b ? comparePapers(research, a, b) : null;
    const sharedFor = (paperId, address) => {
      if (!comparison) return false;
      const side = paperId === a ? 'a' : 'b';
      return (comparison.shared ?? []).some((pair) => pair[side]?.address === address);
    };
    for (const paperId of selectedPaperIds) {
      const revealed = revealPaper(research, paperId);
      if (!revealed) continue;
      for (const f of revealed.findings ?? []) {
        // Cells hang off each finding, and `regionOnly`/`placed` is how a
        // finding with no spatial detail says so — it must stay visible as a
        // marker rather than being interpolated onto a cell.
        const cells = (f.cells ?? []).map((c) => c.address);
        out.push({
          paperId,
          findingId: f.id,
          cells,
          regionLevelOnly: f.regionOnly === true || f.placed === false,
          colour: `paper-${paperId}`,
          hatchedCells: cells.filter((addr) => sharedFor(paperId, addr)),
        });
      }
    }
    return out;
  };

  const state = async () => {
    const sel = viewer.state.selection;
    const atlas = viewer.atlas;
    const cam = viewer.cameraOf(atlas);
    const view = viewer.toView();
    const messages = toMessages(sel?.notices);
    const names = namesOf(sel);
    if (names && sel?.names?.indexVersion) {
      messages.push({ code: 'name_index_version', severity: 'notice', text: String(sel.names.indexVersion) });
    }
    // The cross-atlas offer, as a message, because that is the only way a
    // runner with no DOM can see it. `select()` sets `elsewhere` and `app.js`
    // renders the sentence and the `Open <atlas> atlas` button from it — this is
    // a mapping of the build's own fact into the contract's vocabulary, like
    // `atlas-unavailable` above, not a behaviour the driver invents.
    //
    // What this does NOT do is withhold the cell or the camera move that the
    // decided rule (`docs/deep-link-atlas-rule.md` rule 3) says must not
    // happen. `app.js` draws and flies here, with no `elsewhere` guard, and a
    // driver that quietly corrected that would turn a real defect into a green
    // row. It is DOG-75; the matrix row is red until it lands.
    //
    // Not when the build cannot realise the address at all. This selection
    // model stays `ok` and still resolves names when the brain template is
    // missing or the frame ships disabled, so `elsewhere` is set there too —
    // and "open the brain atlas" is not a route forward into an atlas that has
    // no template to draw in. Those are the two codes the contract pairs
    // `cross_atlas_offer` against, and conflating them is what that pairing
    // exists to prevent.
    const unrealisable = messages.some((m) => m.code === 'no_template' || m.code === 'frame_disabled');
    if (sel?.ok && sel.elsewhere && !unrealisable) {
      messages.push({
        code: 'cross_atlas_offer',
        severity: 'notice',
        text: `This address belongs to the ${sel.elsewhere} atlas. The view has not been changed.`,
      });
    }
    for (const h of highlightsOf()) {
      if (h.regionLevelOnly) {
        messages.push({ code: 'region_level_only', severity: 'notice', text: `${h.paperId}/${h.findingId}` });
        break;
      }
    }
    // `applyView` records what the URL got wrong. The length cap is refused
    // there, before any frame code path runs, so it never reaches select() and
    // is not on the selection model — it has to be read off viewProblems or the
    // trust-boundary row sees no message at all.
    for (const problem of viewer.state.viewProblems ?? []) {
      if (/longer than 64/.test(problem)) {
        messages.push({ code: 'rejected_too_long', severity: 'error', text: problem });
      }
    }
    if (!viewer.isAvailable(atlas)) {
      messages.push({ code: 'assets_unavailable', severity: 'error', text: viewer.state.unavailable[atlas] });
    }

    // `papersOverlapping` returns {paper, matching, filtered} wrappers, not ids.
    // Browsing by anatomy narrows to papers overlapping the FILTER STRUCTURE,
    // which is its whole covering and not one of its cells: a structure
    // spanning two cells whose papers differ would otherwise lose the papers
    // that only reach the other cell. `papersOverlapping` answers per address,
    // so the union is taken here, in the model's own paper order.
    const filterCells = filterAddresses(filter);
    const hits = new Set();
    for (const addr of filterCells.length > 0 ? filterCells : [null]) {
      for (const p of papersOverlapping(research, addr)) hits.add(p.paper?.id ?? p.id);
    }
    const paperList = (research?.papers ?? [])
      .map((p) => p.id)
      .filter((id) => hits.has(id));
    return {
      atlas,
      camera: {
        targetMm: [...cam.target],
        distanceMm: cam.distance,
        orientation: [cam.yaw, cam.pitch],
      },
      layers: layersView(),
      isolatedStructureId: viewer.layersOf(atlas).isolated,
      // No label state exists in this build; `labels` is withheld from
      // capabilities() so no row reads this as an observation.
      labelsVisible: false,
      selection: {
        structureId: namesOf(sel)?.[0]?.structureId ?? null,
        address: sel?.ok ? sel.address : null,
      },
      url: `https://atlas.invalid/${viewHref(view) ?? ''}`,
      // The address AS GIVEN, not the demoted one: an over-precise address is
      // not wrong, only finer than this template can answer, so truncating it
      // in the URL would discard the user's own input. The demotion shows up in
      // `cell.displayedDigits` instead, which is where it is a fact about the
      // drawing rather than about the address.
      urlAddress: sel?.ok ? sel.address : null,
      cell: cellOf(sel),
      names,
      nameIndexVersion: sel?.names?.indexVersion ?? null,
      messages,
      research: {
        filter,
        paperList,
        selectedPaperIds: [...selectedPaperIds],
        highlights: highlightsOf(),
      },
      assetsAvailable: viewer.isAvailable(atlas),
      templateId: sel?.templateId ?? (viewer.atlas === 'body' ? (templates.body?.id ?? null) : (templates.brainVolume?.id ?? null)),
    };
  };

  const driver = {
    buildId: `qa-integrated-v1@777b68ae state-machine only (app.js/DOM NOT observed; page dataset ${pageDatasetVersion})`,
    kind: 'product',
    pageDatasetVersion,

    capabilities: () => new Set([
      'body-atlas', 'brain-atlas', 'layers', 'opacity', 'isolate',
      'structure-search', 'camera-controls', 'click-select', 'paste-address',
      'deep-link', 'ranked-names', 'cross-atlas-navigation', 'view-restore',
      'browse-by-anatomy', 'browse-by-research', 'multi-paper-selection',
      'overlap-hatching', 'asset-failure-reporting', 'qa-template-override',
      // 'labels' withheld: absent from the build. See the module header.
    ]),

    async open(url) {
      const search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
      const params = new URLSearchParams(search);
      rebind(params.get(QA_URL_PARAMS.template) ?? 'body');
      const { view, problems } = decodeView(search);
      viewer.applyView(view, problems);
      // applyView selects through select() but cannot fly: camera.js is the
      // shell's business, not the state machine's.
      if (params.get(QA_URL_PARAMS.assets) === 'fail') {
        viewer.markUnavailable(viewer.atlas, 'The atlas geometry could not be loaded.');
      } else {
        viewer.markAvailable(viewer.atlas);
      }
      const sel = viewer.state.selection;
      if (sel?.ok && sel.cell && viewer.isAvailable(viewer.atlas)) {
        viewer.setCamera(flyToCell(viewer.cameraOf(), meshBounds(sel.cell)));
      }
      lastRejected = sel?.ok === false;
      return state();
    },
    state,

    async setLayer(layerId, patch) {
      if (typeof patch.visible === 'boolean') viewer.setLayerHidden(layerId, !patch.visible);
      if (Number.isFinite(patch.opacity)) viewer.setLayerOpacity(layerId, patch.opacity);
      return state();
    },
    async isolate(structureId) { viewer.isolate(structureId); return state(); },
    async setLabels() { return state(); },
    async orbit(deltaDeg) {
      viewer.setCamera(rotate(viewer.cameraOf(), deltaDeg, 0));
      return state();
    },
    async zoom(factor) {
      viewer.setCamera(zoom(viewer.cameraOf(), factor));
      return state();
    },
    async resetCamera() {
      viewer.setCamera({ ...viewer.cameraOf(), distance: 900, target: [0, 0, 0] });
      return state();
    },
    async searchStructures(query) {
      return findStructures(String(query), nameIndex).map((s) => ({
        structureId: s.id, name: s.name, fraction: 1,
      }));
    },

    async clickStructure(structureId) {
      const src = (fixture?.structures ?? []).find((x) => x.id === structureId);
      const idx = (nameIndex.structures ?? []).find((x) => x.id === structureId);
      const first = src?.cells?.[0] ?? idx?.cells?.[0];
      const address = typeof first === 'string' ? first : (first?.address ?? null);
      if (address) selectAndFly(address);
      return state();
    },
    async clickPointMm(pointMm, digits) {
      const enc = viewer.atlas === 'body'
        ? encodeBody(templates.body, pointMm, digits)
        : encodeBrainVolume(templates.brainVolume, pointMm, digits);
      selectAndFly(enc.address);
      // The clamp finding is raised turning millimetres into an address, so it
      // is not on the selection model and has to be merged in here.
      const sel = viewer.state.selection;
      if (sel?.ok && enc.flags?.clamped) {
        sel.notices = [...(sel.notices ?? []), {
          code: 'clamped', severity: 'warning',
          title: 'Pulled back to the template boundary',
          detail: 'The requested location lies beyond the extent this template models.',
          notes: enc.flags.notes ?? [],
        }];
      }
      return state();
    },
    async pasteAddress(text) {
      const model = selectAndFly(text);
      lastRejected = !model.ok;
      return state();
    },

    async openBrainAtlas() { viewer.openAtlas('brain'); return state(); },
    async returnToBody() { viewer.returnToPrevious(); return state(); },

    async setAnatomyFilter(structureId) { filter = structureId; return state(); },
    async selectPaper(paperId, options = {}) {
      selectedPaperIds = options.add ? [...new Set([...selectedPaperIds, paperId])] : [paperId];
      return state();
    },
    async clearPaperSelection() { selectedPaperIds = []; return state(); },

    async samePlaceAcrossSubjects(cellsA, cellsB, toleranceMm) {
      for (const a of cellsA) {
        for (const b of cellsB) {
          const r = samePlace(a, b, templates, { toleranceMm });
          if (r.same) return { same: true, basis: r.basis ?? 'covering-overlap' };
        }
      }
      return { same: false, basis: 'covering-overlap' };
    },
  };

  return driver;
}
