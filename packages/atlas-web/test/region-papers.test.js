/**
 * W7 (DOG-132): the region ↔ paper panels against the region tree W6 serves.
 *
 * Read off disk, the way the page reads it over HTTP: the committed tree in
 * packages/atlas-assets/api/v1 is what the build byte-copies to dist/assets/.
 * What is asserted is what the panels rely on. Every region the tree lists is
 * reached through the catalogue's declaration, or named as not drawn. Every
 * link reads with its how and precision, approximate as approximate. Every
 * paper shows its structures or the API's stated reasons. The overlay keeps a
 * paper's mappings whole and stays in its own atlas. And the viewer joins
 * nothing: it reads what the API answered.
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ASSET_MESH_SETS } from '../catalogue/asset-meshes.mjs';
import { meshSetFrom } from '../src/viewer/meshset.js';
import { createViewer, meshDraws } from '../src/viewer/state.js';
import {
  apiModel,
  checkApiDocument,
  describeLink,
  listedHref,
  overlayOf,
  paperFrame,
  paperRegions,
  regionPapers,
  treeUrl,
} from '../src/viewer/regionpapers.js';
import { ASSETS, REPO_ROOT } from './real-assets.js';

const json = (rel) => JSON.parse(readFileSync(join(ASSETS, rel), 'utf8'));
const API = 'api/v1';
const regionIndex = json(`${API}/index.json`);
const doc = (href) => json(`${API}/${href}`);
const bodyTemplate = json('templates/bp3d-4.0-adult-body-centroid.body.json');

/** Every declared set at the low tier, decoded as the page decodes it, per atlas. */
const sets = { body: [], brain: [] };
for (const entry of ASSET_MESH_SETS) {
  const docs = {
    structures: json(entry.structures),
    labels: entry.labels ? json(entry.labels) : null,
    registration: entry.registration ? json(entry.registration) : null,
  };
  const bytes = readFileSync(join(ASSETS, docs.structures.tiers.low.file));
  sets[entry.atlas].push(meshSetFrom(entry, docs, bytes, bodyTemplate));
}
const structures = Object.values(sets).flat().flatMap((s) => s.structures);

/** The curated corpus, in the shape the page's model gives the panels: papers with titled findings. */
const seed = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'atlas-research', 'data', 'research-seed.json'), 'utf8'));
const research = {
  papers: seed.papers.map((p) => ({
    id: p.id,
    title: p.title,
    year: p.year,
    findings: seed.findings.filter((f) => f.paperId === p.id).map((f) => ({ id: f.id, label: f.statement })),
  })),
};

/** A link as W5 makes them, for the cases the committed tree cannot reach today. */
const link = (over) => ({
  mappingId: 'map:x/y/z', findingId: 'finding:x/y', paperId: 'paper:x', representation: 'zanatomy-gross-anatomy',
  structureId: '122', structureName: 'Hippocampus.l', side: 'left', sideFromSource: true,
  how: 'exact-term', precision: { kind: 'exact' }, source: { scheme: 'ATLAS-LABEL', term: 'ATLAS-LABEL:hippocampus', label: 'hippocampus' },
  ...over,
});

describe('which drawn structure is which region', () => {
  it('stamps each declared set with its representation, and the ICBM cortex with none until its lobes are in the tree', () => {
    const at = (set, id) => sets.brain.concat(sets.body).find((s) => s.id === set).structures.find((s) => s.id === id);
    assert.equal(at('zanatomy-2929e94', 122).regionKey, 'zanatomy-gross-anatomy/122');
    assert.equal(at('bp3d-4066585', 13075).regionKey, 'bodyparts3d-bd/FMA13075');
    const icbm = sets.brain.find((s) => s.id === 'icbm152-2009c').structures;
    assert.ok(icbm.length > 0);
    assert.ok(icbm.every((s) => s.regionKey === null), 'a lobe must not claim a region key the tree does not have');
  });

  it('reaches every region the served tree lists, or knows exactly which it cannot draw', () => {
    const drawn = new Map();
    for (const s of structures) if (s.regionKey) drawn.set(s.regionKey, [...(drawn.get(s.regionKey) ?? []), s]);
    const declared = new Set(ASSET_MESH_SETS.filter((e) => e.research).map((e) => e.research.representation));
    const undrawn = [];
    for (const r of regionIndex.regions) {
      assert.ok(declared.has(r.representation), `${r.key}: no mesh set declares representation ${r.representation}`);
      const hits = drawn.get(r.key) ?? [];
      assert.ok(hits.length <= 1, `${r.key} is ${hits.length} drawn structures`);
      if (hits.length === 0) undrawn.push(r.key);
    }
    // BodyParts3D wholes the body mesh ships only as parts. A new name here is
    // a region the overlay silently stops drawing, so it is a literal.
    assert.deepEqual(undrawn.sort(), [
      'bodyparts3d-bd/FMA7088', // heart
      'bodyparts3d-bd/FMA7197', // liver
      'bodyparts3d-bd/FMA7309', // right lung
      'bodyparts3d-bd/FMA7310', // left lung
      'bodyparts3d-bd/FMA7647', // spinal cord
    ]);
  });
});

