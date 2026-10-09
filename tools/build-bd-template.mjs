/**
 * The `BD` body template pipeline: BodyParts3D meshes in, one audited
 * `*.body.json` out.
 *
 *   node tools/build-bd-template.mjs --source <dir> [--centreline body|whole]
 *
 * `<dir>` holds the four published source files named in tools/lib/bp3d.mjs.
 * They are not in the repository: 136 MB of third-party mesh data, which the
 * pipeline reduces to a 40 kB template. The template is the committed
 * artefact and CI audits it (tools/audit-real-template.mjs); this tool is how
 * it was derived and how it can be re-derived.
 *
 * What the template is, in one paragraph. Each of the 25 addressable levels
 * contributes one axis point, taken from its own vertebra's mesh. Consecutive
 * axis points define a boundary node halfway between them, and a level's slab
 * runs from the node above it to the node below it — so the slabs tile the
 * column exactly, which is what `spineGeometry()` needs to build its bisector
 * planes. Surface radii are cast as rays from each slab's axis out to the
 * skin, at `--azimuths` equally spaced azimuths starting at the anterior
 * midline.
 *
 * THE CENTRELINE RULE IS A CHOICE AND IT IS MEASURED. `VertebralSlab.origin`
 * is documented as the centroid of the vertebral body, but a BodyParts3D
 * vertebra is one mesh: body, arch and processes together. So there are two
 * honest readings and the pipeline implements both:
 *
 *   --centreline whole   the volume centroid of the entire vertebra. No
 *                        parameter, nothing to tune. Sits posterior of the
 *                        vertebral body, because the laminae and the spinous
 *                        process carry real volume.
 *   --centreline body    the volume centroid restricted to the anterior
 *                        `--body-fraction` of the vertebra's own
 *                        antero-posterior extent. This is the radiologist's
 *                        centroid method — a spinal centreline is drawn
 *                        through vertebral body centres — and it is what the
 *                        clinically parameterised templates in
 *                        testing/anatomicalTemplates.ts approximate.
 *
 * Both are built, both are gated, and both results are published in
 * docs/alc-1-body-template-audit.md. Neither was chosen by argument.
 *
 * S01 IS DIFFERENT, BY REQUIREMENT. docs/alc-1-admissibility.md §5
 * requirement 2: the single sacral level's axis follows the UPPER SACRAL
 * ENDPLATE, not the sacrum's chord. Measured in §3 of that document: the
 * chord leaves a ~30 degree kink at L5/S1 and that kink, not the sacrum, is
 * what limits the frame. So `S01`'s axis point is the centroid of the S1
 * endplate region of the sacrum mesh, and its axial direction is the tangent
 * entering the sacrum from `L05` rather than the direction of the whole bone.
 *
 * UNMEASURED AZIMUTHS ARE NOT RADII. A ray that leaves the skin mesh without
 * crossing it is a failed measurement. The pipeline does not interpolate it
 * away: it fills that azimuth with an UPPER bound — the largest radius
 * measured at that level — records the azimuth in
 * `provenance.measurement.unverified`, and the audit reports the level
 * `UNVERIFIED`. The direction of the bound is the whole point. Utilisation
 * rises with radius, so an over-estimated radius makes the fold test strictly
 * harder to pass; the template is then sound under a one-sided bound, which is
 * a weaker claim than soundness and is published as one. Filling with a
 * neighbour's radius, or with the level's minimum, would make an unmeasurable
 * region read green.
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { REPO_ROOT, rel } from './lib/repo.mjs';
import {
  BD_LEVELS,
  SKIN_FMA,
  SOURCE,
  assertLaterality,
  openSource,
} from './lib/bp3d.mjs';
import {
  add,
  areaCentroid,
  bounds,
  buildGrid,
  dot,
  firstHit,
  mid,
  norm,
  sub,
  surfaceStats,
  unit,
  volumeCentroid,
} from './lib/mesh.mjs';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    source: process.env.ALC_BP3D_DIR ?? null,
    centreline: 'body',
    azimuths: 72,
    bodyFraction: 0.4,
    out: null,
    measurement: null,
    id: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '--source') opts.source = next();
    else if (a === '--centreline') opts.centreline = next();
    else if (a === '--azimuths') opts.azimuths = Number(next());
    else if (a === '--body-fraction') opts.bodyFraction = Number(next());
    else if (a === '--out') opts.out = next();
    else if (a === '--measurement') opts.measurement = next();
    else if (a === '--id') opts.id = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.source) {
    throw new Error('--source <dir> (or ALC_BP3D_DIR) must name the BodyParts3D source directory');
  }
  if (opts.centreline !== 'body' && opts.centreline !== 'whole') {
    throw new Error(`--centreline must be "body" or "whole", got ${JSON.stringify(opts.centreline)}`);
  }
  if (!Number.isInteger(opts.azimuths) || opts.azimuths < 12) {
    throw new Error('--azimuths must be an integer of at least 12 (the template validator\'s floor)');
  }
  opts.id ??= `bp3d-4.0-adult-${opts.centreline}-centroid`;
  return opts;
}

// ---------------------------------------------------------------------------
// Axis points
// ---------------------------------------------------------------------------

/**
 * One axis point per presacral vertebra.
 *
 * `whole` integrates the entire mesh. `body` integrates the same mesh clipped
 * to the anterior `fraction` of its own AP extent, which is why the clip is
 * expressed as a fraction rather than millimetres: a cervical vertebra is
 * 50 mm deep and a lumbar one 90 mm, and a fixed offset would cut them in
 * anatomically different places.
 *
 * The clip is applied per triangle by its own centroid, so the integrated
 * region is not closed and the divergence-theorem volume is meaningless there.
 * That is what `areaCentroid` is for in the `body` case: for a roughly convex,
 * roughly cylindrical vertebral body the area centroid and the volume centroid
 * differ by well under a millimetre, and the difference is published.
 */
