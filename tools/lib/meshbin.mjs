/**
 * The project-owned mesh format, `ATLM` version 1. One file holds many
 * structures that share one quantisation frame, so a renderer uploads a file
 * once and draws each structure as an index range.
 *
 * This module is the format's single definition. The writer is used by
 * tools/build-meshes.mjs; the reader by the gates (tools/perf-budget.mjs,
 * tools/check-mesh-assets.mjs, tools/check-licence-separation.mjs) and by the
 * viewer, which loads it from packages/atlas-web/src/viewer/atlm.js (DOG-129).
 * Fork it and the perf gate stops measuring what the page does.
 *
 * Layout, little-endian, every section 4-byte aligned:
 *
 *   offset  size  field
 *        0     4  magic "ATLM"
 *        4     2  version (1)
 *        6     2  flags: bit 0 = 32-bit indices (else 16-bit, structure-local)
 *        8     4  structureCount
 *       12     4  vertexCount
 *       16     4  indexCount
 *       20    12  origin, float32 x3, in the source frame's units
 *       32    12  step, float32 x3: source units per int16 unit, per axis
 *       44     4  tableOffset
 *       48     4  positionsOffset
 *       52     4  normalsOffset
 *       56     4  indicesOffset
 *       60     4  byteLength (the whole file, as a truncation check)
 *
 *   table      structureCount x 5 uint32:
 *              structureId, firstVertex, vertexCount, firstIndex, indexCount
 *   positions  vertexCount x 3 int16. Source = origin + step * q.
 *   normals    vertexCount x 2 int8, octahedral, snorm8.
 *   indices    indexCount x uint16 (relative to the structure's firstVertex)
 *              or uint32 (absolute), per flag bit 0. Triangle lists.
 *
 * Structure-local 16-bit indices are why each structure is limited to 65,535
 * vertices unless the file sets the 32-bit flag. The writer picks the flag; a
 * reader must honour it.
 */

import {
  FLAG_INDEX32, HEADER_BYTES, MAGIC, TABLE_STRIDE, VERSION, octDecode, readMeshBin,
} from '../../packages/atlas-web/src/viewer/atlm.js';

/*
 * The READ side lives in packages/atlas-web/src/viewer/atlm.js and is
 * re-exported here, so the gates and the viewer run one reader, not two that
 * agree today (DOG-129). It is in the shipped bundle, which is why its comments
 * are short and the layout is documented above, in a file that is not shipped.
 */
export { FLAG_INDEX32, HEADER_BYTES, MAGIC, TABLE_STRIDE, VERSION, octDecode, readMeshBin };

const align4 = (n) => (n + 3) & ~3;

/** Octahedral encode of a unit normal to two snorm8 components. */
export function octEncode(x, y, z) {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / l1;
  let v = y / l1;
  if (z < 0) {
    const pu = u;
    u = (1 - Math.abs(v)) * (pu >= 0 ? 1 : -1);
    v = (1 - Math.abs(pu)) * (v >= 0 ? 1 : -1);
  }
  const q = (t) => Math.max(-127, Math.min(127, Math.round(t * 127)));
  return [q(u), q(v)];
}

/**
 * Write a file. `structures` is a list of `{ id, positions: Int16Array,
 * normals: Int8Array, indices: Uint32Array (structure-local) }`, already
 * quantised against `origin` and `step`.
 */
export function writeMeshBin({ origin, step, structures }) {
  const vertexCount = structures.reduce((n, s) => n + s.positions.length / 3, 0);
  const indexCount = structures.reduce((n, s) => n + s.indices.length, 0);
  const index32 = structures.some((s) => s.positions.length / 3 > 0xffff);
  const tableOffset = HEADER_BYTES;
  const positionsOffset = align4(tableOffset + structures.length * TABLE_STRIDE * 4);
  const normalsOffset = align4(positionsOffset + vertexCount * 6);
  const indicesOffset = align4(normalsOffset + vertexCount * 2);
  const byteLength = align4(indicesOffset + indexCount * (index32 ? 4 : 2));

  const buf = new ArrayBuffer(byteLength);
  const dv = new DataView(buf);
  for (let i = 0; i < 4; i += 1) dv.setUint8(i, MAGIC.charCodeAt(i));
  dv.setUint16(4, VERSION, true);
  dv.setUint16(6, index32 ? FLAG_INDEX32 : 0, true);
  dv.setUint32(8, structures.length, true);
  dv.setUint32(12, vertexCount, true);
  dv.setUint32(16, indexCount, true);
  for (let a = 0; a < 3; a += 1) {
    dv.setFloat32(20 + a * 4, origin[a], true);
    dv.setFloat32(32 + a * 4, step[a], true);
  }
  dv.setUint32(44, tableOffset, true);
  dv.setUint32(48, positionsOffset, true);
  dv.setUint32(52, normalsOffset, true);
  dv.setUint32(56, indicesOffset, true);
  dv.setUint32(60, byteLength, true);

  const positions = new Int16Array(buf, positionsOffset, vertexCount * 3);
  const normals = new Int8Array(buf, normalsOffset, vertexCount * 2);
  const indices = index32 ? new Uint32Array(buf, indicesOffset, indexCount) : new Uint16Array(buf, indicesOffset, indexCount);
  let v = 0;
  let i = 0;
  structures.forEach((s, k) => {
    const n = s.positions.length / 3;
    const t = tableOffset + k * TABLE_STRIDE * 4;
    dv.setUint32(t, s.id, true);
    dv.setUint32(t + 4, v, true);
    dv.setUint32(t + 8, n, true);
    dv.setUint32(t + 12, i, true);
    dv.setUint32(t + 16, s.indices.length, true);
    positions.set(s.positions, v * 3);
    normals.set(s.normals, v * 2);
    for (let j = 0; j < s.indices.length; j += 1) indices[i + j] = index32 ? s.indices[j] + v : s.indices[j];
    v += n;
    i += s.indices.length;
  });
  return new Uint8Array(buf);
}

/**
 * One structure as float positions in the source frame and absolute indices
 * into them, which is what every geometric check wants.
 */
export function structureGeometry(mesh, entry) {
  const { origin, step } = mesh;
  const positions = new Float64Array(entry.vertexCount * 3);
  for (let v = 0; v < entry.vertexCount; v += 1) {
    for (let a = 0; a < 3; a += 1) {
      positions[v * 3 + a] = origin[a] + step[a] * mesh.positions[(entry.firstVertex + v) * 3 + a];
    }
  }
  const indices = new Uint32Array(entry.indexCount);
  for (let i = 0; i < entry.indexCount; i += 1) {
    const raw = mesh.indices[entry.firstIndex + i];
    indices[i] = mesh.index32 ? raw - entry.firstVertex : raw;
  }
  return { positions, indices };
}
