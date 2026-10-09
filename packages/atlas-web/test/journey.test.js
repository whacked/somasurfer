/**
 * The DOG-1 §7 journey, and the deep-link round trip, driven through the state
 * machine with no browser.
 *
 * The journey is one test with ordered steps rather than several independent
 * ones, because what it is actually asserting is that state *survives* across
 * steps — a per-step test that rebuilds the viewer each time cannot catch a
 * return path that loses the camera.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fitCamera, flyToCell, pan, rotate, zoom } from '../src/viewer/camera.js';
import { ATLASES, decodeView, encodeView, viewHref } from '../src/viewer/deeplink.js';
import {
  atlasForAddress,
  atlasForFrame,
  createViewer,
  isLayerVisible,
  layerOpacity,
} from '../src/viewer/state.js';
import { bodySurfaceMesh, meshBounds } from '../src/viewer/template.js';
import { nameIndex, templates } from './support.js';

const viewer = () => createViewer({ templates: templates(), nameIndex: nameIndex() });

describe('selection never switches the atlas', () => {
  it('keeps the body atlas when a brain address is selected', () => {
    const v = viewer();
    assert.equal(v.atlas, 'body');
    const model = v.select('BV-L-471');
    assert.ok(model.ok);
    assert.equal(v.atlas, 'body', 'selecting must never move the atlas');
    assert.equal(model.elsewhere, 'brain', 'it reports where the address lives');
  });

  it('keeps the brain atlas when a body address is selected', () => {
    const v = viewer();
    v.openAtlas('brain');
    v.select('BD-T07-03O');
    assert.equal(v.atlas, 'brain');
    assert.equal(v.state.selection.elsewhere, 'body');
  });

  it('reports elsewhere as null for an address in the current atlas', () => {
    const v = viewer();
    assert.equal(v.select('BD-T07-03O').elsewhere, null);
  });

  it('maps frames to atlases without selecting', () => {
    assert.equal(atlasForFrame('BD'), 'body');
    assert.equal(atlasForFrame('BV'), 'brain');
    assert.equal(atlasForFrame('BR'), 'brain');
    assert.equal(atlasForAddress('BD-T07-03O'), 'body');
    assert.equal(atlasForAddress('not an address'), null);
  });

  it('leaves the atlas and the camera alone when an address is rejected', () => {
    const v = viewer();
    v.select('BD-T07-03O');
    v.setCamera({ yaw: 1.25, pitch: 0.3, distance: 900, target: [1, 2, 3] });
    const before = JSON.stringify(v.toView());

    const rejected = v.select('BD-C08-03O');
    assert.equal(rejected.ok, false);
    assert.equal(v.atlas, 'body');
    // The only thing that moved is `selection`, which now holds the message.
    const after = JSON.stringify(v.toView());
    assert.equal(after, before, 'a rejection must change nothing but the message');
  });
});

describe('the §7 journey', () => {
  it('runs end to end and comes back with the previous view intact', () => {
    const v = viewer();
    const body = bodySurfaceMesh(templates().body);
    const bounds = meshBounds(body);

    // 1. Default body view.
    assert.equal(v.atlas, 'body');
    v.setCamera(fitCamera(bounds));
    assert.ok(v.cameraOf('body').distance > 0);

    // 2. Change layers: hide the cervical region, dim the spine, isolate.
    v.setLayerHidden('cervical', true);
    v.setLayerOpacity('spine', 0.35);
    assert.equal(isLayerVisible(v.layersOf(), 'cervical'), false);
    assert.equal(isLayerVisible(v.layersOf(), 'thoracic'), true);
    assert.equal(layerOpacity(v.layersOf(), 'spine'), 0.35);

    v.isolate('thoracic');
    assert.equal(isLayerVisible(v.layersOf(), 'thoracic'), true);
    assert.equal(isLayerVisible(v.layersOf(), 'lumbar'), false);
    v.isolate(null);
    // Isolate is reversible and non-destructive: the hidden set is intact.
    assert.equal(isLayerVisible(v.layersOf(), 'lumbar'), true);
    assert.equal(isLayerVisible(v.layersOf(), 'cervical'), false);

    // 3. Select a structure WITHOUT leaving the atlas.
    const selected = v.select('BD-T07-03O');
    assert.ok(selected.ok);
    assert.equal(v.atlas, 'body');
    assert.ok(selected.names.matches.length > 1);
    v.setCamera(flyToCell(v.cameraOf(), meshBounds(selected.cell)));

    const bodyView = JSON.parse(JSON.stringify(v.toView()));

    // 4. Explicit brain navigation.
    assert.equal(v.canReturn, false);
    v.openAtlas('brain');
    assert.equal(v.atlas, 'brain');
    assert.equal(v.canReturn, true);
    assert.equal(v.returnTarget, 'body');

    // 5. Work in the brain atlas: its own camera and its own layers.
    v.select('BV-L-471');
    v.setCamera({ yaw: -0.9, pitch: 0.4, distance: 310, target: [0, 0, 0] });
    v.setLayerHidden('right', true);
    assert.equal(isLayerVisible(v.layersOf(), 'right'), false);

    // 6. Return to the body with the previous view intact.
    assert.equal(v.returnToPrevious(), 'body');
    assert.equal(v.atlas, 'body');
    assert.deepEqual(v.toView(), bodyView, 'the return must restore what we left');
    assert.equal(v.canReturn, false);

    // The brain atlas still remembers its own state for next time.
    assert.equal(isLayerVisible(v.layersOf('brain'), 'right'), false);
  });

  it('restores the view we left, not the atlas"s current state', () => {
    const v = viewer();
    v.setCamera({ yaw: 0.1, pitch: 0.1, distance: 500, target: [0, 0, 0] });
    v.setLayerHidden('lumbar', true);
    const left = JSON.parse(JSON.stringify(v.toView()));

    v.openAtlas('brain');
    // Reach back and mutate the body atlas while we are away. The snapshot
    // must win, otherwise "restores the previous state" means nothing.
    v.setCamera({ yaw: 9, pitch: 0.2, distance: 123, target: [9, 9, 9] }, 'body');

    v.returnToPrevious();
    assert.deepEqual(v.toView(), left);
  });
});

describe('deep links round-trip every view', () => {
  it('is canonical and idempotent', () => {
    const view = {
      atlas: 'brain',
      address: 'BV-L-471',
      camera: { yaw: 0.5, pitch: -0.25, distance: 420, target: [1, 2, 3] },
      layers: { hidden: ['right'], isolated: null, opacity: { left: 0.4 } },
    };
    const once = encodeView(view);
    const twice = encodeView(decodeView(once).view);
    assert.equal(twice, once);
    assert.equal(encodeView(decodeView(twice).view), once);
  });

  it('omits defaults, so the entry view is a bare URL', () => {
    assert.equal(encodeView({ atlas: 'body', address: null }), '');
    assert.equal(viewHref({ atlas: 'body', address: null }, '/atlas/'), '/atlas/');
  });

  it('restores the same view through the state machine, across the atlas round trip', () => {
    const v = viewer();
    v.openAtlas('brain');
    v.select('BV-L-471');
    v.setCamera({ yaw: -0.9, pitch: 0.4, distance: 310, target: [2, 0, -4] });
    v.setLayerHidden('right', true);
    v.setLayerOpacity('left', 0.6);

    const link = encodeView(v.toView());
    const restored = viewer();
    const decoded = decodeView(link);
    restored.applyView(decoded.view, decoded.problems);

    assert.deepEqual(restored.toView(), v.toView());
    assert.equal(restored.atlas, 'brain');
    assert.equal(encodeView(restored.toView()), link);
  });

  it('round-trips every atlas and a representative address in each', () => {
    for (const [atlas, address] of [['body', 'BD-T07-03O-531'], ['brain', 'BV-L-471']]) {
      const v = viewer();
      if (atlas !== 'body') v.openAtlas(atlas);
      v.select(address);
      v.setCamera({ yaw: 0.25, pitch: -0.1, distance: 640, target: [0, 1, -2] });
      const link = encodeView(v.toView());
      const back = decodeView(link);
      const other = viewer();
      other.applyView(back.view, back.problems);
      assert.deepEqual(other.toView(), v.toView(), `${atlas} ${address} must round-trip`);
    }
    assert.deepEqual([...ATLASES], ['body', 'brain']);
  });

  it('validates an address out of a URL through parse(), like a pasted one', () => {
    const v = viewer();
    const { view, problems } = decodeView('a=BD-C08-03O');
    assert.deepEqual(problems, []);
    v.applyView(view, problems);
    assert.equal(v.state.selection.ok, false);
    assert.equal(v.state.selection.notices[0].code, 'rejected');
    // A rejected address does not become the view's address.
    assert.equal(v.toView().address, null);
  });

  it('keeps the address when the camera is malformed, and says what it dropped', () => {
    const { view, problems } = decodeView('a=BD-T07-03O&cam=notanumber');
    assert.equal(view.address, 'BD-T07-03O');
    assert.equal(view.camera.distance, 0);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /camera/);
  });

  it('never throws and never yields NaN on hostile input', () => {
    const hostile = [
      '', '?', 'a=', 'a=' + 'x'.repeat(200), 'cam=1,2,3', 'cam=NaN,NaN,NaN,NaN,NaN,NaN',
      'atlas=../../etc', 'hide=a,,b,<script>', 'iso=' + 'y'.repeat(80), 'op=left:9',
      'op=:0.5', 'op=left:', 'cam=0,0,-5,0,0,0', '%%%',
    ];
    for (const search of hostile) {
      const { view, problems } = decodeView(search);
      assert.ok(ATLASES.includes(view.atlas), `${search} must yield a known atlas`);
      for (const n of [view.camera.yaw, view.camera.pitch, view.camera.distance]) {
        assert.ok(Number.isFinite(n), `${search} produced a non-finite camera`);
      }
      assert.ok(view.camera.target.every(Number.isFinite));
      assert.ok(Array.isArray(problems));
      // And it must re-encode to something that decodes to the same thing.
      assert.equal(encodeView(decodeView(encodeView(view)).view), encodeView(view));
    }
  });

  it('caps an over-long address before it reaches the viewer', () => {
    const { view, problems } = decodeView(`a=${'B'.repeat(65)}`);
    assert.equal(view.address, null);
    assert.match(problems[0], /longer than 64/);
  });
});

describe('camera controls', () => {
  const base = { yaw: 0, pitch: 0, distance: 500, target: [0, 0, 0] };
  const bounds = { centre: [0, 0, 0], radius: 400, lo: [], hi: [] };

  it('rotates, and clamps pitch short of the poles', () => {
    assert.equal(rotate(base, 0.5, 0).yaw, 0.5);
    assert.ok(Math.abs(rotate(base, 0, 99).pitch) < Math.PI / 2);
    assert.ok(Math.abs(rotate(base, 0, -99).pitch) < Math.PI / 2);
  });

  it('zooms multiplicatively within the scene', () => {
    assert.equal(zoom(base, 0.5, bounds).distance, 250);
    assert.ok(zoom(base, 1e9, bounds).distance <= bounds.radius * 40);
    assert.ok(zoom(base, 1e-9, bounds).distance >= bounds.radius * 0.05);
  });

  it('pans the target without changing orientation or distance', () => {
    const panned = pan(base, 0.1, 0.1);
    assert.equal(panned.yaw, base.yaw);
    assert.equal(panned.distance, base.distance);
    assert.notDeepEqual(panned.target, base.target);
  });

  it('reset reframes the subject, and is the same every time', () => {
    assert.deepEqual(fitCamera(bounds), fitCamera(bounds));
    assert.ok(fitCamera(bounds).distance > bounds.radius);
  });

  it('flies to a cell without re-orienting, and stops zooming at a floor', () => {
    const tiny = { centre: [10, 20, 30], radius: 0.2, lo: [], hi: [] };
    const flown = flyToCell(base, tiny);
    assert.deepEqual(flown.target, [10, 20, 30]);
    assert.equal(flown.yaw, base.yaw, 'orientation is preserved on a fly-to');
    assert.ok(flown.distance > 20, 'a sub-millimetre cell must not put the camera inside the body');
  });
});
