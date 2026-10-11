/**
 * PROTOTYPE. A first-party cerebral cortical surface from the ICBM152 2009c
 * template, as the pre-decided fallback if the Z-Anatomy cortex is never
 * licence-cleared. Nothing this writes is shipped; the owner decides that
 * (DOG-123). See docs/brain-cortex-fallback.md.
 *
 *   (cd tools/mesh-build && npm ci)        # once: the build-only simplifier
 *   node tools/build-icbm-cortex.mjs --icbm <dir> [--out <dir>]
 *
 * `<dir>` holds the extracted archive `mni_icbm152_nlin_asym_09c_nifti.zip`
 * (source `icbm152-2009c` in packages/atlas-assets/attribution.json), i.e.
 * `<dir>/mni_icbm152_nlin_asym_09c/*.nii`. If the zip itself is also in
 * `<dir>` its SHA-256 is checked too. Every file read is checked against the
 * SHA-256 recorded below first; a file that does not match is refused, not
 * built from. `--out` defaults to `$PAPERCLIP_TASK_SCRATCH_DIR/icbm-out`. It
 * is never the repository: the outputs are image-derived and uncleared for
 * shipping until the owner says otherwise.
 *
 * Writes `icbm-cortex.fullres.bin`, `icbm-cortex.lowres.bin` (ATLM, MNI RAS
 * millimetres, structure 1 = left hemisphere, 2 = right) and
 * `icbm-cortex.report.json`.
 *
 * The decisions, and why:
 *
 *   - THE SURFACE IS THE 0.5 LEVEL OF GM + WM PROBABILITY. The 2009c tissue
 *     maps are probabilities, so GM + WM = 0.5 is where a voxel is as likely to
 *     be brain tissue as CSF or background: the probabilistic pial boundary.
 *     The NIfTI files are int16 with `scl_slope`/`scl_inter`, which
 *     tools/lib/nifti.mjs does not apply, so they are applied here. Voxels
 *     outside the distribution's own brain mask (mask < 0.5) are zeroed first,
 *     so a stray tissue probability in the scalp cannot grow a surface.
 *   - CEREBRUM ONLY, BY A GEOMETRIC RULE MEASURED FROM THE TEMPLATE. The
 *     distribution has no cerebellum or brainstem label, and at 1 mm the
 *     tentorium is not resolved everywhere: medially GM + WM stays above 0.9
 *     straight through it, so no threshold or erosion separates the cerebellum.
 *     Two cuts, both stated as constants below:
 *       1. Tentorial cut. Where the tentorium IS resolved, a column of the
 *          volume shows a gap (GM + WM < 0.6) with tissue (> 0.8) within 8 mm
 *          above and below it. The deepest such gap per column, over the
 *          posterior fossa footprint, is a measured tentorium sample. A surface
 *          z = a + b*y + c*|x| + d*|x|*y is fitted to them by least squares
 *          (one refit after dropping residuals over 6 mm), clamped to
 *          [-40, -3] mm, and every voxel below it with y <= -30 is removed.
 *          The fit is re-derived from the data on every run and its sample
 *          count and residual are reported.
 *       2. Brainstem cut. Every voxel with |x| <= 15, -50 <= y <= -6 and
 *          z < -12 is removed: the midbrain and pons below the diencephalon.
 *          The medial temporal lobes sit at |x| >= 16 at those levels, which
 *          is what the 15 is chosen against.
 *     What it costs, stated rather than hidden: medially the cut is an
 *     extrapolation of the fit, so it can leave a sliver of superior vermis
 *     attached or shave the inferior lingual gyrus; the brainstem box leaves a
 *     flat cap under the diencephalon; and neither cut is checked against an
 *     anatomical label, because there is none in the distribution. The voxel
 *     volume each cut removes is reported.
 *   - HEMISPHERES SPLIT AT x = 0. MNI RAS, x < 0 is left, so the voxel column
 *     at x = 0 goes to the right. Each hemisphere is a separate closed surface
 *     with a flat medial cap where the corpus callosum and diencephalon were
 *     cut; the two caps are coincident at x = -0.5 mm. Without the split the
 *     two hemispheres are one component through the corpus callosum.
 *   - LARGEST COMPONENT PER HEMISPHERE. Isolated islands (CSF-partial-volume
 *     specks, a cut-off piece of the inferior occipital lobe) are dropped; the
 *     count and triangle total of what was dropped are reported.
 *   - MARCHING TETRAHEDRA (tools/lib/marching-cubes.mjs), so the surface is a
 *     closed 2-manifold before simplification. The report re-checks that.
 *   - TIERS AS IN tools/lib/brain-meshes.mjs. Full = the extracted surface,
 *     reordered and quantised, not decimated. Low = meshoptimizer simplify()
 *     to a triangle budget shared between hemispheres in proportion to their
 *     full triangle counts. The budget is not a fixed count: it is searched
 *     for until the low tier's gzip size is at most LOW_GZIP_TARGET, because
 *     the constraint the project actually has is bytes (docs/performance-
 *     budget.md, `lowResBrainAssetGzipBytes` = 1.00 MiB), not triangles.
 *   - LOW_GZIP_TARGET = 280,000 B. The committed low tier is 760,620 B gzip,
 *     which leaves 287,956 B under the 1.00 MiB share; a cortex that ships
 *     ALONGSIDE it must fit there, so 280,000 B leaves ~8 KB for the
 *     structures document and rounding. That is stricter than the 350 KB the
 *     prototype was briefed with, which would overrun the share by ~62 KB.
 *   - ERROR IS MEASURED LOW VS FULL, symmetric Hausdorff and mean over every
 *     vertex with exact nearest-surface distance: surfaceDeviation's method
 *     (tools/lib/mesh-geometry.mjs), called through its parts with a finer
 *     triangle grid, because the default 24-cell grid puts thousands of
 *     full-tier triangles in every cell. The grid only changes speed; the
 *     search is exact either way.
 *   - NATIVELY MNI. Positions are MNI RAS millimetres, straight from the NIfTI
 *     sform (checked to be sform_code 4, axis aligned, 1 mm). No affine is
 *     applied. The one place the registration affine appears is the
 *     indicative alignment figure in the report, labelled as such.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { REPO_ROOT, fail, rel } from './lib/repo.mjs';
import { parseNifti } from './lib/nifti.mjs';
import { octEncode, readMeshBin, structureGeometry, writeMeshBin } from './lib/meshbin.mjs';
import { dequantise, quantisationFrame } from './lib/brain-meshes.mjs';
import { applyAffine } from './lib/brain-registration.mjs';
import {
  bounds, degenerateTriangles, dropDegenerate, oneSidedDistance, surfaceArea, triangleGrid, vertexNormals,
} from './lib/mesh-geometry.mjs';
import { keepComponents, manifoldReport, marchingTetrahedra, meshComponents, signedVolume } from './lib/marching-cubes.mjs';

const GATE = 'build-icbm-cortex';

/** What was measured on 2026-10-11: the archive as served, and the entries read from it. */
const PINNED = Object.freeze({
  source: 'icbm152-2009c',
  url: 'https://www.bic.mni.mcgill.ca/~vfonov/icbm/2009/mni_icbm152_nlin_asym_09c_nifti.zip',
  archive: {
    name: 'mni_icbm152_nlin_asym_09c_nifti.zip',
    bytes: 58602393,
    sha256: '804382e5d68a42ff8096ee845a7600b6658434da762fa67840a149eb25d48bd4',
  },
  dir: 'mni_icbm152_nlin_asym_09c',
  files: {
    gm: { name: 'mni_icbm152_gm_tal_nlin_asym_09c.nii', sha256: '781550eec4b7f0e33abfba267b96887a32cf57f9482c958c700f9e35199cc666' },
    wm: { name: 'mni_icbm152_wm_tal_nlin_asym_09c.nii', sha256: '337525d68780df3eef82539cf1ff3f44efeb4d988379407cf7a678303bd913d4' },
    mask: { name: 'mni_icbm152_t1_tal_nlin_asym_09c_mask.nii', sha256: '7d80b651fc5f11bae015f28577b9e9b4211d11910b4d215f6a8fb47fc2ab2b40' },
  },
});