describe('a link, as a reader sees it', () => {
  it('says an exact term is exact, and a crosswalk or a coordinate is approximate with its reason', () => {
    const exact = describeLink(link());
    assert.equal(exact.approximate, false);
    assert.equal(exact.precision, 'exact');
    const crosswalk = describeLink(link({ how: 'crosswalk', precision: { kind: 'approximate', why: 'many to few' }, crosswalk: { completeness: 'parts', heldTargets: [] } }));
    assert.equal(crosswalk.approximate, true);
    assert.match(crosswalk.precision, /^approximate: many to few$/);
    assert.ok(crosswalk.notes.some((n) => /one of its parts/.test(n)));
    const coordinate = describeLink(link({ how: 'coordinate', precision: { kind: 'mm', mm: 8.55, basis: 'held-out affine error' }, coordinate: { from: 'coordinates', mniMm: [0, 0, 0], depthMm: 0 } }));
    assert.equal(coordinate.approximate, true);
    assert.match(coordinate.precision, /±8\.55 mm \(held-out affine error\)/);
  });

  it('keeps an HCP-MMP1 area\'s own name, never only the structure it was projected onto', () => {
    const l = describeLink(link({ how: 'crosswalk', precision: { kind: 'approximate', why: 'area to lobe' }, source: { scheme: 'HCP-MMP1', term: 'HCP-MMP1:55b', label: 'Area 55b' }, crosswalk: { completeness: 'overlaps', heldTargets: ['Middle frontal gyrus'] } }));
    assert.equal(l.source, 'HCP-MMP1 area Area 55b (HCP-MMP1:55b)');
    assert.ok(l.notes.some((n) => n.includes('Middle frontal gyrus')), 'held targets are named');
    // The tree reaches no HCP-MMP1 structure today (every gyrus is held, DOG-157
    // has not landed), so the case above is synthetic. Whatever the tree does
    // reach is held to the same rule.
    for (const r of regionIndex.regions) {
      for (const p of doc(r.href).papers) {
        for (const x of p.links.filter((y) => y.source.scheme === 'HCP-MMP1')) {
          assert.ok(describeLink(x).source.includes(x.source.label), `${x.mappingId} lost its area name`);
        }
      }
    }
  });

  it('says the side was inferred when the paper named none', () => {
    assert.ok(describeLink(link({ sideFromSource: false })).notes.some((n) => /names no side/.test(n)));
    assert.deepEqual(describeLink(link()).notes, []);
  });
});

