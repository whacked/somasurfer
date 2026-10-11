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
 */
export const BODY_MESH_BUILD = Object.freeze({
  fullRatio: 0.1,
  fullFloorTriangles: 256,
  ratio: 0.2,
  floorTriangles: 16,
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
