/**
 * brain.glb → two tiers of `ATLM` meshes for the structures that may ship.
 *
 * The decisions, and why:
 *
 *   - ONE FILE PER CLEARANCE GROUP AND TIER. §7.3 of docs/asset-licensing.md:
 *     a later clearance adds a file instead of re-cutting a shipped one, and a
 *     held structure can never ride along inside a cleared file. v2 ships one
 *     group, `cleared`.
 *   - FULL TIER = THE SOURCE, WELDED AND QUANTISED. Nothing is decimated.
 *     Positions are welded (Draco splits vertices at attribute seams), put on a
 *     16-bit grid shared by every structure in the file, and normals are
 *     recomputed from the welded surface.
 *   - LOW TIER = PER-STRUCTURE DECIMATION WITH A FLOOR. Each structure keeps
 *     `ratio` of its triangles, but never fewer than `floorTriangles` (or all
 *     of them, if it has fewer). The floor is what stops the smallest nuclei
 *     from being simplified out of existence: a global ratio alone takes the
 *     subthalamic nucleus to a handful of triangles.
 *   - ERROR IS MEASURED AGAINST THE FULL TIER, NOT THE SOURCE, so the gate can
 *     re-measure it from the two committed files without the source. The full
 *     tier differs from the source only by quantisation, which is reported
 *     separately as `quantisationStepMm`.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO_ROOT } from './repo.mjs';
import { mergeParts } from './glb.mjs';
import { octEncode, writeMeshBin } from './meshbin.mjs';
import { bounds, degenerateTriangles, dropDegenerate, surfaceArea, surfaceDeviation, vertexNormals, weld } from './mesh-geometry.mjs';

let meshopt = null;
async function meshoptimizer() {
  if (meshopt) return meshopt;
  const require = createRequire(join(REPO_ROOT, 'tools', 'mesh-build', 'package.json'));
  const entry = require.resolve('meshoptimizer');
  const mod = await import(entry);
  await mod.MeshoptSimplifier.ready;
  await mod.MeshoptEncoder.ready;
  meshopt = mod;
  return mod;
}

/** One quantisation frame for a set of float meshes: centred, int16, per-axis step. */
export function quantisationFrame(meshes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const b = bounds(m.positions);
    for (let a = 0; a < 3; a += 1) {
      min[a] = Math.min(min[a], b.min[a]);
      max[a] = Math.max(max[a], b.max[a]);
    }
  }
  const origin = [0, 1, 2].map((a) => Math.fround((min[a] + max[a]) / 2));
  // 65534 steps across the extent, so the extremes land on ±32767 exactly.
  const step = [0, 1, 2].map((a) => Math.fround((max[a] - min[a]) / 65534 || 1e-9));
  return { origin, step };
}

/** Quantise a float mesh into the frame, drop what collapses, recompute normals. */
function quantise(mesh, frame) {
  const n = mesh.positions.length / 3;
  const q = new Int16Array(n * 3);
  for (let v = 0; v < n; v += 1) {
    for (let a = 0; a < 3; a += 1) {
      const t = Math.round((mesh.positions[v * 3 + a] - frame.origin[a]) / frame.step[a]);
      q[v * 3 + a] = Math.max(-32767, Math.min(32767, t));
    }
  }
  const back = dequantise(q, frame);
  // Quantisation can collapse a sliver to zero area; keep only real triangles.
  const keep = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = mesh.indices.subarray(t, t + 3);
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

export function dequantise(q, frame) {
  const out = new Float64Array(q.length);
  for (let i = 0; i < q.length; i += 1) out[i] = frame.origin[i % 3] + frame.step[i % 3] * q[i];
  return out;
}

/** Vertex-cache and fetch order, then drop unreferenced vertices. Smaller after gzip, same surface. */
function reorder(M, mesh) {
  const indices = Uint32Array.from(mesh.indices);
  const [remap, unique] = M.MeshoptEncoder.reorderMesh(indices, true, true);
  const positions = new Float32Array(unique * 3);
  // `remap` covers only up to the highest referenced vertex. Reading past its
  // end gives undefined, and `set` at an undefined offset writes slot 0: that
  // silently moved vertex 0 of every decimated tube and doubled its area.
  for (let v = 0; v < Math.min(remap.length, mesh.positions.length / 3); v += 1) {
    const to = remap[v];
    if (to === 0xffffffff) continue;
    positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), to * 3);
  }
  return { positions, indices };
}

/** Decimate to `target` triangles. */
function decimate(M, mesh, target) {
  const sourceTriangles = mesh.indices.length / 3;
  if (target >= sourceTriangles) return mesh;
  const [indices] = M.MeshoptSimplifier.simplify(
    Uint32Array.from(mesh.indices),
    mesh.positions,
    3,
    target * 3,
    1, // relative error bound of 1 = the whole extent: the triangle target decides, not the error
    // Open borders stay where they are. Without this, simplification erodes them
    // and drops isolated source triangles outright: the superior semilunar
    // lobules lost four stray triangles 7.85 mm off the surface. With it, the
    // worst structure in the file is 3.1 mm and the file is the same size.
    ['LockBorder'],
  );
  return { positions: mesh.positions, indices: dropDegenerate(indices) };
}

