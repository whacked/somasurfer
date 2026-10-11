/**
 * The viewer's state machine. No DOM, no WebGL, no fetch.
 *
 * Everything the §7 journey asserts about *behaviour* lives here, which is what
 * lets the journey be driven in Node: open the body atlas, change layers,
 * select a structure, navigate explicitly to the brain atlas, come back and
 * find the previous view intact. The browser shell is a renderer of this
 * object, not a second implementation of it.
 *
 * ## Selection never switches the atlas
 *
 * This is the rule with the most ways to get violated by accident, so it is
 * structural here rather than a convention. `select()` cannot change
 * `state.atlas` — there is no code path from it to the assignment. An address
 * belonging to the other atlas still selects, still resolves, still reports its
 * names and flags; what it does *not* do is move the camera somewhere else and
 * swap the geometry out from under the user. Instead the selection carries
 * `elsewhere`, naming the atlas the address lives in, and the shell offers the
 * explicit action. A viewer that teleports on click makes the body's brain and
 * the brain atlas feel like one continuous space, which is exactly the
 * confusion the plan's §2 refuses.
 *
 * The only transitions that change the atlas are `openAtlas()` and
 * `returnToPrevious()`, both of which are user actions.
 *
 * ## Not switching is not enough: it must not DRAW there either
 *
 * Reporting `elsewhere` and leaving `state.atlas` alone was only the first half,
 * and for a while the second half was missing: the selection still carried its
 * mesh and its millimetres, so the shell uploaded a brain cell into the body
 * scene and flew the body camera to brain coordinates while the panel said the
 * view had not changed. Those numbers are the other template's; next to a view
 * of this one they are not a smaller truth but a different coordinate system,
 * and the camera move is the teleport this rule exists to refuse.
 *
 * So an address whose frame lives in the other atlas has NO geometry in this
 * view. `cell`, `pointMm`, `extentMm` and `templateId` come back null and the
 * resolution is kept under `elsewhereCell`, where the panel reports it as that
 * atlas's answer and nothing that draws can pick it up by accident. The guard
 * is here and not in the shell because this object is the behaviour of record —
 * a rule the shell implements privately is a rule the journey cannot measure,
 * and that is exactly how the two halves came apart (DOG-75).
 *
 * ## A cross-atlas selection is still a view, so it is still a link
 *
 * `state.address[a]` means "the address atlas `a` is showing", not "an address
 * belonging to frame `a`". It used to mean the second, which made the first
 * unrepresentable: `toView()` reads the current atlas's slot, so the brain
 * address you had just selected in the body atlas was missing from the URL the
 * page then showed, and copying that link lost the selection (plan §7: every
 * view is linkable). Filing it under the atlas being viewed also makes the
 * return stack's snapshot true — it restores what you were looking at.
 *
 * The destination atlas's own slot is therefore not written on selection. The
 * address rides to it through `openAtlas`, which is where the move actually
 * happens, so the offer still lands on the cell it offered.
 *
 * ## Camera and layers are per atlas, and the return is a snapshot
 *
 * Two mechanisms, because they answer two different questions. Per-atlas
 * `camera`, `layers` and `labels` mean each atlas remembers how you were
 * looking at it, so switching back and forth does not reset anything. The
 * `returnStack` additionally snapshots the whole view — atlas, camera, layers,
 * label visibility and the selected address — at the moment of an explicit
 * switch, which is what the "route back that restores the previous camera and
 * layer state" requirement actually asks for: not "the body atlas's current
 * state" but "the state you left".
 *
 * ## Label visibility is view state, not shell state
 *
 * It used to live in `app.js` as one boolean on the DOM shell, which made it
 * invisible in three ways at once: one flag shared by both atlases, so turning
 * the markers off in the brain atlas turned them off in the body atlas you came
 * back to; absent from `toView()`, so no link carried it and "every link
 * restores the same view" was false by one facet; and unreachable from anything
 * driving the viewer in Node, so the §7 label behaviour could not be measured
 * at all — the gap DOG-71 was filed for. Whether labels are showing is part of
 * what you are looking at, so it is here with the rest of the view.
 */

import { parse } from '../alc.js';
import { DEFAULT_CAMERA, DEFAULT_LABELS, hasAddress, labelsVisible } from './deeplink.js';
import { selectAddress } from './select.js';

/** Which atlas a frame's addresses belong to. */
export function atlasForFrame(frame) {
  if (frame === 'BD') return 'body';
  if (frame === 'BV' || frame === 'BR') return 'brain';
  return null;
}

/**
 * The layers each atlas offers, in display order.
 *
 * Body layers are the four vertebral regions plus the spine axis. They are
 * groups of levels rather than arbitrary buckets, because that is what a
 * clinician reads and what the solid region colour mode paints.
 */