function axisPoint(mesh, mode, fraction) {
  const { lo, hi } = bounds(mesh.V);
  const whole = volumeCentroid(mesh.V, mesh.F);
  if (mode === 'whole') {
    if (whole.volume === 0) throw new Error(`${mesh.fma}: mesh is not closed; volume integrates to zero`);
    return { point: whole.centroid, whole, apExtentMm: hi[1] - lo[1] };
  }
  // anterior is +y in template space; keep the anterior `fraction` of the extent.
  const cut = hi[1] - (hi[1] - lo[1]) * fraction;
  const region = areaCentroid(mesh.V, mesh.F, (_x, y) => y >= cut);
  if (region.area === 0) throw new Error(`${mesh.fma}: no triangles anterior of y=${cut.toFixed(1)}`);
  return { point: region.centroid, whole, apExtentMm: hi[1] - lo[1], cutMm: cut, regionArea: region.area };
}

/**
 * The `S01` axis point: the centroid of the S1 endplate region.
 *
 * "Upper sacral endplate" has to become an operation on a mesh. The sacrum's
 * cranial end carries three things at nearly the same height — the S1 body's
 * superior surface, the two alae, and the superior articular processes — and
 * only the first one is the endplate. The alae extend laterally and the
 * articular processes posteriorly, so the region is isolated by taking the
 * cranial `zBand` of the bone and then its anterior half, which is the S1
 * body. The result is published, so "is that the S1 endplate" is a question
 * about a number and not about this comment.
 */
