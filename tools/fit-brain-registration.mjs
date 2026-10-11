/**
 * Fit our own MNI → brain-mesh affine and write it, with its residuals.
 *
 *   node tools/fit-brain-registration.mjs --cit168 <dir>
 *
 * `<dir>` holds CIT168 v1.1.0's `CIT168toMNI152-2009c_prob.nii.gz` (OSF jkzwp,
 * folder MNI152-Nonlin-Asym-2009c), checked against the digest recorded below.
 * The mesh side is read from the committed full-tier brain mesh, so it needs no
 * source mesh. The method and the choice of landmarks are in
 * tools/lib/brain-registration.mjs.
 *
 * Writes packages/atlas-assets/registration/mni-to-zanatomy-<sha7>.json.
 * tools/check-mesh-assets.mjs re-derives everything in it except the MNI
 * centroids (which need the atlas volume) from the committed files.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { REPO_ROOT, fail } from './lib/repo.mjs';
import { parseNifti } from './lib/nifti.mjs';
import { brainAssetPaths } from './lib/brain-asset-paths.mjs';
import { CIT168_LABELS, HELD_OUT, LANDMARKS, MAX_OPEN_EDGE_SHARE, evaluate, meshGeometries, volumeCentroid } from './lib/brain-registration.mjs';

export const CIT168_PROB = Object.freeze({
  file: 'CIT168toMNI152-2009c_prob.nii.gz',
  url: 'https://osf.io/download/w8zq2/',
  sha256: '7a91c36701f36d9d908479b862e65a879d15f54badcec6878e61d857ab570f66',
});

const args = process.argv.slice(2);
const dir = args.includes('--cit168') ? args[args.indexOf('--cit168') + 1] : null;
if (!dir) fail('fit-brain-registration', ['Pass --cit168 <dir> holding CIT168toMNI152-2009c_prob.nii.gz.']);
const probPath = join(dir, CIT168_PROB.file);
if (!existsSync(probPath)) fail('fit-brain-registration', [`${probPath} does not exist. Download it from ${CIT168_PROB.url}.`]);
const probBytes = readFileSync(probPath);
const probSha = createHash('sha256').update(probBytes).digest('hex');
if (probSha !== CIT168_PROB.sha256) fail('fit-brain-registration', [`${probPath} has SHA-256 ${probSha}, expected ${CIT168_PROB.sha256}.`]);
const prob = parseNifti(gunzipSync(probBytes));
if (prob.volumes !== CIT168_LABELS.length) fail('fit-brain-registration', [`expected ${CIT168_LABELS.length} volumes, found ${prob.volumes}`]);

/**
 * Probability-weighted centroid of the union of `labels`, on one side of the
 * midline. MNI is RAS, so left is x < 0. Voxels exactly on x = 0 go to neither.
 */
function mniCentroid(labels, side) {
  const t = labels.map((l) => CIT168_LABELS.indexOf(l));
  const [nx, ny, nz] = prob.dim;
  let w = 0;
  const c = [0, 0, 0];
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const [x, y, z] = prob.toWorld(i, j, k);
        if ((side === 'l' && x >= 0) || (side === 'r' && x <= 0)) continue;
        // Union of exclusive labels: probabilities add, capped at 1.
        let p = 0;
        for (const v of t) p += prob.atT(i, j, k, v);
        if (p <= 0) continue;
        p = Math.min(1, p);
        w += p;
        c[0] += p * x;
        c[1] += p * y;
        c[2] += p * z;
      }
    }
  }
  if (!(w > 0)) throw new Error(`CIT168 ${labels.join('+')} has no mass on side ${side}`);
  return { mm: c.map((x) => x / w), mass: w };
}

const attribution = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'atlas-assets', 'attribution.json'), 'utf8'));
const pin = attribution.upstreamSources.find((s) => s.id === 'brainproject-brain-glb').pinned;
const paths = brainAssetPaths(pin.commit);
const structures = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'atlas-assets', paths.structuresFile), 'utf8'));
const full = readFileSync(join(REPO_ROOT, 'packages', 'atlas-assets', paths.fullFile));

const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

