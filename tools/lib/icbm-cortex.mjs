/**
 * The ICBM152 2009c cerebral surface, from the template's tissue maps.
 *
 * Shared by the producer (tools/build-icbm-cortex.mjs) and nothing that runs in
 * CI: every function here needs the template volumes, which are not in the
 * repository. The gate (tools/check-icbm-cortex.mjs) works from the committed
 * files alone. The decisions are documented in the producer's header and in
 * docs/brain-cortex-icbm.md.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from './repo.mjs';
import { parseNifti } from './nifti.mjs';
import { degenerateTriangles, surfaceArea } from './mesh-geometry.mjs';
import { keepComponents, manifoldReport, marchingTetrahedra, meshComponents, signedVolume } from './marching-cubes.mjs';

/** What was measured on 2026-10-11: the archive as served, and the entries read from it. */
export const PINNED = Object.freeze({
  source: 'icbm152-2009c',
  url: 'https://www.bic.mni.mcgill.ca/~vfonov/icbm/2009/mni_icbm152_nlin_asym_09c_nifti.zip',
  archive: {
    name: 'mni_icbm152_nlin_asym_09c_nifti.zip',
    bytes: 58602393,
    sha256: '804382e5d68a42ff8096ee845a7600b6658434da762fa67840a149eb25d48bd4',
  },
  dir: 'mni_icbm152_nlin_asym_09c',
  // The archive's licence, at its root. It asks that the copyright notice appear in all copies.
  copying: { name: 'COPYING', sha256: '5915d16f84d99c3cedc8290b09da72f6f92e5dde1ba1c9859ee186aa952b66a4' },
  files: {
    gm: { name: 'mni_icbm152_gm_tal_nlin_asym_09c.nii', sha256: '781550eec4b7f0e33abfba267b96887a32cf57f9482c958c700f9e35199cc666' },
    wm: { name: 'mni_icbm152_wm_tal_nlin_asym_09c.nii', sha256: '337525d68780df3eef82539cf1ff3f44efeb4d988379407cf7a678303bd913d4' },
    csf: { name: 'mni_icbm152_csf_tal_nlin_asym_09c.nii', sha256: '6baf048a874ebabb252e028229cbfd19ddfc835fa7d89efe18ceab86926c87b3' },
    mask: { name: 'mni_icbm152_t1_tal_nlin_asym_09c_mask.nii', sha256: '7d80b651fc5f11bae015f28577b9e9b4211d11910b4d215f6a8fb47fc2ab2b40' },
  },
});