function sacralEndplate(mesh, zBand = 0.18, apFraction = 0.5) {
  const { lo, hi } = bounds(mesh.V);
  const zCut = hi[2] - (hi[2] - lo[2]) * zBand;
  const band = areaCentroid(mesh.V, mesh.F, (_x, _y, z) => z >= zCut);
  if (band.area === 0) throw new Error('sacrum: cranial band is empty');
  // AP extent of the band itself, not of the whole bone: the ala and the
  // articular processes are in the band and the whole-bone extent is not.
  let yLo = Infinity;
  let yHi = -Infinity;
  for (let t = 0; t < mesh.F.length; t += 3) {
    const a = mesh.F[t] * 3; const b = mesh.F[t + 1] * 3; const c = mesh.F[t + 2] * 3;
    const gz = (mesh.V[a + 2] + mesh.V[b + 2] + mesh.V[c + 2]) / 3;
    if (gz < zCut) continue;
    const gy = (mesh.V[a + 1] + mesh.V[b + 1] + mesh.V[c + 1]) / 3;
    if (gy < yLo) yLo = gy;
    if (gy > yHi) yHi = gy;
  }
  const yCut = yHi - (yHi - yLo) * apFraction;
  const region = areaCentroid(mesh.V, mesh.F, (_x, y, z) => z >= zCut && y >= yCut);
  if (region.area === 0) throw new Error('sacrum: S1 endplate region is empty');
  return { point: region.centroid, zCutMm: zCut, yCutMm: yCut, areaMm2: region.area, lo, hi };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function build(opts) {
  const source = openSource(opts.source);
  const laterality = assertLaterality(source);

  // --- meshes -------------------------------------------------------------
  const levels = [];
  for (const [label, fma, term] of BD_LEVELS) {
    const mesh = source.loadMesh(fma);
    if (!mesh) throw new Error(`${label}: no mesh for ${fma} (${term}) in ${SOURCE.files.meshes}`);
    levels.push({ label, fma, term, mesh });
  }
  const skinMesh = source.loadMesh(SKIN_FMA);
  if (!skinMesh) throw new Error(`no skin mesh for ${SKIN_FMA} in ${SOURCE.files.meshes}`);

  // --- axis points --------------------------------------------------------
  const presacral = levels.slice(0, levels.length - 1);
  const sacral = levels[levels.length - 1];
  const points = [];
  const perLevelMeasurement = [];

  for (const lv of presacral) {
    const a = axisPoint(lv.mesh, opts.centreline, opts.bodyFraction);
    points.push(a.point);
    perLevelMeasurement.push({
      level: lv.label,
      fma: lv.fma,
      term: lv.term,
      triangles: lv.mesh.F.length / 3,
      axisPointMm: a.point.map((v) => round(v, 2)),
      wholeCentroidMm: a.whole.centroid.map((v) => round(v, 2)),
      apExtentMm: round(a.apExtentMm, 1),
    });
  }

  const endplate = sacralEndplate(sacral.mesh);
  points.push(endplate.point);
  perLevelMeasurement.push({
    level: sacral.label,
    fma: sacral.fma,
    term: sacral.term,
    triangles: sacral.mesh.F.length / 3,
    axisPointMm: endplate.point.map((v) => round(v, 2)),
    wholeCentroidMm: volumeCentroid(sacral.mesh.V, sacral.mesh.F).centroid.map((v) => round(v, 2)),
    note: 'S1 endplate region, not the whole bone: admissibility §5 requirement 2',
  });

  // --- boundary nodes -----------------------------------------------------
  // Interior nodes halfway between consecutive axis points. The cranial end
  // mirrors the first interval so C01 gets the same height as its spacing;
  // the caudal end is the sacrum's own extent along S01's axis, because the
  // sacrum has no successor to bisect against.
  const nodes = [];
  for (let i = 0; i < points.length - 1; i += 1) nodes.push(mid(points[i], points[i + 1]));
  const cranial = add(points[0], sub(points[0], nodes[0]));
  nodes.unshift(cranial);

  const sacralAxial = unit(sub(points[points.length - 1], points[points.length - 2]));
  const l5s1Node = nodes[nodes.length - 1];
  let sacralReach = 0;
  for (let i = 0; i < sacral.mesh.V.length; i += 3) {
    const d = dot(sub([sacral.mesh.V[i], sacral.mesh.V[i + 1], sacral.mesh.V[i + 2]], l5s1Node), sacralAxial);
    if (d > sacralReach) sacralReach = d;
  }
  nodes.push(add(l5s1Node, sacralAxial, sacralReach));

  if (nodes.length !== levels.length + 1) {
    throw new Error(`built ${nodes.length} nodes for ${levels.length} levels; expected ${levels.length + 1}`);
  }

  // --- slab frames --------------------------------------------------------
  // `origin` is the midpoint of the level's two boundary nodes, so the stored
  // origin/axial/heightMm reproduce exactly the node polyline `spineGeometry()`
  // rebuilds from them. The level's own vertebral centroid lies within a
  // fraction of a millimetre of that segment; the deviation is published.
  const slabs = [];
  for (let i = 0; i < levels.length; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const axial = unit(sub(b, a));
    const heightMm = norm(sub(b, a));
    const origin = mid(a, b);
    // Anterior is +y globally; re-orthogonalise against this level's own axis.
    const k = dot([0, 1, 0], axial);
    const anterior = unit(sub([0, 1, 0], [axial[0] * k, axial[1] * k, axial[2] * k]));
    const left = unit([
      axial[1] * anterior[2] - axial[2] * anterior[1],
      axial[2] * anterior[0] - axial[0] * anterior[2],
      axial[0] * anterior[1] - axial[1] * anterior[0],
    ]);
    slabs.push({ label: levels[i].label, origin, axial, anterior, left, heightMm });

    const p = points[i];
    const alongAxis = dot(sub(p, a), axial);
    const perp = norm(sub(sub(p, a), [axial[0] * alongAxis, axial[1] * alongAxis, axial[2] * alongAxis]));
    perLevelMeasurement[i].heightMm = round(heightMm, 2);
    perLevelMeasurement[i].centroidOffAxisMm = round(perp, 3);
  }

  // --- surface radii ------------------------------------------------------
  const grid = buildGrid(skinMesh.V, skinMesh.F);
  const skinStats = surfaceStats(skinMesh.V, skinMesh.F);
  const unverified = [];

  for (let i = 0; i < slabs.length; i += 1) {
    const slab = slabs[i];
    const radii = new Array(opts.azimuths).fill(NaN);
    for (let k = 0; k < opts.azimuths; k += 1) {
      const t = k / opts.azimuths;
      const ang = t * 2 * Math.PI;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const dir = unit([
        slab.anterior[0] * c + slab.left[0] * s,
        slab.anterior[1] * c + slab.left[1] * s,
        slab.anterior[2] * c + slab.left[2] * s,
      ]);
      const hit = firstHit(grid, slab.origin, dir);
      if (hit > 0) radii[k] = hit;
    }

    const measured = radii.filter(Number.isFinite);
    if (measured.length === 0) {
      throw new Error(`${slab.label}: no azimuth reached the skin; the axis is not inside the body`);
    }
    const bound = Math.max(...measured);
    for (let k = 0; k < radii.length; k += 1) {
      if (Number.isFinite(radii[k])) continue;
      unverified.push({
        level: slab.label,
        azimuthTurns: round(k / opts.azimuths, 5),
        clock: clockOf(k / opts.azimuths),
        reason: 'ray left the skin mesh without crossing it',
        boundMm: round(bound, 2),
        boundDirection: 'upper',
      });
      radii[k] = bound;
    }
    slab.surfaceRadiiMm = radii.map((v) => round(v, 3));

    const m = perLevelMeasurement[i];
    m.radiusMm = {
      anterior: round(radii[0], 1),
      left: round(radii[Math.round(opts.azimuths * 0.25) % opts.azimuths], 1),
      posterior: round(radii[Math.round(opts.azimuths * 0.5) % opts.azimuths], 1),
      right: round(radii[Math.round(opts.azimuths * 0.75) % opts.azimuths], 1),
      min: round(Math.min(...measured), 1),
      max: round(Math.max(...measured), 1),
    };
    m.azimuthsMeasured = measured.length;
    m.azimuthsUnverified = opts.azimuths - measured.length;
  }

  // --- precision ----------------------------------------------------------
  const precision = derivePrecision(slabs, skinStats, opts.azimuths);

  const template = {
    id: opts.id,
    maxUsefulDigits: precision.maxUsefulDigits,
    slabs: slabs.map((s) => ({
      label: s.label,
      origin: s.origin.map((v) => round(v, 3)),
      axial: s.axial.map((v) => round(v, 9)),
      anterior: s.anterior.map((v) => round(v, 9)),
      left: s.left.map((v) => round(v, 9)),
      heightMm: round(s.heightMm, 4),
      surfaceRadiiMm: s.surfaceRadiiMm,
    })),
    provenance: {
      comment: [
        'Derived from the BodyParts3D 4.0 99%-reduced OBJ set by',
        'tools/build-bd-template.mjs. Not hand-authored; every number here is a',
        'measurement on the source meshes. Attribution ships with the assets:',
        'see packages/atlas-assets/ATTRIBUTION.md and docs/asset-licensing.md.',
      ],
      source: SOURCE,
      generator: 'tools/build-bd-template.mjs',
      options: {
        centreline: opts.centreline,
        bodyFraction: opts.centreline === 'body' ? opts.bodyFraction : null,
        azimuths: opts.azimuths,
      },
      frame: {
        space: 'LAS millimetres: +x subject left, +y anterior, +z superior',
        laterality: laterality.map((w) => ({
          witness: w.name, fma: w.fma, expected: w.side, observed: w.observed, meanXMm: round(w.meanXMm, 2),
        })),
      },
      measurement: {
        skin: {
          fma: SKIN_FMA,
          triangles: skinStats.triangles,
          areaMm2: Math.round(skinStats.area),
          meanEdgeMm: round(skinStats.meanEdgeMm, 3),
        },
        precision,
        levels: perLevelMeasurement,
        unverified,
      },
    },
  };

  return { template, unverified, skinStats, precision, laterality };
}

/**
 * `maxUsefulDigits` from mesh resolution, as `BodyTemplate` requires ("derived
 * from mesh resolution by the asset pipeline, not guessed here").
 *
 * An address with the azimuth anchor already denotes a cell spanning one
 * level's height, a 30 degree sector and half the radius. Each octree digit
 * halves all three. The finest cell worth issuing is the last one whose
 * SMALLEST side is still at least the geometry's own positional uncertainty,
 * which for a surface-derived radius is the skin mesh's mean edge length. One
 * digit past that, the address claims a distinction the mesh cannot make.
 */
function derivePrecision(slabs, skinStats, azimuths) {
  // Use the median level rather than the smallest, then report the spread:
  // a single short level would otherwise set the precision for the whole body.
  const heights = slabs.map((s) => s.heightMm).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)];
  const maxRadius = Math.max(...slabs.map((s) => Math.max(...s.surfaceRadiiMm)));
  const medianRadius = slabs
    .map((s) => Math.max(...s.surfaceRadiiMm))
    .sort((a, b) => a - b)[Math.floor(slabs.length / 2)];

  const axialMm = medianHeight;
  const arcMm = (2 * Math.PI * medianRadius) / 12; // one clock sector at the skin
  const radialMm = medianRadius / 2; // the I/O half
  const smallest = Math.min(axialMm, arcMm, radialMm);
  const fidelityMm = skinStats.meanEdgeMm;
  const raw = Math.floor(Math.log2(smallest / fidelityMm));
  const maxUsefulDigits = Math.max(0, Math.min(12, raw));

  return {
    maxUsefulDigits,
    basis: {
      medianLevelHeightMm: round(medianHeight, 2),
      shortestLevelHeightMm: round(heights[0], 2),
      medianMaxRadiusMm: round(medianRadius, 2),
      largestRadiusMm: round(maxRadius, 2),
      clockSectorArcMm: round(arcMm, 2),
      radialHalfMm: round(radialMm, 2),
      smallestCellSideMm: round(smallest, 2),
      skinMeanEdgeMm: round(skinStats.meanEdgeMm, 3),
      azimuthKnots: azimuths,
      azimuthKnotSpacingMm: round((2 * Math.PI * medianRadius) / azimuths, 2),
    },
    rule:
      'largest d with min(level height, clock-sector arc at the skin, radial half) / 2^d '
      + '>= the skin mesh mean edge length',
    frameCap: 12,
  };
}