const ISO = 0.5;
const MASK_MIN = 0.5;
const TENT = Object.freeze({
  // Sampling window for tentorium gaps, MNI mm.
  absX: [4, 64],
  y: [-100, -30],
  z: [-40, 5],
  gapMax: 0.6,
  tissueMin: 0.8,
  reachMm: 8,
  rejectResidualMm: 6,
  clampZ: [-40, -3],
  // The cut applies at and behind this coronal plane.
  applyYMax: -30,
});
const BRAINSTEM = Object.freeze({ absXMax: 15, y: [-50, -6], zBelow: -12 });
const LOW_GZIP_TARGET = 280000;
const COMMITTED_LOW_GZIP = 760620;
const LOW_RES_BRAIN_SHARE = 1048576;
const LEFT = 1;
const RIGHT = 2;

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { icbm: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--icbm') opts.icbm = argv[(i += 1)];
    else if (argv[i] === '--out') opts.out = argv[(i += 1)];
    else fail(GATE, [`unknown argument ${argv[i]}`]);
  }
  if (!opts.icbm) fail(GATE, ['Pass --icbm <dir> holding the extracted ICBM152 2009c archive.', `Fetch: curl -o ${PINNED.archive.name} ${PINNED.url}`]);
  if (!opts.out) {
    if (!process.env.PAPERCLIP_TASK_SCRATCH_DIR) fail(GATE, ['Pass --out <dir>; there is no $PAPERCLIP_TASK_SCRATCH_DIR to default to.']);
    opts.out = join(process.env.PAPERCLIP_TASK_SCRATCH_DIR, 'icbm-out');
  }
  if (opts.out.startsWith(REPO_ROOT)) fail(GATE, [`--out ${opts.out} is inside the repository. These outputs are not cleared to ship; write them elsewhere.`]);
  return opts;
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const gz = (b) => gzipSync(b, { level: 9 }).length;
const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
const timings = {};
let mark = performance.now();
const lap = (name) => {
  const now = performance.now();
  timings[name] = round((now - mark) / 1000, 2);
  mark = now;
};

