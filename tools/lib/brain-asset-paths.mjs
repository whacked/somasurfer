/**
 * Where the brain mesh files live, and the build parameters they were made
 * with. Shared by the producer (tools/build-meshes.mjs) and the gates, so a
 * gate can never check a different path or floor from the one the build used.
 */

/**
 * The decimation parameters, chosen once and recorded in docs/brain-meshes.md.
 *
 *   ratio 0.15        puts the low tier at ~0.72 MiB gzip, inside the brain's
 *                     1 MiB share of lowResAssetGzipBytes with room left over
 *   floorTriangles 128  no structure drops below 128 triangles, or below its
 *                     full count if that is smaller; enough for a closed
 *                     nucleus to keep its shape at a sub-millimetre error
 */
export const BRAIN_MESH_BUILD = Object.freeze({ ratio: 0.15, floorTriangles: 128 });

/** Paths for a brainproject commit, relative to the repository root. */
export function brainAssetPaths(commit) {
  const id = `zanatomy-${commit.slice(0, 7)}`;
  const dir = `packages/atlas-assets/brain/${id}`;
  return {
    id,
    dir,
    lowFile: `brain/${id}/meshes.lowres.bin`,
    fullFile: `brain/${id}/meshes.fullres.bin`,
    structuresFile: `brain/${id}/structures.json`,
    provenance: `packages/atlas-assets/provenance/brain-${id}.json`,
    containment: `packages/atlas-assets/provenance/cortex-containment-${id}.json`,
  };
}