const clockOf = (t) => {
  const sector = Math.floor(((t % 1) + 1) % 1 * 12 + 0.5) % 12;
  return sector === 0 ? 12 : sector;
};

const round = (v, places) => {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const { template, unverified, precision } = build(opts);

const outPath = opts.out
  ?? join(REPO_ROOT, 'packages', 'atlas-assets', 'templates', `${template.id}.body.json`);
const json = `${JSON.stringify(template, null, 1)}\n`;
writeFileSync(outPath, json);

const lines = [
  `template ${template.id}`,
  `  centreline ${opts.centreline}${opts.centreline === 'body' ? ` (anterior ${opts.bodyFraction})` : ''}`
    + `, ${opts.azimuths} azimuth knots, ${template.slabs.length} levels`,
  `  maxUsefulDigits ${precision.maxUsefulDigits} (${precision.basis.smallestCellSideMm} mm smallest cell side`
    + ` / ${precision.basis.skinMeanEdgeMm} mm skin edge)`,
  `  wrote ${rel(outPath)} (${json.length} bytes, sha256 ${createHash('sha256').update(json).digest('hex').slice(0, 16)})`,
];
if (unverified.length > 0) {
  lines.push(`  UNVERIFIED: ${unverified.length} azimuth(s) could not be measured; each filled with an upper bound`);
  for (const u of unverified.slice(0, 8)) {
    lines.push(`    ${u.level} at ${u.azimuthTurns} turns (${u.clock} o'clock): bound ${u.boundMm} mm`);
  }
  if (unverified.length > 8) lines.push(`    ...and ${unverified.length - 8} more`);
} else {
  lines.push('  every azimuth at every level reached the skin mesh');
}
console.log(lines.join('\n'));

if (opts.measurement) {
  writeFileSync(opts.measurement, `${JSON.stringify(template.provenance.measurement, null, 1)}\n`);
  console.log(`  wrote ${rel(opts.measurement)}`);
}