/** Read and verify one pinned NIfTI, returning its header and scaled float values. */
function readVolume(dir, pin) {
  const candidates = [join(dir, PINNED.dir, pin.name), join(dir, pin.name)];
  const path = candidates.find((p) => existsSync(p));
  if (!path) fail(GATE, [`${pin.name} is not in ${dir} or ${join(dir, PINNED.dir)}. Extract ${PINNED.archive.name} there.`]);
  const bytes = readFileSync(path);
  const sha = sha256(bytes);
  if (sha !== pin.sha256) {
    fail(GATE, [`${path} has SHA-256 ${sha}.`, `The recorded value is ${pin.sha256}.`, 'This is not the file that was measured. Re-fetch the archive, or re-measure and re-record.']);
  }
  const img = parseNifti(bytes);
  // nifti.mjs returns raw stored values. The 2009c maps are int16 scaled by
  // scl_slope / scl_inter (header bytes 112 and 116); 0 slope means unscaled.
  const slope = bytes.readFloatLE(112) || 1;
  const inter = bytes.readFloatLE(116);
  const voxOffset = Math.round(bytes.readFloatLE(108));
  if (img.datatype !== 'int16') fail(GATE, [`${pin.name} is ${img.datatype}; this tool reads the int16 2009c maps.`]);
  const values = new Float32Array(img.voxels);
  for (let v = 0; v < img.voxels; v += 1) values[v] = bytes.readInt16LE(voxOffset + v * 2) * slope + inter;
  return { path, sha, img, values, slope, inter };
}

/** World axes must be RAS, axis-aligned, 1 mm, MNI: then voxel (i,j,k) -> mm is a translation. */
function checkFrame(vols) {
  const ref = vols[0].img;
  for (const v of vols) {
    if (v.img.sformCode !== 4) fail(GATE, [`${v.path} declares sform_code ${v.img.sformCode}, not 4 (mni_152).`]);
    if (v.img.dim.join() !== ref.dim.join() || JSON.stringify(v.img.srow) !== JSON.stringify(ref.srow)) {
      fail(GATE, [`${v.path} is not on the same grid as ${vols[0].path}.`]);
    }
  }
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      if (ref.srow[r][c] !== (r === c ? 1 : 0)) fail(GATE, [`sform is not the 1 mm RAS identity (row ${r}: ${ref.srow[r].join(', ')}). This tool assumes it.`]);
    }
  }
  return { dims: ref.dim, offset: [ref.srow[0][3], ref.srow[1][3], ref.srow[2][3]] };
}

/** Least squares for z = a + b*y + c*ax + d*ax*y. */
function fitTent(samples) {
  const rows = samples.map(([ax, y]) => [1, y, ax, ax * y]);
  const ata = Array.from({ length: 4 }, () => new Float64Array(5));
  rows.forEach((r, n) => {
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) ata[i][j] += r[i] * r[j];
      ata[i][4] += r[i] * samples[n][2];
    }
  });
  for (let col = 0; col < 4; col += 1) {
    let p = col;
    for (let r = col + 1; r < 4; r += 1) if (Math.abs(ata[r][col]) > Math.abs(ata[p][col])) p = r;
    [ata[col], ata[p]] = [ata[p], ata[col]];
    for (let r = 0; r < 4; r += 1) {
      if (r === col) continue;
      const f = ata[r][col] / ata[col][col];
      for (let k = col; k < 5; k += 1) ata[r][k] -= f * ata[col][k];
    }
  }
  const coef = ata.map((row, i) => row[4] / row[i]);
  const at = (ax, y) => coef[0] + coef[1] * y + coef[2] * ax + coef[3] * ax * y;
  const residuals = samples.map(([ax, y, z]) => z - at(ax, y));
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
  return { coef, at, residuals, rms };
}

// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const report = { schema: 'icbm-cortex-prototype-report/1', prototype: true, shipped: false };

// 1. Inputs.
const archivePath = join(opts.icbm, PINNED.archive.name);
let archive = { checked: false, note: 'archive not present in --icbm; extracted files checked individually' };
if (existsSync(archivePath)) {
  const bytes = readFileSync(archivePath);
  const sha = sha256(bytes);
  if (sha !== PINNED.archive.sha256 || bytes.length !== PINNED.archive.bytes) {
    fail(GATE, [`${archivePath}: ${bytes.length} B, SHA-256 ${sha}.`, `Recorded: ${PINNED.archive.bytes} B, ${PINNED.archive.sha256}.`]);
  }
  archive = { checked: true, bytes: bytes.length, sha256: sha };
}
const gmV = readVolume(opts.icbm, PINNED.files.gm);
const wmV = readVolume(opts.icbm, PINNED.files.wm);
const maskV = readVolume(opts.icbm, PINNED.files.mask);
const { dims, offset } = checkFrame([gmV, wmV, maskV]);
const [nx, ny, nz] = dims;
const idx = (i, j, k) => (k * ny + j) * nx + i;
// Voxel index <-> MNI mm is a pure translation here (checked above).
const toI = (x) => x - offset[0];
const toJ = (y) => y - offset[1];
const toK = (z) => z - offset[2];
report.inputs = {
  source: PINNED.source,
  url: PINNED.url,
  archive,
  files: Object.fromEntries([['gm', gmV], ['wm', wmV], ['mask', maskV]].map(([k, v]) => [k, { file: `${PINNED.dir}/${PINNED.files[k].name}`, sha256: v.sha, sclSlope: v.slope, sclInter: v.inter }])),
  grid: { dims, voxelMm: 1, originMm: offset, space: 'MNI152 2009c asymmetric (sform_code 4), RAS' },
};
lap('readAndVerifyS');

// 2. Tissue field: P = GM + WM inside the brain mask.
const P = new Float32Array(gmV.values.length);
let tissueVoxels = 0;
for (let v = 0; v < P.length; v += 1) {
  P[v] = maskV.values[v] >= MASK_MIN ? gmV.values[v] + wmV.values[v] : 0;
  if (P[v] > ISO) tissueVoxels += 1;
}
const Pat = (x, y, z) => P[idx(toI(x), toJ(y), toK(z))];

// 3. The tentorium, measured where it is resolved, then fitted.
const samples = [];
for (let ax = TENT.absX[0]; ax <= TENT.absX[1]; ax += 1) {
  for (const x of [-ax, ax]) {
    for (let y = TENT.y[0]; y <= TENT.y[1]; y += 1) {
      let best = null;
      let bestV = TENT.gapMax;
      for (let z = TENT.z[1]; z >= TENT.z[0]; z -= 1) {
        const v = Pat(x, y, z);
        if (v >= bestV) continue;
        let up = false;
        let down = false;
        for (let t = 1; t <= TENT.reachMm && !(up && down); t += 1) {
          if (Pat(x, y, z + t) > TENT.tissueMin) up = true;
          if (Pat(x, y, z - t) > TENT.tissueMin) down = true;
        }
        if (up && down) {
          bestV = v;
          best = z;
        }
      }
      if (best !== null) samples.push([ax, y, best]);
    }
  }
}
if (samples.length < 50) fail(GATE, [`only ${samples.length} tentorium samples; the fit would be meaningless.`]);
const firstFit = fitTent(samples);
const kept = samples.filter((_, n) => Math.abs(firstFit.residuals[n]) <= TENT.rejectResidualMm);
const tent = fitTent(kept);
const zTent = (x, y) => Math.min(TENT.clampZ[1], Math.max(TENT.clampZ[0], tent.at(Math.abs(x), y)));
const tentAt = {};
for (const ax of [0, 10, 20, 40, 60]) for (const y of [-40, -60, -80, -100]) tentAt[`|x|=${ax},y=${y}`] = round(zTent(ax, y), 1);
lap('tentoriumFitS');

