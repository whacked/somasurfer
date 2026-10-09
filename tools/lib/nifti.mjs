/**
 * Enough of NIfTI-1 to read a template's geometry and a binary mask.
 *
 * Dependency-free, like everything else under tools/. We need four things from
 * a NIfTI file and no more: the voxel grid, the voxel-to-world affine, which
 * world space that affine claims to be in, and the mask voxels themselves.
 *
 * Spec: https://nifti.nimh.nih.gov/pub/dist/src/niftilib/nifti1.h
 */

/** `sform_code` / `qform_code` values. 4 is the one that matters here. */
export const XFORM = Object.freeze({
  0: 'unknown',
  1: 'scanner_anat',
  2: 'aligned_anat',
  3: 'talairach',
  4: 'mni_152',
});

const DATATYPE = Object.freeze({
  2: { name: 'uint8', size: 1, read: (b, o) => b.readUInt8(o) },
  4: { name: 'int16', size: 2, read: (b, o) => b.readInt16LE(o) },
  8: { name: 'int32', size: 4, read: (b, o) => b.readInt32LE(o) },
  16: { name: 'float32', size: 4, read: (b, o) => b.readFloatLE(o) },
  64: { name: 'float64', size: 8, read: (b, o) => b.readDoubleLE(o) },
  512: { name: 'uint16', size: 2, read: (b, o) => b.readUInt16LE(o) },
});

/**
 * Parse a single-file NIfTI-1 (`n+1`) buffer.
 *
 * Little-endian only, and that is checked rather than assumed: `sizeof_hdr`
 * must read as exactly 348. If a big-endian file ever turns up it will read as
 * 1 543 569 408 and this throws, which is the correct outcome — silently
 * byte-swapping a header is how a template ends up mirrored.
 */
export function parseNifti(buf) {
  const sizeofHdr = buf.readInt32LE(0);
  if (sizeofHdr !== 348) {
    throw new Error(
      `not a little-endian NIfTI-1 header: sizeof_hdr reads ${sizeofHdr}, expected 348`,
    );
  }
  const magic = buf.subarray(344, 348).toString('latin1').replace(/\0/g, '');
  if (magic !== 'n+1') {
    throw new Error(`expected a single-file NIfTI-1 ("n+1"), got ${JSON.stringify(magic)}`);
  }

  const dim = [];
  for (let i = 0; i < 8; i += 1) dim.push(buf.readInt16LE(40 + i * 2));
  const pixdim = [];
  for (let i = 0; i < 8; i += 1) pixdim.push(buf.readFloatLE(76 + i * 4));

  const datatypeCode = buf.readInt16LE(70);
  const datatype = DATATYPE[datatypeCode];
  if (!datatype) throw new Error(`unsupported NIfTI datatype code ${datatypeCode}`);

  const sformCode = buf.readInt16LE(254);
  const srow = [
    [0, 1, 2, 3].map((i) => buf.readFloatLE(280 + i * 4)),
    [0, 1, 2, 3].map((i) => buf.readFloatLE(296 + i * 4)),
    [0, 1, 2, 3].map((i) => buf.readFloatLE(312 + i * 4)),
  ];

  const voxOffset = Math.round(buf.readFloatLE(108));
  const [, nx, ny, nz] = dim;
  const voxels = nx * ny * nz;
  if (voxOffset + voxels * datatype.size > buf.length) {
    throw new Error(
      `NIfTI data is truncated: need ${voxOffset + voxels * datatype.size} bytes, have ${buf.length}`,
    );
  }

  return {
    dim: [nx, ny, nz],
    pixdimMm: [pixdim[1], pixdim[2], pixdim[3]],
    datatype: datatype.name,
    sformCode,
    space: XFORM[sformCode] ?? `code_${sformCode}`,
    /** Row-major 3x4 voxel-index -> world-millimetre affine. */
    srow,
    /** `(i, j, k) -> [x, y, z]` world millimetres. */
    toWorld: (i, j, k) => [
      srow[0][0] * i + srow[0][1] * j + srow[0][2] * k + srow[0][3],
      srow[1][0] * i + srow[1][1] * j + srow[1][2] * k + srow[1][3],
      srow[2][0] * i + srow[2][1] * j + srow[2][2] * k + srow[2][3],
    ],
    /** Voxel value at an index. */
    at: (i, j, k) => datatype.read(buf, voxOffset + ((k * ny + j) * nx + i) * datatype.size),
    voxels,
  };
}

/**
 * Voxel-index bounding box of the non-zero voxels, inclusive.
 *
 * Returns `null` for an all-zero volume, which the caller must treat as a
 * failed measurement rather than an empty box at the origin.
 */
export function maskBounds(img, threshold = 0) {
  const [nx, ny, nz] = img.dim;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        if (img.at(i, j, k) <= threshold) continue;
        count += 1;
        if (i < lo[0]) lo[0] = i;
        if (j < lo[1]) lo[1] = j;
        if (k < lo[2]) lo[2] = k;
        if (i > hi[0]) hi[0] = i;
        if (j > hi[1]) hi[1] = j;
        if (k > hi[2]) hi[2] = k;
      }
    }
  }
  return count === 0 ? null : { lo, hi, count };
}
