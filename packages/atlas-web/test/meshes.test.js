/**
 * The W4 mesh layer (DOG-129) against the asset sets the build ships.
 *
 * Read off disk as data, the way real-assets.test.js reads the templates: the
 * build may not parse assets, a test may. What is asserted is what the page
 * relies on — each declared set decodes into the atlas's own world, every
 * structure W8a samples is pickable by name, layers act on two axes without
 * breaking the v1 ids, and the selected structure survives a link.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readMeshBin as gateReader } from '../../../tools/lib/meshbin.mjs';
import { ASSET_MESH_SETS } from '../catalogue/asset-meshes.mjs';
import { encodeBrainVolume } from '../src/alc.js';
import { readMeshBin } from '../src/viewer/atlm.js';
import { decodeView, encodeView } from '../src/viewer/deeplink.js';
import { BANDS, boundsOfStructures, meshSetFrom, nextPick, pickStructure, pickStructures, searchStructures, withheldOf } from '../src/viewer/meshset.js';
import { ATLAS_LAYERS, createViewer, isLayerVisible, structureLayers } from '../src/viewer/state.js';
import { validateBrainVolumeTemplate } from '../src/viewer/template.js';
import { ASSETS, REPO_ROOT } from './real-assets.js';

const json = (rel) => JSON.parse(readFileSync(join(ASSETS, rel), 'utf8'));
const bodyTemplate = json('templates/bp3d-4.0-adult-body-centroid.body.json');
const brainTemplate = json('templates/icbm152-2009c-asym.brain-volume.json');

const cache = new Map();
/** One declared set at one tier, decoded as the page decodes it. */
function decoded(id, tier = 'low') {
  const key = `${id}/${tier}`;
  if (!cache.has(key)) {
    const entry = ASSET_MESH_SETS.find((e) => e.id === id);
    const docs = {
      structures: json(entry.structures),
      labels: entry.labels ? json(entry.labels) : null,
      registration: entry.registration ? json(entry.registration) : null,
    };
    const bytes = readFileSync(join(ASSETS, docs.structures.tiers[tier].file));
    cache.set(key, meshSetFrom(entry, docs, bytes, bodyTemplate));
  }
  return cache.get(key);
}

const ZA = 'zanatomy-2929e94';
const ICBM = 'icbm152-2009c';
const BODY = 'bp3d-4066585';

/**
 * A ray from above at one of the structure's own triangles: the one facing
 * most nearly up, so the ray cannot graze it. A ray at a thin artery's box
 * centre can miss the artery, and proves nothing about picking.
 */
function rayAt(mesh, s) {
  const P = mesh.positions;
  let best = null;
  for (let i = s.firstTriangle * 3; i < (s.firstTriangle + s.triangleCount) * 3; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => mesh.triangles[i + k] * 3);
    const e1 = [0, 1, 2].map((d) => P[b + d] - P[a + d]);
    const e2 = [0, 1, 2].map((d) => P[c + d] - P[a + d]);
    const nz = Math.abs(e1[0] * e2[1] - e1[1] * e2[0]) / (Math.hypot(...e1) * Math.hypot(...e2) || 1);
    if (!best || nz > best.nz) best = { nz, at: [0, 1, 2].map((d) => (P[a + d] + P[b + d] + P[c + d]) / 3) };
  }
  return { origin: [best.at[0], best.at[1], s.hi[2] + 50], direction: [0, 0, -1] };
}