export const ATLAS_LAYERS = Object.freeze({
  body: Object.freeze([
    { id: 'cervical', label: 'Cervical (C01–C07)' },
    { id: 'thoracic', label: 'Thoracic (T01–T12)' },
    { id: 'lumbar', label: 'Lumbar (L01–L05)' },
    { id: 'sacral', label: 'Sacral' },
    { id: 'spine', label: 'Spine axis' },
  ]),
  brain: Object.freeze([
    { id: 'left', label: 'Left hemisphere' },
    { id: 'right', label: 'Right hemisphere' },
  ]),
});

const freshLayers = () => ({ hidden: [], isolated: null, opacity: {} });

const cloneLayers = (l) => ({
  hidden: [...l.hidden],
  isolated: l.isolated,
  opacity: { ...l.opacity },
});

const cloneCamera = (c) => ({ ...c, target: [...c.target] });

/**
 * Whether a layer is drawn, given the layer state.
 *
 * Isolate is not "hide all the others" written into `hidden`. It is a separate,
 * reversible mode, so turning it off restores whatever show/hide state the user
 * had built up rather than leaving them with everything hidden. Making isolate
 * destructive is the standard way this control becomes annoying.
 */
export function isLayerVisible(layers, id) {
  if (layers.isolated !== null) return layers.isolated === id;
  return !layers.hidden.includes(id);
}

/** Effective opacity for a layer: 1 unless the user set one. */
export function layerOpacity(layers, id) {
  const v = layers.opacity[id];
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

export function createViewer(options = {}) {
  const state = {
    atlas: 'body',
    templates: options.templates ?? {},
    nameIndex: options.nameIndex ?? null,
    /** Per atlas, so each remembers its own view. */
    camera: { body: { ...cloneCamera(DEFAULT_CAMERA) }, brain: { ...cloneCamera(DEFAULT_CAMERA) } },
    layers: { body: freshLayers(), brain: freshLayers() },
    /**
     * Per atlas too, and for the same reason: the body atlas's level markers
     * and the brain atlas's hemisphere markers are different enough that
     * wanting one is not wanting the other.
     */
    labels: { body: DEFAULT_LABELS, brain: DEFAULT_LABELS },
    /** Per atlas, so an address selected in one is still there on return. */
    address: { body: null, brain: null },
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

    /**
     * Select an address.
     *
     * Returns the selection model. On rejection nothing in `state` moves except
     * `selection`, which holds the rejection so the shell can render the
     * message inline — the address that was showing stays showing, the camera
     * does not move, and the layers are untouched.
     *
     * Never changes `state.atlas`. See the module header.
     */
    select(input) {
      const model = selectAddress(input, {
        templates: state.templates,
        nameIndex: state.nameIndex,
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

    /**
     * Show or hide the labels in the current atlas.
     *
     * Changes nothing else. Labels are an annotation over the view, so toggling
     * them is not a navigation and not a selection: the camera, the layers and
     * the selected address are all untouched, which is what the §7 row asserts
     * and the reason this is not folded into the layer state.
     */
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

    /**
     * Move to another atlas, explicitly.
     *
     * Snapshots the view being left onto the return stack first. The snapshot
     * is a deep copy: the whole point is that it still describes the old view
     * after the new atlas has been panned and had its layers changed.
     */
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
        /**
         * Say the atlas out loud when the address does not imply it.
         *
         * `encodeView` omits a default, so a brain address selected in the
         * body atlas would otherwise encode as a bare `?a=BV-…`, and which
         * atlas that link reopens in would depend on a rule rather than on
         * what it says. One link, one meaning: the view that is only half
         * about this atlas is the one that states it.
         */
        atlasExplicit: state.selection?.ok === true && state.selection.elsewhere !== null,
      };
    },

    /**
     * Apply a decoded view.
     *
     * The atlas comes from the URL, which is not a selection-driven switch: a
     * link is an explicit act by whoever followed it. The address is applied
     * after the atlas, so a brain address in a `atlas=brain` link lands in the
     * atlas that can draw it, and a brain address in a body link selects
     * without switching — same rule as a click.
     */
    applyView(view, problems = []) {
      state.viewProblems = [...problems];
      if (view.atlas in state.layers) state.atlas = view.atlas;
      state.camera[state.atlas] = cloneCamera({ ...DEFAULT_CAMERA, ...view.camera });
      state.layers[state.atlas] = cloneLayers({ ...freshLayers(), ...view.layers });
      // Normalised rather than assigned: a view that came from a URL has
      // already been through `decodeView`, but one assembled by a caller may
      // simply not mention labels, and that is the default, not "off".
      state.labels[state.atlas] = labelsVisible(view.labels);
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

/**
 * The atlas an address would be drawn in, without selecting it.
 *
 * Used by the shell to label the cross-atlas offer before the user commits.
 * Returns `null` for an address that does not parse — the caller shows the
 * rejection instead, and this must not be the thing that throws.
 */
export function atlasForAddress(address) {
  try {
    return atlasForFrame(parse(address).frame);
  } catch {
    return null;
  }
}
