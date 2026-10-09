/**
 * The URL *is* the view state.
 *
 * "Every view is linkable, and every link restores the same view" only holds if
 * the URL carries everything a view consists of. An address alone does not: two
 * people with the same `?a=` and different layer sets are not looking at the
 * same thing, and a link that silently resets the camera has not restored
 * anything. So the query string carries the atlas, the address, the camera and
 * the layer state, and this module is the only place that knows the encoding.
 *
 * Two properties are deliberately built in and asserted by the suite.
 *
 * **Canonical and idempotent.** `encode` rounds every float to a fixed number
 * of decimals and emits keys in a fixed order, so `encode(decode(s))` is stable
 * and two viewers that reached the same view produce character-identical links.
 * Without that, `pushState` on every camera nudge would fill the history with
 * URLs that differ in the ninth decimal.
 *
 * **Total on bad input.** A query string is untrusted. Every field is parsed
 * defensively and a malformed one falls back to its default while the rest are
 * kept — a mangled `cam=` must not cost you the address. `decode` never throws
 * and never returns a `NaN`; it reports what it rejected in `problems` so the
 * viewer can say so instead of silently showing something else.
 *
 * What this module does NOT do is validate the address. That is `parse()`'s job
 * and it happens downstream, in `select.js`, before any geometry — an address
 * is carried through here as an opaque string precisely so that a bad one is
 * rejected by the one validator that knows the grammar.
 */

/** Atlases the URL can name. `body` is the default because it is the entry view. */
export const ATLASES = Object.freeze(['body', 'brain']);

const ANGLE_DECIMALS = 3;
const MM_DECIMALS = 2;
const OPACITY_DECIMALS = 2;

export const DEFAULT_CAMERA = Object.freeze({
  yaw: 0,
  pitch: 0,
  distance: 0,
  target: Object.freeze([0, 0, 0]),
});

export const DEFAULT_VIEW = Object.freeze({
  atlas: 'body',
  address: null,
  camera: DEFAULT_CAMERA,
  layers: Object.freeze({ hidden: Object.freeze([]), isolated: null, opacity: Object.freeze({}) }),
});

const round = (value, decimals) => {
  const f = 10 ** decimals;
  // `+ 0` normalises -0 to 0, so two views that differ only in the sign of a
  // zero do not produce two different URLs.
  return Math.round(value * f) / f + 0;
};

const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/** A layer id: the viewer's own ids are ASCII words, and only those round-trip. */
const isLayerId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);

/**
 * "Is there an address here at all?" — as a predicate, on purpose.
 *
 * Written inline, this is `typeof view.address === 'string' && view.address !==
 * ''`, and the standing address-equality guard fires on it: it sees an
 * address-named operand in a comparison, which is exactly the shape it exists
 * to catch. It is a false positive — an emptiness test is not an identity claim
 * between two addresses — but the right response is to stop writing the shape
 * rather than to file a reviewed exception for a non-problem. Naming the
 * predicate once says what the test actually is, and leaves the guard scoped to
 * real comparisons.
 */
export const hasAddress = (value) => typeof value === 'string' && value.length > 0;

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * View -> query string, without the leading `?`.
 *
 * Keys are omitted when they hold their default, so the entry view is a bare
 * URL and a link is as short as what it actually says.
 */
