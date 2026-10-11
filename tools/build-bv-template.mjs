/**
 * The `BV` brain-volume template: ICBM152 bounding box and AC-PC landmarks.
 *
 *   node tools/build-bv-template.mjs --source <dir>
 *
 * `<dir>` holds `mni_icbm152_nlin_asym_09c_nifti.zip` as published by the
 * McConnell Brain Imaging Centre:
 *
 *   https://www.bic.mni.mcgill.ca/~vfonov/icbm/2009/mni_icbm152_nlin_asym_09c_nifti.zip
 *
 * Nothing from that archive is redistributed. What ships is six distances, one
 * landmark and three unit vectors — the template's geometry, measured.
 *
 * WHAT IS MEASURED, AND WHAT IS NOT. This distinction is the whole file.
 *
 *   MEASURED. The voxel grid and the voxel-to-world affine, from the NIfTI
 *   header. That the header's `sform_code` is 4, which is `NIFTI_XFORM_MNI_152`
 *   — the file itself declares which world space its coordinates are in, so
 *   "this is MNI152 space" is read, not assumed. That the world origin falls on
 *   an exact integer voxel index, which is what makes the origin a landmark
 *   rather than a rounding. And the brain's extent in all six directions, from
 *   the non-zero voxels of the distribution's own brain mask.
 *
 *   NOT MEASURED. The distance from the AC to the PC. The distribution ships
 *   images and masks, not landmark coordinates, and locating the posterior
 *   commissure in an image is a segmentation problem, not a header read. So
 *   that distance is recorded as `null` with status `UNVERIFIED` and is not
 *   used by anything. It cannot be: `BrainVolumeTemplate` consumes the AC as
 *   its origin and the AC-PC LINE as its anterior axis, both of which are
 *   measured above, and no field of it is a function of how far back the PC
 *   sits. Writing a plausible 26 mm in there would add a number nobody
 *   measured to a file whose entire purpose is that every number in it was.
 *
 * THE BOUNDING BOX IS THE BRAIN'S, NOT THE IMAGE'S. The image field of view is
 * 193x229x193 mm and includes skull, scalp and a stub of neck. Using it would
 * put `r`-like proportional coordinates at the edge of the field rather than at
 * the edge of the brain, so every `BV` address would denote a place a few
 * millimetres off in a direction that varies by axis. The distribution's
 * `*_mask.nii` is the brain mask the template was built with, and its non-zero
 * extent is the box the frame should normalise against.
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, rel } from './lib/repo.mjs';
import { openZip } from './lib/mesh.mjs';
import { maskBounds, parseNifti } from './lib/nifti.mjs';

const SOURCE = Object.freeze({
  dataset: 'ICBM 152 non-linear atlas, 2009c, asymmetric',
  release: 'mni_icbm152_nlin_asym_09c',
  archive: 'mni_icbm152_nlin_asym_09c_nifti.zip',
  url: 'https://www.bic.mni.mcgill.ca/~vfonov/icbm/2009/mni_icbm152_nlin_asym_09c_nifti.zip',
  holder: 'Louis Collins, McConnell Brain Imaging Centre, Montreal Neurological Institute, McGill University',
  copyrightYears: '1993-2004',
  licence: 'MNI BIC permissive licence (COPYING in the archive)',
  citation:
    'VS Fonov, AC Evans, K Botteron, CR Almli, RC McKinstry, DL Collins and BDCG, '
    + 'Unbiased average age-appropriate atlases for pediatric studies, NeuroImage 54:1 (2011). '
    + 'VS Fonov, AC Evans, RC McKinstry, CR Almli and DL Collins, '
    + 'Unbiased nonlinear average age-appropriate brain templates from birth to adulthood, NeuroImage 47:S102 (2009).',
  maskEntry: 'mni_icbm152_nlin_asym_09c/mni_icbm152_t1_tal_nlin_asym_09c_mask.nii',
  licenceEntry: 'COPYING',
});

function parseArgs(argv) {
  const opts = { source: process.env.ALC_ICBM_DIR ?? null, out: null, id: 'icbm152-2009c-asym' };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    if (argv[i] === '--source') opts.source = next();
    else if (argv[i] === '--out') opts.out = next();
    else if (argv[i] === '--id') opts.id = next();
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!opts.source) {
    throw new Error(
      '--source <dir> (or ALC_ICBM_DIR) must hold the ICBM152 archive. Fetch it with:\n'
      + `  curl -o ${SOURCE.archive} ${SOURCE.url}`,
    );
  }
  return opts;
}

const round = (v, p = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** p) / 10 ** p : v);

/**
 * Which world axis each anatomical direction is, read off the affine.
 *
 * NIfTI world coordinates are RAS by definition of the standard: `+x` is the
 * subject's RIGHT, `+y` anterior, `+z` superior. `BrainVolumeTemplate` wants
 * `left`, so left is `-x`. Rather than hard-code that, each direction is
 * derived from the affine's own columns and then checked for being axis
 * aligned, because a template whose affine had an oblique or permuted rotation
 * would need the full basis and should fail loudly rather than be approximated
 * by the identity.
 */