describe('mesh sets, decoded the way the page decodes them', () => {
  it('reads ATLM through the one reader the gates also use', () => {
    // A second reader that agreed today would drift the first time the format
    // moved, and the perf gate would go on measuring the one the page dropped.
    assert.equal(gateReader, readMeshBin);
  });

  it('declares only files the asset package ships, one atlas each', () => {
    for (const entry of ASSET_MESH_SETS) {
      assert.ok(['body', 'brain'].includes(entry.atlas), entry.id);
      for (const key of ['structures', 'labels', 'registration']) {
        if (entry[key]) assert.doesNotThrow(() => json(entry[key]), `${entry.id} ${key}`);
      }
    }
  });

  it('places the ICBM cortex natively inside the BV template box', () => {
    // Native MNI and the BV template's own space: if a transform crept in, the
    // surface would leave the box the frame addresses.
    const b = boundsOfStructures(decoded(ICBM).structures);
    const e = brainTemplate.extents;
    assert.ok(b.lo[0] >= -e.right - 1 && b.hi[0] <= e.left + 1, `x ${b.lo[0]}..${b.hi[0]}`);
    assert.ok(b.lo[1] >= -e.posterior - 1 && b.hi[1] <= e.anterior + 1, `y ${b.lo[1]}..${b.hi[1]}`);
    assert.ok(b.lo[2] >= -e.inferior - 1 && b.hi[2] <= e.superior + 1, `z ${b.lo[2]}..${b.hi[2]}`);
  });

  it('carries the Z-Anatomy set into MNI through W2\'s affine, left on the left', () => {
    const za = decoded(ZA).structures;
    const caudate = za.filter((s) => s.label === 'Caudate nucleus');
    assert.equal(caudate.length, 2);
    for (const s of caudate) {
      // MNI is RAS: left is negative x. The mesh frame's +x is the model's
      // left, so a missing or transposed affine puts these on the wrong side.
      assert.ok(s.side === 'left' ? s.centre[0] < -5 : s.centre[0] > 5, `${s.name} at x ${s.centre[0]}`);
      // Deep grey sits within a few centimetres of the anterior commissure.
      assert.ok(Math.hypot(...s.centre) < 50, `${s.name} at ${s.centre}`);
    }
  });

  it('says on every Z-Anatomy structure how far its placement is from the anatomy', () => {
    const errorMm = Math.max(...json('registration/mni-to-zanatomy-2929e94.json').heldOut.map((h) => h.errorMm));
    for (const s of decoded(ZA).structures) assert.equal(s.placedBy?.errorMm, errorMm, s.name);
    for (const s of decoded(ICBM).structures) assert.equal(s.placedBy, undefined, s.name);
  });

  it('splits the cortex into its six lobes per hemisphere and names the rest for what it is', () => {
    const icbm = decoded(ICBM).structures;
    const lobes = icbm.filter((s) => s.lobe);
    assert.equal(lobes.length, 12);
    for (const side of ['left', 'right']) {
      assert.deepEqual(
        lobes.filter((s) => s.side === side).map((s) => s.label).sort(),
        ['Frontal lobe', 'Insula', 'Limbic lobe', 'Occipital lobe', 'Parietal lobe', 'Temporal lobe'],
      );
    }
    // The medial wall and cut faces are not cortex, and the lobe file says so;
    // calling them "Cerebral cortex" would name a cut as anatomy.
    const rest = icbm.filter((s) => !s.lobe);
    assert.equal(rest.length, 2);
    for (const s of rest) assert.match(s.title, /^Not cortex/);
    // Every triangle of the file lands in exactly one structure.
    const file = readMeshBin(readFileSync(join(ASSETS, json('brain/icbm152-2009c/structures.json').tiers.low.file)));
    assert.equal(icbm.reduce((n, s) => n + s.triangleCount, 0), file.indexCount / 3);
  });

  it('lays each set out by layer, so a layer is one run of triangles', () => {
    for (const id of [ZA, ICBM, BODY]) {
      const seen = new Set();
      let previous = null;
      for (const s of decoded(id).structures) {
        if (s.group !== previous) {
          assert.ok(!seen.has(s.group), `${id}: group ${s.group} is split`);
          seen.add(s.group);
          previous = s.group;
        }
      }
    }
  });

  it('decodes the full tier into the same structures as the low tier', () => {
    for (const id of [ZA, BODY]) {
      const low = decoded(id, 'low').structures.map((s) => s.key).sort();
      const full = decoded(id, 'full').structures.map((s) => s.key).sort();
      assert.deepEqual(full, low, id);
    }
  });

  it('gives the skin every body band, so hiding one region does not hide it', () => {
    const skin = decoded(BODY).structures.find((s) => s.name === 'Skin');
    assert.deepEqual(skin.parts, BANDS);
    const v = createViewer();
    v.setLayerHidden('sacral', true);
    assert.equal(structureLayers(v.layersOf(), skin).visible, true);
    for (const band of BANDS) v.setLayerHidden(band, true);
    assert.equal(structureLayers(v.layersOf(), skin).visible, false);
  });

  it('assigns a shin below the sacrum, a femur from the hip down, and a vertebra to its own region', () => {
    const body = decoded(BODY).structures;
    assert.deepEqual(body.find((s) => s.name === 'Left tibia').parts, ['caudal']);
    // The femoral head sits beside the sacrum, so the femur spans both.
    assert.deepEqual(body.find((s) => s.name === 'Left femur').parts, ['sacral', 'caudal']);
    const t7 = body.find((s) => /seventh thoracic vertebra/i.test(s.name));
    assert.ok(t7, 'a seventh thoracic vertebra ships');
    assert.deepEqual(t7.parts, ['thoracic']);
  });
});

