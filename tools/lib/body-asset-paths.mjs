/**
 * Where the body mesh files live, and the build parameters they were made
 * with (DOG-128). Shared by the producer (tools/build-body-meshes.mjs) and the
 * gates, so a gate can never check a different path or floor from the one the
 * build used. The brain's equivalent is brain-asset-paths.mjs.
 */

/**
 * The decimation parameters, chosen once and recorded in docs/body-meshes.md.
 *
 * Unlike the brain, the full tier is decimated too: the source is 6.4 million
 * triangles once the brain is excluded, about 46 MB gzip as ATLM, which is not
 * a web asset at any tier. So:
 *
 *   fullRatio, fullFloorTriangles   source -> full tier (lazy)
 *   ratio, floorTriangles           full tier -> low tier (eager), as for the brain
 *   minComponentTriangles           both steps decimate each connected piece of
 *                                   a structure on its own, keeping at least this
 *                                   many triangles of it, so no piece vanishes
 *   shapeMargin                     each step keeps at least the triangles that
 *                                   hold the structure's area and extents inside
 *                                   this margin. Stricter than the gate's [0.75,
 *                                   1.25] and 0.5, so the gate has room to spare
 *
 * The ratios set the budget for large smooth surfaces; the shape floor is what
 * thin vessels and nerves get instead, measured on the first dry run: at a
 * plain 2% of the source, the right inferior phrenic artery kept 0.38 of its
 * area and moved 112 mm.
 */
export const BODY_MESH_BUILD = Object.freeze({
  fullRatio: 0.1,
  fullFloorTriangles: 256,
  ratio: 0.125,
  floorTriangles: 16,
  minComponentTriangles: 8,
  shapeMargin: Object.freeze({
    full: Object.freeze({ area: 0.05, axis: 0.9 }),
    low: Object.freeze({ area: 0.15, axis: 0.6 }),
  }),
});

/** Paths for a BodyParts3D archive (by its SHA-256), relative to the repository root. */
export function bodyAssetPaths(archiveSha256) {
  const id = `bp3d-${archiveSha256.slice(0, 7)}`;
  const dir = `packages/atlas-assets/body/${id}`;
  return {
    id,
    dir,
    lowFile: `body/${id}/meshes.lowres.bin`,
    fullFile: `body/${id}/meshes.fullres.bin`,
    structuresFile: `body/${id}/structures.json`,
  };
}
