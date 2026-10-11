/**
 * The template interface, and the geometry the viewer derives from it.
 *
 * The viewer is built against this interface and never against one template.
 * A template arrives as JSON — synthetic ones prebuilt by `build.mjs` now, the
 * asset pipeline's audited ones later — is validated here, and from then on the
 * viewer only knows "a body template" and "a brain volume template".
 *
 * ## The mesh comes out of the frame, not alongside it
 *
 * `bodySurfaceMesh` does not read `surfaceRadiiMm` and build its own tube. It
 * calls the library's own forward map, `bodyLocalToMm`, at `r = 1`. That is the
 * point: the surface on screen is by construction the surface the BD frame
 * describes, so a click that raycasts to this mesh and then encodes through
 * `bodyMmToLocal` is a round trip through one coordinate system rather than two
 * that can drift. If the frame's idea of the skin and the drawing of the skin
 * disagreed, a user would be clicking one body and addressing another.
 *
 * The same applies to the brain: `bvLocalToMm` at the hemisphere box corners.
 *
 * ## Validation is not ceremony
 *
 * These objects come over `fetch`. A truncated response, a missing field or a
 * non-finite coordinate must surface as "the atlas is unavailable" — with
 * addresses still parsing and still resolving to names (plan §6, last row) —
 * rather than as a thrown error from inside a render loop, or worse, as
 * geometry quietly built around a `NaN`.
 */

import { bodyLocalToMm, bvLocalToMm } from '../alc.js';
import { addScaled, cross, dist, rayTriangle, sub, unit } from './vec.js';

/** Thrown by the validators. The viewer turns it into an "atlas unavailable" state. */
export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
  }
}

const REGIONS = { C: 'cervical', T: 'thoracic', L: 'lumbar', S: 'sacral' };

/** `T07` -> `thoracic`. The grouping the body atlas's layers are built on. */
export const levelRegion = (label) => REGIONS[String(label)[0]] ?? 'other';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function requireFiniteVec(value, what) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => Number.isFinite(v))) {
    throw new TemplateError(`${what} must be three finite numbers, got ${JSON.stringify(value)}`);
  }
  return [value[0], value[1], value[2]];
}

function requirePositive(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TemplateError(`${what} must be a positive finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireDigitCap(value, what) {
  if (!Number.isInteger(value) || value < 0 || value > 16) {
    throw new TemplateError(`${what} must be an integer in 0..16, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Validate a body template.
 *
 * `maxUsefulDigits` is checked as hard as the geometry is, because it is the
 * number the honesty flag is derived from: a template that arrives claiming
 * more precision than it has makes `locate()` stop raising `overPrecise`, and
 * the viewer would then render a cell far finer than the mesh justifies without
 * anything on screen saying so.
 */
export function validateBodyTemplate(input) {
  if (!input || typeof input !== 'object') throw new TemplateError('body template is not an object');
  const id = typeof input.id === 'string' && input.id !== '' ? input.id : null;
  if (!id) throw new TemplateError('body template needs a non-empty id');
  if (!Array.isArray(input.slabs) || input.slabs.length === 0) {
    throw new TemplateError(`body template ${id} has no slabs`);
  }

  const seen = new Set();
  const slabs = input.slabs.map((slab, i) => {
    const where = `body template ${id} slab ${i}`;
    const label = typeof slab?.label === 'string' && slab.label !== '' ? slab.label : null;
    if (!label) throw new TemplateError(`${where} needs a non-empty label`);
    if (seen.has(label)) throw new TemplateError(`${where}: duplicate level label ${label}`);
    seen.add(label);
    if (!Array.isArray(slab.surfaceRadiiMm) || slab.surfaceRadiiMm.length < 3) {
      throw new TemplateError(`${where} (${label}) needs at least 3 surface radii`);
    }
    for (const r of slab.surfaceRadiiMm) requirePositive(r, `${where} (${label}) surface radius`);
    return {
      label,
      origin: requireFiniteVec(slab.origin, `${where} (${label}) origin`),
      axial: unit(requireFiniteVec(slab.axial, `${where} (${label}) axial`)),
      anterior: unit(requireFiniteVec(slab.anterior, `${where} (${label}) anterior`)),
      left: unit(requireFiniteVec(slab.left, `${where} (${label}) left`)),
      heightMm: requirePositive(slab.heightMm, `${where} (${label}) heightMm`),
      surfaceRadiiMm: slab.surfaceRadiiMm.map(Number),
    };
  });

  return {
    id,
    slabs,
    maxUsefulDigits: requireDigitCap(input.maxUsefulDigits, `body template ${id} maxUsefulDigits`),
  };
}

export function validateBrainVolumeTemplate(input) {
  if (!input || typeof input !== 'object') throw new TemplateError('brain template is not an object');
  const id = typeof input.id === 'string' && input.id !== '' ? input.id : null;
  if (!id) throw new TemplateError('brain volume template needs a non-empty id');
  const extentsIn = input.extents;
  if (!extentsIn || typeof extentsIn !== 'object') {
    throw new TemplateError(`brain volume template ${id} has no extents`);
  }
  const extents = {};
  for (const key of ['left', 'right', 'anterior', 'posterior', 'superior', 'inferior']) {
    extents[key] = requirePositive(extentsIn[key], `brain volume template ${id} extents.${key}`);
  }
  return {
    id,
    acMm: requireFiniteVec(input.acMm, `brain volume template ${id} acMm`),
    left: unit(requireFiniteVec(input.left, `brain volume template ${id} left`)),
    anterior: unit(requireFiniteVec(input.anterior, `brain volume template ${id} anterior`)),
    superior: unit(requireFiniteVec(input.superior, `brain volume template ${id} superior`)),
    extents,
    maxUsefulDigits: requireDigitCap(
      input.maxUsefulDigits,
      `brain volume template ${id} maxUsefulDigits`,
    ),
  };
}

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

/** The spine axis as a polyline, cranial to caudal: one point per level boundary. */
export function bodySpinePolyline(template) {
  const points = [];
  for (const slab of template.slabs) {
    points.push(bodyLocalToMm(template, { level: slab.label, u: 0, t: 0, r: 0 }));
  }
  const last = template.slabs[template.slabs.length - 1];
  points.push(bodyLocalToMm(template, { level: last.label, u: 1, t: 0, r: 0 }));
  return points;
}

/** The axis-aligned bounds of a point list, and a centre and radius for the camera. */
export function boundsOf(points) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i += 1) {
      if (p[i] < lo[i]) lo[i] = p[i];
      if (p[i] > hi[i]) hi[i] = p[i];
    }
  }
  const centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return { lo, hi, centre, radius: dist(lo, hi) / 2 || 1 };
}

/** Bounds straight from a mesh's position buffer, without materialising points. */
export function meshBounds(mesh) {
  const points = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    points.push([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
  }
  return boundsOf(points);
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