describe('picking', () => {
  const sample = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'atlas-qa', 'fixtures', 'brain-structure-sample.json'), 'utf8'));
  const za = decoded(ZA);

  it('returns the name of each of the 40 W8a sample structures', () => {
    assert.equal(sample.sample.length, 40);
    for (const want of sample.sample) {
      const s = za.structures.find((x) => x.id === want.id);
      assert.ok(s, `${want.name} is drawn`);
      const { origin, direction } = rayAt(za, s);
      const hit = pickStructure([za], origin, direction, (x) => x.key === s.key);
      assert.ok(hit, `a ray at ${want.name} hits it`);
      assert.equal(hit.structure.label, want.expect.name);
      assert.ok(hit.structure.title.startsWith(want.expect.name), hit.structure.title);
    }
  });

  it('reaches every W8a sample structure by clicking one spot again, enclosed or not (DOG-192)', () => {
    // The page's own filter at the brain's opening layers, over both brain sets.
    const icbm = decoded(ICBM);
    const v = createViewer();
    v.openAtlas('brain');
    const layers = v.layersOf();
    const accept = (s) => {
      const { visible, opacity } = structureLayers(layers, s);
      return visible && opacity >= 0.5;
    };
    const enclosed = [];
    for (const want of sample.sample) {
      const s = za.structures.find((x) => x.id === want.id);
      const { origin, direction } = rayAt(za, s);
      const hits = pickStructures([za, icbm], origin, direction, accept);
      let picked = nextPick(hits);
      let clicks = 1;
      while (picked.structure.key !== s.key && clicks <= hits.length) {
        picked = nextPick(hits, { again: true, current: picked.structure.key });
        clicks += 1;
      }
      assert.equal(picked.structure.key, s.key, `${want.name} is under the pointer and a click again reaches it`);
      assert.deepEqual(picked.pointMm, [0, 1, 2].map((a) => origin[a] + direction[a] * picked.t), 'its address is from its own surface');
      if (clicks > 1) enclosed.push(want.id);
    }
    // W8a found four: the EW nuclei (6, 7) inside the midbrain, the hippocampi
    // (122, 123) inside the ICBM lobes. The DOG-238 redraw kept the hippocampi.
    const known = [6, 7, 122, 123].filter((id) => sample.sample.some((x) => x.id === id));
    assert.ok(known.length > 0, 'the sample keeps a structure W8a found enclosed');
    for (const id of known) assert.ok(enclosed.includes(id), `fixture ${id} is not the nearest hit, so needs the click again`);
  });

  it('cycles through the hits, deepest back to nearest', () => {
    const hits = ['a', 'b', 'c'].map((key, t) => ({ structure: { key }, t }));
    assert.equal(nextPick([]), null);
    assert.equal(nextPick(hits, { again: true, current: 'a' }).structure.key, 'b');
    assert.equal(nextPick(hits, { again: true, current: 'c' }).structure.key, 'a', 'wraps');
    assert.equal(nextPick(hits, { again: true, current: 'gone' }).structure.key, 'a', 'a selection not under the pointer starts at the front');
    assert.equal(nextPick(hits, { again: false, current: 'b' }).structure.key, 'a', 'a fresh click is the nearest');
  });

  it('does not draw, so cannot pick, the withheld control', () => {
    for (const control of sample.withheldControls) {
      assert.equal(za.structures.some((s) => s.id === control.id), false, control.name);
    }
  });

  it('finds the withheld control by name and says why, in the shipped file\'s words', () => {
    const entry = ASSET_MESH_SETS.find((e) => e.id === ZA);
    const held = withheldOf(entry, json(entry.structures));
    for (const control of sample.withheldControls) {
      // As a reader types it: `Tentorium cerebelli left`, not the file's `.l`.
      const base = control.name.replace(/\.[lr]$/, '');
      const query = control.side === 'left' || control.side === 'right' ? `${base} ${control.side}` : control.name;
      const [w] = searchStructures(held, query, 4);
      assert.ok(w, `${query} is found as withheld`);
      assert.ok(w.title.includes(base), w.title);
      assert.equal(w.group, control.expect.reason);
      assert.deepEqual(w.reasons, control.expect.heldBecause);
      assert.equal(searchStructures(za.structures, query).some((s) => s.title === w.title), false, 'and is not also offered as drawn');
    }
  });

  it('reads every named exclusion of every set, one entry per name, each with a reason', () => {
    for (const entry of ASSET_MESH_SETS) {
      const doc = json(entry.structures);
      const held = withheldOf(entry, doc);
      const named = (doc.excluded ?? []).filter((x) => typeof x.name === 'string');
      assert.equal(named.length > 0, held.length > 0, `${entry.id} lists what it holds`);
      for (const w of held) assert.ok(w.reasons.length > 0, `${entry.id} ${w.title} has a reason`);
      assert.equal(new Set(held.map((w) => w.title)).size, held.length, `${entry.id} titles are unique`);
    }
    // Not vacuous: the body file holds files that name nothing, which are left
    // out, and the brain file holds all three groups.
    assert.ok(json(ASSET_MESH_SETS.find((e) => e.id === BODY).structures).excluded.some((x) => x.name === null));
    const za = ASSET_MESH_SETS.find((e) => e.id === ZA);
    assert.deepEqual([...new Set(withheldOf(za, json(za.structures)).map((w) => w.group))].sort(),
      ['dundee-cranial-nerves', 'held-by-decision', 'held-outside-cortex', 'zanatomy-undeclared-brain-materials']);
  });

  it('returns the nearest structure the layers admit, not the first one listed', () => {
    const icbm = decoded(ICBM);
    const caudate = za.structures.find((s) => s.name === 'Caudate nucleus.l');
    const origin = [caudate.centre[0], caudate.centre[1], 200];
    const everything = pickStructure([za, icbm], origin, [0, 0, -1]);
    assert.equal(everything.structure.set, ICBM, 'from above, the cortex is in front');

    const v = createViewer();
    v.openAtlas('brain');
    v.setLayerOpacity('cortex', 0.3);
    const layers = v.layersOf();
    const faded = pickStructure([za, icbm], origin, [0, 0, -1], (s) => {
      const { visible, opacity } = structureLayers(layers, s);
      return visible && opacity >= 0.5;
    });
    assert.notEqual(faded.structure.category, 'cortex', 'a cortex faded below half is clicked through');
    assert.ok(faded.t > everything.t);
  });

  it('encodes a brain pick unclamped everywhere but the vessels and nerves', () => {
    // A click goes through encodeBrainVolume, so a pick outside the BV box
    // reads as `clamped` to the user. Only what runs below the box may.
    const bv = validateBrainVolumeTemplate(brainTemplate);
    const outside = new Set(['arteries', 'cranial_nerves', 'veins_sinuses']);
    const clamped = (mesh, s) => {
      const P = mesh.positions;
      const out = [];
      for (let i = s.firstTriangle * 3; i < (s.firstTriangle + s.triangleCount) * 3; i += 1) {
        const v = mesh.triangles[i] * 3;
        const p = [P[v], P[v + 1], P[v + 2]];
        if (encodeBrainVolume(bv, p, bv.maxUsefulDigits).flags.clamped) out.push(p);
      }
      return out;
    };
    // Both tiers: the page draws, and so picks, the full tier once it arrives.
    // The ICBM cortex ships one tier, so the page keeps drawing its low one.
    assert.equal(json(ASSET_MESH_SETS.find((e) => e.id === ICBM).structures).tiers.full, undefined, 'an ICBM full tier would need checking too');
    for (const tier of ['low', 'full']) {
      const zaTier = decoded(ZA, tier);
      let picks = 0;
      for (const mesh of tier === 'low' ? [decoded(ICBM), zaTier] : [zaTier]) {
        for (const s of mesh.structures) {
          if (mesh === zaTier && outside.has(s.category)) continue;
          assert.deepEqual(clamped(mesh, s).slice(0, 1), [], `${tier}: ${s.name} (${s.category})`);
          picks += 1;
        }
      }
      assert.ok(picks > 100, `${tier}: ${picks} structures checked`);
      // The check can see a clamp: an artery runs below the box.
      const arteries = zaTier.structures.filter((s) => s.category === 'arteries');
      assert.ok(arteries.some((s) => clamped(zaTier, s).length > 0), `${tier}: no artery vertex is clamped`);
    }
  });

  it('finds structures by any word of their title', () => {
    assert.deepEqual(searchStructures(za.structures, 'caudate').map((s) => s.title), ['Caudate nucleus (left)', 'Caudate nucleus (right)']);
    assert.deepEqual(searchStructures(decoded(ICBM).structures, 'frontal left').map((s) => s.title), ['Frontal lobe (left)']);
    assert.deepEqual(searchStructures(za.structures, '   '), []);
  });
});