function anatomicalAxes(img) {
  const col = (c) => [img.srow[0][c], img.srow[1][c], img.srow[2][c]];
  const axes = [col(0), col(1), col(2)];
  for (const [i, a] of axes.entries()) {
    const n = Math.hypot(...a);
    const offAxis = a.filter((v) => Math.abs(v) > 1e-6).length;
    if (offAxis !== 1) {
      throw new Error(
        `the ICBM152 affine's voxel axis ${i} is oblique (${a.map((v) => v.toFixed(4)).join(', ')}). `
        + 'This tool only handles an axis-aligned template; derive the full basis instead of trusting RAS.',
      );
    }
    if (Math.abs(n - img.pixdimMm[i]) > 1e-4) {
      throw new Error(`affine column ${i} has length ${n}, but pixdim says ${img.pixdimMm[i]}`);
    }
  }
  // RAS: right, anterior, superior are the +x, +y, +z world directions.
  return {
    left: [-1, 0, 0],
    anterior: [0, 1, 0],
    superior: [0, 0, 1],
    note: 'NIfTI world coordinates are RAS, so the subject\'s left is -x. Verified axis-aligned above.',
  };
}

const opts = parseArgs(process.argv.slice(2));
const archive = join(opts.source, SOURCE.archive);
if (!existsSync(archive)) throw new Error(`${archive} is missing. Fetch it from ${SOURCE.url}`);

const zip = openZip(archive);
const licenceText = zip.read(SOURCE.licenceEntry).toString('utf8').trim();
const maskBytes = zip.read(SOURCE.maskEntry);
const img = parseNifti(maskBytes);

// The header must say which world space it is in. `sform_code` 4 is
// NIFTI_XFORM_MNI_152; anything else and "the AC is at the origin" is an
// assumption about somebody else's file rather than a fact about this one.
if (img.sformCode !== 4) {
  throw new Error(
    `${SOURCE.maskEntry} declares sform_code ${img.sformCode} (${img.space}), not 4 (mni_152). `
    + 'MNI152 is what puts the AC at the world origin; without that this template has no landmark.',
  );
}

// The AC is the world origin. For it to be a landmark rather than a rounding,
// the origin has to land on an exact voxel index.
const acVoxel = [0, 1, 2].map((a) => -img.srow[a][3] / img.srow[a][a]);
for (const [a, v] of acVoxel.entries()) {
  if (Math.abs(v - Math.round(v)) > 1e-6) {
    throw new Error(
      `the world origin falls at voxel ${acVoxel.map((x) => x.toFixed(4)).join(', ')}, which is not an `
      + `integer index on axis ${a}. The AC landmark would be a rounding.`,
    );
  }
}

const bounds = maskBounds(img);
if (!bounds) throw new Error(`${SOURCE.maskEntry} is all zero; there is no brain to bound`);

// Voxel centres bound the brain; a voxel occupies half a pixdim either side of
// its centre, so the brain's own extent reaches half a voxel further out.
const half = img.pixdimMm.map((p) => p / 2);
const loWorld = img.toWorld(...bounds.lo).map((v, a) => v - half[a]);
const hiWorld = img.toWorld(...bounds.hi).map((v, a) => v + half[a]);
const imageLo = img.toWorld(0, 0, 0).map((v, a) => v - half[a]);
const imageHi = img.toWorld(...img.dim.map((d) => d - 1)).map((v, a) => v + half[a]);

// Extents are distances from the AC, so every one is non-negative.
const extents = {
  left: -loWorld[0],
  right: hiWorld[0],
  anterior: hiWorld[1],
  posterior: -loWorld[1],
  superior: hiWorld[2],
  inferior: -loWorld[2],
};
for (const [name, v] of Object.entries(extents)) {
  if (!(v > 0)) {
    throw new Error(
      `the ${name} extent measured ${v} mm. The AC is supposed to be inside the brain mask; `
      + 'it is not, so either the mask or the affine is not what this tool thinks it is.',
    );
  }
}

/**
 * `maxUsefulDigits` from voxel size, the same way the `BD` pipeline derives it
 * from mesh edge length.
 *
 * A `BV` address with no digits denotes a whole hemisphere: the dimensionless
 * box is the unit cube, and in millimetres its sides are the three extents on
 * that side. Each octree digit halves all three. The finest cell worth issuing
 * is the last one whose smallest side is still at least one voxel, because one
 * digit further the address claims a distinction the template cannot make.
 */
const cell0Mm = [
  Math.max(extents.left, extents.right),
  extents.anterior + extents.posterior,
  extents.superior + extents.inferior,
];
const smallestMm = Math.min(...cell0Mm);
const voxelMm = Math.max(...img.pixdimMm);
const maxUsefulDigits = Math.max(0, Math.min(12, Math.floor(Math.log2(smallestMm / voxelMm))));