// 4. Cerebrum mask, and what each cut removed.
let removedTent = 0;
let removedStem = 0;
const cerebrum = new Uint8Array(P.length);
for (let k = 0; k < nz; k += 1) {
  const z = k + offset[2];
  for (let j = 0; j < ny; j += 1) {
    const y = j + offset[1];
    for (let i = 0; i < nx; i += 1) {
      const v = idx(i, j, k);
      if (P[v] <= 0) continue;
      const x = i + offset[0];
      const stem = Math.abs(x) <= BRAINSTEM.absXMax && y >= BRAINSTEM.y[0] && y <= BRAINSTEM.y[1] && z < BRAINSTEM.zBelow;
      const below = y <= TENT.applyYMax && z < zTent(x, y);
      if (stem || below) {
        if (P[v] > ISO) {
          if (stem) removedStem += 1;
          else removedTent += 1;
        }
        continue;
      }
      cerebrum[v] = 1;
    }
  }
}
report.method = {
  isoLevel: ISO,
  field: 'GM + WM probability (scl_slope/scl_inter applied), zeroed where the brain mask < 0.5',
  extraction: 'marching tetrahedra, Kuhn 6-tetrahedron split (tools/lib/marching-cubes.mjs)',
  hemispheres: 'split at MNI x = 0; x < 0 left (structure 1), x >= 0 right (structure 2)',
  cerebrumRule: {
    tentorium: {
      rule: `remove voxels with y <= ${TENT.applyYMax} and z < clamp(a + b*y + c*|x| + d*|x|*y, ${TENT.clampZ.join(', ')})`,
      sampling: `per column |x| in [${TENT.absX}], y in [${TENT.y}], the deepest z in [${TENT.z}] with GM+WM < ${TENT.gapMax} and GM+WM > ${TENT.tissueMin} within ${TENT.reachMm} mm above and below`,
      samples: samples.length,
      samplesKept: kept.length,
      coefficients: { a: round(tent.coef[0], 4), b: round(tent.coef[1], 5), c: round(tent.coef[2], 5), d: round(tent.coef[3], 6) },
      rmsResidualMm: round(tent.rms, 2),
      cutZMmAt: tentAt,
    },
    brainstem: { rule: `remove voxels with |x| <= ${BRAINSTEM.absXMax}, ${BRAINSTEM.y[0]} <= y <= ${BRAINSTEM.y[1]}, z < ${BRAINSTEM.zBelow}` },
    tissueVoxelsAboveIso: tissueVoxels,
    removedByTentoriumCutVoxels: removedTent,
    removedByBrainstemCutVoxels: removedStem,
    removedShare: round((removedTent + removedStem) / tissueVoxels, 4),
    note: 'Voxels are 1 mm^3. Counts are of voxels with GM+WM > iso. No anatomical label exists in the distribution to check the cut against; its anatomical accuracy is UNVERIFIED.',
  },
};
lap('cerebrumMaskS');

// 5. Extract each hemisphere, keep its largest component, move to MNI mm.
const hemis = [];
for (const [id, name, inSide] of [[LEFT, 'left', (i) => i + offset[0] < 0], [RIGHT, 'right', (i) => i + offset[0] >= 0]]) {
  const field = new Float32Array(P.length);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const v = idx(i, j, k);
        if (!cerebrum[v] || !inSide(i)) continue;
        field[v] = P[v];
        if (P[v] > ISO) {
          lo[0] = Math.min(lo[0], i); lo[1] = Math.min(lo[1], j); lo[2] = Math.min(lo[2], k);
          hi[0] = Math.max(hi[0], i); hi[1] = Math.max(hi[1], j); hi[2] = Math.max(hi[2], k);
        }
      }
    }
  }
  const raw = marchingTetrahedra(field, dims, ISO, { lo, hi });
  const comps = meshComponents(raw.indices, raw.positions.length / 3);
  const mesh = keepComponents(raw, comps.triangleComponent, [0]);
  for (let v = 0; v < mesh.positions.length; v += 3) {
    for (let a = 0; a < 3; a += 1) mesh.positions[v + a] += offset[a];
  }
  const dropped = comps.sizes.slice(1);
  hemis.push({
    id, name, mesh,
    extraction: {
      trianglesExtracted: raw.indices.length / 3,
      components: comps.count,
      keptComponentTriangles: comps.sizes[0],
      droppedComponents: dropped.length,
      droppedTriangles: dropped.reduce((s, n) => s + n, 0),
      largestDroppedTriangles: dropped[0] ?? 0,
      ...manifoldReport(mesh.indices),
      degenerateTriangles: degenerateTriangles(mesh.positions, mesh.indices),
      enclosedVolumeCm3: round(signedVolume(mesh.positions, mesh.indices) / 1000, 1),
      areaCm2: round(surfaceArea(mesh.positions, mesh.indices) / 100, 1),
    },
  });
}
lap('extractS');