describe('layers on two axes', () => {
  const brainLayer = (id) => ATLAS_LAYERS.brain.find((l) => l.id === id);

  it('keeps the v1 layer ids, so v1 links still mean what they said', () => {
    for (const id of ['left', 'right']) assert.equal(brainLayer(id).axis, 'hemisphere');
    for (const id of ['cervical', 'thoracic', 'lumbar', 'sacral', 'spine']) {
      assert.equal(ATLAS_LAYERS.body.find((l) => l.id === id).axis, 'region');
    }
  });

  it('isolates within one axis, keeping the other', () => {
    const v = createViewer();
    v.openAtlas('brain');
    v.setLayerHidden('right', true);
    v.isolate('cortex');
    const l = v.layersOf();
    assert.equal(isLayerVisible(l, 'cortex'), true);
    assert.equal(isLayerVisible(l, 'deep_grey'), false);
    assert.equal(isLayerVisible(l, 'left'), true, 'isolating a category leaves the hemisphere choice alone');
    assert.equal(isLayerVisible(l, 'right'), false);
  });

  it('shows a midline structure while either hemisphere shows, at the more opaque', () => {
    const v = createViewer();
    v.openAtlas('brain');
    const midline = decoded(ZA).structures.find((s) => s.name === 'Fourth ventricle');
    assert.deepEqual([...midline.parts].sort(), ['left', 'right']);
    v.setLayerHidden('left', true);
    v.setLayerOpacity('right', 0.4);
    assert.deepEqual(structureLayers(v.layersOf(), midline), { visible: true, opacity: 0.4 });
    v.setLayerHidden('right', true);
    assert.equal(structureLayers(v.layersOf(), midline).visible, false);
  });

  it('offers a brain category layer for exactly the categories that ship', () => {
    // A layer with nothing in it is a control that does nothing (DOG-238: the
    // dura is held whole); a shipped category with no layer cannot be hidden.
    const shipped = new Set([ZA, ICBM].flatMap((id) => decoded(id).structures.map((s) => s.category)));
    const offered = ATLAS_LAYERS.brain.filter((l) => l.axis === 'category').map((l) => l.id);
    assert.deepEqual([...offered].sort(), [...shipped].sort());
  });

  it('opens a link naming the retired Dura layer without it, and says so', () => {
    const { view, problems } = decodeView('?atlas=brain&hide=left,meninges_dura&iso=meninges_dura&op=meninges_dura:0.5,right:0.4');
    assert.deepEqual(view.layers, { hidden: ['left'], isolated: null, opacity: { right: 0.4 } });
    assert.equal(problems.length, 3);
    for (const p of problems) assert.match(p, /meninges_dura.*Dura layer is withdrawn/);
  });

  it('multiplies a faded cortex by its hemisphere', () => {
    const v = createViewer();
    v.openAtlas('brain');
    v.setLayerOpacity('cortex', 0.5);
    v.setLayerOpacity('left', 0.5);
    assert.equal(structureLayers(v.layersOf(), { category: 'cortex', parts: ['left'] }).opacity, 0.25);
  });
});