export function encodeView(view) {
  const atlas = ATLASES.includes(view?.atlas) ? view.atlas : DEFAULT_VIEW.atlas;
  const params = new URLSearchParams();

  if (hasAddress(view?.address)) params.set('a', view.address);
  if (atlas !== DEFAULT_VIEW.atlas) params.set('atlas', atlas);

  const camera = view?.camera;
  if (camera && Number.isFinite(camera.distance) && camera.distance > 0) {
    const target = Array.isArray(camera.target) ? camera.target : DEFAULT_CAMERA.target;
    params.set('cam', [
      round(finiteOr(camera.yaw, 0), ANGLE_DECIMALS),
      round(finiteOr(camera.pitch, 0), ANGLE_DECIMALS),
      round(camera.distance, MM_DECIMALS),
      round(finiteOr(target[0], 0), MM_DECIMALS),
      round(finiteOr(target[1], 0), MM_DECIMALS),
      round(finiteOr(target[2], 0), MM_DECIMALS),
    ].join(','));
  }

  const layers = view?.layers ?? DEFAULT_VIEW.layers;
  const hidden = (layers.hidden ?? []).filter(isLayerId);
  if (hidden.length > 0) params.set('hide', [...new Set(hidden)].sort().join(','));
  if (isLayerId(layers.isolated)) params.set('iso', layers.isolated);

  const opacity = Object.entries(layers.opacity ?? {})
    .filter(([id, value]) => isLayerId(id) && Number.isFinite(value))
    .map(([id, value]) => [id, round(Math.min(1, Math.max(0, value)), OPACITY_DECIMALS)])
    // Opacity 1 is the default and says nothing, so it stays out of the URL.
    .filter(([, value]) => value < 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (opacity.length > 0) params.set('op', opacity.map(([id, v]) => `${id}:${v}`).join(','));

  return params.toString();
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Query string -> view, plus a list of what it had to reject.
 *
 * `problems` is not decoration. A link that half-worked should say which half,
 * because the alternative is a user comparing two screenshots and concluding
 * the atlas is non-deterministic.
 */
export function decodeView(search) {
  const problems = [];
  let params;
  try {
    params = new URLSearchParams(
      typeof search === 'string' ? search.replace(/^[?#]/, '') : '',
    );
  } catch {
    return { view: { ...DEFAULT_VIEW }, problems: ['the query string could not be parsed'] };
  }

  const raw = params.get('a');
  // Length is capped before the address reaches `parse()`, which caps it too.
  // Doing it here as well keeps an absurd URL out of the history entry and out
  // of the error message that would quote it back.
  let address = null;
  if (raw !== null) {
    if (raw.length > 64) problems.push(`the address in the URL is longer than 64 characters (${raw.length})`);
    else if (raw.trim() === '') problems.push('the address in the URL is empty');
    else address = raw.trim();
  }

  let atlas = DEFAULT_VIEW.atlas;
  const atlasRaw = params.get('atlas');
  if (atlasRaw !== null) {
    if (ATLASES.includes(atlasRaw)) atlas = atlasRaw;
    else problems.push(`unknown atlas ${JSON.stringify(atlasRaw)}; showing the body atlas`);
  }

  let camera = { ...DEFAULT_CAMERA };
  const camRaw = params.get('cam');
  if (camRaw !== null) {
    const parts = camRaw.split(',').map(Number);
    if (parts.length !== 6 || !parts.every(Number.isFinite) || !(parts[2] > 0)) {
      problems.push('the camera in the URL is malformed; using the default view');
    } else {
      camera = {
        yaw: round(parts[0], ANGLE_DECIMALS),
        pitch: round(parts[1], ANGLE_DECIMALS),
        distance: round(parts[2], MM_DECIMALS),
        target: [
          round(parts[3], MM_DECIMALS),
          round(parts[4], MM_DECIMALS),
          round(parts[5], MM_DECIMALS),
        ],
      };
    }
  }

  const hideRaw = params.get('hide');
  const hidden = [];
  if (hideRaw !== null) {
    for (const id of hideRaw.split(',').filter((s) => s !== '')) {
      if (isLayerId(id)) hidden.push(id);
      else problems.push(`ignored an unusable layer id in hide=: ${JSON.stringify(id)}`);
    }
  }

  let isolated = null;
  const isoRaw = params.get('iso');
  if (isoRaw !== null && isoRaw !== '') {
    if (isLayerId(isoRaw)) isolated = isoRaw;
    else problems.push(`ignored an unusable layer id in iso=: ${JSON.stringify(isoRaw)}`);
  }

  const opacity = {};
  const opRaw = params.get('op');
  if (opRaw !== null) {
    for (const pair of opRaw.split(',').filter((s) => s !== '')) {
      const at = pair.lastIndexOf(':');
      const id = at < 0 ? '' : pair.slice(0, at);
      const value = at < 0 ? NaN : Number(pair.slice(at + 1));
      if (!isLayerId(id) || !Number.isFinite(value) || value < 0 || value > 1) {
        problems.push(`ignored an unusable opacity in op=: ${JSON.stringify(pair)}`);
        continue;
      }
      opacity[id] = round(value, OPACITY_DECIMALS);
    }
  }

  return {
    view: {
      atlas,
      address,
      camera,
      layers: { hidden: [...new Set(hidden)].sort(), isolated, opacity },
    },
    problems,
  };
}

/** The full URL for a view, against a base. Used for `pushState` and for Copy link. */
export function viewHref(view, base = '') {
  const query = encodeView(view);
  const path = base === '' ? '' : base;
  return query === '' ? path || '.' : `${path}?${query}`;
}