// 6. Tiers.
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

// The next three mirror tools/lib/brain-meshes.mjs, which does not export
// them, with one difference in `quantise`: vertices that land on the same
// int16 position are merged BEFORE collapsed triangles are dropped. Marching
// tetrahedra puts crossings within EPS (1e-4 voxel) of a grid point when a
// value sits next to the iso level; those slivers collapse at the 0.003 mm
// step, and dropping them without the merge took 1,081 triangles out of the
// left hemisphere's full tier in the first run, each leaving open edges. Merging first makes the drop an edge collapse, not a hole.
function quantise(mesh, frame) {
  const n0 = mesh.positions.length / 3;
  const slot = new Map();
  const remap = new Uint32Array(n0);
  const qList = [];
  for (let v = 0; v < n0; v += 1) {
    const t = [0, 1, 2].map((a) => Math.max(-32767, Math.min(32767, Math.round((mesh.positions[v * 3 + a] - frame.origin[a]) / frame.step[a]))));
    const key = `${t[0]},${t[1]},${t[2]}`;
    let id = slot.get(key);
    if (id === undefined) {
      id = qList.length / 3;
      slot.set(key, id);
      qList.push(t[0], t[1], t[2]);
    }
    remap[v] = id;
  }
  const q = Int16Array.from(qList);
  const n = q.length / 3;
  const back = dequantise(q, frame);
  const keep = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = [remap[mesh.indices[t]], remap[mesh.indices[t + 1]], remap[mesh.indices[t + 2]]];
    if (degenerateTriangles(back, tri) === 0) keep.push(tri[0], tri[1], tri[2]);
  }
  const indices = Uint32Array.from(keep);
  const normals = vertexNormals(back, indices);
  const oct = new Int8Array(n * 2);
  for (let v = 0; v < n; v += 1) {
    const [u, w] = octEncode(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    oct[v * 2] = u;
    oct[v * 2 + 1] = w;
  }
  return { q, oct, indices, dequantised: back };
}
/** Vertex-cache and fetch order (reorderMesh rewrites `indices` in place), unreferenced vertices dropped. */
function reordered(mesh) {
  const indices = Uint32Array.from(mesh.indices);
  const [remap, unique] = M.MeshoptEncoder.reorderMesh(indices, true, true);
  const positions = new Float32Array(unique * 3);
  for (let v = 0; v < Math.min(remap.length, mesh.positions.length / 3); v += 1) {
    const to = remap[v];
    if (to === 0xffffffff) continue;
    positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), to * 3);
  }
  return { positions, indices };
}
function decimate(mesh, target) {
  if (target >= mesh.indices.length / 3) return mesh;
  const [indices] = M.MeshoptSimplifier.simplify(Uint32Array.from(mesh.indices), mesh.positions, 3, target * 3, 1, ['LockBorder']);
  return { positions: mesh.positions, indices: dropDegenerate(indices) };
}

const frame = quantisationFrame(hemis.map((h) => h.mesh));
const fullTier = hemis.map((h) => {
  const r = reordered(h.mesh);
  return { h, mesh: r, q: quantise(r, frame) };
});
const fullBin = writeMeshBin({ ...frame, structures: fullTier.map((f) => ({ id: f.h.id, positions: f.q.q, normals: f.q.oct, indices: f.q.indices })) });
lap('fullTierS');

const fullTris = fullTier.reduce((s, f) => s + f.q.indices.length / 3, 0);
let budget = 40000;
let lowTier = null;
let lowBin = null;
const searched = [];
for (let attempt = 0; attempt < 8; attempt += 1) {
  lowTier = fullTier.map((f) => {
    const target = Math.max(1, Math.round(budget * (f.q.indices.length / 3) / fullTris));
    const r = reordered(decimate(f.mesh, target));
    return { f, target, simplified: r.indices.length / 3, q: quantise(r, frame) };
  });
  lowBin = writeMeshBin({ ...frame, structures: lowTier.map((l) => ({ id: l.f.h.id, positions: l.q.q, normals: l.q.oct, indices: l.q.indices })) });
  const g = gz(lowBin);
  searched.push({ budgetTriangles: budget, gzipBytes: g });
  if (g <= LOW_GZIP_TARGET && g > LOW_GZIP_TARGET * 0.97) break;
  // Bytes scale close to linearly with triangles; aim 1.5% under the target.
  budget = Math.floor(budget * (LOW_GZIP_TARGET * 0.985) / g);
}
if (gz(lowBin) > LOW_GZIP_TARGET) fail(GATE, [`low tier search did not converge under ${LOW_GZIP_TARGET} B gzip`, JSON.stringify(searched)]);
lap('lowTierS');