function pairsFor(list) {
  const out = [];
  for (const l of list) {
    for (const side of ['l', 'r']) {
      const geoms = meshGeometries(full, structures, l.mesh[side]);
      const m = volumeCentroid(geoms);
      if (m.boundaryEdges > MAX_OPEN_EDGE_SHARE * m.edges) {
        fail('fit-brain-registration', [
          `${l.key}.${side}: the mesh surface is open (${m.boundaryEdges} of ${m.edges} edges on a boundary); its volume centroid is not defined.`,
        ]);
      }
      const mni = mniCentroid(l.cit168, side);
      // Rounded BEFORE the fit, to the precision the file records, so the file
      // is self-consistent: refitting its own numbers gives its own affine.
      out.push({
        id: `${l.key}.${side}`,
        cit168: l.cit168,
        meshStructures: l.mesh[side],
        mniMm: mni.mm.map((x) => round(x, 3)),
        meshM: m.centroid.map((x) => round(x, 7)),
        openEdges: `${m.boundaryEdges} of ${m.edges}`,
      });
    }
  }
  return out;
}

const fit = pairsFor(LANDMARKS);
const held = pairsFor(HELD_OUT);
const r = evaluate(fit, held);

const stats = (xs) => ({ meanMm: round(xs.reduce((n, x) => n + x.mm, 0) / xs.length, 2), maxMm: round(Math.max(...xs.map((x) => x.mm)), 2) });

const doc = {
  schema: 'atlas-brain-registration/1',
  id: `mni-to-${paths.id}`,
  comment: [
    'Generated by tools/fit-brain-registration.mjs. Do not edit; refit.',
    'mniToMesh maps ICBM152 2009c (MNI, RAS) millimetres to the brain mesh frame (glTF metres:',
    '+x the model\'s left, +y superior, +z anterior). meshToMni is its inverse. Rows of a 3x4 affine.',
    'A coordinate carried through this affine inherits the held-out error below; it is never exact.',
  ],
  method: {
    model: '12-parameter affine, least squares on landmark centroids',
    mni: 'probability-weighted centroid of the CIT168 v1.1.0 label union per hemisphere (MNI x < 0 is left), in ICBM152 2009c',
    mesh: 'volume centroid (divergence theorem) of the closed Z-Anatomy surface; for the pallidus and hypothalamus, the union of the partitions brainproject cut it into',
    excluded: 'every structure brainproject GENERATED from an atlas with its own affine (STN, SN, accumbens, the amygdala groups as generated, the tracts): fitting to them would return its affine, not ours',
    heldOut: 'the red nucleus, left and right: in both the mesh and CIT168, never in the fit',
  },
  inputs: {
    cit168: { ...CIT168_PROB, source: 'cit168-subcortical', note: 'Centroid coordinates are measurements of the CIT168 atlas, credited to Pauli et al. 2018, CC BY 4.0.' },
    mesh: { file: paths.fullFile, sha256: createHash('sha256').update(full).digest('hex') },
  },
  mniToMesh: r.mniToMesh.map((row) => row.map((x) => round(x, 9))),
  meshToMni: r.meshToMni.map((row) => row.map((x) => round(x, 6))),
  axisScaleMeshMmPerMniMm: r.scales.map((s) => round(s * 1000, 4)),
  landmarks: fit.map((l) => ({
    id: l.id,
    cit168: l.cit168,
    meshStructures: l.meshStructures,
    mniMm: l.mniMm.map((x) => round(x, 3)),
    meshM: l.meshM.map((x) => round(x, 7)),
    openEdges: l.openEdges,
    residualMm: round(r.inSample.find((x) => x.id === l.id).mm, 2),
    leaveOneOutMm: round(r.loo.find((x) => x.id === l.id).mm, 2),
  })),
  heldOut: held.map((l) => ({
    id: l.id,
    cit168: l.cit168,
    meshStructures: l.meshStructures,
    mniMm: l.mniMm.map((x) => round(x, 3)),
    meshM: l.meshM.map((x) => round(x, 7)),
    openEdges: l.openEdges,
    errorMm: round(r.heldOut.find((x) => x.id === l.id).mm, 2),
  })),
  summary: {
    landmarks: fit.length,
    inSample: stats(r.inSample),
    leaveOneOut: stats(r.loo),
    heldOut: stats(r.heldOut),
  },
};

const out = join(REPO_ROOT, 'packages', 'atlas-assets', 'registration', `mni-to-${paths.id}.json`);
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
console.log(JSON.stringify({ summary: doc.summary, scales: doc.axisScaleMeshMmPerMniMm, heldOut: doc.heldOut.map((h) => [h.id, h.errorMm]), loo: doc.landmarks.map((l) => [l.id, l.residualMm, l.leaveOneOutMm]) }, null, 1));