export const ISO = 0.5;
const MASK_MIN = 0.5;
export const TENT = Object.freeze({
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
export const BRAINSTEM = Object.freeze({ absXMax: 15, y: [-50, -6], zBelow: -12 });
export const LEFT = 1;
export const RIGHT = 2;

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

/** Read and verify one pinned NIfTI, returning its header and scaled float values. */
export function readVolume(gate, dir, pin, subdir = PINNED.dir) {
  const candidates = [join(dir, subdir, pin.name), join(dir, pin.name)];
  const path = candidates.find((p) => existsSync(p));
  if (!path) fail(gate, [`${pin.name} is not in ${dir} or ${join(dir, subdir)}.`]);
  const bytes = readFileSync(path);
  const sha = sha256(bytes);
  if (sha !== pin.sha256) {
    fail(gate, [`${path} has SHA-256 ${sha}.`, `The recorded value is ${pin.sha256}.`, 'This is not the file that was measured. Re-fetch it, or re-measure and re-record.']);
  }
  const img = parseNifti(bytes);
  // nifti.mjs returns raw stored values; apply scl_slope / scl_inter (header
  // bytes 112 and 116; 0 slope means unscaled).
  const slope = bytes.readFloatLE(112) || 1;
  const inter = bytes.readFloatLE(116);
  const voxOffset = Math.round(bytes.readFloatLE(108));
  const read = { int16: (v) => bytes.readInt16LE(voxOffset + v * 2), uint8: (v) => bytes[voxOffset + v] }[img.datatype];
  if (!read) fail(gate, [`${pin.name} is ${img.datatype}; only int16 and uint8 volumes are read.`]);
  const values = new Float32Array(img.voxels);
  for (let v = 0; v < img.voxels; v += 1) values[v] = read(v) * slope + inter;
  return { path, sha, img, values, slope, inter };
}

/** World axes must be RAS, axis-aligned, 1 mm: then voxel (i,j,k) -> mm is a translation. */
export function checkFrame(gate, vols, sformCode = 4) {
  const ref = vols[0].img;
  for (const v of vols) {
    if (v.img.sformCode !== sformCode) fail(gate, [`${v.path} declares sform_code ${v.img.sformCode}, not ${sformCode}.`]);
    if (v.img.dim.join() !== ref.dim.join() || JSON.stringify(v.img.srow) !== JSON.stringify(ref.srow)) {
      fail(gate, [`${v.path} is not on the same grid as ${vols[0].path}.`]);
    }
  }
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      if (ref.srow[r][c] !== (r === c ? 1 : 0)) fail(gate, [`sform is not the 1 mm RAS identity (row ${r}: ${ref.srow[r].join(', ')}).`]);
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

/**
 * The tissue field, the tentorium fit and the cerebrum mask. `vols` are the
 * verified gm, wm and mask volumes.
 */
export function cerebrum(gate, { gm, wm, csf, mask }, { dims, offset }, { csfCarve = null } = {}) {
  const [nx, ny, nz] = dims;
  const idx = (i, j, k) => (k * ny + j) * nx + i;
  const P = new Float32Array(gm.values.length);
  let tissueVoxels = 0;
  for (let v = 0; v < P.length; v += 1) {
    P[v] = mask.values[v] >= MASK_MIN ? gm.values[v] + wm.values[v] : 0;
    if (P[v] > ISO) tissueVoxels += 1;
  }
  const Pat = (x, y, z) => P[idx(x - offset[0], y - offset[1], z - offset[2])];

  // The tentorium, measured where it is resolved, then fitted.
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
  if (samples.length < 50) fail(gate, [`only ${samples.length} tentorium samples; the fit would be meaningless.`]);
  const firstFit = fitTent(samples);
  const kept = samples.filter((_, n) => Math.abs(firstFit.residuals[n]) <= TENT.rejectResidualMm);
  const tent = fitTent(kept);
  const zTent = (x, y) => Math.min(TENT.clampZ[1], Math.max(TENT.clampZ[0], tent.at(Math.abs(x), y)));
  const cutAt = (x, y, z) => {
    if (Math.abs(x) <= BRAINSTEM.absXMax && y >= BRAINSTEM.y[0] && y <= BRAINSTEM.y[1] && z < BRAINSTEM.zBelow) return 'brainstem';
    if (y <= TENT.applyYMax && z < zTent(x, y)) return 'tentorium';
    return null;
  };

  let removedTent = 0;
  let removedStem = 0;
  const keep = new Uint8Array(P.length);
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const v = idx(i, j, k);
        if (P[v] <= 0) continue;
        const cut = cutAt(i + offset[0], j + offset[1], k + offset[2]);
        if (cut) {
          if (P[v] > ISO) {
            if (cut === 'brainstem') removedStem += 1;
            else removedTent += 1;
          }
          continue;
        }
        keep[v] = 1;
      }
    }
  }
  const tentAt = {};
  for (const ax of [0, 10, 20, 40, 60]) for (const y of [-40, -60, -80, -100]) tentAt[`|x|=${ax},y=${y}`] = round(zTent(ax, y), 1);
  // The surface field. Uncarved, it is P at ISO. Carved, it is P - CSF at
  // 1 - 2 * csfCarve: inside the mask P + CSF is ~1, so that level is where the
  // CSF probability reaches csfCarve.
  let F = P;
  let isoF = ISO;
  if (csfCarve !== null) {
    F = new Float32Array(P.length);
    for (let v = 0; v < P.length; v += 1) F[v] = P[v] > 0 ? P[v] - csf.values[v] : 0;
    isoF = 1 - 2 * csfCarve;
  }
  return {
    P, F, isoF, keep, idx, cutAt, wm: wm.values, csf: csf.values,
    method: {
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
      },
    },
  };
}

