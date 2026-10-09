/**
 * The orbit camera, as arithmetic.
 *
 * Kept separate from the renderer and from the DOM so that "the camera flies to
 * the cell", "reset returns to the default view" and "a link restores the same
 * camera" are all testable without a GL context. The camera is four numbers —
 * yaw, pitch, distance, target — which is also exactly what the URL carries, so
 * there is no lossy conversion between the camera and its deep link.
 *
 * Template millimetres throughout. The body template is about 770 mm tall and
 * the brain about 180 mm, so nothing here assumes a scene scale; every default
 * is derived from the bounds it is given.
 */

import { addScaled, cross, unit } from './vec.js';

/** Pitch is clamped short of the poles, where yaw becomes meaningless. */
const PITCH_LIMIT = Math.PI / 2 - 0.02;

export const FOV_Y = (45 * Math.PI) / 180;

/**
 * The camera that frames a bounding sphere.
 *
 * `1.6` is slack, not a magic number: it leaves the subject filling most of the
 * frame with room for the cell outline and the labels that sit around it.
 */
export function fitCamera(bounds, { yaw = 0.6, pitch = 0.18 } = {}) {
  const distance = (bounds.radius / Math.tan(FOV_Y / 2)) * 1.6;
  return { yaw, pitch, distance, target: [...bounds.centre] };
}

/** Eye position in template millimetres. `+z` is superior, so pitch lifts in z. */
export function eyeOf(camera) {
  const { yaw, pitch, distance, target } = camera;
  const cp = Math.cos(pitch);
  return [
    target[0] + distance * cp * Math.sin(yaw),
    target[1] - distance * cp * Math.cos(yaw),
    target[2] + distance * Math.sin(pitch),
  ];
}

/** World up. Fixed to superior so the body never rolls; pitch is clamped instead. */
export const UP = Object.freeze([0, 0, 1]);

export const rotate = (camera, dYaw, dPitch) => ({
  ...camera,
  yaw: camera.yaw + dYaw,
  pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camera.pitch + dPitch)),
});

/**
 * Zoom by a multiplicative factor, clamped to a sane span of the scene.
 *
 * Multiplicative so a wheel notch feels the same at every scale, and clamped so
 * the user cannot get lost inside the geometry or so far out that the subject
 * is a dot with no way back but reset.
 */
export const zoom = (camera, factor, bounds) => ({
  ...camera,
  distance: Math.max(
    bounds ? bounds.radius * 0.05 : 1,
    Math.min(bounds ? bounds.radius * 40 : 1e6, camera.distance * factor),
  ),
});

/**
 * Pan across the view plane.
 *
 * `dx`/`dy` are fractions of the viewport, so the grab point tracks the pointer
 * at any distance: the world span of the viewport is proportional to distance,
 * which is what the `distance` factor below is.
 */
export function pan(camera, dx, dy) {
  const eye = eyeOf(camera);
  const forward = unit([
    camera.target[0] - eye[0],
    camera.target[1] - eye[1],
    camera.target[2] - eye[2],
  ]);
  const right = unit(cross(forward, UP));
  const up = cross(right, forward);
  const span = 2 * camera.distance * Math.tan(FOV_Y / 2);
  let target = addScaled(camera.target, right, -dx * span);
  target = addScaled(target, up, dy * span);
  return { ...camera, target };
}

/**
 * Frame a cell, keeping the current orientation.
 *
 * Orientation is deliberately preserved. Pasting an address should show you
 * where that cell is from where you were already looking; re-orienting as well
 * as moving makes it hard to tell what just happened. `minRadiusMm` keeps a
 * five-digit cell — a couple of millimetres across — from putting the camera
 * inside the body: a cell can be smaller than anything worth filling a screen
 * with, and this is where the viewer stops zooming in and starts relying on the
 * outline to say how big the cell really is.
 */
export function flyToCell(camera, cellBounds, { minRadiusMm = 25 } = {}) {
  const radius = Math.max(cellBounds.radius, minRadiusMm);
  return {
    ...camera,
    distance: (radius / Math.tan(FOV_Y / 2)) * 2.2,
    target: [...cellBounds.centre],
  };
}

/**
 * A ray through a viewport pixel, for picking.
 *
 * `(px, py)` are CSS pixels from the top-left of the canvas. Returns a unit
 * direction from the eye, which is what `pickMesh` expects.
 */
export function rayThrough(camera, px, py, width, height) {
  const eye = eyeOf(camera);
  const forward = unit([
    camera.target[0] - eye[0],
    camera.target[1] - eye[1],
    camera.target[2] - eye[2],
  ]);
  const right = unit(cross(forward, UP));
  const up = cross(right, forward);
  const aspect = width / height;
  // NDC, y up.
  const ndcX = (px / width) * 2 - 1;
  const ndcY = 1 - (py / height) * 2;
  const tanHalf = Math.tan(FOV_Y / 2);
  let direction = addScaled(forward, right, ndcX * tanHalf * aspect);
  direction = addScaled(direction, up, ndcY * tanHalf);
  return { origin: eye, direction: unit(direction) };
}