/**
 * Build both tiers for `structures` (the provenance records of one clearance
 * group) from decoded glb `nodes`.
 */
export async function buildTiers({ nodes, structures, floorTriangles, ratio, replacements = new Map() }) {
  const byId = new Map(nodes.map((n) => [n.extras.bx_id, n]));
  const meshes = structures.map((s) => {
    // A replaced structure's geometry comes from its replacement source, already
    // in the mesh frame; everything else from the glb.
    const merged = replacements.get(s.id) ?? mergeParts(byId.get(s.id).parts);
    return { id: s.id, positions: merged.positions, indices: merged.indices };
  });
  // The glb is in metres.
  return buildMeshTiers({ meshes, floorTriangles, ratio, mmPerUnit: 1000 });
}

/**
 * The tier builder itself, for any set of float meshes in one frame. The brain
 * (from the glb, in metres) and the body (DOG-128, from BodyParts3D, in
 * millimetres) both come through here, so both are welded, quantised,
 * decimated and measured by the same code.
 *
 * `meshes` is `[{ id, positions, indices }]`, unwelded. `mmPerUnit` converts
 * the frame's units to the millimetres every reported figure is in.
 *
 * The full tier is the source, undecimated, unless `fullRatio` is below 1.
 * Then it is decimated the way the low tier is, to `fullRatio` of the source
 * with a floor of `fullFloorTriangles`, and the build reports how far it moved
 * from the source (`fullVsSource`). That figure is the build's, not the gate's:
 * the gate has the two tiers and not the source.
 */
export async function buildMeshTiers({ meshes, floorTriangles, ratio, mmPerUnit, fullRatio = 1, fullFloorTriangles = 0 }) {
  const M = await meshoptimizer();
  const mm2 = mmPerUnit * mmPerUnit;
  const welded = meshes.map((m) => ({ record: m, mesh: weld(m.positions, m.indices), sourceTriangles: m.indices.length / 3 }));
  const frame = quantisationFrame(welded.map((w) => w.mesh));

  const full = [];
  const low = [];
  const report = [];
  for (const w of welded) {
    const sourceMesh = reorder(M, w.mesh);
    const sourceTris = sourceMesh.indices.length / 3;
    const fullMesh = fullRatio < 1
      ? reorder(M, decimate(M, sourceMesh, Math.min(sourceTris, Math.max(fullFloorTriangles, Math.ceil(sourceTris * fullRatio)))))
      : sourceMesh;
    const fq = quantise(fullMesh, frame);
    const fullTris = fq.indices.length / 3;
    // The floor is a guarantee, not a target: the simplifier may stop short of
    // the count it is given, and quantisation may drop a sliver, so ask again
    // with a higher target until what lands in the file meets it. The gate
    // checks exactly this inequality.
    const required = Math.min(fullTris, floorTriangles);
    let target = Math.min(fullTris, Math.max(floorTriangles, Math.ceil(fullTris * ratio)));
    let lq;
    for (;;) {
      lq = quantise(reorder(M, decimate(M, fullMesh, target)), frame);
      if (lq.indices.length / 3 >= required || target >= fullMesh.indices.length / 3) break;
      target += Math.max(1, required - lq.indices.length / 3);
    }
    full.push({ id: w.record.id, positions: fq.q, normals: fq.oct, indices: fq.indices });
    low.push({ id: w.record.id, positions: lq.q, normals: lq.oct, indices: lq.indices });

    const deviation = surfaceDeviation(
      { positions: lq.dequantised, indices: lq.indices },
      { positions: fq.dequantised, indices: fq.indices },
    );
    const fullVsSource = fullMesh === sourceMesh
      ? null
      : surfaceDeviation({ positions: fq.dequantised, indices: fq.indices }, sourceMesh);
    report.push({
      id: w.record.id,
      sourceTriangles: w.sourceTriangles,
      full: { triangles: fq.indices.length / 3, vertices: fq.q.length / 3, areaMm2: surfaceArea(fq.dequantised, fq.indices) * mm2 },
      low: { triangles: lq.indices.length / 3, vertices: lq.q.length / 3, areaMm2: surfaceArea(lq.dequantised, lq.indices) * mm2 },
      targetTriangles: target,
      hausdorffMm: deviation.hausdorff * mmPerUnit,
      meanDeviationMm: deviation.meanSymmetric * mmPerUnit,
      ...(fullVsSource && {
        fullVsSource: {
          sourceAreaMm2: surfaceArea(sourceMesh.positions, sourceMesh.indices) * mm2,
          hausdorffMm: fullVsSource.hausdorff * mmPerUnit,
          meanDeviationMm: fullVsSource.meanSymmetric * mmPerUnit,
        },
      }),
    });
  }

  return {
    frame,
    full: writeMeshBin({ ...frame, structures: full }),
    low: writeMeshBin({ ...frame, structures: low }),
    report,
  };
}
