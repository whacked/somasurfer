/**
 * The read side of the ATLM mesh format: the one reader the viewer AND the
 * gates use (tools/lib/meshbin.mjs re-exports it beside its writer, and holds
 * the layout). Shipped in the bundle, so the argument lives there, not here.
 */

export const MAGIC = 'ATLM';
export const VERSION = 1;
export const HEADER_BYTES = 64;
export const TABLE_STRIDE = 5;
export const FLAG_INDEX32 = 1;

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

/** Typed-array views over a file and its structure table. Throws, naming what, on anything malformed. */
export function readMeshBin(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < HEADER_BYTES) throw new Error(`ATLM: ${u8.byteLength} bytes is shorter than the header`);
  // Views need an aligned, exclusively owned buffer.
  const buf = u8.byteOffset % 4 === 0 && u8.byteOffset + u8.byteLength <= u8.buffer.byteLength
    ? u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    : u8.slice().buffer;
  const dv = new DataView(buf);
  const u32 = (o) => dv.getUint32(o, true);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== MAGIC) throw new Error(`ATLM: bad magic ${JSON.stringify(magic)}`);
  const version = dv.getUint16(4, true);
  if (version !== VERSION) throw new Error(`ATLM: version ${version}, this reader knows ${VERSION}`);
  const index32 = (dv.getUint16(6, true) & FLAG_INDEX32) !== 0;
  const structureCount = u32(8);
  const vertexCount = u32(12);
  const indexCount = u32(16);
  const origin = [0, 1, 2].map((a) => dv.getFloat32(20 + a * 4, true));
  const step = [0, 1, 2].map((a) => dv.getFloat32(32 + a * 4, true));
  const [tableOffset, positionsOffset, normalsOffset, indicesOffset, byteLength] = [44, 48, 52, 56, 60].map(u32);
  if (byteLength !== buf.byteLength) {
    throw new Error(`ATLM: header says ${byteLength} bytes, file has ${buf.byteLength}`);
  }
  if (indicesOffset + indexCount * (index32 ? 4 : 2) > buf.byteLength) throw new Error('ATLM: index section overruns the file');

  const table = [];
  for (let k = 0; k < structureCount; k += 1) {
    const t = tableOffset + k * TABLE_STRIDE * 4;
    const s = { id: u32(t), firstVertex: u32(t + 4), vertexCount: u32(t + 8), firstIndex: u32(t + 12), indexCount: u32(t + 16) };
    if (s.firstVertex + s.vertexCount > vertexCount || s.firstIndex + s.indexCount > indexCount || s.indexCount % 3 !== 0) {
      throw new Error(`ATLM: structure ${s.id} has a range outside the file`);
    }
    table.push(s);
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