/** surfaceDeviation (mesh-geometry.mjs) with a finer triangle grid. Exact either way. */
function deviation(a, b) {
  const cells = (m) => Math.max(24, Math.round(Math.cbrt(m.indices.length / 3) * 2));
  const ab = oneSidedDistance(a.positions, triangleGrid(b.positions, b.indices, cells(b)));
  const ba = oneSidedDistance(b.positions, triangleGrid(a.positions, a.indices, cells(a)));
  return {
    hausdorff: Math.max(ab.max, ba.max),
    meanSymmetric: (ab.mean * ab.count + ba.mean * ba.count) / (ab.count + ba.count),
    lowToFull: ab,
    fullToLow: ba,
  };
}
report.hemispheres = hemis.map((h, n) => {
  const f = fullTier[n];
  const l = lowTier[n];
  const d = deviation({ positions: l.q.dequantised, indices: l.q.indices }, { positions: f.q.dequantised, indices: f.q.indices });
  return {
    id: h.id,
    name: h.name,
    extraction: h.extraction,
    full: {
      triangles: f.q.indices.length / 3,
      vertices: f.q.q.length / 3,
      collapsedByQuantisation: f.mesh.indices.length / 3 - f.q.indices.length / 3,
      ...manifoldReport(f.q.indices),
      enclosedVolumeCm3: round(signedVolume(f.q.dequantised, f.q.indices) / 1000, 1),
    },
    low: {
      triangles: l.q.indices.length / 3,
      vertices: l.q.q.length / 3,
      targetTriangles: l.target,
      simplifiedTriangles: l.simplified,
      collapsedByQuantisation: l.simplified - l.q.indices.length / 3,
      ...manifoldReport(l.q.indices),
      enclosedVolumeCm3: round(signedVolume(l.q.dequantised, l.q.indices) / 1000, 1),
    },
    errorMm: {
      hausdorff: round(d.hausdorff, 3),
      mean: round(d.meanSymmetric, 3),
      lowToFullP95: round(d.lowToFull.p95, 3),
      fullToLowP95: round(d.fullToLow.p95, 3),
    },
    boundsMm: (() => { const b = bounds(f.q.dequantised); return { min: b.min.map((v) => round(v, 1)), max: b.max.map((v) => round(v, 1)) }; })(),
  };
});
lap('deviationS');

const errs = report.hemispheres.map((h) => h.errorMm.hausdorff).sort((a, b) => a - b);
report.tiers = {
  frame: { space: 'MNI RAS (ICBM152 2009c asymmetric)', units: 'millimetre', origin: frame.origin, step: frame.step, quantisationStepMm: round(Math.max(...frame.step), 5) },
  full: { file: 'icbm-cortex.fullres.bin', bytes: fullBin.length, gzipBytes: gz(fullBin), sha256: sha256(fullBin), triangles: fullTris },
  low: {
    file: 'icbm-cortex.lowres.bin', bytes: lowBin.length, gzipBytes: gz(lowBin), sha256: sha256(lowBin),
    triangles: lowTier.reduce((s, l) => s + l.q.indices.length / 3, 0),
    gzipTarget: LOW_GZIP_TARGET,
    budgetSearch: searched,
  },
  hausdorffMm: { median: errs.length % 2 ? errs[errs.length >> 1] : round((errs[0] + errs[1]) / 2, 3), max: errs.at(-1), over: 'the two hemispheres' },
  budget: {
    lowResBrainShareBytes: LOW_RES_BRAIN_SHARE,
    committedLowTierGzipBytes: COMMITTED_LOW_GZIP,
    headroomBytes: LOW_RES_BRAIN_SHARE - COMMITTED_LOW_GZIP,
    thisLowTierGzipBytes: gz(lowBin),
    headroomAfterBytes: LOW_RES_BRAIN_SHARE - COMMITTED_LOW_GZIP - gz(lowBin),
    note: 'Counts the ATLM bytes only; a structures document of its own would add to it.',
  },
};

