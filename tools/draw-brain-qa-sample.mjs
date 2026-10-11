/**
 * Draw the brain QA sample once and write it as a fixture.
 *
 *   node tools/draw-brain-qa-sample.mjs            refuses if the fixture exists
 *   node tools/draw-brain-qa-sample.mjs --redraw   a deliberate redraw
 *
 * The rules and the one change the licence forced are in
 * tools/lib/brain-qa-sample.mjs. tools/check-mesh-assets.mjs checks the
 * committed fixture against them on every run, without redrawing it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, fail, rel } from './lib/repo.mjs';
import { brainAssetPaths } from './lib/brain-asset-paths.mjs';
import { SAMPLE_RULES, drawSample } from './lib/brain-qa-sample.mjs';

export const SAMPLE_FIXTURE = join(REPO_ROOT, 'packages', 'atlas-qa', 'fixtures', 'brain-structure-sample.json');

if (existsSync(SAMPLE_FIXTURE) && !process.argv.includes('--redraw')) {
  fail('draw-brain-qa-sample', [
    `${rel(SAMPLE_FIXTURE)} exists. The sample is drawn once; QA may already have run against it.`,
    'Pass --redraw only if that is the decision, and say why in the commit.',
  ]);
}

const attribution = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'atlas-assets', 'attribution.json'), 'utf8'));
const paths = brainAssetPaths(attribution.upstreamSources.find((s) => s.id === 'brainproject-brain-glb').pinned.commit);
const doc = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'atlas-assets', paths.structuresFile), 'utf8'));
const r = drawSample(doc);

const fixture = {
  schema: 'atlas-brain-qa-sample/1',
  comment: [
    'The DOG-123 W8a brain sample: drawn once by tools/draw-brain-qa-sample.mjs, checked by tools/check-mesh-assets.mjs.',
    'Every `sample` entry ships and must be pickable, returning `expect.name`. Every `withheldControls` entry',
    'is held under docs/asset-licensing.md 7.3 and must NOT be pickable; the page should say why.',
    'white_matter ships nothing, so it is represented by withheld controls, not by sampled structures.',
  ],
  drawnFrom: { mesh: paths.id, structures: doc.structures.length, excluded: doc.excluded.length },
  seed: SAMPLE_RULES.seed,
  rules: SAMPLE_RULES,
  categories: { all: r.categories, shipping: r.shippable, shippingNothing: r.unshippable },
  quota: r.quota,
  sample: r.sample,
  withheldControls: r.withheldControls,
};
writeFileSync(SAMPLE_FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`wrote ${rel(SAMPLE_FIXTURE)}: ${r.sample.length} sampled over ${r.shippable.length} categories, ${r.withheldControls.length} withheld control(s) for ${r.unshippable.join(', ')}`);
