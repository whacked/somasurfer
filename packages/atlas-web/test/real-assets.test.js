/**
 * Stage B: the viewer against the templates and name index the asset pipeline
 * actually emits.
 *
 * Stage A proved the viewer reads its limits off the template it was handed
 * rather than off a literal. It proved that with synthetic templates whose
 * limits it also chose, which is a weaker claim than it looks: a viewer that
 * happened to hard-code `maxUsefulDigits: 3` would have passed every stage-A
 * precision test, because the fixtures declare 3. The real body template
 * declares **2**, and nothing here states that number as a literal — every
 * assertion reads it from the bound template, so the suite would still be
 * correct if DOG-35 regenerated the template with a different cap.
 *
 * What is new in stage B, and why each part needs real data:
 *
 *   - the name index is TWO documents with two shapes, joined by id;
 *   - the naming contract is FMA, with UBERON as an xref that must never be
 *     readable as an identifier;
 *   - `BD` has 25 levels and no anomalies, so the real template reaches none
 *     of `folded`, `variant` or `absent` on its own;
 *   - `BV` ships with coordinates and no names at all.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ASSET_TEMPLATES, NAME_INDEX_FILES } from '../catalogue/asset-templates.mjs';
import { locate, parse, resolve } from '../src/alc.js';
import { fitCamera, flyToCell } from '../src/viewer/camera.js';
import { decodeView, encodeView } from '../src/viewer/deeplink.js';
import { NOTICE_CODES } from '../src/viewer/flags.js';
import { NameIndexError, joinNameIndex } from '../src/viewer/nameindex.js';
import { demote, selectAddress } from '../src/viewer/select.js';
import { createViewer, isLayerVisible, layerOpacity } from '../src/viewer/state.js';
import {
  bodySurfaceMesh,
  meshBounds,
  validateBodyTemplate,
} from '../src/viewer/template.js';
import {
  ASSETS,
  COVERINGS_FILE,
  NAMES_FILE,
  assetJson,
  realAssets,
  realTemplates,
} from './real-assets.js';
import { sourceFilesOf } from './support.js';

const codesOf = (model) => model.notices.map((n) => n.code);

/** The AABB diagonal of a drawn cell, which is what "how big does it look" means. */
function drawnSize(cell) {
  const b = meshBounds({ positions: cell.positions });
  return Math.hypot(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]);
}

// ---------------------------------------------------------------------------
// 1. Binding
// ---------------------------------------------------------------------------

