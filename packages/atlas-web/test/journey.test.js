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
import { ATLASES, DEFAULT_LABELS, decodeView, encodeView, viewHref } from '../src/viewer/deeplink.js';
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

/**
 * The other half of that rule: not switching is not enough.
 *
 * DOG-75. The viewer reported `elsewhere` and left `state.atlas` alone, and
 * then handed the shell a mesh and a set of millimetres from the other
 * template anyway — so the brain cell was drawn in the body scene and the body
 * camera flew to brain coordinates, under a panel saying the view had not
 * changed. The selection was also unlinkable, which is the one thing that
 * could have argued for switching instead.
 *
 * These are state-machine tests on purpose. The draw and the fly both key off
 * `model.cell`, so the guard has to be in the object the §7 journey measures,
 * not in the shell where only a browser could see it.
 */
describe('a cross-atlas selection is shown, but never drawn here', () => {
  it('withholds the geometry of an address that lives in the other atlas', () => {
    const v = viewer();
    const model = v.select('BV-L-471');

    assert.ok(model.ok, 'it still resolves');
    assert.equal(model.elsewhere, 'brain');
    assert.equal(model.cell, null, 'there is no mesh to put in the body scene');
    assert.equal(model.extentMm, null);
    assert.equal(model.pointMm, null);
    assert.equal(model.templateId, null, 'the body view is not drawn by the brain template');

    // Withheld from the view, not discarded: the panel reports it as the
    // brain atlas's answer, and the address and its names stand.
    assert.equal(model.elsewhereCell.atlas, 'brain');
    assert.ok(model.elsewhereCell.extentMm.every((n) => Number.isFinite(n) && n > 0));
    assert.ok(model.elsewhereCell.pointMm.every(Number.isFinite));
    assert.ok(model.elsewhereCell.cell, 'the brain atlas can still draw it');
    assert.equal(model.address, 'BV-L-471');
    assert.ok(model.names, 'and it is still named, or says why it is not');
  });

  it('keeps an in-atlas selection fully placed, so the guard is not blanket', () => {
    // Without this, withholding everything from every selection would pass the
    // test above and break the viewer.
    const v = viewer();
    const model = v.select('BD-T07-03O');
    assert.equal(model.elsewhere, null);
    assert.equal(model.elsewhereCell, null);
    assert.ok(model.cell);
    assert.ok(model.extentMm.every(Number.isFinite));
    assert.ok(model.templateId);
  });

  it('does not move the camera, because there is nothing to fly to', () => {
    const v = viewer();
    v.setCamera({ yaw: 0.2, pitch: -0.1, distance: 640, target: [4, 5, 6] });
    const before = JSON.parse(JSON.stringify(v.cameraOf('body')));

    const model = v.select('BV-L-471');
    // The shell flies with `if (fly && model.cell)`; this is that condition.
    assert.equal(model.cell, null, 'the shell would fly if a cell came back');
    assert.deepEqual(v.cameraOf('body'), before, 'the body camera must not move');
  });

  it('is in the URL, with the atlas it was selected under', () => {
    const v = viewer();
    v.setCamera({ yaw: 0, pitch: 0, distance: 500, target: [0, 0, 0] });
    v.select('BV-L-471');

    const view = v.toView();
    assert.equal(view.atlas, 'body');
    assert.equal(view.address, 'BV-L-471', 'the view is showing it, so the view carries it');
    const params = new URLSearchParams(encodeView(view));
    assert.equal(params.get('a'), 'BV-L-471');
    // Stated rather than implied: `atlas` is the default here, and a bare
    // `?a=BV-…` would leave which atlas it reopens in up to a rule.
    assert.equal(params.get('atlas'), 'body');
  });

  it('says nothing about the atlas when the address implies it', () => {
    // The anti-vacuity half of the line above: `atlas=` is emitted for the
    // view that needs it, not pinned onto every link.
    const v = viewer();
    v.select('BD-T07-03O');
    assert.equal(v.toView().atlasExplicit, false);
    assert.equal(new URLSearchParams(encodeView(v.toView())).get('atlas'), null);
  });

  it('restores from its own link, offer and all', () => {
    const v = viewer();
    v.setCamera({ yaw: 0.3, pitch: 0.1, distance: 500, target: [1, 2, 3] });
    v.setLayerHidden('cervical', true);
    v.select('BV-L-471');
    const link = encodeView(v.toView());

    const other = viewer();
    const decoded = decodeView(link);
    assert.deepEqual(decoded.problems, []);
    other.applyView(decoded.view, decoded.problems);

    assert.equal(other.atlas, 'body', 'the link said body, so it opens in the body atlas');
    assert.equal(other.state.selection.address, 'BV-L-471');
    assert.equal(other.state.selection.elsewhere, 'brain', 'and it still offers the move');
    assert.equal(other.state.selection.cell, null, 'and still draws nothing here');
    assert.deepEqual(other.toView(), v.toView());
    assert.equal(encodeView(other.toView()), link, 'and the link it then shows is the same link');
  });

  it('hands the address to the other atlas only when the offer is accepted', () => {
    const v = viewer();
    v.select('BV-L-471');
    // Not filed under the brain atlas yet: it is the body atlas that is
    // showing this address, and the brain atlas may have a view of its own.
    assert.equal(v.state.address.brain, null);
    assert.equal(v.state.address.body, 'BV-L-471');

    v.openAtlas('brain');
    assert.equal(v.atlas, 'brain');
    const model = v.state.selection;
    assert.equal(model.address, 'BV-L-471', 'accepting the offer lands on the cell it offered');
    assert.equal(model.elsewhere, null, 'which is no longer elsewhere');
    assert.ok(model.cell, 'and is drawn, here, where the geometry is');
    assert.ok(model.extentMm.every(Number.isFinite));
  });

  it('does not lose the brain atlas"s own view to an unaccepted offer', () => {
    const v = viewer();
    v.openAtlas('brain');
    v.select('BV-R-205');
    v.returnToPrevious();

    v.select('BV-L-471');
    assert.equal(v.atlas, 'body');
    assert.equal(v.state.address.brain, 'BV-R-205', 'the brain atlas still remembers its own');
  });

  it('brings the cross-atlas view back on the return trip', () => {
    const v = viewer();
    v.setCamera({ yaw: 0.4, pitch: -0.2, distance: 720, target: [7, 8, 9] });
    v.select('BV-L-471');
    const left = JSON.parse(JSON.stringify(v.toView()));

    v.openAtlas('brain');
    assert.equal(v.returnToPrevious(), 'body');

    assert.deepEqual(v.toView(), left, 'the body atlas was showing that address when we left it');
    assert.equal(v.state.selection.elsewhere, 'brain', 'and says so again');
    assert.equal(v.state.selection.cell, null);
  });

  it('is the same rule mirrored: a body address in the brain atlas', () => {
    const v = viewer();
    v.openAtlas('brain');
    v.setCamera({ yaw: 0, pitch: 0, distance: 300, target: [0, 0, 0] });
    const before = JSON.parse(JSON.stringify(v.cameraOf('brain')));

    const model = v.select('BD-T07-03O');
    assert.equal(v.atlas, 'brain');
    assert.equal(model.elsewhere, 'body');
    assert.equal(model.cell, null);
    assert.deepEqual(v.cameraOf('brain'), before);

    const params = new URLSearchParams(encodeView(v.toView()));
    assert.equal(params.get('a'), 'BD-T07-03O');
    assert.equal(params.get('atlas'), 'brain');
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

    // Labels are part of "what is visible", and off is the state worth
    // carrying: the default is on, so a view that restored the default would
    // pass this step without restoring anything.
    assert.equal(v.labelsOf(), true, 'labels start on');
    assert.equal(v.toggleLabels(), false);
    assert.equal(v.labelsOf(), false);

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

    // 5. Work in the brain atlas: its own camera, its own layers, its own
    // labels. The brain atlas opens with labels on even though we just turned
    // them off in the body — one shared flag would have brought the body's off
    // state here, and then carried this atlas's state home on the way back.
    v.select('BV-L-471');
    v.setCamera({ yaw: -0.9, pitch: 0.4, distance: 310, target: [0, 0, 0] });
    v.setLayerHidden('right', true);
    assert.equal(isLayerVisible(v.layersOf(), 'right'), false);
    assert.equal(v.labelsOf(), true, 'the brain atlas has its own label state');
    v.setLabels(false);

    // 6. Return to the body with the previous view intact.
    assert.equal(v.returnToPrevious(), 'body');
    assert.equal(v.atlas, 'body');
    assert.deepEqual(v.toView(), bodyView, 'the return must restore what we left');
    assert.equal(v.labelsOf(), false, 'label visibility is restored with the rest of the view');
    assert.equal(v.canReturn, false);

    // The brain atlas still remembers its own state for next time.
    assert.equal(isLayerVisible(v.layersOf('brain'), 'right'), false);
    assert.equal(v.labelsOf('brain'), false);
  });

  it('restores labels that were ON when the view was left', () => {
    // The mirror of the step above. Restoring the default always looks right,
    // so the facet has to be checked from both sides: here the body is left
    // with labels on and the brain is the atlas whose labels go off.
    const v = viewer();
    assert.equal(v.labelsOf('body'), true);
    v.openAtlas('brain');
    v.setLabels(false);
    assert.equal(v.returnToPrevious(), 'body');
    assert.equal(v.labelsOf(), true, 'the body atlas was left with labels on');
    assert.equal(v.toView().labels, true);
  });

  it('toggling labels changes nothing else about the view', () => {
    const v = viewer();
    v.setCamera({ yaw: 0.3, pitch: -0.2, distance: 700, target: [1, 2, 3] });
    v.setLayerHidden('sacral', true);
    v.setLayerOpacity('spine', 0.4);
    const selected = v.select('BD-T07-03O');
    const before = JSON.parse(JSON.stringify(v.toView()));

    v.setLabels(false);
    const after = v.toView();
    assert.equal(after.labels, false);
    // Annotation, not navigation and not selection.
    assert.deepEqual(after.camera, before.camera);
    assert.deepEqual(after.layers, before.layers);
    assert.equal(after.atlas, before.atlas);
    assert.equal(after.address, before.address);
    assert.equal(v.state.selection, selected, 'the selection object itself must be untouched');
  });

  it('refuses to set labels on an atlas that does not exist', () => {
    const v = viewer();
    assert.throws(() => v.setLabels(false, 'liver'), /unknown atlas/);
    assert.equal(v.labelsOf('body'), true, 'and changes nothing on the way out');
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

  it('carries label visibility, and only when it is not the default', () => {
    assert.equal(DEFAULT_LABELS, true, 'the rest of this test is written against on-by-default');
    // Unstated is the default, not off: a view object built before labels were
    // a facet must not encode as a request to hide them.
    assert.equal(encodeView({ atlas: 'body', address: null }), '');
    assert.equal(encodeView({ atlas: 'body', address: null, labels: true }), '');
    assert.equal(encodeView({ atlas: 'body', address: null, labels: false }), 'labels=0');

    assert.equal(decodeView('').view.labels, true);
    assert.equal(decodeView('labels=0').view.labels, false);
    assert.equal(decodeView('labels=false').view.labels, false);
    assert.equal(decodeView('labels=1').view.labels, true);
    assert.equal(decodeView('labels=true').view.labels, true);
  });

  it('says what it rejected in labels=, and keeps the rest of the link', () => {
    // "0" is truthy as a string, so a decoder written on truthiness would read
    // labels=0 as ON. That is the one spelling a hand-written link will use.
    const { view, problems } = decodeView('a=BD-T07-03O&labels=maybe');
    assert.equal(view.address, 'BD-T07-03O');
    assert.equal(view.labels, DEFAULT_LABELS, 'an unusable value falls back to the default');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /labels=/);
  });

  it('round-trips labels off through the state machine, per atlas', () => {
    const v = viewer();
    v.setLabels(false);
    const link = encodeView(v.toView());
    assert.match(link, /labels=0/);

    const restored = viewer();
    const decoded = decodeView(link);
    restored.applyView(decoded.view, decoded.problems);
    assert.equal(restored.labelsOf(), false, 'the link has to restore the facet it carries');
    assert.deepEqual(restored.toView(), v.toView());
    // The atlas the link did not name is untouched, so following a body link
    // does not reach into the brain atlas's state.
    assert.equal(restored.labelsOf('brain'), true);
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
      'labels=', 'labels=0,1', 'labels=' + 'z'.repeat(200), 'labels=2', 'labels=TRUE',
      'labels=null', 'labels=undefined', 'labels=-0',
    ];
    for (const search of hostile) {
      const { view, problems } = decodeView(search);
      assert.ok(ATLASES.includes(view.atlas), `${search} must yield a known atlas`);
      assert.equal(typeof view.labels, 'boolean', `${search} produced a non-boolean labels`);
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
