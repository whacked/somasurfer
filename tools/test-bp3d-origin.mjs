/**
 * The pre-registered origin test, against BodyParts3D, for the three
 * `Temporal lobe`-only structures: is Z-Anatomy's corpus callosum, and are its
 * two midbrain halves, BodyParts3D's own meshes?
 *
 *   node tools/test-bp3d-origin.mjs --source <brainproject dir> --bp3d <BodyParts3D dir>
 *
 * The rule, the thresholds and the reasons are in docs/brain-origin-test.md and
 * tools/lib/origin-test.mjs, committed before this was run. This file only
 * chooses the structures, and it chooses them by the rule written there:
 *
 *   - FIT: Z-Anatomy structures that are cleared and have a sided BodyParts3D
 *     counterpart. One similarity transform for all of them together.
 *   - HELD OUT: the three structures under test. They are never in the fit, so
 *     their figures are out-of-sample.
 *
 * Writes packages/atlas-assets/provenance/origin-test-bodyparts3d.json.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, fail } from './lib/repo.mjs';
import { decodeGlbNodes, mergeParts } from './lib/glb.mjs';
import { weld } from './lib/mesh-geometry.mjs';
import { openSource } from './lib/bp3d.mjs';
import { ORIGIN_TEST } from './lib/origin-test.mjs';
import { fitGlobalSimilarity, scoreStructures, verdict } from './lib/origin-match.mjs';

const BP3D_ARCHIVE_SHA256 = '40665852c49f218326590e204db91064a1ecfc3c6f8cbd7bbbcaac62c7cd409e';

/** Z-Anatomy name → BodyParts3D IS-A concept (sided where BodyParts3D sides it). */
const FIT = [
  ['Caudate nucleus.l', 'FMA72827'], ['Caudate nucleus.r', 'FMA72826'],
  ['Putamen.l', 'FMA72829'], ['Putamen.r', 'FMA72828'],
  ['Hippocampus.l', 'FMA72714'], ['Hippocampus.r', 'FMA72713'],
  ['Lateral ventricle.l', 'FMA78450'], ['Lateral ventricle.r', 'FMA78449'],
  ['Superior colliculus.l', 'FMA73423'], ['Superior colliculus.r', 'FMA73422'],
  ['Inferior colliculus.l', 'FMA73435'], ['Inferior colliculus.r', 'FMA73434'],
  ['Third ventricle', 'FMA78454'],
  ['Fourth ventricle', 'FMA78469'],
];
/**
 * Held out. BodyParts3D has one midbrain concept (FMA61993) made of two element
 * files; each half is matched to the element on its own side, decided by the
 * element's centroid (BodyParts3D +x is the subject's left).
 */
const HELD = [
  ['Corpus callosum', 'FMA86464'],
  ['Midbrain.l', 'FMA61993:left'],
  ['Midbrain.r', 'FMA61993:right'],
];

const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const sourceDir = arg('--source');
const bp3dDir = arg('--bp3d');
if (!sourceDir || !bp3dDir) fail('test-bp3d-origin', ['Pass --source <brainproject dir> and --bp3d <BodyParts3D dir>.']);

const attribution = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'atlas-assets', 'attribution.json'), 'utf8'));
const pin = attribution.upstreamSources.find((s) => s.id === 'brainproject-brain-glb').pinned;
const glb = readFileSync(join(sourceDir, 'brain.glb'));
if (createHash('sha256').update(glb).digest('hex') !== pin.files['brain-atlas/models/brain.glb'].sha256) {
  fail('test-bp3d-origin', ['brain.glb does not match the pinned SHA-256.']);
}
const zipSha = createHash('sha256').update(readFileSync(join(bp3dDir, 'isa_BP3D_4.0_obj_99.zip'))).digest('hex');
if (zipSha !== BP3D_ARCHIVE_SHA256) fail('test-bp3d-origin', [`isa_BP3D_4.0_obj_99.zip has SHA-256 ${zipSha}, expected ${BP3D_ARCHIVE_SHA256} (docs/asset-licensing.md 2).`]);

const { nodes } = await decodeGlbNodes(glb);
const candidate = (name) => {
  const n = nodes.find((x) => x.name.trim() === name);
  if (!n) fail('test-bp3d-origin', [`${name} is not in brain.glb`]);
  const m = mergeParts(n.parts);
  return weld(m.positions, m.indices);
};

