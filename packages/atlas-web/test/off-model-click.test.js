/**
 * DOG-116: a click can raise `clamped`.
 *
 * Two halves had to be fixed, and each is asserted on its own. A click off the
 * model used to select nothing, and a click on it threw `encodeBody()`'s flags
 * away — so no path in the page could ever show the notice. These drive the
 * same sequence `app.js` `pick()` does: `rayThrough` → `pickMesh` or
 * `missPoint` → `encodeBody` → `viewer.select(address, { encodeFlags })`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeBody, parse } from '../src/alc.js';
import { fitCamera, missPoint, rayThrough } from '../src/viewer/camera.js';
import { createViewer } from '../src/viewer/state.js';
import { bodySurfaceMesh, meshBounds, pickMesh } from '../src/viewer/template.js';
import { nameIndex, templates } from './support.js';

const W = 1280;
const H = 900;

function scene() {
  const t = templates();
  const viewer = createViewer({ templates: t, nameIndex: nameIndex() });
  const mesh = bodySurfaceMesh(t.body);
  const bounds = meshBounds(mesh);
  viewer.setCamera(fitCamera(bounds));
  const click = (px, py) => {
    const ray = rayThrough(viewer.cameraOf(), px, py, W, H);
    const hit = pickMesh(mesh, ray.origin, ray.direction);
    const enc = encodeBody(t.body, hit ? hit.pointMm : missPoint(ray, bounds), 4);
    return { hit, model: viewer.select(enc.address, { encodeFlags: enc.flags }) };
  };
  return { t, viewer, mesh, click };
}

/** The topmost and bottommost rows of the canvas column through x that hit. */
function modelRows(click, x) {
  let top = null;
  let bottom = null;
  for (let y = 0; y < H; y += 2) {
    if (click(x, y).hit) {
      if (top === null) top = y;
      bottom = y;
    }
  }
  return { top, bottom };
}

const clampNotice = (model) => model.notices.find((n) => n.code === 'clamped');

describe('a click off the model is addressed at the boundary, and says so', () => {
  const { click } = scene();
  const x = W / 2;
  const { top, bottom } = modelRows(click, x);

  it('finds the model in view', () => {
    assert.ok(top !== null && bottom !== null && top > 30 && bottom < H - 30, `rows ${top}..${bottom}`);
  });

  it('25 px above the top row selects C01 with a cranial clamp', () => {
    const { hit, model } = click(x, top - 25);
    assert.equal(hit, null, 'the click must miss the mesh');
    assert.ok(model.ok);
    assert.equal(parse(model.address).anchors[0], 'C01');
    const n = clampNotice(model);
    assert.ok(n, 'a clamped notice is shown');
    assert.match(n.notes.join(' '), /cranial/);
  });

  it('25 px below the bottom row selects S01 with a caudal clamp', () => {
    const { hit, model } = click(x, bottom + 25);
    assert.equal(hit, null);
    assert.equal(parse(model.address).anchors[0], 'S01');
    const n = clampNotice(model);
    assert.ok(n);
    assert.match(n.notes.join(' '), /caudal/);
  });

  it('beside the trunk is clamped to the surface, not silently projected', () => {
    let side = null;
    for (let px = W / 2; px < W; px += 4) {
      if (!click(px, (top + bottom) / 2).hit) { side = px + 25; break; }
    }
    const { hit, model } = click(side, (top + bottom) / 2);
    assert.equal(hit, null);
    assert.ok(clampNotice(model), 'a lateral miss is a clamp too');
  });
});

describe('the encoder flags survive selection, and only a click carries them', () => {
  it('a replayed address is never a clamp', () => {
    const { click, viewer } = scene();
    const { top } = modelRows(click, W / 2);
    const clicked = click(W / 2, top - 25).model;
    assert.ok(clampNotice(clicked));
    const replayed = viewer.select(clicked.address);
    assert.equal(clampNotice(replayed), undefined);
  });

  it('a click on the model does not raise a spurious clamp', () => {
    const { click } = scene();
    let hits = 0;
    const clamped = [];
    for (let y = 0; y < H; y += 18) {
      for (let x = 0; x < W; x += 18) {
        const r = click(x, y);
        if (!r.hit) continue;
        hits += 1;
        if (clampNotice(r.model)) clamped.push([x, y, r.model.address, clampNotice(r.model).notes]);
      }
    }
    assert.ok(hits > 150, `hits ${hits}`);
    assert.deepEqual(clamped.slice(0, 5), [], `${clamped.length} of ${hits} on-model clicks clamped`);
  });
});
