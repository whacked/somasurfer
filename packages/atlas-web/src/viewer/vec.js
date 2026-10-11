/**
 * The vector and matrix arithmetic the viewer needs, and nothing more.
 *
 * Vectors are plain 3-element arrays, which is exactly what `@gstack/alc`
 * returns in `pointMm`, `extentMm` and `axesMm`, so a located cell flows
 * through here without a conversion step. Matrices are column-major
 * `Float32Array(16)`, which is what `uniformMatrix4fv` wants.
 */

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function unit(a) {
  const n = len(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

/** `a + b * s`, the step that shows up in every ray and frame expression. */
export const addScaled = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** True when every component is finite. An absent anchor yields NaN millimetres. */
export const isFiniteVec = (a) =>
  Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v));

// ---------------------------------------------------------------------------
// Matrices, column-major
// ---------------------------------------------------------------------------

export function identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function perspective(fovYRadians, aspect, near, far) {
  const f = 1 / Math.tan(fovYRadians / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function lookAt(eye, target, up) {
  const z = unit(sub(eye, target));
  let x = cross(up, z);
  if (len(x) < 1e-9) x = cross([0, 1, 0], z);
  x = unit(x);
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2]; m[12] = -dot(x, eye);
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2]; m[13] = -dot(y, eye);
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2]; m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}

/**
 * Ray/triangle intersection, Möller–Trumbore, returning the ray parameter or
 * null. Single-sided tests would miss a click on the inside of the body shell,
 * so both faces hit and the caller keeps the nearest.
 */
export function rayTriangle(origin, direction, a, b, c) {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross(direction, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  const t = sub(origin, a);
  const u = dot(t, p) * invDet;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = cross(t, e1);
  const v = dot(direction, q) * invDet;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const hit = dot(e2, q) * invDet;
  return hit > 1e-6 ? hit : null;
}
