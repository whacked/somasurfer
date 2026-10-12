/**
 * Which mesh sets the page draws, declared first-party (DOG-129, W4).
 *
 * The same contract as `asset-templates.mjs`: every field is OUR statement
 * about a file in packages/atlas-assets — where it is, which atlas draws it,
 * how it reaches world millimetres. Nothing is read out of an asset here;
 * `build.mjs` only checks each path was copied. The tiers, structure names,
 * labels and the registration affine are asset content, and the browser reads
 * them at runtime from the files named below.
 *
 * World millimetres per atlas, and why each set lands in them:
 *
 *   brain  MNI152 2009c asymmetric, RAS — the `BV` template's own space
 *          (`acMm` at the origin), so a picked point encodes straight through
 *          `encodeBrainVolume`.
 *            - `icbm152-2009c` is native MNI (its own `mapping` says identity).
 *            - `zanatomy-2929e94` is in glTF metres; W2's fitted `meshToMni`
 *              affine carries it, and its held-out error is shown to the user
 *              on every pick of one of its structures.
 *   body   BodyParts3D 4.0 millimetres — the chart `BD` was measured in, so
 *          the meshes and the frame are the same coordinates (W3's
 *          `registration.transform` is identity).
 *
 * Order matters within an atlas only for drawing: a set listed first is
 * uploaded first. Each set is fetched, decoded and drawn on its own, so one
 * failing costs that set and nothing else.
 */

export const ASSET_MESH_SETS = Object.freeze([
  Object.freeze({
    id: 'icbm152-2009c',
    atlas: 'brain',
    structures: 'brain/icbm152-2009c/structures.json',
    // First-party lobe labels, one per vertex (DOG-151 criterion 7).
    labels: 'brain/icbm152-2009c/lobes.json',
  }),
  Object.freeze({
    id: 'zanatomy-2929e94',
    atlas: 'brain',
    structures: 'brain/zanatomy-2929e94/structures.json',
    registration: 'registration/mni-to-zanatomy-2929e94.json',
  }),
  Object.freeze({
    id: 'bp3d-4066585',
    atlas: 'body',
    structures: 'body/bp3d-4066585/structures.json',
  }),
]);
