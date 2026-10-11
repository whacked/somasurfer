/**
 * The project-owned mesh format, `ATLM` version 1. One file holds many
 * structures that share one quantisation frame, so a renderer uploads a file
 * once and draws each structure as an index range.
 *
 * This module is the format's single definition. The writer is used by
 * tools/build-meshes.mjs; the reader by the gates (tools/perf-budget.mjs,
 * tools/check-mesh-assets.mjs, tools/check-licence-separation.mjs) and, from
 * W4, by the viewer. It has no imports, so a consumer anywhere can take it
 * as it stands. Fork it and the perf gate stops measuring what the page does.
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

export const MAGIC = 'ATLM';
export const VERSION = 1;
export const HEADER_BYTES = 64;
export const TABLE_STRIDE = 5;
export const FLAG_INDEX32 = 1;

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

/** Octahedral decode of two snorm8 components to a unit normal. */
export function octDecode(qu, qv) {
  const u = Math.max(-1, qu / 127);
  const v = Math.max(-1, qv / 127);
  let x = u;
  let y = v;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    x = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    y = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
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
 * Read a file without copying it: typed-array views over the buffer and a
 * structure table. Throws on anything malformed, naming what, because a gate
 * that reads a truncated file as "fewer structures" would pass it.
 */
export function readMeshBin(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < HEADER_BYTES) throw new Error(`ATLM: ${u8.byteLength} bytes is shorter than the header`);
  // Views need an aligned, exclusively owned buffer.
  const buf = u8.byteOffset % 4 === 0 && u8.byteOffset + u8.byteLength <= u8.buffer.byteLength
    ? u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    : u8.slice().buffer;
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== MAGIC) throw new Error(`ATLM: bad magic ${JSON.stringify(magic)}`);
  const version = dv.getUint16(4, true);
  if (version !== VERSION) throw new Error(`ATLM: version ${version}, this reader knows ${VERSION}`);
  const flags = dv.getUint16(6, true);
  const index32 = (flags & FLAG_INDEX32) !== 0;
  const structureCount = dv.getUint32(8, true);
  const vertexCount = dv.getUint32(12, true);
  const indexCount = dv.getUint32(16, true);
  const origin = [0, 1, 2].map((a) => dv.getFloat32(20 + a * 4, true));
  const step = [0, 1, 2].map((a) => dv.getFloat32(32 + a * 4, true));
  const tableOffset = dv.getUint32(44, true);
  const positionsOffset = dv.getUint32(48, true);
  const normalsOffset = dv.getUint32(52, true);
  const indicesOffset = dv.getUint32(56, true);
  const byteLength = dv.getUint32(60, true);
  if (byteLength !== buf.byteLength) {
    throw new Error(`ATLM: header says ${byteLength} bytes, file has ${buf.byteLength}`);
  }
  if (indicesOffset + indexCount * (index32 ? 4 : 2) > buf.byteLength) throw new Error('ATLM: index section overruns the file');

  const table = [];
  for (let k = 0; k < structureCount; k += 1) {
    const t = tableOffset + k * TABLE_STRIDE * 4;
    table.push({
      id: dv.getUint32(t, true),
      firstVertex: dv.getUint32(t + 4, true),
      vertexCount: dv.getUint32(t + 8, true),
      firstIndex: dv.getUint32(t + 12, true),
      indexCount: dv.getUint32(t + 16, true),
    });
  }
  for (const s of table) {
    if (s.firstVertex + s.vertexCount > vertexCount || s.firstIndex + s.indexCount > indexCount || s.indexCount % 3 !== 0) {
      throw new Error(`ATLM: structure ${s.id} has a range outside the file`);
    }
  }
  return {
    version,
    index32,
    origin,
    step,
    vertexCount,
    indexCount,
    table,
    positions: new Int16Array(buf, positionsOffset, vertexCount * 3),
    normals: new Int8Array(buf, normalsOffset, vertexCount * 2),
    indices: index32 ? new Uint32Array(buf, indicesOffset, indexCount) : new Uint16Array(buf, indicesOffset, indexCount),
  };
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
