/**
 * The ICBM152 2009c cerebral cortex, its low tier and its first-party lobe
 * labels (DOG-151, approved on card 6a774981). See docs/brain-cortex-icbm.md.
 *
 *   (cd tools/mesh-build && npm ci)        # once: the build-only simplifier
 *   node tools/build-icbm-cortex.mjs --icbm <dir>
 *
 * `<dir>` holds the extracted archive `mni_icbm152_nlin_asym_09c_nifti.zip`
 * (source `icbm152-2009c` in packages/atlas-assets/attribution.json), i.e.
 * `<dir>/mni_icbm152_nlin_asym_09c/*.nii`. Every file read is checked against
 * the SHA-256 recorded in tools/lib/icbm-cortex.mjs first.
 *
 * Writes, under packages/atlas-assets/:
 *
 *   brain/icbm152-2009c/cortex.lowres.bin   ATLM, MNI RAS millimetres; 1 = left, 2 = right
 *   brain/icbm152-2009c/structures.json     the geometry's description and provenance
 *   brain/icbm152-2009c/lobes.json          the label set, its own file (first-party)
 *   provenance/icbm152-2009c-cortex.json    the build record: cut, leak, boundaries, QA
 *
 * The decisions, and why:
 *
 *   - THE SURFACE IS THE 0.3 CSF LEVEL. The prototype's surface was the 0.5
 *     level of GM + WM. At 1 mm that fuses the opercula over the insula and the
 *     two hemispheres along most of the medial surface, so the insula and the
 *     medial sulci (calcarine, parieto-occipital, cingulate) were not on it at
 *     all, and lobes could not be drawn there. The template's CSF map resolves
 *     them. The field is GM + WM - CSF and the level is 1 - 2 * 0.3: inside the
 *     mask GM + WM + CSF is ~1, so that is where the CSF probability reaches
 *     0.3. Measured on the left hemisphere: cut-face vertices 35,982 -> 20,272,
 *     and the insular floor is exposed. Enclosed volume falls 4.5% (753 -> 714
 *     cm^3); the surface sits slightly inside the probabilistic pial boundary.
 *   - CEREBRUM ONLY, by the prototype's measured tentorial and brainstem cuts
 *     (tools/lib/icbm-cortex.mjs). The leak past them is counted against the
 *     committed Z-Anatomy cerebellum (tools/lib/icbm-cerebellar-leak.mjs). The
 *     cut is not validated: nothing in this build can validate it.
 *   - LOBES ON THE FULL SURFACE, THEN CARRIED DOWN. The labels are drawn on the
 *     undecimated surface (tools/lib/icbm-lobes.mjs) from first-party landmarks
 *     (tools/lib/icbm-lobe-landmarks.mjs). The simplifier keeps original
 *     vertices, so each low-tier vertex takes the label of the vertex it is.
 *   - LOW TIER = meshoptimizer simplify() with Regularize, then a manifold repair
 *     (tools/lib/mesh-manifold.mjs), then quantisation. A triangle budget is
 *     accepted only if the result has 0 non-manifold edges, 0 inconsistently
 *     wound edges and 0 degenerate triangles; otherwise the next budget down is
 *     tried. The budget is searched until the file is at most LOW_GZIP_TARGET.
 *   - LOW_GZIP_TARGET = 145,000 B. The brain's low-res share is 1,048,576 B and
 *     the acceptance criterion leaves at least 5% of it (52,429 B) unused. The
 *     committed Z-Anatomy low tier and its structures.json read 829,850 B, so
 *     the cortex's three files may total 166,297 B. 145,000 B for the mesh
 *     leaves ~21 KB for structures.json and lobes.json. The perf gate, not this
 *     tool, is the measurement of record.
 *   - NO FULL TIER SHIPS. The undecimated surface is ~8.6 MB gzip; the full-res
 *     line (5.25 MiB) has ~3.6% left and the brief keeps the budget lines
 *     untouched. The low tier's error against it is measured here and
 *     published; the gate cannot re-measure it, because the full surface is not
 *     in the repository, and says so.
 *   - NATIVELY MNI. Positions are MNI152 2009c asymmetric millimetres, straight
 *     from the NIfTI sform (checked: sform_code 4, axis-aligned, 1 mm). No affine
 *     is applied, so a coordinate needs none.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { REPO_ROOT, fail, rel } from './lib/repo.mjs';
import { octEncode, writeMeshBin } from './lib/meshbin.mjs';
import { dequantise, quantisationFrame } from './lib/brain-meshes.mjs';
import { degenerateTriangles, oneSidedDistance, surfaceArea, triangleGrid, vertexNormals } from './lib/mesh-geometry.mjs';
import { manifoldReport, signedVolume } from './lib/marching-cubes.mjs';
import { PINNED, LEFT, RIGHT, ISO, cerebrum, checkFrame, extractHemispheres, readVolume, round, sha256, sampler } from './lib/icbm-cortex.mjs';
import { CLOSING_RADIUS_MM, CUT_PROBE_MM, HIDDEN_REACH_MM, depthField, surfaceMeasures } from './lib/icbm-surface-measures.mjs';
import { INSULA, LOBES, labelHemisphere } from './lib/icbm-lobes.mjs';
import { LANDMARKS } from './lib/icbm-lobe-landmarks.mjs';
import { makeManifold } from './lib/mesh-manifold.mjs';
import { REFERENCE, countLeak, loadReference, referenceAgainstCut } from './lib/icbm-cerebellar-leak.mjs';

const GATE = 'build-icbm-cortex';
export const CSF_CARVE = 0.3;
const LOW_GZIP_TARGET = 145000;
// Regularize evens out triangle shapes, and in this surface it leaves about half as
// many collapsed sheets for the repair as plain simplification does.
const SIMPLIFY_FLAGS = ['Regularize'];
const SET_ID = 'icbm152-2009c';
const ASSETS = join(REPO_ROOT, 'packages', 'atlas-assets');
const OUT_DIR = join(ASSETS, 'brain', SET_ID);
const FILES = {
  low: `brain/${SET_ID}/cortex.lowres.bin`,
  structures: `brain/${SET_ID}/structures.json`,
  lobes: `brain/${SET_ID}/lobes.json`,
  provenance: `provenance/${SET_ID}-cortex.json`,
};
const SIDES = [[LEFT, 'left', 'l'], [RIGHT, 'right', 'r']];

const args = process.argv.slice(2);
const icbmDir = args[args.indexOf('--icbm') + 1];
if (!args.includes('--icbm') || !icbmDir) {
  fail(GATE, ['Pass --icbm <dir> holding the extracted ICBM152 2009c archive.', `Fetch: curl -o ${PINNED.archive.name} ${PINNED.url}`]);
}

const gz = (b) => gzipSync(b, { level: 9 }).length;
const timings = {};
let mark = performance.now();
const lap = (name) => {
  const now = performance.now();
  timings[name] = round((now - mark) / 1000, 1);
  mark = now;
};

// 1. Inputs, verified.
const archivePath = join(icbmDir, PINNED.archive.name);
let archive = { checked: false, note: 'archive not present beside the extracted files; each file checked individually' };
if (existsSync(archivePath)) {
  const bytes = readFileSync(archivePath);
  if (sha256(bytes) !== PINNED.archive.sha256) fail(GATE, [`${archivePath} does not match the recorded SHA-256 ${PINNED.archive.sha256}.`]);
  archive = { checked: true, bytes: bytes.length, sha256: PINNED.archive.sha256 };
}
let vols = Object.fromEntries(['gm', 'wm', 'csf', 'mask'].map((k) => [k, readVolume(GATE, icbmDir, PINNED.files[k])]));
const frame = checkFrame(GATE, Object.values(vols));
const inputs = {
  source: PINNED.source,
  url: PINNED.url,
  archive,
  files: Object.fromEntries(Object.entries(vols).map(([k, v]) => [k, { file: `${PINNED.dir}/${PINNED.files[k].name}`, sha256: v.sha }])),
  grid: { dims: frame.dims, voxelMm: 1, originMm: frame.offset, space: 'MNI152 2009c asymmetric (sform_code 4), RAS' },
};
const c = cerebrum(GATE, vols, frame, { csfCarve: CSF_CARVE });
vols = null;
lap('readAndCutS');

// 2. Surface, measures and labels per hemisphere.
const hemis = extractHemispheres(c, frame);
lap('extractS');
for (const h of hemis) {
  const inSide = h.id === LEFT ? (i) => i + frame.offset[0] < 0 : (i) => i + frame.offset[0] >= 0;
  const m = surfaceMeasures(h.mesh, c, depthField(c, frame, inSide), frame, inSide);
  h.surface = { positions: h.mesh.positions, indices: h.mesh.indices, depth: m.depth, cut: m.cut, wm: m.wmAtProbe };
  h.lobes = labelHemisphere(GATE, h.surface, LANDMARKS[h.name]);
}
lap('measureAndLabelS');

// 3. The low tier.
let meshopt = null;
async function meshoptimizer() {
  if (meshopt) return meshopt;
  const require = createRequire(join(REPO_ROOT, 'tools', 'mesh-build', 'package.json'));
  const mod = await import(require.resolve('meshoptimizer'));
  await mod.MeshoptSimplifier.ready;
  await mod.MeshoptEncoder.ready;
  meshopt = mod;
  return mod;
}
const M = await meshoptimizer();
const qframe = quantisationFrame(hemis.map((h) => h.mesh));

/** Simplify one hemisphere to `target` triangles, repair, reorder, quantise; null if it is not clean. */
function lowTier(h, target, flags) {
  const [simplified] = M.MeshoptSimplifier.simplify(Uint32Array.from(h.mesh.indices), Float32Array.from(h.mesh.positions), 3, target * 3, 1, flags);
  const fixed = makeManifold(simplified, h.mesh.positions);
  // The repaired vertex list: a split vertex is a copy of its source, nudged.
  const src = fixed.source;
  const positions = fixed.positions;
  const indices = Uint32Array.from(fixed.indices);
  const [remap, unique] = M.MeshoptEncoder.reorderMesh(indices, true, true);
  const outPos = new Float32Array(unique * 3);
  const origin = new Uint32Array(unique);
  for (let v = 0; v < Math.min(remap.length, src.length); v += 1) {
    const to = remap[v];
    if (to === 0xffffffff) continue;
    outPos.set(positions.subarray(v * 3, v * 3 + 3), to * 3);
    origin[to] = src[v];
  }
  const q = new Int16Array(unique * 3);
  for (let v = 0; v < unique; v += 1) {
    for (let a = 0; a < 3; a += 1) q[v * 3 + a] = Math.max(-32767, Math.min(32767, Math.round((outPos[v * 3 + a] - qframe.origin[a]) / qframe.step[a])));
  }
  const back = dequantise(q, qframe);
  const report = manifoldReport(indices);
  const degenerate = degenerateTriangles(back, indices);
  if (report.nonManifoldEdges !== 0 || report.inconsistentlyWoundEdges !== 0 || degenerate !== 0) return null;
  const normals = vertexNormals(back, indices);
  const oct = new Int8Array(unique * 2);
  for (let v = 0; v < unique; v += 1) {
    const [u, w] = octEncode(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    oct[v * 2] = u;
    oct[v * 2 + 1] = w;
  }
  const labels = new Uint8Array(unique);
  for (let v = 0; v < unique; v += 1) labels[v] = h.lobes.label[origin[v]];
  return { target, flags, q, oct, indices, back, labels, repair: { droppedPairs: fixed.droppedPairs, splitVertices: fixed.splitVertices, holesClosed: fixed.holesClosed }, report };
}

const fullTris = hemis.reduce((s, h) => s + h.mesh.indices.length / 3, 0);
let budget = 18000;
let tiers = null;
let lowBin = null;
const searched = [];
for (let attempt = 0; attempt < 10; attempt += 1) {
  tiers = hemis.map((h) => {
    // Not every budget comes out clean, so look either side of the share,
    // nearest first, with and without Regularize.
    const share = Math.round(budget * (h.mesh.indices.length / 3) / fullTris);
    for (let k = 0; k <= 40; k += 1) {
      const offset = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 0.005;
      for (const flags of [SIMPLIFY_FLAGS, []]) {
        const t = lowTier(h, Math.round(share * (1 + offset)), flags);
        if (t) return t;
      }
    }
    return fail(GATE, [`${h.name}: no triangle budget within 10% of ${share} gave a clean low tier.`]);
  });
  lowBin = writeMeshBin({ ...qframe, structures: tiers.map((t, k) => ({ id: hemis[k].id, positions: t.q, normals: t.oct, indices: t.indices })) });
  const g = gz(lowBin);
  searched.push({ budgetTriangles: budget, gzipBytes: g });
  if (g <= LOW_GZIP_TARGET && g > LOW_GZIP_TARGET * 0.97) break;
  budget = Math.floor(budget * (LOW_GZIP_TARGET * 0.985) / g);
}
if (gz(lowBin) > LOW_GZIP_TARGET) fail(GATE, [`the low tier did not come under ${LOW_GZIP_TARGET} B gzip`, JSON.stringify(searched)]);
lap('lowTierS');

// 4. Error against the undecimated surface, exact nearest-surface.
function deviation(a, b) {
  const cells = (m) => Math.max(24, Math.round(Math.cbrt(m.indices.length / 3) * 2));
  const ab = oneSidedDistance(a.positions, triangleGrid(b.positions, b.indices, cells(b)));
  const ba = oneSidedDistance(b.positions, triangleGrid(a.positions, a.indices, cells(a)));
  return { hausdorff: Math.max(ab.max, ba.max), mean: (ab.mean * ab.count + ba.mean * ba.count) / (ab.count + ba.count), lowToFullP95: ab.p95, fullToLowP95: ba.p95 };
}
const errors = hemis.map((h, k) => deviation({ positions: tiers[k].back, indices: tiers[k].indices }, { positions: Float64Array.from(h.mesh.positions), indices: h.mesh.indices }));
lap('errorS');

// 5. The cerebellar leak.
const ref = loadReference();
const P = c.P;
const tissueAt = sampler(P, frame);
const leak = {
  reference: { ...REFERENCE, structures: ref.structureCount, heldOutErrorMm: ref.heldOutMm },
  referencePlacement: referenceAgainstCut(ref, c.cutAt, (p) => tissueAt(p[0], p[1], p[2]) > ISO),
  fullSurface: Object.fromEntries(hemis.map((h) => [h.name, countLeak(ref, h.mesh.positions)])),
  shippedLowTier: Object.fromEntries(hemis.map((h, k) => [h.name, countLeak(ref, tiers[k].back)])),
};
lap('leakS');

// 6. Documents.
const lowGz = gz(lowBin);
const lobeKeys = LOBES.filter((l) => l.id >= 1 && l.id <= 6);
const structures = hemis.map((h, k) => {
  const t = tiers[k];
  return {
    id: h.id,
    slot: k,
    name: `Cerebral cortex.${SIDES[k][2]}`,
    label: 'Cerebral cortex',
    category: 'cortex',
    side: h.name,
    sources: [PINNED.source],
    basis: 'First-party surface extracted from the ICBM152 2009c tissue maps (tools/build-icbm-cortex.mjs).',
    low: { triangles: t.indices.length / 3, vertices: t.q.length / 3, areaMm2: round(surfaceArea(t.back, t.indices), 0), enclosedVolumeCm3: round(signedVolume(t.back, t.indices) / 1000, 1) },
    full: { triangles: h.mesh.indices.length / 3, vertices: h.mesh.positions.length / 3, shipped: false },
    errorMm: { hausdorff: round(errors[k].hausdorff, 3), mean: round(errors[k].mean, 3), lowToFullP95: round(errors[k].lowToFullP95, 3), fullToLowP95: round(errors[k].fullToLowP95, 3), measuredAgainst: 'the undecimated extracted surface, at build time; not in the repository, so not re-measurable in CI' },
  };
});
const leakSummary = Object.fromEntries(hemis.map((h) => [h.name, (({ vertices, inside, deeperThan4Mm, deeperThanHeldOutError }) => ({ vertices, inside, deeperThan4Mm, deeperThanHeldOutError }))(leak.shippedLowTier[h.name])]));
const structuresDoc = {
  schema: 'atlas-brain-structures/1',
  id: SET_ID,
  comment: [
    'Generated by tools/build-icbm-cortex.mjs. Do not edit; rebuild.',
    'Positions are MNI152 2009c asymmetric millimetres, RAS, natively: the surface was extracted in the template\'s own space and no affine was applied.',
    'A coordinate in MNI152 2009c asymmetric space needs no mapping to land on it. The lobe labels are a separate file, lobes.json.',
  ],
  source: { upstream: PINNED.source, kind: 'volume', archiveSha256: PINNED.archive.sha256, files: Object.fromEntries(Object.entries(inputs.files).map(([k, v]) => [k, v.sha256])) },
  frame: {
    space: 'MNI152 2009c asymmetric',
    units: 'millimetre',
    axes: { x: 'right (RAS)', y: 'anterior', z: 'superior' },
    quantisation: { origin: qframe.origin, step: qframe.step, quantisationStepMm: round(Math.max(...qframe.step), 5) },
  },
  mapping: { toMni152_2009cAsym: 'identity', affine: null, errorMm: 0, note: 'Native: the surface is extracted from the template volumes in their own sform (sform_code 4, 1 mm, axis-aligned). There is no registration, so there is no registration error. The surface\'s own geometric error is per structure, errorMm.' },
  build: {
    field: `GM + WM - CSF, level ${round(1 - 2 * CSF_CARVE, 2)} (the CSF probability ${CSF_CARVE} level), inside the brain mask`,
    extraction: 'marching tetrahedra (Kuhn 6-tetrahedron split), largest component per hemisphere, hemispheres split at x = 0',
    cerebrumCut: 'tentorial and brainstem cuts measured from the template (provenance/icbm152-2009c-cortex.json); not validated',
    simplifier: 'meshoptimizer 1.3.0 simplify() with Regularize, then a manifold repair (tools/lib/mesh-manifold.mjs); a budget is accepted only with 0 non-manifold edges, 0 inconsistently wound edges, 0 degenerate triangles',
    lowGzipTarget: LOW_GZIP_TARGET,
  },
  tiers: {
    low: { file: FILES.low, bytes: lowBin.length, gzipBytes: lowGz, sha256: sha256(lowBin), loading: 'eager' },
  },
  labels: { file: FILES.lobes, note: 'First-party lobe labels, Apache-2.0, a separate attribution entry.' },
  cerebellarLeak: {
    cutValidated: false,
    method: 'shipped low-tier vertices mapped into the brain-mesh frame by mniToMesh (registration/mni-to-zanatomy-2929e94.json) and tested for being inside the committed Z-Anatomy cerebellum (31 structures) by two-way ray parity; depth is the distance to the nearest cerebellar surface',
    limitation: `The reference is the Z-Anatomy cerebellum carried by an affine whose held-out error is ${ref.heldOutMm} mm at the deep grey nuclei and is extrapolated, unmeasured, at the cerebellum. Only counts deeper than that error are robust to it. No cerebellum label with a licence readable today exists for this template, so the cut is not validated.`,
    shippedLowTier: leakSummary,
    detail: FILES.provenance,
  },
  counts: { structures: structures.length },
  structures,
  excluded: [],
};
const structuresText = `${JSON.stringify(structuresDoc, null, 1)}\n`;

const lowSha = sha256(lowBin);
const xyzRound = (p) => p.map((x) => round(x, 1));
const lobesDoc = {
  schema: 'atlas-brain-labels/1',
  id: 'icbm152-2009c-cortex-lobes',
  comment: [
    'Generated by tools/build-icbm-cortex.mjs. Do not edit; rebuild.',
    'First-party lobe labels for the ICBM152 2009c cortex. Drawn by us from standard anatomical landmarks placed on the ICBM152 surface; no parcellation was used to draw them.',
    'vertexLabels[structure id] has one character per vertex of that structure in the geometry file, in vertex order: the label value, 0 for not cortex (the medial wall and the cut faces).',
  ],
  licence: { id: 'Apache-2.0', holder: 'GStack', firstParty: true, thirdPartyParcellationsUsed: [] },
  space: 'MNI152 2009c asymmetric millimetres, RAS (the geometry\'s own space)',
  geometry: { file: FILES.low, sha256: lowSha, structures: hemis.map((h) => h.id) },
  values: LOBES.filter((l) => l.id <= 6).map((l) => ({ value: l.id, key: l.key, label: l.id === 0 ? 'Not cortex (medial wall, cut faces)' : l.label })),
  structures: hemis.flatMap((h, k) => lobeKeys.map((l) => ({
    id: h.id * 100 + l.id,
    name: `${l.label}.${SIDES[k][2]}`,
    label: l.label,
    side: h.name,
    geometryStructure: h.id,
    value: l.id,
    vertices: [...tiers[k].labels].filter((x) => x === l.id).length,
  }))),
  vertexLabels: Object.fromEntries(hemis.map((h, k) => [String(h.id), Array.from(tiers[k].labels).join('')])),
  conventions: {
    limbic: 'cingulate gyrus and isthmus; the parahippocampal gyrus is labelled temporal (the brief names the cingulate sulcus as the limbic landmark, and no collateral sulcus)',
    insula: 'inside the circular sulcus, placed as the border of the insular floor: laterally facing cortex deeper than 12 mm in the lateral fissure',
    paracentral: 'the central sulcus is carried over the dorsal margin to the cingulate sulcus by a line, which splits the paracentral lobule between frontal and parietal',
    calcarine: 'inside the occipital lobe; not a boundary',
  },
  precision: { geometryToMni: 'identity, 0 mm', surfaceErrorMm: Object.fromEntries(hemis.map((h, k) => [h.name, structures[k].errorMm.hausdorff])), boundaries: 'unstated: no independent measurement of where a lobe boundary truly lies exists for this template' },
  provenance: Object.fromEntries(hemis.map((h) => [h.name, {
    insula: { landmark: 'circular sulcus', placement: lobesInsulaPlacement(), ...h.lobes.insula },
    seeds: h.lobes.seeds,
    boundaries: h.lobes.boundaries.map((b) => ({
      key: b.key,
      landmark: b.landmark,
      separates: b.separates,
      kind: b.kind,
      placement: b.placement,
      coordinates: 'MNI152 2009c asymmetric mm; given = placed by us, snapped = the surface vertex it landed on',
      controlPoints: b.controlPoints.map((p) => ({ role: p.role, snap: p.snap, givenMni: p.givenMni, snappedMni: xyzRound(p.snappedMni) })),
      lengthMm: b.lengthMm,
      meanDepthMm: b.meanDepthMm,
    })),
  }])),
  detail: FILES.provenance,
};
function lobesInsulaPlacement() {
  return `largest connected set of vertices deeper than ${INSULA.minDepthMm} mm with |n_x| >= ${INSULA.lateralNormal} (facing laterally) in |x| ${INSULA.box.absX.join('-')}, y ${INSULA.box.y.join('..')}, z ${INSULA.box.z.join('..')}, holes filled; its border is the circular sulcus`;
}
const lobesText = `${JSON.stringify(lobesDoc)}\n`;

const provenanceDoc = {
  schema: 'icbm152-2009c-cortex-build/1',
  generatedBy: 'tools/build-icbm-cortex.mjs',
  inputs,
  method: {
    ...c.method,
    surfaceField: structuresDoc.build.field,
    isoLevel: round(1 - 2 * CSF_CARVE, 2),
    depth: `distance to the outside of the hemisphere's morphological closing, radius ${CLOSING_RADIUS_MM} mm; on the medial cap, CSF summed ${HIDDEN_REACH_MM} mm into the hemisphere`,
    cutProbeMm: CUT_PROBE_MM,
  },
  hemispheres: hemis.map((h, k) => ({
    id: h.id,
    name: h.name,
    extraction: h.extraction,
    low: { ...structures[k].low, targetTriangles: tiers[k].target, simplifierFlags: tiers[k].flags, repair: tiers[k].repair, manifold: tiers[k].report },
    errorMm: structures[k].errorMm,
    lobes: {
      vertexCounts: Object.fromEntries(lobeKeys.map((l) => [l.key, [...h.lobes.label].filter((x) => x === l.id).length])),
      nonCortex: h.lobes.nonCortex,
      bandVertices: h.lobes.bandVertices,
      sideSeeds: h.lobes.sideSeeds,
      sideConflicts: h.lobes.sideConflicts,
      openFronts: h.lobes.openFronts,
      fragments: h.lobes.fragments,
      unreachedVertices: h.lobes.unreachedVertices,
      boundaries: h.lobes.boundaries.map(({ vertices, ...b }) => ({ ...b, polylineMni: vertices.filter((_, i) => i % 4 === 0).map((v) => xyzRound([h.mesh.positions[v * 3], h.mesh.positions[v * 3 + 1], h.mesh.positions[v * 3 + 2]])) })),
    },
  })),
  lowTierSearch: searched,
  cerebellarLeak: leak,
  timingsS: timings,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(ASSETS, FILES.low), lowBin);
writeFileSync(join(ASSETS, FILES.structures), structuresText);
writeFileSync(join(ASSETS, FILES.lobes), lobesText);
writeFileSync(join(ASSETS, FILES.provenance), `${JSON.stringify(provenanceDoc, null, 1)}\n`);
lap('writeS');

const total = lowGz + gz(Buffer.from(structuresText)) + gz(Buffer.from(lobesText));
console.log([
  `ICBM152 2009c cortex: CSF ${CSF_CARVE} level, ${hemis.map((h) => `${h.name} ${h.mesh.indices.length / 3} tris`).join(', ')}`,
  ...hemis.map((h, k) => `  ${h.name}: low ${structures[k].low.triangles} tris, Hausdorff ${structures[k].errorMm.hausdorff} mm (mean ${structures[k].errorMm.mean}); non-manifold ${tiers[k].report.nonManifoldEdges}; lobes ${JSON.stringify(provenanceDoc.hemispheres[k].lobes.vertexCounts)}`),
  `  cortex.lowres.bin ${lowBin.length} B, gzip ${lowGz} B; with structures.json and lobes.json ${total} B gzip`,
  `  leak (shipped low tier, inside / deeper than 4 mm / deeper than ${ref.heldOutMm} mm): ${hemis.map((h) => { const l = leak.shippedLowTier[h.name]; return `${h.name} ${l.inside}/${l.deeperThan4Mm}/${l.deeperThanHeldOutError} of ${l.vertices}`; }).join(', ')}`,
  `  reference placement: ${JSON.stringify(leak.referencePlacement)}`,
  `  wrote ${Object.values(FILES).map((f) => rel(join(ASSETS, f))).join(', ')}; ${Object.values(timings).reduce((s, t) => s + t, 0).toFixed(0)} s`,
].join('\n'));
