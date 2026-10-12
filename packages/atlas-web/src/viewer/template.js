/**
 * The template interface, and the geometry the viewer derives from it.
 *
 * The viewer is built against this interface and never against one template.
 * A template arrives as JSON — synthetic ones prebuilt by `build.mjs` now, the
 * asset pipeline's audited ones later — is validated here, and from then on the
 * viewer only knows "a body template" and "a brain volume template".
 *
 * ## The anatomy is drawn from meshes; the frame only addresses
 *
 * v1 drew the frame itself — a band per vertebral level, a box per
 * hemisphere — because there was no anatomy to draw. v2 draws the W2/W3 mesh
 * sets (`meshset.js`), and the frame's role is what it always was underneath:
 * a clicked millimetre point goes back through `encodeBody` /
 * `encodeBrainVolume`, so the address and its flags come from one coordinate
 * system. The frame-surface meshes v1 drew live on in
 * `test/frame-surface.js`, where the suite still uses them as the frame's own
 * surface (DOG-129).
 *
 * ## Validation is not ceremony
 *
 * These objects come over `fetch`. A truncated response, a missing field or a
 * non-finite coordinate must surface as "the atlas is unavailable" — with
 * addresses still parsing and still resolving to names (plan §6, last row) —
 * rather than as a thrown error from inside a render loop, or worse, as
 * geometry quietly built around a `NaN`.
 */

import { bodyLocalToMm } from '../alc.js';
import { dist, unit } from './vec.js';

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
