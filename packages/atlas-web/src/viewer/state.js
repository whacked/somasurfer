/** The viewer's state machine. (docs/viewer-shell.md) */

import { parse } from '../alc.js';
import { DEFAULT_CAMERA, DEFAULT_LABELS, hasAddress, labelsVisible } from './deeplink.js';
import { selectAddress } from './select.js';

/** Which atlas a frame's addresses belong to. */
export function atlasForFrame(frame) {
  if (frame === 'BD') return 'body';
  if (frame === 'BV' || frame === 'BR') return 'brain';
  return null;
}

/** The layers each atlas offers, in display order, on two independent axes. (docs/viewer-shell.md) */
const layer = (axis) => ([id, label]) => Object.freeze({ id, label, axis });
export const ATLAS_LAYERS = Object.freeze({
  body: Object.freeze([
    ...[
      ['cranial', 'Above C01 (head)'],
      ['cervical', 'Cervical (C01–C07)'],
      ['thoracic', 'Thoracic (T01–T12)'],
      ['lumbar', 'Lumbar (L01–L05)'],
      ['sacral', 'Sacral'],
      ['caudal', 'Below the sacrum'],
      ['spine', 'Spine axis'],
    ].map(layer('region')),
    ...[
      ['skin', 'Skin'], ['muscle', 'Muscles'], ['skeleton', 'Skeleton'],
      ['cardiovascular', 'Heart and vessels'], ['nervous', 'Nervous system'],
      ['respiratory', 'Respiratory'], ['alimentary', 'Digestive'], ['urinary', 'Urinary'],
      ['genital', 'Genital'], ['endocrine', 'Endocrine'], ['other', 'Other'],
    ].map(layer('category')),
  ]),
  brain: Object.freeze([
    ...[['left', 'Left hemisphere'], ['right', 'Right hemisphere']].map(layer('hemisphere')),
    ...[
      ['cortex', 'Cortex'], ['deep_grey', 'Deep grey nuclei'], ['diencephalon', 'Diencephalon'],
      ['brainstem', 'Brainstem'], ['cerebellum', 'Cerebellum'], ['white_matter', 'White matter'],
      ['tracts', 'Tracts'], ['ventricles', 'Ventricles'], ['arteries', 'Arteries'],
      ['veins_sinuses', 'Veins and sinuses'], ['cranial_nerves', 'Cranial nerves'],
    ].map(layer('category')),
  ]),
});

const AXIS = new Map(Object.values(ATLAS_LAYERS).flat().map((l) => [l.id, l.axis]));

const freshLayers = () => ({ hidden: [], isolated: null, opacity: {} });

const cloneLayers = (l) => ({
  hidden: [...l.hidden],
  isolated: l.isolated,
  opacity: { ...l.opacity },
});

const cloneCamera = (c) => ({ ...c, target: [...c.target] });

/** Whether a layer is drawn, given the layer state. (docs/viewer-shell.md) */
export function isLayerVisible(layers, id) {
  if (layers.isolated !== null && AXIS.get(layers.isolated) === AXIS.get(id)) return layers.isolated === id;
  return !layers.hidden.includes(id);
}