describe('the real templates bind through the stage-A interface', () => {
  it('validates the real body template with no change to the validator', () => {
    const { body } = realAssets();
    assert.equal(body.id, 'bp3d-4.0-adult-body-centroid');
    assert.equal(body.slabs.length, 25);
    assert.equal(body.slabs[0].label, 'C01');
    assert.equal(body.slabs.at(-1).label, 'S01');
    // Every slab arrived with unit axes and a positive height.
    for (const slab of body.slabs) {
      assert.ok(slab.heightMm > 0, `${slab.label} heightMm`);
      assert.ok(slab.surfaceRadiiMm.length >= 3, `${slab.label} radii`);
      assert.ok(Math.abs(Math.hypot(...slab.axial) - 1) < 1e-9, `${slab.label} axial is a unit vector`);
    }
  });

  it('validates the real brain volume template with no change to the validator', () => {
    const { brainVolume } = realAssets();
    assert.equal(brainVolume.id, 'icbm152-2009c-asym');
    for (const key of ['left', 'right', 'anterior', 'posterior', 'superior', 'inferior']) {
      assert.ok(brainVolume.extents[key] > 0, `extents.${key}`);
    }
  });

  it('declares catalogue ids that match the ids inside the asset files', () => {
    // The build may not read an asset, so the declared id is a claim. This is
    // where the claim is checked: a regenerated template that changed its own
    // id would otherwise leave the catalogue pointing at a file whose caveat
    // and label belong to something else.
    for (const declaration of ASSET_TEMPLATES) {
      assert.equal(assetJson(declaration.file).id, declaration.id, declaration.file);
    }
  });

  it('declares every asset file it advertises, and they all exist', () => {
    for (const file of [...ASSET_TEMPLATES.map((t) => t.file), ...Object.values(NAME_INDEX_FILES)]) {
      assert.doesNotThrow(() => readFileSync(`${ASSETS}/${file}`), file);
    }
  });

  it('keeps every asset path out of src/, so the browser learns them from the catalogue', () => {
    // The boundary `test/real-assets.js` leans on, asserted rather than
    // assumed: a module under src/ that knew an asset path would be a code
    // package reaching for an asset by location instead of by catalogue entry,
    // which is the shape the licence gate's rule 3 exists to keep out.
    const offenders = [];
    for (const file of sourceFilesOf('src')) {
      const text = readFileSync(file, 'utf8');
      // The literal directory name, and any path into the asset package.
      if (/atlas-assets|assets\/(templates|labels|geometry)\//.test(text)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'src/ must not name an asset path');
  });
});

// ---------------------------------------------------------------------------
// 2. The naming contract
// ---------------------------------------------------------------------------

describe('the naming contract is FMA, and UBERON is an xref only', () => {
  it('carries bare FMA concept ids, never a CURIE', () => {
    const { nameIndex } = realAssets();
    assert.equal(nameIndex.structures.length, 57);
    for (const s of nameIndex.structures) {
      assert.match(s.id, /^FMA\d+$/, `${s.id} must be a bare FMA concept id`);
      assert.ok(!s.id.includes(':'), `${s.id} must not be a CURIE`);
      assert.equal(s.source, 'FMA');
    }
  });

  it('never lets a UBERON xref into the index at all', () => {
    const { nameIndex, namesDoc } = realAssets();
    // Not vacuous: the source document does carry xrefs, so there is something
    // that could have leaked.
    const withXrefs = namesDoc.structures.filter((s) => (s.uberon ?? []).length > 0);
    assert.ok(withXrefs.length > 0, 'the fixture for this test is names.json itself');
    assert.ok(withXrefs.some((s) => s.uberon.some((x) => x.startsWith('UBERON:'))));

    for (const s of nameIndex.structures) {
      assert.ok(!/UBERON/i.test(s.id), `${s.id} leaked a UBERON xref into the id`);
      assert.ok(!/UBERON/i.test(s.source ?? ''), `${s.id} leaked a UBERON xref into the source`);
      // The index is frozen to id/name/source, so there is nowhere else for it.
      assert.deepEqual(Object.keys(s).sort(), ['id', 'name', 'source']);
    }
  });

  it('stamps the real index version on every ranked name list', () => {
    const { nameIndex } = realAssets();
    const expected = assetJson(NAMES_FILE).version;
    assert.equal(nameIndex.version, expected);
    assert.match(expected, /^bp3d-4\.0\+uberon-/);

    for (const address of ['BD-T07', 'BD-T07-03O', 'BD-L02-06I', 'BD-C01']) {
      const model = selectAddress(address, { templates: realTemplates(), nameIndex });
      assert.equal(model.names.covered, true, address);
      assert.equal(model.names.indexVersion, expected, `${address} must cite the real index`);
      assert.ok(model.names.matches.length > 0, address);
    }
  });

  it('ranks several structures with fractions rather than picking a winner', () => {
    const { nameIndex } = realAssets();
    const model = selectAddress('BD-T07', { templates: realTemplates(), nameIndex });
    assert.ok(model.names.matches.length > 1, 'a whole level overlaps many structures');
    const fractions = model.names.matches.map((m) => m.fraction);
    // Ranked, descending, and no single match claims the whole cell.
    assert.deepEqual(fractions, [...fractions].sort((a, b) => b - a));
    assert.ok(fractions[0] < 1);
    assert.ok(model.names.unclaimedFraction > 0, 'and it says what nothing claims');
  });
});

describe('the two naming documents are joined, not assumed to be one', () => {
  it('refuses two documents from different builds', () => {
    const names = assetJson(NAMES_FILE);
    const coverings = { ...assetJson(COVERINGS_FILE), indexVersion: 'some-other-build' };
    assert.throws(
      () => joinNameIndex(names, coverings),
      (e) => e instanceof NameIndexError && /different builds/.test(e.message),
    );
  });

  it('joins by id, not by array position', () => {
    const names = assetJson(NAMES_FILE);
    const coverings = assetJson(COVERINGS_FILE);
    const shuffled = { ...coverings, coverings: [...coverings.coverings].reverse() };
    const straight = joinNameIndex(names, coverings);
    const reversed = joinNameIndex(names, shuffled);
    // Same structure order (names.json's), same cells per structure. A
    // positional join would pair every name with the wrong covering and still
    // produce a perfectly valid-looking index.
    assert.deepEqual(
      reversed.structures.map((s) => [s.id, s.cells.length]),
      straight.structures.map((s) => [s.id, s.cells.length]),
    );
  });

  it('refuses a named structure with no covering', () => {
    const names = assetJson(NAMES_FILE);
    const coverings = assetJson(COVERINGS_FILE);
    const short = { ...coverings, coverings: coverings.coverings.slice(1) };
    assert.throws(
      () => joinNameIndex(names, short),
      (e) => e instanceof NameIndexError && /no covering for/.test(e.message),
    );
  });

  it('refuses a covering nothing names', () => {
    const names = assetJson(NAMES_FILE);
    const coverings = assetJson(COVERINGS_FILE);
    const extra = {
      ...coverings,
      coverings: [...coverings.coverings, { id: 'FMA00000', cells: ['BD-T07'] }],
    };
    assert.throws(
      () => joinNameIndex(names, extra),
      (e) => e instanceof NameIndexError && /does not name it/.test(e.message),
    );
  });

  it('refuses a document missing its version, rather than resolving unversioned', () => {
    const names = { ...assetJson(NAMES_FILE) };
    delete names.version;
    assert.throws(
      () => joinNameIndex(names, assetJson(COVERINGS_FILE)),
      (e) => e instanceof NameIndexError && /`version`/.test(e.message),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Precision, against the real limit
// ---------------------------------------------------------------------------

describe('over-precision is demoted at the real template limit', () => {
  const t = realTemplates();
  // Read, never stated. The real body template declares 2.
  const limit = t.body.maxUsefulDigits;
  const written = `BD-T07-03O-${'5'.repeat(limit + 3)}`;

  it('the real limit is what the template says it is', () => {
    assert.equal(limit, assetJson(ASSET_TEMPLATES[0].file).maxUsefulDigits);
  });

  it('resolves rather than rejecting an over-precise address', () => {
    const model = selectAddress(written, { templates: t });
    assert.ok(model.ok);
    assert.equal(model.address, parse(written).canonical);
  });

  it('draws at the template limit, not as written', () => {
    const model = selectAddress(written, { templates: t });
    assert.ok(model.demoted);
    assert.equal(parse(model.displayAddress).digits.length, limit);
    assert.equal(model.displayAddress, demote(written, limit));
  });

  it('says so, and the notice survives the re-locate that clears the flag', () => {
    const model = selectAddress(written, { templates: t });
    assert.ok(codesOf(model).includes('over-precise'));
    const notice = model.notices.find((n) => n.code === 'over-precise');
    assert.match(notice.detail, /drawn AND named/);
    assert.ok(notice.detail.includes(model.displayAddress));
    // The notice quotes the template's own cap, so the number on screen is
    // the number the template declared.
    assert.ok(notice.detail.includes(`(${limit} digits)`));
  });

  it('demotes the names together with the cell', () => {
    const { nameIndex } = realAssets();
    const model = selectAddress(written, { templates: t, nameIndex });
    const atLimit = selectAddress(model.displayAddress, { templates: t, nameIndex });
    assert.deepEqual(
      model.names.matches.map((m) => [m.id, m.fraction]),
      atLimit.names.matches.map((m) => [m.id, m.fraction]),
      'names must describe the cell that is drawn',
    );
    assert.deepEqual(model.extentMm, atLimit.extentMm);
  });

  it('follows the bound template rather than any literal', () => {
    // The same address against a template that declares a DIFFERENT cap. A
    // hard-coded 2 anywhere in the path would demote to 2 here as well.
    const coarser = validateBodyTemplate({ ...assetJson(ASSET_TEMPLATES[0].file), maxUsefulDigits: 1 });
    assert.notEqual(coarser.maxUsefulDigits, limit);
    const model = selectAddress(written, { templates: { ...t, body: coarser } });
    assert.equal(parse(model.displayAddress).digits.length, coarser.maxUsefulDigits);
    assert.ok(model.notices.find((n) => n.code === 'over-precise')
      .detail.includes(`(${coarser.maxUsefulDigits} digits)`));
  });

  it('leaves an address at or under the limit completely alone', () => {
    for (let d = 0; d <= limit; d += 1) {
      const address = d === 0 ? 'BD-T07-03O' : `BD-T07-03O-${'5'.repeat(d)}`;
      const model = selectAddress(address, { templates: t });
      assert.equal(model.demoted, false, address);
      assert.ok(!codesOf(model).includes('over-precise'), address);
      assert.equal(model.displayAddress, model.address, address);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. True extent, through the real frame's forward map
// ---------------------------------------------------------------------------

describe('a cell is drawn at its true extent on the real template', () => {
  const t = realTemplates();

  it('reports a finite, positive extent that shrinks as the address refines', () => {
    let previous = Infinity;
    for (const address of ['BD-T07', 'BD-T07-03O', 'BD-T07-03O-5', 'BD-T07-03O-53']) {
      const model = selectAddress(address, { templates: t });
      assert.ok(model.extentMm.every((v) => Number.isFinite(v) && v > 0), address);
      const size = drawnSize(model.cell);
      assert.ok(size < previous, `${address} must draw smaller than its parent`);
      previous = size;
    }
  });

  it('draws a region, never a marker', () => {
    // A whole level is tens of millimetres across. If the renderer were given
    // a point, this is the assertion that would fail.
    const model = selectAddress('BD-T07', { templates: t });
    assert.ok(drawnSize(model.cell) > 50, 'a whole-level cell is a region');
    assert.ok(Math.min(...model.extentMm) > 1);
  });

  it('bends a whole-level cell’s edges instead of cutting a chord', () => {
    const model = selectAddress('BD-T07', { templates: t });
    const bent = model.cell.edges.some((line) => {
      const a = line[0];
      const b = line[Math.floor(line.length / 2)];
      const c = line.at(-1);
      const chord = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const viaMid = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
        + Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
      return viaMid > chord * 1.01;
    });
    assert.ok(bent, 'at least one edge must follow the real frame rather than cut a chord');
  });

  it('puts every vertex of the cell where the frame puts it', () => {
    // The mesh comes out of `bodyLocalToMm`, so a cell on the skin cannot sit
    // outside the drawn body. Compared against the surface built by the same
    // forward map, with a millimetre of slack for the band tessellation.
    const model = selectAddress('BD-T07-11O', { templates: t });
    const body = meshBounds(bodySurfaceMesh(t.body));
    for (let i = 0; i < model.cell.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const v = model.cell.positions[i + axis];
        assert.ok(
          v >= body.lo[axis] - 1 && v <= body.hi[axis] + 1,
          `cell vertex ${v} on axis ${axis} left the modelled body`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. BV ships without names
// ---------------------------------------------------------------------------

describe('BV is a location, and the real index says nothing about it', () => {
  const t = realTemplates();

  it('reports covered:false rather than an empty result', () => {
    const { nameIndex } = realAssets();
    const model = selectAddress('BV-L-471', { templates: t, nameIndex });
    assert.ok(model.ok);
    assert.equal(model.names.covered, false);
    assert.deepEqual(model.names.matches, []);
    // resolve() would have said 1 here: "all of this cell is unclaimed". No
    // index spoke, so nothing is claimed either way.
    assert.equal(model.names.unclaimedFraction, 0);
  });

  it('cites no index version, rather than borrowing the body index’s', () => {
    const { nameIndex } = realAssets();
    const model = selectAddress('BV-L-471', { templates: t, nameIndex });
    assert.equal(model.names.indexVersion, null);
    assert.ok(!JSON.stringify(model.names).includes(nameIndex.version));
  });

  it('says so with its own notice, which is not a failure or a gap', () => {
    const { nameIndex } = realAssets();
    const model = selectAddress('BV-L-471', { templates: t, nameIndex });
    const notice = model.notices.find((n) => n.code === 'frame-unnamed');
    assert.ok(notice, 'the unnamed frame must surface');
    assert.equal(notice.severity, 'info');
    // Shares no vocabulary with "nothing overlapped", which is the other
    // answer and a different fact.
    assert.ok(!/overlap/i.test(notice.detail));
    assert.match(notice.detail, /shipping state/);
    assert.ok(!codesOf(model).includes('names-unavailable'));
    assert.ok(!codesOf(model).includes('atlas-unavailable'));
  });

  it('still locates, draws and round-trips in millimetres', () => {
    const { nameIndex } = realAssets();
    const model = selectAddress('BV-L-471', { templates: t, nameIndex });
    assert.ok(model.pointMm.every(Number.isFinite));
    assert.ok(model.extentMm.every((v) => Number.isFinite(v) && v > 0));
    assert.ok(model.cell, 'an unnamed cell still draws at its true extent');
    assert.equal(model.templateId, 'icbm152-2009c-asym');
    // And the address survives the round trip unchanged.
    const { view } = decodeView(encodeView({ atlas: 'brain', address: model.address }));
    assert.equal(view.address, model.address);
  });

  it('is a per-frame fact: BD is still covered by the same index', () => {
    const { nameIndex } = realAssets();
    const body = selectAddress('BD-T07-03O', { templates: t, nameIndex });
    assert.equal(body.names.covered, true);
    assert.equal(body.names.indexVersion, nameIndex.version);
    assert.ok(!codesOf(body).includes('frame-unnamed'));
  });

  it('keeps the brain atlas selectable without leaving the body atlas', () => {
    const { nameIndex } = realAssets();
    const v = createViewer({ templates: t, nameIndex });
    const model = v.select('BV-L-471');
    assert.equal(v.atlas, 'body', 'selection never switches the atlas');
    assert.equal(model.elsewhere, 'brain');
    assert.equal(model.names.covered, false);
  });
});

// ---------------------------------------------------------------------------
// 6. Deep links, on the real templates
// ---------------------------------------------------------------------------

describe('deep links round-trip on the real templates', () => {
  const viewer = () => createViewer({ templates: realTemplates(), nameIndex: realAssets().nameIndex });

  it('restores camera and layers for a real body address', () => {
    const v = viewer();
    v.select('BD-T07-03O-53');
    v.setCamera({ yaw: 0.4, pitch: -0.2, distance: 780, target: [3, -12, 40] });
    v.setLayerHidden('cervical', true);
    v.setLayerOpacity('spine', 0.4);

    const link = encodeView(v.toView());
    const other = viewer();
    const decoded = decodeView(link);
    other.applyView(decoded.view, decoded.problems);

    assert.deepEqual(other.toView(), v.toView());
    assert.equal(encodeView(other.toView()), link);
    assert.equal(other.state.selection.templateId, 'bp3d-4.0-adult-body-centroid');
  });

  it('round-trips the brain atlas with the body atlas mutated while away', () => {
    const v = viewer();
    v.select('BD-T07-03O');
    v.setCamera({ yaw: 0.1, pitch: 0.1, distance: 600, target: [0, 0, 0] });
    v.setLayerHidden('lumbar', true);
    const left = JSON.parse(JSON.stringify(v.toView()));

    v.openAtlas('brain');
    v.select('BV-R-205');
    v.setCamera({ yaw: -0.9, pitch: 0.4, distance: 310, target: [2, 0, -4] });
    v.setLayerHidden('right', true);
    const brainLink = encodeView(v.toView());

    // Reach back and mutate the body atlas while away. The snapshot must win.
    v.setCamera({ yaw: 9, pitch: 0.2, distance: 123, target: [9, 9, 9] }, 'body');
    v.setLayerHidden('sacral', true);

    assert.equal(v.returnToPrevious(), 'body');
    assert.deepEqual(v.toView(), left, 'the return restores the view we left');

    // And the brain link still restores the brain view independently.
    const restored = viewer();
    const back = decodeView(brainLink);
    restored.applyView(back.view, back.problems);
    assert.equal(restored.atlas, 'brain');
    assert.equal(encodeView(restored.toView()), brainLink);
  });

  it('demotes an over-precise address out of a URL, and says so', () => {
    const v = viewer();
    const limit = realTemplates().body.maxUsefulDigits;
    const { view, problems } = decodeView(`a=BD-T07-03O-${'5'.repeat(limit + 2)}`);
    v.applyView(view, problems);
    const model = v.state.selection;
    assert.ok(model.ok);
    assert.ok(model.demoted);
    assert.equal(parse(model.displayAddress).digits.length, limit);
    assert.ok(codesOf(model).includes('over-precise'));
  });

  it('rejects a bad address out of a URL and changes nothing else', () => {
    const v = viewer();
    v.select('BD-T07-03O');
    v.setCamera({ yaw: 0.5, pitch: 0.1, distance: 500, target: [1, 1, 1] });
    const before = JSON.stringify(v.toView());
    // C08 does not exist: seven cervical levels.
    const rejected = v.select('BD-C08-03O');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.notices[0].code, 'rejected');
    assert.equal(JSON.stringify(v.toView()), before);
  });
});

// ---------------------------------------------------------------------------
// 7. The notice surface QA drives
// ---------------------------------------------------------------------------

describe('the stage-A notice surface still holds against real templates', () => {
  it('lists every notice code the module can emit, including the addition', () => {
    // A list that drifts from the code is how a state stops being surfaced
    // without anyone noticing. `names-other-template` is stage B's addition.
    assert.ok(NOTICE_CODES.includes('names-other-template'));
    assert.equal(new Set(NOTICE_CODES).size, NOTICE_CODES.length);
  });

  it('raises none of the template-defect findings on the real body template', () => {
    // The real template is admissible, does not fold, and realises every level
    // it claims, so a viewer that flagged defects indiscriminately would fail
    // here rather than pass. This is the negative control for stage B.
    const t = realTemplates();
    for (const address of ['BD-C01', 'BD-T07-03O', 'BD-L05-06I', 'BD-S01']) {
      const model = selectAddress(address, { templates: t });
      assert.ok(model.ok, address);
      assert.deepEqual(codesOf(model), [], `${address} must be clean on the real template`);
      assert.equal(model.located.flags.homology, 'exact', address);
    }
  });

  it('still reports a reserved sacral level as reserved, not as a variant', () => {
    const model = selectAddress('BD-S03', { templates: realTemplates() });
    assert.ok(codesOf(model).includes('homology-absent'));
    assert.ok(!codesOf(model).includes('homology-variant'));
  });

  it('still reports a count anomaly as a variant, distinctly', () => {
    const model = selectAddress('BD-T13', { templates: realTemplates() });
    assert.ok(codesOf(model).includes('homology-variant'));
    assert.ok(!codesOf(model).includes('homology-absent'));
  });

  it('resolves names even when no template loaded, so a broken asset degrades', () => {
    const { nameIndex } = realAssets();
    const model = selectAddress('BD-T07-03O', { templates: {}, nameIndex });
    assert.equal(model.ok, true);
    assert.ok(codesOf(model).includes('no-template'));
    assert.equal(model.names.covered, true);
    assert.ok(model.names.matches.length > 0, 'names survive a missing template');
    assert.equal(model.names.indexVersion, nameIndex.version);
  });
});

// ---------------------------------------------------------------------------
// 8. The §7 journey, on the real templates
// ---------------------------------------------------------------------------

describe('the §7 journey on the real body and brain templates', () => {
  it('runs end to end and comes back with the previous view intact', () => {
    const t = realTemplates();
    const { nameIndex } = realAssets();
    const v = createViewer({ templates: t, nameIndex });
    const bounds = meshBounds(bodySurfaceMesh(t.body));

    // 1. Default body view.
    assert.equal(v.atlas, 'body');
    v.setCamera(fitCamera(bounds));
    assert.ok(v.cameraOf('body').distance > 0);

    // 2. Change layers.
    v.setLayerHidden('cervical', true);
    v.setLayerOpacity('spine', 0.35);
    assert.equal(isLayerVisible(v.layersOf(), 'cervical'), false);
    assert.equal(isLayerVisible(v.layersOf(), 'thoracic'), true);
    assert.equal(layerOpacity(v.layersOf(), 'spine'), 0.35);
    v.isolate('thoracic');
    assert.equal(isLayerVisible(v.layersOf(), 'lumbar'), false);
    v.isolate(null);
    assert.equal(isLayerVisible(v.layersOf(), 'lumbar'), true);
    assert.equal(isLayerVisible(v.layersOf(), 'cervical'), false);

    // 3. Select a real structure WITHOUT leaving the atlas.
    const selected = v.select('BD-T07-03O');
    assert.ok(selected.ok);
    assert.equal(v.atlas, 'body');
    assert.ok(selected.names.matches.length > 1, 'a real cell overlaps several structures');
    assert.equal(selected.names.indexVersion, nameIndex.version);
    assert.equal(selected.templateId, 'bp3d-4.0-adult-body-centroid');
    v.setCamera(flyToCell(v.cameraOf(), meshBounds(selected.cell)));

    const bodyView = JSON.parse(JSON.stringify(v.toView()));

    // 4. Explicit brain navigation.
    assert.equal(v.canReturn, false);
    v.openAtlas('brain');
    assert.equal(v.atlas, 'brain');
    assert.equal(v.returnTarget, 'body');

    // 5. Work in the brain atlas: coordinates, and no names.
    const brain = v.select('BV-L-471');
    assert.equal(brain.names.covered, false);
    assert.ok(brain.pointMm.every(Number.isFinite));
    v.setCamera({ yaw: -0.9, pitch: 0.4, distance: 310, target: [0, 0, 0] });
    v.setLayerHidden('right', true);

    // 6. Return to the body with the previous view intact.
    assert.equal(v.returnToPrevious(), 'body');
    assert.deepEqual(v.toView(), bodyView, 'the return must restore what we left');
    assert.equal(v.canReturn, false);
    assert.equal(isLayerVisible(v.layersOf('brain'), 'right'), false);
  });
});