describe('region → papers', () => {
  it('lists every link of every region document once, under its paper and finding, titled from the corpus', () => {
    let links = 0;
    let approximate = 0;
    for (const r of regionIndex.regions) {
      const d = checkApiDocument(doc(r.href), 'region');
      const rows = regionPapers(d, research);
      assert.deepEqual(rows.map((p) => p.paperId), d.papers.map((p) => p.paperId));
      for (const p of rows) {
        assert.equal(p.title, research.papers.find((x) => x.id === p.paperId).title);
        for (const f of p.findings) {
          assert.equal(f.label, seed.findings.find((x) => x.id === f.findingId).statement);
        }
      }
      const shown = rows.flatMap((p) => p.findings.flatMap((f) => f.links));
      const served = d.papers.flatMap((p) => p.links);
      assert.deepEqual(shown.map((l) => l.mappingId).sort(), served.map((l) => l.mappingId).sort());
      for (const [i, l] of served.entries()) {
        const said = shown.find((x) => x.mappingId === l.mappingId);
        assert.equal(said.approximate, l.precision.kind !== 'exact', `${l.mappingId} at ${i}`);
      }
      links += shown.length;
      approximate += shown.filter((l) => l.approximate).length;
    }
    // Both kinds are on the real tree, so neither half of the check above is vacuous.
    assert.ok(links > approximate && approximate > 0, `${links} links, ${approximate} approximate`);
  });

  it('finds a document only through the region index, and a structure no paper links has none', () => {
    assert.equal(listedHref(regionIndex, 'region', 'zanatomy-gross-anatomy/122'), 'regions/zanatomy-gross-anatomy/122.json');
    assert.equal(listedHref(regionIndex, 'region', 'zanatomy-gross-anatomy/6'), null);
    assert.equal(listedHref(regionIndex, 'paper-regions', 'paper:glasser-2016-mmp1'), 'paper-regions/glasser-2016-mmp1.json');
    assert.equal(listedHref(regionIndex, 'paper-regions', 'paper:not-in-corpus'), null);
  });
});

describe('paper → regions', () => {
  const models = regionIndex.papers.map((p) => paperRegions(checkApiDocument(doc(p.href), 'paper-regions'), ASSET_MESH_SETS, sets));

  it('shows every paper\'s structures, or the reasons the API states for none, verbatim', () => {
    assert.equal(models.length, 30);
    for (const m of models) {
      const served = doc(regionIndex.papers.find((p) => p.paperId === m.paperId).href);
      assert.deepEqual(m.regions.map((r) => r.key), served.regions.map((r) => r.key), `${m.paperId}: a paper's mappings are never narrowed`);
      if (m.regions.length === 0) {
        assert.ok(m.emptyBecause.length > 0, `${m.paperId} has neither regions nor a reason`);
        assert.deepEqual(m.emptyBecause, served.emptyBecause);
        assert.ok(m.emptyBecause.every((e) => e.detail.length > 0));
      }
    }
    assert.equal(models.filter((m) => m.regions.length === 0).length, regionIndex.coverage.papers.emptyWithStatedReason);
  });

  it('marks a structure exact when any link to it is, and approximate only when every link is', () => {
    for (const m of models) {
      for (const r of m.regions) assert.equal(r.exact, r.links.some((l) => !l.approximate), `${r.key}`);
    }
    const fischl = models.find((m) => m.paperId === 'paper:fischl-2012-freesurfer');
    assert.ok(fischl.regions.some((r) => !r.exact), 'the thalamus crosswalk reaches its nuclei approximately');
  });

  it('highlights a two-atlas paper in each atlas separately, so a selection never draws in the other', () => {
    const both = models.find((m) => m.paperId === 'paper:mazziotta-2001-icbm');
    assert.deepEqual([...new Set(both.regions.map((r) => r.atlas))].sort(), ['body', 'brain']);
    const brain = overlayOf(both, 'brain');
    const brainKeys = new Set(sets.brain.flatMap((s) => s.structures.map((x) => x.key)));
    assert.equal(brain.size, both.regions.filter((r) => r.atlas === 'brain').length);
    assert.ok([...brain.keys()].every((k) => brainKeys.has(k)));
    // Its one body region is the spinal cord, which the body draws only as parts:
    // still listed, in the body atlas, and highlighted nowhere.
    const cord = both.regions.find((r) => r.atlas === 'body');
    assert.equal(cord.key, 'bodyparts3d-bd/FMA7647');
    assert.deepEqual(cord.structures, []);
    assert.equal(overlayOf(both, 'body').size, 0);
    // No served paper draws in both atlases today, so the split is also checked on one that does.
    const kidney = structures.find((s) => s.regionKey === 'bodyparts3d-bd/FMA7204');
    const hippocampus = structures.find((s) => s.regionKey === 'zanatomy-gross-anatomy/122');
    const synthetic = paperRegions({
      paperId: 'paper:x',
      regions: [kidney, hippocampus].map((s) => ({ key: s.regionKey, structureName: s.name, links: [link()] })),
      emptyBecause: [],
    }, ASSET_MESH_SETS, sets);
    assert.deepEqual([...overlayOf(synthetic, 'body').keys()], [kidney.key]);
    assert.deepEqual([...overlayOf(synthetic, 'brain').keys()], [hippocampus.key]);
  });

  it('overlays nothing for a paper with no structures, and nothing with no paper', () => {
    const glasser = models.find((m) => m.paperId === 'paper:glasser-2016-mmp1');
    assert.equal(overlayOf(glasser, 'brain').size, 0);
    assert.equal(overlayOf(null, 'brain').size, 0);
  });

  it('keeps exact over approximate when two regions reach one structure', () => {
    const s = { key: 'zanatomy-2929e94.122' };
    const model = { regions: [
      { atlas: 'brain', exact: true, structures: [s] },
      { atlas: 'brain', exact: false, structures: [s] },
    ] };
    assert.equal(overlayOf(model, 'brain').get(s.key), 'exact');
    model.regions.reverse();
    assert.equal(overlayOf(model, 'brain').get(s.key), 'exact');
  });
});

