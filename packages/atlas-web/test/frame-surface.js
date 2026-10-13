/**
 * The frame-surface meshes v1 drew as stand-in anatomy, kept for the suite.
 *
 * v2 draws the W2/W3 meshes instead (src/viewer/meshset.js, DOG-129), so
 * these left the shipped bundle. They are still the frame's own surface — a
 * point on them encodes through the frame by construction — which is what the
 * journey, real-asset and off-model tests use them for.
 */

import { bodyLocalToMm, bvLocalToMm } from '../src/alc.js';
import { levelRegion } from '../src/viewer/template.js';
import { addScaled, cross, rayTriangle, sub, unit } from '../src/viewer/vec.js';

// ---------------------------------------------------------------------------
// Body surface, through the frame's own forward map
// ---------------------------------------------------------------------------

/**
 * A triangle mesh of the body surface, one quad band per level.
 *
 * Bands are not vertex-welded across levels. Two reasons, and the second is the
 * one that matters: a per-level vertex attribute is what the solid region
 * colour mode paints with, and a welded seam vertex would have to belong to one
 * of the two levels and be wrong for the other. Levels are also exactly what
 * the layer controls show, hide and isolate.
 *
 * `azimuthSamples` defaults to the template's own radial sampling, so the mesh
 * is as detailed as the data and no more. Asking for more would interpolate
 * detail the template does not have.
 */
export function bodySurfaceMesh(template, azimuthSamples = 0) {
  const positions = [];
  const normals = [];
  const triangles = [];
  /** Parallel to `triangles`: which level each triangle belongs to. */
  const triangleLevels = [];
  /** Per-level vertex ranges, so a layer can be drawn on its own. */
  const levels = [];

  for (const slab of template.slabs) {
    const samples = azimuthSamples > 0 ? azimuthSamples : slab.surfaceRadiiMm.length;
    const firstVertex = positions.length / 3;
    const firstTriangle = triangles.length / 3;

    // Two rings: the cranial and caudal bounding planes of this level. u is the
    // fraction between them, so u=1 here and u=0 on the next level are the same
    // surface, and the bands meet without a gap.
    for (const u of [0, 1]) {
      for (let k = 0; k < samples; k += 1) {
        const t = k / samples;
        const p = bodyLocalToMm(template, { level: slab.label, u, t, r: 1 });
        positions.push(p[0], p[1], p[2]);
      }
    }

    for (let k = 0; k < samples; k += 1) {
      const kNext = (k + 1) % samples;
      const a = firstVertex + k;
      const b = firstVertex + kNext;
      const c = firstVertex + samples + k;
      const d = firstVertex + samples + kNext;
      triangles.push(a, c, b, b, c, d);
      triangleLevels.push(slab.label, slab.label);
    }

    levels.push({
      label: slab.label,
      region: levelRegion(slab.label),
      firstVertex,
      vertexCount: samples * 2,
      firstTriangle,
      triangleCount: samples * 2,
    });
  }

  // Area-weighted vertex normals, so the shell reads as a solid body rather
  // than as a faceted one. Lighting only; nothing addressable depends on it.
  for (let i = 0; i < positions.length; i += 1) normals.push(0);
  for (let i = 0; i < triangles.length; i += 3) {
    const [ia, ib, ic] = [triangles[i] * 3, triangles[i + 1] * 3, triangles[i + 2] * 3];
    const pa = positions.slice(ia, ia + 3);
    const pb = positions.slice(ib, ib + 3);
    const pc = positions.slice(ic, ic + 3);
    const n = cross(sub(pb, pa), sub(pc, pa));
    for (const base of [ia, ib, ic]) {
      normals[base] += n[0];
      normals[base + 1] += n[1];
      normals[base + 2] += n[2];
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const n = unit([normals[i], normals[i + 1], normals[i + 2]]);
    normals[i] = n[0];
    normals[i + 1] = n[1];
    normals[i + 2] = n[2];
  }

  return {
    templateId: template.id,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    triangles: Uint32Array.from(triangles),
    triangleLevels,
    levels,
  };
}

// ---------------------------------------------------------------------------
// Brain volume box
// ---------------------------------------------------------------------------

const BOX_QUADS = [
  [0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1],
  [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3],
];

/**
 * One hemisphere half-box as a triangle mesh, with its corners placed by
 * `bvLocalToMm` rather than by this module's own arithmetic about extents.
 *
 * The `a` axis is the lateral one and runs from the midsagittal plane outwards,
 * so the two hemispheres meet at `a = 0` and the midline is not drawn twice.
 */
export function brainHemisphereMesh(template, hemisphere) {
  const corners = [];
  for (let i = 0; i < 8; i += 1) {
    corners.push(bvLocalToMm(template, hemisphere, {
      a: i & 4 ? 1 : 0,
      b: i & 2 ? 1 : 0,
      c: i & 1 ? 1 : 0,
    }));
  }
  const positions = [];
  const normals = [];
  const triangles = [];
  for (const quad of BOX_QUADS) {
    const base = positions.length / 3;
    const n = unit(cross(
      sub(corners[quad[1]], corners[quad[0]]),
      sub(corners[quad[3]], corners[quad[0]]),
    ));
    for (const c of quad) {
      positions.push(corners[c][0], corners[c][1], corners[c][2]);
      normals.push(n[0], n[1], n[2]);
    }
    triangles.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    templateId: template.id,
    hemisphere,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    triangles: Uint32Array.from(triangles),
    corners,
  };
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

/**
 * Nearest triangle hit along a ray, as a millimetre point plus the level that
 * owns the triangle.
 *
 * The level is returned for the hit *report*, never to build the address. The
 * address comes from running the millimetres back through the frame
 * (`encodeBody`), because that is the only path that also produces the flags —
 * including `folded`, which is precisely the case where the level the triangle
 * belongs to and the level the frame decodes are not the same. Trusting the
 * triangle here would hide the one defect the flag exists to show.
 */
export function pickMesh(mesh, origin, direction) {
  let best = null;
  const { positions, triangles } = mesh;
  for (let i = 0; i < triangles.length; i += 3) {
    const ia = triangles[i] * 3;
    const ib = triangles[i + 1] * 3;
    const ic = triangles[i + 2] * 3;
    const t = rayTriangle(
      origin,
      direction,
      [positions[ia], positions[ia + 1], positions[ia + 2]],
      [positions[ib], positions[ib + 1], positions[ib + 2]],
      [positions[ic], positions[ic + 1], positions[ic + 2]],
    );
    if (t !== null && (best === null || t < best.t)) {
      best = { t, triangle: i / 3 };
    }
  }
  if (best === null) return null;
  return {
    pointMm: addScaled(origin, direction, best.t),
    distanceMm: best.t,
    level: mesh.triangleLevels ? mesh.triangleLevels[best.triangle] : null,
    triangle: best.triangle,
  };
}