/** Effective opacity for a layer: 1 unless the user set one. */
export function layerOpacity(layers, id) {
  const v = layers.opacity[id];
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/** Whether a mesh structure is drawn, and how opaque: category layer times its most opaque visible `parts` layer (docs/viewer-shell.md). */
export function structureLayers(layers, structure) {
  const parts = structure.parts.filter((p) => isLayerVisible(layers, p));
  return {
    visible: parts.length > 0 && isLayerVisible(layers, structure.category),
    opacity: layerOpacity(layers, structure.category) * Math.max(0, ...parts.map((p) => layerOpacity(layers, p))),
  };
}

/**
 * One atlas's mesh draw list. Solids: one draw per run of equally opaque,
 * same-coloured structures; the sets are laid out by layer, so a frame is a few
 * dozen draws, not 1,605. X-ray: a paper's structures (`overlay`, key ->
 * exact|approximate), whatever their layer, then the selected structure when its
 * layer would not show it, last so it reads on top of a paper's.
 */
export function meshDraws(sets, { layers, chosen, overlay, palette }) {
  const solids = [];
  const xrays = [];
  let xray = null;
  for (const set of sets) {
    if (!set.gpu) continue;
    const marked = [];
    const byOpacity = new Map();
    for (const s of set.structures) {
      // The selected structure keeps its layer's opacity, so a faded skin stays
      // faded. Opaque or hidden, an x-ray pass shows it through what is in front.
      const isChosen = s.key === chosen;
      const mark = overlay.get(s.key);
      const colour = isChosen ? palette.chosen : mark ? palette.paper : palette[s.lobe ? s.label : s.category] ?? palette.other;
      const hatch = !isChosen && mark === 'approximate' ? palette.paperStripe : null;
      const { visible, opacity } = structureLayers(layers, s);
      if (isChosen && (!visible || opacity >= 1)) {
        xray = { mesh: set.gpu, ranges: [{ firstTriangle: s.firstTriangle, triangleCount: s.triangleCount, colour }] };
      } else if (mark) {
        marked.push({ firstTriangle: s.firstTriangle, triangleCount: s.triangleCount, colour, hatch });
      }
      if (!visible || !(opacity > 0)) continue;
      if (!byOpacity.has(opacity)) byOpacity.set(opacity, []);
      const ranges = byOpacity.get(opacity);
      const last = ranges[ranges.length - 1];
      if (last && last.colour === colour && last.hatch === hatch && last.firstTriangle + last.triangleCount === s.firstTriangle) last.triangleCount += s.triangleCount;
      else ranges.push({ firstTriangle: s.firstTriangle, triangleCount: s.triangleCount, colour, hatch });
    }
    for (const [opacity, ranges] of byOpacity) solids.push({ mesh: set.gpu, ranges, visible: true, opacity });
    if (marked.length > 0) xrays.push({ mesh: set.gpu, ranges: marked });
  }
  return { solids, xray: xray ? [...xrays, xray] : xrays };
}

export function createViewer(options = {}) {
  const state = {
    atlas: 'body',
    templates: options.templates ?? {},
    nameIndex: options.nameIndex ?? null,
    /** Per atlas, so each remembers its own view. */
    camera: { body: { ...cloneCamera(DEFAULT_CAMERA) }, brain: { ...cloneCamera(DEFAULT_CAMERA) } },
    layers: { body: freshLayers(), brain: freshLayers() },
    /** Per atlas too: wanting one atlas's markers is not wanting the other's (docs/viewer-shell.md). */
    labels: { body: DEFAULT_LABELS, brain: DEFAULT_LABELS },
    /** Per atlas, so an address selected in one is still there on return. */
    address: { body: null, brain: null },
    /** The mesh structure each atlas has selected, by `set.id` key, or null. */
    structure: { body: null, brain: null },
    selection: null,
    returnStack: [],
    /** atlas id -> reason, when geometry failed to load. */
    unavailable: {},
    /** Set by `applyView` when the incoming URL had problems. */
    viewProblems: [],
  };

  const api = {
    get state() {
      return state;
    },

    get atlas() {
      return state.atlas;
    },

    layersOf(atlas = state.atlas) {
      return state.layers[atlas];
    },

    cameraOf(atlas = state.atlas) {
      return state.camera[atlas];
    },

    labelsOf(atlas = state.atlas) {
      return state.labels[atlas];
    },

    /** The layer a given vertebral level is drawn under. */
    isAvailable(atlas = state.atlas) {
      return !(atlas in state.unavailable);
    },

    markUnavailable(atlas, reason) {
      state.unavailable[atlas] = reason;
    },

    markAvailable(atlas) {
      delete state.unavailable[atlas];
    },

    // --- selection --------------------------------------------------------

    /** Select an address. (docs/viewer-shell.md) */
    select(input, { encodeFlags } = {}) {
      const model = selectAddress(input, {
        templates: state.templates,
        nameIndex: state.nameIndex,
        encodeFlags,
      });

      if (!model.ok) {
        state.selection = model;
        return model;
      }

      const home = atlasForFrame(model.frame);
      // Reported, never acted on. The shell turns this into an offer.
      const elsewhere = home !== null && home !== state.atlas ? home : null;
      model.elsewhere = elsewhere;
      // The geometry of an address that lives in the other atlas is withheld
      // from the view and kept here instead. See the module header.
      model.elsewhereCell = elsewhere === null ? null : {
        atlas: elsewhere,
        templateId: model.templateId,
        pointMm: model.pointMm,
        extentMm: model.extentMm,
        cell: model.cell,
      };
      if (elsewhere !== null) {
        model.templateId = null;
        model.pointMm = null;
        model.extentMm = null;
        model.cell = null;
      }
      state.selection = model;
      // The address THIS atlas's view is showing, whichever atlas the address
      // belongs to, because that is what a link to this view has to carry. The
      // destination atlas's own slot is left alone until the move actually
      // happens, in `openAtlas`.
      state.address[state.atlas] = model.address;
      return model;
    },

    structureOf(atlas = state.atlas) {
      return state.structure[atlas];
    },

    /** Select a mesh structure (a key, or null). Like labels, it moves nothing else. */
    selectStructure(key, atlas = state.atlas) {
      state.structure[atlas] = typeof key === 'string' && key !== '' ? key : null;
      return state.structure[atlas];
    },

    clearSelection() {
      state.selection = null;
      state.address[state.atlas] = null;
    },

    // --- camera -----------------------------------------------------------

    setCamera(patch, atlas = state.atlas) {
      const current = state.camera[atlas];
      state.camera[atlas] = {
        yaw: Number.isFinite(patch.yaw) ? patch.yaw : current.yaw,
        pitch: Number.isFinite(patch.pitch) ? patch.pitch : current.pitch,
        distance: Number.isFinite(patch.distance) && patch.distance > 0
          ? patch.distance
          : current.distance,
        target: Array.isArray(patch.target) && patch.target.every(Number.isFinite)
          ? [...patch.target]
          : [...current.target],
      };
      return state.camera[atlas];
    },

    // --- layers -----------------------------------------------------------

    setLayerHidden(id, hidden) {
      const layers = state.layers[state.atlas];
      const next = new Set(layers.hidden);
      if (hidden) next.add(id);
      else next.delete(id);
      layers.hidden = [...next].sort();
      return layers;
    },

    toggleLayer(id) {
      return api.setLayerHidden(id, isLayerVisible(state.layers[state.atlas], id));
    },

    setLayerOpacity(id, value) {
      const layers = state.layers[state.atlas];
      if (!Number.isFinite(value)) return layers;
      layers.opacity = { ...layers.opacity, [id]: Math.min(1, Math.max(0, value)) };
      return layers;
    },

    /** Isolate a layer, or pass `null` to leave isolate mode. */
    isolate(id) {
      state.layers[state.atlas].isolated = id ?? null;
      return state.layers[state.atlas];
    },

    resetLayers() {
      state.layers[state.atlas] = freshLayers();
      return state.layers[state.atlas];
    },

    // --- labels -----------------------------------------------------------

    /** Show or hide the labels in the current atlas. (docs/viewer-shell.md) */
    setLabels(visible, atlas = state.atlas) {
      if (!(atlas in state.labels)) throw new Error(`unknown atlas ${JSON.stringify(atlas)}`);
      // `Boolean`, not the `!== false` the view normaliser uses: a setter is
      // told what to do, so an omitted argument here means off rather than
      // "unstated, use the default".
      state.labels[atlas] = Boolean(visible);
      return state.labels[atlas];
    },

    toggleLabels(atlas = state.atlas) {
      return api.setLabels(!state.labels[atlas], atlas);
    },

    // --- atlas navigation, the only thing that changes `atlas` ------------

    /** Move to another atlas, explicitly. (docs/viewer-shell.md) */
    openAtlas(atlas) {
      if (!(atlas in state.layers)) throw new Error(`unknown atlas ${JSON.stringify(atlas)}`);
      if (atlas === state.atlas) return state.atlas;
      // The address being offered to this atlas, read before the atlas moves:
      // accepting *Open brain atlas* has to land on the cell that was offered,
      // and that address is filed under the atlas we are leaving.
      const offered = state.selection?.ok && state.selection.elsewhere === atlas
        ? state.selection.address
        : null;
      state.returnStack.push({
        atlas: state.atlas,
        camera: cloneCamera(state.camera[state.atlas]),
        layers: cloneLayers(state.layers[state.atlas]),
        labels: state.labels[state.atlas],
        address: state.address[state.atlas],
        structure: state.structure[state.atlas],
      });
      state.atlas = atlas;
      // Re-select the address this atlas was last showing, so its own panel is
      // populated rather than showing the other atlas's selection — unless we
      // arrived by accepting an offer, which names its own address.
      state.selection = null;
      const pending = offered ?? state.address[atlas];
      if (pending) api.select(pending);
      return state.atlas;
    },

    get canReturn() {
      return state.returnStack.length > 0;
    },

    /** Where `returnToPrevious()` would go, for labelling the control. */
    get returnTarget() {
      const top = state.returnStack[state.returnStack.length - 1];
      return top ? top.atlas : null;
    },

    /**
     * Restore the view we left, exactly: atlas, camera, layers, labels and
     * address.
     */
    returnToPrevious() {
      const previous = state.returnStack.pop();
      if (!previous) return null;
      state.atlas = previous.atlas;
      state.camera[previous.atlas] = cloneCamera(previous.camera);
      state.layers[previous.atlas] = cloneLayers(previous.layers);
      state.labels[previous.atlas] = labelsVisible(previous.labels);
      state.address[previous.atlas] = previous.address;
      state.structure[previous.atlas] = previous.structure ?? null;
      state.selection = null;
      if (previous.address) api.select(previous.address);
      return previous.atlas;
    },

    // --- deep links -------------------------------------------------------

    /** The current view, in the shape `deeplink.encodeView` wants. */
    toView() {
      return {
        atlas: state.atlas,
        address: state.address[state.atlas],
        camera: state.camera[state.atlas],
        layers: state.layers[state.atlas],
        labels: state.labels[state.atlas],
        structure: state.structure[state.atlas],
        /** Say the atlas out loud when the address does not imply it. (docs/viewer-shell.md) */
        atlasExplicit: state.selection?.ok === true && state.selection.elsewhere !== null,
      };
    },

    /** Apply a decoded view. (docs/viewer-shell.md) */
    applyView(view, problems = []) {
      state.viewProblems = [...problems];
      if (view.atlas in state.layers) state.atlas = view.atlas;
      state.camera[state.atlas] = cloneCamera({ ...DEFAULT_CAMERA, ...view.camera });
      state.layers[state.atlas] = cloneLayers({ ...freshLayers(), ...view.layers });
      // Normalised rather than assigned: a view that came from a URL has
      // already been through `decodeView`, but one assembled by a caller may
      // simply not mention labels, and that is the default, not "off".
      state.labels[state.atlas] = labelsVisible(view.labels);
      state.structure[state.atlas] = view.structure ?? null;
      state.selection = null;
      if (hasAddress(view.address)) {
        // Still goes through select(), so an address out of a URL is validated
        // by parse() before any geometry, exactly like a pasted one.
        const model = api.select(view.address);
        if (!model.ok) state.address[state.atlas] = null;
      } else {
        state.address[state.atlas] = null;
      }
      return state;
    },
  };

  return api;
}

/** The atlas an address would be drawn in, without selecting it. (docs/viewer-shell.md) */
export function atlasForAddress(address) {
  try {
    return atlasForFrame(parse(address).frame);
  } catch {
    return null;
  }
}
