/**
 * Reads the pinned brainproject `brain.glb` into plain typed arrays, one record
 * per structure node.
 *
 * Build-time only. The Draco decoder is a devDependency of tools/mesh-build and
 * is loaded from there on demand, so nothing that imports this file at gate time
 * pulls a decoder in, and nothing in any shipped package can reach it.
 *
 * What this does NOT do is interpret the structures. Which ones may ship, and
 * under which source, is tools/lib/brain-provenance.mjs; this file only says
 * what the bytes are.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO_ROOT } from './repo.mjs';

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** The glTF JSON chunk and the binary chunk of a GLB, with no decoding. */
export function parseGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB: bad magic');
  if (view.getUint32(4, true) !== 2) throw new Error(`GLB version ${view.getUint32(4, true)}, expected 2`);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === CHUNK_BIN) bin = body;
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

let decoderModule = null;

async function draco() {
  if (decoderModule) return decoderModule;
  const require = createRequire(join(REPO_ROOT, 'tools', 'mesh-build', 'package.json'));
  let factory;
  try {
    factory = require('draco3dgltf');
  } catch (err) {
    throw new Error(
      'draco3dgltf is not installed. It is a build-only devDependency:\n'
        + '  (cd tools/mesh-build && npm ci)\n'
        + `(${err.message})`,
    );
  }
  decoderModule = await factory.createDecoderModule({});
  return decoderModule;
}

/** One Draco-compressed primitive, decoded to positions, normals and a triangle list. */
function decodeDraco(M, buffer, attributeIds) {
  const decoder = new M.Decoder();
  const geometryType = decoder.GetEncodedGeometryType(buffer);
  if (geometryType !== M.TRIANGULAR_MESH) {
    M.destroy(decoder);
    throw new Error(`Draco geometry type ${geometryType} is not a triangle mesh`);
  }
  const mesh = new M.Mesh();
  const status = decoder.DecodeArrayToMesh(buffer, buffer.byteLength, mesh);
  if (!status.ok()) {
    const msg = status.error_msg();
    M.destroy(mesh);
    M.destroy(decoder);
    throw new Error(`Draco decode failed: ${msg}`);
  }
  const vertexCount = mesh.num_points();
  const faceCount = mesh.num_faces();

  const readFloat = (uniqueId, components) => {
    const attr = decoder.GetAttributeByUniqueId(mesh, uniqueId);
    const n = vertexCount * components;
    const ptr = M._malloc(n * 4);
    decoder.GetAttributeDataArrayForAllPoints(mesh, attr, M.DT_FLOAT32, n * 4, ptr);
    const out = new Float32Array(M.HEAPF32.buffer, ptr, n).slice();
    M._free(ptr);
    return out;
  };

  const positions = readFloat(attributeIds.POSITION, 3);
  const normals = attributeIds.NORMAL === undefined ? null : readFloat(attributeIds.NORMAL, 3);

  const indexBytes = faceCount * 3 * 4;
  const ptr = M._malloc(indexBytes);
  decoder.GetTrianglesUInt32Array(mesh, indexBytes, ptr);
  const indices = new Uint32Array(M.HEAPU32.buffer, ptr, faceCount * 3).slice();
  M._free(ptr);

  M.destroy(mesh);
  M.destroy(decoder);
  return { positions, normals, indices };
}

/**
 * Every node of the scene that carries a mesh, decoded. Primitives of one node
 * are concatenated, and each primitive's material name is kept, because the
 * materials are the only provenance record brain.glb carries (§7.3).
 */
export async function decodeGlbNodes(bytes) {
  const { json, bin } = parseGlb(bytes);
  if ((json.extensionsRequired ?? []).some((e) => e !== 'KHR_draco_mesh_compression')) {
    throw new Error(`GLB requires extensions this reader does not implement: ${json.extensionsRequired.join(', ')}`);
  }
  const M = await draco();
  const nodes = [];
  for (const [nodeIndex, node] of json.nodes.entries()) {
    if (node.mesh === undefined) continue;
    if (node.matrix || node.translation || node.rotation || node.scale || node.children?.length) {
      // Every node in the pinned file is flat and untransformed, so positions are
      // already in the scene frame. A file where that stops being true would be
      // silently misplaced by a reader that ignored it.
      throw new Error(`node ${nodeIndex} (${node.name}) carries a transform or children; this reader assumes none`);
    }
    const parts = [];
    for (const prim of json.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4) throw new Error(`node ${node.name}: primitive mode ${prim.mode} is not TRIANGLES`);
      const ext = prim.extensions?.KHR_draco_mesh_compression;
      if (!ext) throw new Error(`node ${node.name}: primitive is not Draco-compressed`);
      const bv = json.bufferViews[ext.bufferView];
      const buffer = new Int8Array(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength);
      const decoded = decodeDraco(M, buffer, ext.attributes);
      parts.push({
        ...decoded,
        material: prim.material === undefined ? null : json.materials[prim.material].name,
      });
    }
    nodes.push({ nodeIndex, name: node.name, extras: node.extras ?? {}, parts });
  }
  return { json, nodes };
}

/** Concatenate a node's primitives into one indexed triangle mesh. */
export function mergeParts(parts) {
  const vertexCount = parts.reduce((n, p) => n + p.positions.length / 3, 0);
  const indexCount = parts.reduce((n, p) => n + p.indices.length, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let v = 0;
  let i = 0;
  for (const p of parts) {
    positions.set(p.positions, v * 3);
    if (p.normals) normals.set(p.normals, v * 3);
    for (let k = 0; k < p.indices.length; k += 1) indices[i + k] = p.indices[k] + v;
    v += p.positions.length / 3;
    i += p.indices.length;
  }
  return { positions, normals, indices };
}