describe('the camera and the x-ray pass', () => {
  const models = regionIndex.papers.map((p) => paperRegions(checkApiDocument(doc(p.href), 'paper-regions'), ASSET_MESH_SETS, sets));
  const both = models.find((m) => m.paperId === 'paper:mazziotta-2001-icbm');

  it('frames a revealed paper once, on its structures in this atlas, and waits only while they are still coming', () => {
    const brain = paperFrame(both, 'brain', 'loading', 'brain');
    assert.deepEqual(brain.drawn.map((s) => s.key), [...overlayOf(both, 'brain').keys()]);
    assert.equal(brain.done, true, 'framed as soon as anything here is drawn, so a later commit never refits');
    // Its body region is the spinal cord, drawn only as parts: nothing to frame.
    // While the body meshes are coming, the reveal waits; once they are in, or failed, it is spent.
    assert.deepEqual(paperFrame(both, 'body', 'loading', 'body'), { drawn: [], done: false });
    assert.deepEqual(paperFrame(both, 'body', 'pending', 'body'), { drawn: [], done: false });
    for (const status of ['low', 'full', 'failed', 'none']) assert.deepEqual(paperFrame(both, 'body', status, 'body'), { drawn: [], done: true }, status);
    const glasser = models.find((m) => m.paperId === 'paper:glasser-2016-mmp1');
    assert.deepEqual(paperFrame(glasser, 'brain', 'loading', 'brain'), { drawn: [], done: true }, 'a paper with no structures waits for nothing');
  });

  it('never frames in an atlas the paper was not revealed in, however the view got there', () => {
    // Revealed in the body, answered after a switch to the brain (a button, a return or browser Back):
    // the brain structures are drawn, and still nothing is framed, and the reveal is spent.
    assert.deepEqual(paperFrame(both, 'brain', 'full', 'body'), { drawn: [], done: true });
    assert.deepEqual(paperFrame(both, 'brain', 'loading', 'body'), { drawn: [], done: true }, 'not kept waiting for the old atlas either');
    assert.deepEqual(paperFrame(both, 'body', 'loading', 'brain'), { drawn: [], done: true });
  });

  it('draws a paper\'s structures through any layer, and the selected one last', () => {
    const v = createViewer();
    v.openAtlas('brain');
    v.setLayerHidden('cortex', true);
    const palette = { chosen: '#c', paper: '#p', paperStripe: '#s', cortex: '#1', deep_grey: '#2', other: '#o' };
    const at = (key, category, firstTriangle) => ({ key, category, parts: ['left'], firstTriangle, triangleCount: 10 });
    const gpu = { id: 'set' };
    const set = { gpu, structures: [at('a', 'cortex', 0), at('b', 'deep_grey', 10), at('c', 'deep_grey', 20), at('d', 'deep_grey', 30)] };
    const overlay = new Map([['a', 'exact'], ['b', 'approximate']]);
    const draws = (chosen, layers = v.layersOf()) => meshDraws([{ structures: set.structures }, set], { layers, chosen, overlay, palette });

    const { solids, xray } = draws('c');
    // a's cortex layer is hidden: it is not a solid, and still shows, in the paper colour.
    assert.deepEqual(solids, [{ mesh: gpu, visible: true, opacity: 1, ranges: [
      { firstTriangle: 10, triangleCount: 10, colour: '#p', hatch: '#s' },
      { firstTriangle: 20, triangleCount: 10, colour: '#c', hatch: null },
      { firstTriangle: 30, triangleCount: 10, colour: '#2', hatch: null },
    ] }]);
    assert.deepEqual(xray, [
      { mesh: gpu, ranges: [
        { firstTriangle: 0, triangleCount: 10, colour: '#p', hatch: null },
        { firstTriangle: 10, triangleCount: 10, colour: '#p', hatch: '#s' },
      ] },
      { mesh: gpu, ranges: [{ firstTriangle: 20, triangleCount: 10, colour: '#c' }] },
    ], 'exact solid, approximate striped, the selection on top; a set not yet on the GPU draws nothing');

    // A selected paper structure is drawn as the selection, once, not also as the paper's.
    assert.deepEqual(draws('b').xray.map((x) => x.ranges.map((r) => [r.firstTriangle, r.colour])), [[[0, '#p']], [[10, '#c']]]);
    // A faded selection keeps its fade: no x-ray for it.
    v.setLayerOpacity('deep_grey', 0.4);
    assert.deepEqual(draws('c').xray.map((x) => x.ranges.length), [2]);
    assert.deepEqual(draws(null).xray.map((x) => x.ranges.length), [2]);
    assert.deepEqual(meshDraws([set], { layers: v.layersOf(), chosen: null, overlay: new Map(), palette }).xray, [], 'no paper, no selection: no x-ray');
  });
});