const template = {
  id: opts.id,
  acMm: [0, 0, 0],
  left: [-1, 0, 0],
  anterior: [0, 1, 0],
  superior: [0, 0, 1],
  extents: Object.fromEntries(Object.entries(extents).map(([k, v]) => [k, round(v, 2)])),
  maxUsefulDigits,
  provenance: {
    comment: [
      'Derived from the ICBM152 2009c asymmetric distribution by',
      'tools/build-bv-template.mjs. No image data from that archive is',
      'redistributed here: this file is six distances, one landmark and three',
      'unit vectors. See docs/asset-licensing.md.',
    ],
    source: SOURCE,
    generator: 'tools/build-bv-template.mjs',
    archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
    licenceText,
    header: {
      entry: SOURCE.maskEntry,
      dim: img.dim,
      pixdimMm: img.pixdimMm,
      datatype: img.datatype,
      sformCode: img.sformCode,
      declaredSpace: img.space,
      srow: img.srow,
    },
    frame: anatomicalAxes(img),
    landmarks: {
      ac: {
        mm: [0, 0, 0],
        voxelIndex: acVoxel.map((v) => Math.round(v)),
        status: 'MEASURED',
        basis:
          'The world origin of the affine, which falls on an exact integer voxel index. The header '
          + 'declares sform_code 4 (NIFTI_XFORM_MNI_152), and MNI152 places the anterior commissure '
          + 'at the origin of its world coordinates.',
      },
      acpcLine: {
        directionMm: [0, 1, 0],
        status: 'MEASURED',
        basis:
          'The +y world axis, read from the affine and verified axis-aligned. This is the direction '
          + '`BrainVolumeTemplate.anterior` consumes, and it is the AC-PC line of MNI152 space.',
      },
      pc: {
        mm: null,
        distanceFromAcMm: null,
        status: 'UNVERIFIED',
        basis:
          'The PC lies on the AC-PC line posterior of the AC, so its direction is measured, but the '
          + 'distribution ships images and masks rather than landmark coordinates and locating the '
          + 'posterior commissure in an image is a segmentation problem. No field of this template is '
          + 'a function of that distance: the frame uses the AC as its origin and the AC-PC line as '
          + 'its anterior axis, both measured above. A plausible value is therefore not supplied.',
      },
    },
    measurement: {
      brainMaskVoxels: bounds.count,
      brainMaskVoxelBounds: { lo: bounds.lo, hi: bounds.hi },
      brainBoxMm: {
        x: [round(loWorld[0], 2), round(hiWorld[0], 2)],
        y: [round(loWorld[1], 2), round(hiWorld[1], 2)],
        z: [round(loWorld[2], 2), round(hiWorld[2], 2)],
      },
      imageBoxMm: {
        x: [round(imageLo[0], 2), round(imageHi[0], 2)],
        y: [round(imageLo[1], 2), round(imageHi[1], 2)],
        z: [round(imageLo[2], 2), round(imageHi[2], 2)],
      },
      boxNote:
        'brainBoxMm is the extent of the brain mask and is what the frame normalises against. '
        + 'imageBoxMm is the field of view, which includes skull, scalp and neck, and is published '
        + 'only so the difference is visible.',
      precision: {
        maxUsefulDigits,
        hemisphereCellMm: cell0Mm.map((v) => round(v, 2)),
        smallestCellSideMm: round(smallestMm, 2),
        voxelMm,
        rule: 'largest d with min(hemisphere cell side) / 2^d >= one voxel',
        frameCap: 12,
      },
    },
  },
};

const outPath = opts.out
  ?? join(REPO_ROOT, 'packages', 'atlas-assets', 'templates', `${template.id}.brain-volume.json`);
const json = `${JSON.stringify(template, null, 1)}\n`;
writeFileSync(outPath, json);

console.log([
  `template ${template.id}  (${img.space}, sform_code ${img.sformCode})`,
  `  brain mask ${bounds.count.toLocaleString('en-GB')} voxels at ${img.pixdimMm.join('x')} mm`,
  `  brain box  x [${round(loWorld[0], 1)}, ${round(hiWorld[0], 1)}]`
    + `  y [${round(loWorld[1], 1)}, ${round(hiWorld[1], 1)}]`
    + `  z [${round(loWorld[2], 1)}, ${round(hiWorld[2], 1)}] mm`,
  `  image box  x [${round(imageLo[0], 1)}, ${round(imageHi[0], 1)}]`
    + `  y [${round(imageLo[1], 1)}, ${round(imageHi[1], 1)}]`
    + `  z [${round(imageLo[2], 1)}, ${round(imageHi[2], 1)}] mm`,
  `  extents from AC  L ${template.extents.left}  R ${template.extents.right}`
    + `  A ${template.extents.anterior}  P ${template.extents.posterior}`
    + `  S ${template.extents.superior}  I ${template.extents.inferior}`,
  `  AC at voxel (${acVoxel.map((v) => Math.round(v)).join(', ')}), exact; PC distance UNVERIFIED and unused`,
  `  maxUsefulDigits ${maxUsefulDigits} (${round(smallestMm, 1)} mm smallest hemisphere cell side / ${voxelMm} mm voxel)`,
  `  wrote ${rel(outPath)} (${json.length} bytes)`,
].join('\n'));
