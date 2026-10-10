/**
 * Which asset templates the catalogue advertises, declared first-party.
 *
 * Every field here is OUR statement *about* an asset file — which file it is,
 * what kind of template it holds, how to label it, what to caution a reader
 * about. Nothing is read out of the asset. `build.mjs` byte-copies assets and
 * never parses them, and `data/atlas-index.json` is one of the prebuilt
 * indexes that rule 6 of `tools/check-licence-separation.mjs` holds to that
 * boundary, so a value lifted out of a template and into the index would make
 * the index a derivative of the template.
 *
 * It lives in its own module, outside `src/`, for two reasons. The browser
 * never loads it — the client reads template paths from the catalogue, which
 * is data, and no module under `src/` may know an asset path (asserted by
 * `test/real-assets.test.js`). And the suite can import it, which is what lets
 * the declared `id` below be checked against the id inside each file rather
 * than trusted: the build may not read assets, but a test may read them as
 * data, so the one claim this file makes that could silently rot is the one
 * claim CI verifies.
 *
 * ## `maxUsefulDigits` is deliberately not here
 *
 * It is the template's own declaration of how much precision its mesh
 * resolution justifies — asset content. It is also not *needed* here: the
 * viewer reads the cap off the template object it actually validated and
 * bound, which is the only reading that can be right. A cap duplicated into
 * the catalogue would be a second source of truth that drifts the first time a
 * template is regenerated, and the drift would surface as the viewer trusting
 * precision the mesh no longer supports — exactly what the cap prevents.
 */

export const ASSET_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'bp3d-4.0-adult-body-centroid',
    file: 'templates/bp3d-4.0-adult-body-centroid.body.json',
    kind: 'body',
    label: 'Adult body — BodyParts3D 4.0',
    provenance: 'asset',
    admissible: true,
    isDefault: true,
    caveat:
      'Derived from the BodyParts3D 4.0 IS-A mesh release by DOG-35’s pipeline, and audited for '
      + 'frame soundness — no fold, worst level T04 at utilisation 0.71. The fused sacrum is one '
      + 'addressable level, so S02–S05 are reserved grammar with no anatomy behind them.',
  }),
  Object.freeze({
    id: 'icbm152-2009c-asym',
    file: 'templates/icbm152-2009c-asym.brain-volume.json',
    kind: 'brainVolume',
    label: 'Adult brain — ICBM152 2009c asymmetric',
    provenance: 'asset',
    admissible: true,
    isDefault: true,
    caveat:
      'A verified stereotaxic bounding volume about the anterior commissure, not a parcellated '
      + 'brain. No brain parcellation cleared licensing for redistribution, so this frame ships '
      + 'with coordinates and no names — see docs/asset-licensing.md §4.',
  }),
]);

/** The two documents the name index is joined from, in the asset package. */
export const NAME_INDEX_FILES = Object.freeze({
  names: 'labels/names.json',
  coverings: 'labels/coverings.json',
});

/**
 * How much of the curated corpus the browser can actually place, declared.
 *
 * This is the one number in the artefact that the build is structurally unable
 * to compute. Resolving a structure id means reading the name index, the name
 * index is an asset payload, and rule 6 holds `dist/data/` to deriving nothing
 * from asset content — the same wall `maxUsefulDigits` is on the other side of,
 * for the same reason. So the resolution happens in the browser, at load, where
 * the index has already been fetched.
 *
 * Which leaves the page unable to say anything about its own coverage until
 * after it has loaded everything, and that is the gap this declaration fills:
 * `atlas-index.json` states what the join is expected to yield, the page
 * compares what it measured against it, and a disagreement is reported rather
 * than absorbed. Without that, a join that silently resolved nothing would
 * render a paper list with no geometry — which is precisely what the correct
 * page looks like for the 139 mappings that genuinely cannot be placed. There
 * is no visual difference between the two, so a number is the only thing that
 * can tell them apart.
 *
 * ## It is a measurement, and it is verified rather than trusted
 *
 * Every figure below was measured against the index named in
 * `againstNameIndexVersion` with both shipped templates bound.
 * `test/curated-corpus.test.js` re-measures all of them on the committed tree
 * and fails if they drift, which is the same arrangement the declared template
 * `id`s have: the build may not read an asset, a test may read it as data, so
 * the claim that could silently rot is the claim CI checks.
 *
 * Raise these when the cleared index grows. Never to make something pass.
 */
export const CURATED_CORPUS_RESOLUTION = Object.freeze({
  againstNameIndexVersion:
    'bp3d-4.0+uberon-uberon/releases/2026-10-01/uberon-basic.owl+8772477294da',
  /** Both templates bound. Without them this is 28, across 8 papers. */
  resolvedMappings: 31,
  unresolvedMappings: 139,
  papersWithGeometry: 10,
  findingsWithGeometry: 24,
  /**
   * Resolved mappings whose structure the index cannot name: real extent from
   * curated `cells` or `coordinates`, carrying a curated label. Neither a
   * success to report as named nor a failure to report as missing.
   */
  placedUnnameable: 5,
  /**
   * Why the 139 are not placed, per partition of `authoredAgainst`, and the
   * reason this is a list rather than a sentence. 135 are blocked by licensing;
   * 4 are a coverage gap in the cleared subset. The dataset separates them
   * deliberately, so the page must not merge them — saying "not licence-cleared"
   * about a rib would be a new false claim introduced while fixing another.
   */
  byPartition: Object.freeze([
    Object.freeze({ partitionId: 'brain-parcellation', resolved: 5, unresolved: 135 }),
    Object.freeze({ partitionId: 'body-bd', resolved: 26, unresolved: 0 }),
    Object.freeze({ partitionId: 'body-not-in-index', resolved: 0, unresolved: 4 }),
  ]),
});