describe('what the page trusts', () => {
  it('refuses a document of another kind or schema', () => {
    assert.throws(() => checkApiDocument(doc('index.json'), 'region'), /region document/);
    assert.throws(() => checkApiDocument({ ...doc('index.json'), schema: 'atlas-research-api/2' }, 'region-index'), /atlas-research-api\/1/);
    assert.throws(() => checkApiDocument(null, 'region'), /region document/);
  });

  it('reads a document that passes the kind check but is malformed inside as the API failing, not a throw', () => {
    // A stale cached copy, say: right schema and kind, wrong body.
    const region = checkApiDocument({ schema: 'atlas-research-api/1', kind: 'region', papers: null }, 'region');
    assert.match(apiModel({ doc: region }, (d) => regionPapers(d, research)).error, /^malformed document: /);
    const paper = checkApiDocument({ schema: 'atlas-research-api/1', kind: 'paper-regions', paperId: 'paper:x', regions: [{ key: 'a/1' }] }, 'paper-regions');
    assert.match(apiModel({ doc: paper }, (d) => paperRegions(d, ASSET_MESH_SETS, sets)).error, /^malformed document: /);
    // Loading and failed answers pass through untouched; a well-formed one is built.
    assert.deepEqual(apiModel({ pending: true }, () => assert.fail('built while pending')), { pending: true });
    assert.deepEqual(apiModel({ error: 'x returned 404' }, () => assert.fail('built on a failure')), { error: 'x returned 404' });
    const served = doc(regionIndex.regions[0].href);
    assert.deepEqual(apiModel({ doc: served }, (d) => regionPapers(d, research)).model, regionPapers(served, research));
  });

  it('refuses an href that leaves the region tree', () => {
    const root = 'https://example.org/somasurfer/assets/api/v1/';
    const from = `${root}index.json`;
    assert.equal(treeUrl(root, from, 'regions/a/1.json'), `${root}regions/a/1.json`);
    assert.throws(() => treeUrl(root, from, '../../../data/api/v1/index.json'), /leaves/);
    assert.throws(() => treeUrl(root, from, 'https://elsewhere.example/x.json'), /leaves/);
    assert.throws(() => treeUrl(root, from, '//elsewhere.example/x.json'), /leaves/);
  });

  it('joins nothing itself: the panels import no resolver and no crosswalk', () => {
    const src = (f) => readFileSync(join(REPO_ROOT, 'packages', 'atlas-web', 'src', f), 'utf8');
    assert.doesNotMatch(src('viewer/regionpapers.js'), /^import /m, 'regionpapers.js reads documents and imports nothing');
    assert.doesNotMatch(src('app.js'), /buildRegionIndex|createRegionApi|createResearchApi|crosswalk\.json|region-index-/);
  });
});

it('lists the region tree the build copies, so this file reads what the page is served', () => {
  const files = readdirSync(join(ASSETS, API, 'regions'), { recursive: true }).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, regionIndex.regions.length);
});
