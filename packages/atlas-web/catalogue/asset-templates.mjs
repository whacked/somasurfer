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