describe('the selected structure is part of the view', () => {
  it('round-trips through the URL as s=', () => {
    const v = createViewer();
    v.openAtlas('brain');
    v.selectStructure('zanatomy-2929e94.49');
    const query = encodeView(v.toView());
    assert.equal(new URLSearchParams(query).get('s'), 'zanatomy-2929e94.49');
    const { view, problems } = decodeView(query);
    assert.deepEqual(problems, []);
    const w = createViewer();
    w.applyView(view);
    assert.equal(w.structureOf(), 'zanatomy-2929e94.49');
  });

  it('refuses a malformed s= and says so, keeping the rest of the link', () => {
    const { view, problems } = decodeView('?a=BD-T07-03O&s=%3Cscript%3E');
    assert.equal(view.structure, null);
    assert.equal(view.address, 'BD-T07-03O');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /s=/);
  });

  it('is left out of a link that selects none, so a v1 link encodes as it did', () => {
    const { view } = decodeView('?a=BV-L-471&atlas=brain&hide=right&op=left:0.6');
    assert.equal(encodeView(view), 'a=BV-L-471&atlas=brain&hide=right&op=left%3A0.6');
  });

  it('is per atlas, and comes back with the view on return', () => {
    const v = createViewer();
    v.selectStructure('bp3d-4066585.7163');
    v.openAtlas('brain');
    assert.equal(v.structureOf(), null, 'the brain has its own selection');
    v.selectStructure('icbm152-2009c.101');
    v.returnToPrevious();
    assert.equal(v.structureOf(), 'bp3d-4066585.7163');
    assert.equal(v.structureOf('brain'), 'icbm152-2009c.101');
  });

  it('moves nothing else when it changes', () => {
    const v = createViewer();
    v.select('BD-T07-03O');
    const before = JSON.stringify({ ...v.toView(), structure: null });
    v.selectStructure('bp3d-4066585.7163');
    assert.equal(JSON.stringify({ ...v.toView(), structure: null }), before);
  });
});