// 7. Indicative alignment against the committed brain meshes, through mniToMesh.
const regPath = join(REPO_ROOT, 'packages', 'atlas-assets', 'registration', 'mni-to-zanatomy-2929e94.json');
const meshDir = join(REPO_ROOT, 'packages', 'atlas-assets', 'brain', 'zanatomy-2929e94');
const reg = JSON.parse(readFileSync(regPath, 'utf8'));
const committed = readMeshBin(readFileSync(join(meshDir, 'meshes.fullres.bin')));
const cPos = [];
const cIdx = [];
for (const entry of committed.table) {
  const g = structureGeometry(committed, entry);
  const base = cPos.length / 3;
  for (const p of g.positions) cPos.push(p * 1000);
  for (const i of g.indices) cIdx.push(i + base);
}
const committedPositions = Float64Array.from(cPos);
const committedGrid = triangleGrid(committedPositions, Uint32Array.from(cIdx), 96);
const mapped = [];
for (const l of lowTier) {
  const p = l.q.dequantised;
  for (let v = 0; v < p.length; v += 3) {
    const m = applyAffine(reg.mniToMesh, [p[v], p[v + 1], p[v + 2]]);
    mapped.push(m[0] * 1000, m[1] * 1000, m[2] * 1000);
  }
}
const mappedPositions = Float64Array.from(mapped);
const near = oneSidedDistance(mappedPositions, committedGrid);
const mb = bounds(mappedPositions);
const cb = bounds(committedPositions);
report.indicativeAlignment = {
  label: 'INDICATIVE ONLY. Not a registration error: the committed meshes contain no cortex, so distances are to the nearest NON-cortical structure.',
  affine: `${rel(regPath)} mniToMesh (held-out error ${reg.summary?.heldOut?.meanMm} mm)`,
  frame: 'brain-mesh frame, millimetres (glTF metres x 1000; +x model left, +y superior, +z anterior)',
  icbmLowTierMappedBoundsMm: { min: mb.min.map((v) => round(v, 1)), max: mb.max.map((v) => round(v, 1)), extent: mb.extent.map((v) => round(v, 1)) },
  committedStructures: committed.table.length,
  committedBoundsMm: { min: cb.min.map((v) => round(v, 1)), max: cb.max.map((v) => round(v, 1)), extent: cb.extent.map((v) => round(v, 1)) },
  meanDistanceToNearestCommittedSurfaceMm: round(near.mean, 2),
  p95DistanceMm: round(near.p95, 2),
  maxDistanceMm: round(near.max, 2),
  vertices: near.count,
};
lap('alignmentS');

report.timingsS = timings;
report.timingsS.totalS = round(Object.values(timings).reduce((s, t) => s + t, 0), 2);

mkdirSync(opts.out, { recursive: true });
writeFileSync(join(opts.out, 'icbm-cortex.fullres.bin'), fullBin);
writeFileSync(join(opts.out, 'icbm-cortex.lowres.bin'), lowBin);
writeFileSync(join(opts.out, 'icbm-cortex.report.json'), `${JSON.stringify(report, null, 1)}\n`);

const t = report.tiers;
console.log([
  'ICBM152 2009c cortex PROTOTYPE (not shipped)',
  `  iso ${ISO} on GM+WM; grid ${dims.join('x')} @ 1 mm; tentorium fit ${kept.length}/${samples.length} samples, rms ${round(tent.rms, 2)} mm`,
  `  removed: tentorium cut ${removedTent} vox, brainstem cut ${removedStem} vox (${round(100 * report.method.cerebrumRule.removedShare, 2)}% of ${tissueVoxels})`,
  ...report.hemispheres.map((h) => `  ${h.name}: ${h.extraction.components} components, kept ${h.full.triangles} tris (dropped ${h.extraction.droppedTriangles}); low ${h.low.triangles}; Hausdorff ${h.errorMm.hausdorff} mm, mean ${h.errorMm.mean} mm; non-manifold edges extracted/full/low ${h.extraction.nonManifoldEdges}/${h.full.nonManifoldEdges}/${h.low.nonManifoldEdges}`),
  `  full ${t.full.triangles} tris, ${t.full.bytes} B, gzip ${t.full.gzipBytes} B`,
  `  low  ${t.low.triangles} tris, ${t.low.bytes} B, gzip ${t.low.gzipBytes} B (target <= ${LOW_GZIP_TARGET}); headroom after ${t.budget.headroomAfterBytes} B`,
  `  indicative: mean distance to nearest committed structure ${report.indicativeAlignment.meanDistanceToNearestCommittedSurfaceMm} mm`,
  `  ${report.timingsS.totalS} s; wrote ${opts.out}`,
].join('\n'));