const bp3d = openSource(bp3dDir);
/** BodyParts3D geometry back in its native LPS millimetres (the adapter hands out LAS). */
const toLps = (V) => Float64Array.from(V, (x, i) => (i % 3 === 1 ? -x : x));
const reference = (spec) => {
  const [fma, side] = spec.split(':');
  if (!side) {
    const m = bp3d.loadMesh(fma);
    if (!m) fail('test-bp3d-origin', [`BodyParts3D has no mesh for ${fma}`]);
    return weld(toLps(m.V), Uint32Array.from(m.F));
  }
  const parts = bp3d.loadParts(fma);
  const withX = parts.map((p) => {
    let x = 0;
    for (let i = 0; i < p.V.length; i += 3) x += p.V[i];
    return { p, x: x / (p.V.length / 3) };
  });
  if (withX.length !== 2) fail('test-bp3d-origin', [`${fma} has ${withX.length} element files; the halves rule needs exactly 2`]);
  const pick = withX.sort((a, b) => b.x - a.x)[side === 'left' ? 0 : 1].p;
  return { ...weld(toLps(pick.V), Uint32Array.from(pick.F)), element: pick.file };
};

const pairs = [
  ...FIT.map(([name, spec]) => ({ name, spec, role: 'fit', candidate: candidate(name), reference: reference(spec) })),
  ...HELD.map(([name, spec]) => ({ name, spec, role: 'held-out', candidate: candidate(name), reference: reference(spec) })),
];

// The stated axis conventions. glTF mesh frame: metres, +x the model's left,
// +y superior, +z anterior. BodyParts3D: millimetres, LPS. So x -> x, -z -> y,
// y -> z, at 1000 mm per metre: a proper rotation, which Umeyama keeps proper.
const init = { s: 1000, R: [[1, 0, 0], [0, 0, -1], [0, 1, 0]], t: [0, 0, 0] };
const fit = fitGlobalSimilarity(pairs.filter((p) => p.role === 'fit'), init);
const scores = scoreStructures(pairs, fit.sim);
const v = verdict(scores);

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const doc = {
  schema: 'atlas-origin-test/1',
  test: 'Z-Anatomy Temporal-lobe-only structures against BodyParts3D 4.0 (docs/brain-origin-test.md)',
  preRegistered: { thresholds: ORIGIN_TEST, file: 'tools/lib/origin-test.mjs' },
  inputs: {
    brainGlb: pin.files['brain-atlas/models/brain.glb'].sha256,
    bodyparts3d: { archive: 'isa_BP3D_4.0_obj_99.zip', sha256: BP3D_ARCHIVE_SHA256 },
  },
  transform: {
    model: 'one similarity for the whole set (Umeyama), fitted by ICP on the fit structures only',
    scaleMmPerMeshM: round(fit.sim.s, 4),
    R: fit.sim.R.map((r) => r.map((x) => round(x, 6))),
    tMm: fit.sim.t.map((x) => round(x, 3)),
    icpMeanMmByIteration: fit.history.map((x) => round(x, 4)),
  },
  structures: scores.map((s) => ({
    name: s.name,
    role: s.role,
    reference: pairs.find((p) => p.name === s.name).spec + (pairs.find((p) => p.name === s.name).reference.element ? ` (${pairs.find((p) => p.name === s.name).reference.element})` : ''),
    matched: { meanSymmetricMm: round(s.matched.meanSymmetricMm), p95Mm: round(s.matched.p95Mm), labelAgreement: round(s.matched.labelAgreement), passes: s.matched.passes },
    control: { against: s.control.against, meanSymmetricMm: round(s.control.meanSymmetricMm), p95Mm: round(s.control.p95Mm), labelAgreement: round(s.control.labelAgreement), passes: s.control.passes },
  })),
  negativeControl: { passes: v.controlPasses, of: scores.length, share: round(v.controlShare, 3), discriminates: v.discriminates },
};
doc.result = {
  heldOut: doc.structures.filter((s) => s.role === 'held-out').map((s) => ({ name: s.name, passes: s.matched.passes && v.discriminates })),
  clears: v.discriminates ? doc.structures.filter((s) => s.role === 'held-out' && s.matched.passes).map((s) => s.name) : [],
};

writeFileSync(join(REPO_ROOT, 'packages', 'atlas-assets', 'provenance', 'origin-test-bodyparts3d.json'), `${JSON.stringify(doc, null, 1)}\n`);
console.log(`scale ${doc.transform.scaleMmPerMeshM} mm per mesh m; ICP ${doc.transform.icpMeanMmByIteration.length} iterations, final mean ${doc.transform.icpMeanMmByIteration.at(-1)} mm`);
for (const s of doc.structures) {
  console.log(`${s.role.padEnd(9)} ${s.name.padEnd(24)} mean ${String(s.matched.meanSymmetricMm).padStart(7)}  p95 ${String(s.matched.p95Mm).padStart(7)}  label ${String(s.matched.labelAgreement).padStart(5)}  ${s.matched.passes ? 'PASS' : 'fail'}   | control vs ${s.control.against}: ${s.control.passes ? 'PASS' : 'fail'}`);
}
console.log(`negative control: ${v.controlPasses} of ${scores.length} pass (${(v.controlShare * 100).toFixed(1)}%); the test ${v.discriminates ? 'discriminates' : 'DOES NOT discriminate'}`);
console.log(`clears: ${doc.result.clears.length ? doc.result.clears.join(', ') : 'nothing'}`);