/** Extract each hemisphere, keep its largest component, move to MNI mm. */
export function extractHemispheres({ F, isoF, keep, idx }, { dims, offset }) {
  const [nx, ny, nz] = dims;
  const hemis = [];
  for (const [id, name, inSide] of [[LEFT, 'left', (i) => i + offset[0] < 0], [RIGHT, 'right', (i) => i + offset[0] >= 0]]) {
    const field = new Float32Array(F.length);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < nz; k += 1) {
      for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
          const v = idx(i, j, k);
          if (!keep[v] || !inSide(i)) continue;
          field[v] = F[v];
          if (F[v] > isoF) {
            lo[0] = Math.min(lo[0], i); lo[1] = Math.min(lo[1], j); lo[2] = Math.min(lo[2], k);
            hi[0] = Math.max(hi[0], i); hi[1] = Math.max(hi[1], j); hi[2] = Math.max(hi[2], k);
          }
        }
      }
    }
    const raw = marchingTetrahedra(field, dims, isoF, { lo, hi });
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
  return hemis;
}

/** Trilinear sample of a volume at MNI mm; 0 outside the grid. */
export function sampler(values, { dims, offset }) {
  const [nx, ny, nz] = dims;
  return (x, y, z) => {
    const fi = x - offset[0];
    const fj = y - offset[1];
    const fk = z - offset[2];
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const k = Math.floor(fk);
    if (i < 0 || j < 0 || k < 0 || i + 1 >= nx || j + 1 >= ny || k + 1 >= nz) return 0;
    const u = fi - i;
    const v = fj - j;
    const w = fk - k;
    const at = (a, b, c) => values[((k + c) * ny + (j + b)) * nx + (i + a)];
    return (
      (1 - w) * ((1 - v) * ((1 - u) * at(0, 0, 0) + u * at(1, 0, 0)) + v * ((1 - u) * at(0, 1, 0) + u * at(1, 1, 0)))
      + w * ((1 - v) * ((1 - u) * at(0, 0, 1) + u * at(1, 0, 1)) + v * ((1 - u) * at(0, 1, 1) + u * at(1, 1, 1)))
    );
  };
}

/**
 * Exact squared Euclidean distance transform (Felzenszwalb and Huttenlocher),
 * in voxels, to the nearest voxel where `inside` is 0.
 */
export function distanceTransform(inside, dims) {
  const [nx, ny, nz] = dims;
  const INF = 1e20;
  const d = new Float64Array(inside.length);
  for (let v = 0; v < d.length; v += 1) d[v] = inside[v] ? INF : 0;
  const n = Math.max(nx, ny, nz);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const vv = new Int32Array(n);
  const zz = new Float64Array(n + 1);
  const pass1 = (len) => {
    let k = 0;
    vv[0] = 0;
    zz[0] = -INF;
    zz[1] = INF;
    for (let q = 1; q < len; q += 1) {
      let s;
      for (;;) {
        s = ((f[q] + q * q) - (f[vv[k]] + vv[k] * vv[k])) / (2 * q - 2 * vv[k]);
        if (s <= zz[k]) k -= 1;
        else break;
      }
      k += 1;
      vv[k] = q;
      zz[k] = s;
      zz[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q += 1) {
      while (zz[k + 1] < q) k += 1;
      out[q] = (q - vv[k]) ** 2 + f[vv[k]];
    }
  };
  const lines = [
    [nx, (a, b) => (b * ny + a) * nx, 1, ny, nz],
    [ny, (a, b) => b * ny * nx + a, nx, nx, nz],
    [nz, (a, b) => b * nx + a, nx * ny, nx, ny],
  ];
  for (const [len, base, stride, na, nb] of lines) {
    for (let b = 0; b < nb; b += 1) {
      for (let a = 0; a < na; a += 1) {
        const o = base(a, b);
        for (let q = 0; q < len; q += 1) f[q] = d[o + q * stride];
        pass1(len);
        for (let q = 0; q < len; q += 1) d[o + q * stride] = out[q];
      }
    }
  }
  return d;
}
