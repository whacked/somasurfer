/**
 * The per-structure checks on a low/full pair of ATLM files, shared by every
 * mesh set tools/check-mesh-assets.mjs gates: the brain (DOG-127) and the body
 * (DOG-128). One definition, so the body cannot be held to a weaker version of
 * the brain's gate by accident or by edit.
 *
 * Per structure, in the low tier:
 *
 *   present         in both files, at the slot structures.json says
 *   floor           at least min(floorTriangles, its full-tier count) triangles
 *   not degenerate  no zero-area or repeated-vertex triangle; every index in range
 *   not a sliver    on every axis, at least half its full-tier extent, both taken
 *                   over the vertices a triangle uses: an undrawn vertex at an
 *                   extreme would otherwise hide a collapse (DOG-173 F1)
 *   all drawn       with `requireReferenced`, no vertex in either tier that no
 *                   triangle uses (the body sets it; the brain carries 5 and
 *                   does not)
 *   same surface    area within [0.75, 1.25] of the full tier
 *   error is real   Hausdorff and mean deviation re-measured, equal to what
 *                   structures.json publishes
 */

import { structureGeometry } from './meshbin.mjs';
import { bounds, degenerateTriangles, surfaceArea, surfaceDeviation } from './mesh-geometry.mjs';

export const MIN_AXIS_SHARE = 0.5;
export const AREA_RATIO = Object.freeze([0.75, 1.25]);
/** structures.json rounds error figures to 3 decimals; allow that and nothing more. */
export const ERROR_TOLERANCE_MM = 0.0015;

/**
 * Check that both tiers hold exactly `doc.structures`, slot for slot. Returns
 * problems; the per-structure pass needs this to hold first.
 */
export function checkTables({ doc, low, full }) {
  const problems = [];
  for (const [tier, mesh] of [['low', low], ['full', full]]) {
    const ids = new Set(mesh.table.map((t) => t.id));
    if (ids.size !== mesh.table.length) problems.push(`The ${tier} tier lists a structure id more than once.`);
  }
  if (doc.structures.length !== low.table.length || doc.structures.length !== full.table.length) {
    problems.push(`structures.json lists ${doc.structures.length} structures; the tiers hold ${low.table.length} (low) and ${full.table.length} (full).`);
  }
  doc.structures.forEach((s, slot) => {
    if (s.slot !== slot || low.table[slot]?.id !== s.id || full.table[slot]?.id !== s.id) {
      problems.push(`structures.json slot ${slot} (${s.name}) does not match the table slot in both mesh files.`);
    }
  });
  return problems;
}

/** Bounds over the vertices that `indices` actually uses, and how many it does not. */
export function drawnBounds(positions, indices) {
  const used = new Uint8Array(positions.length / 3);
  for (let i = 0; i < indices.length; i += 1) if (indices[i] < used.length) used[indices[i]] = 1;
  const p = [];
  let unused = 0;
  for (let v = 0; v < used.length; v += 1) {
    if (used[v]) p.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    else unused += 1;
  }
  return { ...bounds(Float64Array.from(p)), unused };
}

/**
 * Every per-structure check, for every structure in `doc`. `mmPerUnit` is the
 * frame's millimetres per unit (1000 for the brain's metres, 1 for the body).
 * Returns `{ problems, rows }`; each row carries what the report publishes.
 */
export function checkStructures({ doc, low, full, floorTriangles, mmPerUnit, requireReferenced = false }) {
  const problems = [];
  const rows = [];
  const mm2 = mmPerUnit * mmPerUnit;
  for (const [slot, s] of doc.structures.entries()) {
    const lg = structureGeometry(low, low.table[slot]);
    const fg = structureGeometry(full, full.table[slot]);
    const name = `${s.name} (id ${s.id})`;
    const lowTris = lg.indices.length / 3;
    const fullTris = fg.indices.length / 3;

    for (const [tier, g] of [['low', lg], ['full', fg]]) {
      const outOfRange = g.indices.some((i) => i >= g.positions.length / 3);
      if (outOfRange) problems.push(`${name}: the ${tier} tier indexes a vertex outside its own range.`);
      const deg = outOfRange ? 0 : degenerateTriangles(g.positions, g.indices);
      if (deg > 0) problems.push(`${name}: ${deg} degenerate triangle(s) in the ${tier} tier.`);
      if (g.indices.length === 0) problems.push(`${name}: the ${tier} tier has no triangles.`);
    }
    const required = Math.min(floorTriangles, fullTris);
    if (lowTris < required) {
      problems.push(`${name}: ${lowTris} triangles in the low tier, under the floor of ${required}.`);
    }
    const lb = drawnBounds(lg.positions, lg.indices);
    const fb = drawnBounds(fg.positions, fg.indices);
    if (requireReferenced) {
      for (const [tier, b] of [['low', lb], ['full', fb]]) {
        if (b.unused > 0) problems.push(`${name}: ${b.unused} vertex(es) in the ${tier} tier that no triangle uses; every measure here must be of the drawn surface.`);
      }
    }
    for (const [a, axis] of ['x', 'y', 'z'].entries()) {
      if (fb.extent[a] > 0 && lb.extent[a] < MIN_AXIS_SHARE * fb.extent[a]) {
        problems.push(`${name}: the low tier keeps ${(lb.extent[a] * mmPerUnit).toFixed(2)} mm of its ${(fb.extent[a] * mmPerUnit).toFixed(2)} mm ${axis} extent; it has collapsed toward a sliver.`);
      }
    }
    const lowArea = surfaceArea(lg.positions, lg.indices) * mm2;
    const fullArea = surfaceArea(fg.positions, fg.indices) * mm2;
    const ratio = lowArea / fullArea;
    if (!(ratio >= AREA_RATIO[0] && ratio <= AREA_RATIO[1])) {
      problems.push(`${name}: low-tier area is ${ratio.toFixed(2)}x the full tier's, outside [${AREA_RATIO.join(', ')}]. Decimation does not do that to a surface; something moved vertices.`);
    }

    const dev = surfaceDeviation({ positions: lg.positions, indices: lg.indices }, { positions: fg.positions, indices: fg.indices });
    const hausdorff = dev.hausdorff * mmPerUnit;
    const mean = dev.meanSymmetric * mmPerUnit;
    if (Math.abs(hausdorff - s.errorMm.hausdorff) > ERROR_TOLERANCE_MM || Math.abs(mean - s.errorMm.mean) > ERROR_TOLERANCE_MM) {
      problems.push(`${name}: structures.json publishes Hausdorff ${s.errorMm.hausdorff} mm / mean ${s.errorMm.mean} mm; the files measure ${hausdorff.toFixed(3)} / ${mean.toFixed(3)} mm.`);
    }
    if (s.low.triangles !== lowTris || s.full.triangles !== fullTris) {
      problems.push(`${name}: structures.json says ${s.low.triangles}/${s.full.triangles} triangles; the files hold ${lowTris}/${fullTris}.`);
    }
    rows.push({ s, slot, lowTris, fullTris, hausdorff, mean, ratio, extentMm: Math.max(...fb.extent) * mmPerUnit, fullGeometry: fg });
  }
  return { problems, rows };
}
