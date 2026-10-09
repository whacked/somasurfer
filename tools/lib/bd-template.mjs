/**
 * The `BD` body template geometry: BodyParts3D meshes in, one `*.body.json`
 * out. `tools/build-bd-template.mjs` is the command line over this.
 *
 * The source set is not in the repository — 136 MB of third-party mesh data,
 * reduced here to a ~50 kB template. The template is the committed artefact
 * and CI audits it (tools/audit-real-template.mjs) without ever needing the
 * meshes; this file is how it was derived and how it can be re-derived.
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
 * THE CENTRELINE RULE IS A CHOICE AND IT WAS DECIDED BY MEASUREMENT.
 * `VertebralSlab.origin` is documented as the centroid of the vertebral body,
 * but a BodyParts3D vertebra is one mesh: body, arch and processes together.
 * So there are two honest readings, and the pipeline implements both:
 *
 *   --centreline whole   the volume centroid of the entire vertebra. No
 *                        parameter, nothing to tune. Sits 13-15 mm posterior
 *                        of the vertebral body, because the laminae and the
 *                        spinous process carry real volume.
 *   --centreline body    the area centroid restricted to the anterior
 *                        `--body-fraction` of the vertebra's own
 *                        antero-posterior extent. This is the radiologist's
 *                        centroid method — a spinal centreline is drawn
 *                        through vertebral body centres — and it is what the
 *                        clinically parameterised templates in
 *                        testing/anatomicalTemplates.ts approximate.
 *
 * All four combinations of this and the sacral rule below were built and
 * gated. `whole` folds: utilisation 1.14 at `L05`, 979 of 162 000 scanned
 * points ambiguous, 3 of 5 000 interior probes lost. `body` folds nowhere.
 * The numbers are in ci/bd-centreline-trials.json and are rendered into
 * docs/alc-1-body-template-audit.md. Neither rule was chosen by argument, and
 * the losing one is published rather than deleted.
 *
 * S01 IS DIFFERENT, BY REQUIREMENT. docs/alc-1-admissibility.md §5
 * requirement 2: the single sacral level's axis follows the UPPER SACRAL
 * ENDPLATE, not the sacrum's chord. Measured in §3 of that document: the
 * chord leaves a ~30 degree kink at L5/S1 and that kink, not the sacrum, is
 * what limits the frame. Turning "upper sacral endplate" into an operation on
 * a mesh took three attempts; `sacralAxis()` below documents the two that
 * failed and what they measured, because both of them looked right.
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

import {
  BD_LEVELS,
  SKIN_FMA,
  SOURCE,
  assertLaterality,
  openSource,
} from './bp3d.mjs';
import {
  add,
  areaCentroid,
  bounds,
  buildGrid,
  dot,
  firstHit,
  mid,
  norm,
  principalAxes,
  sub,
  surfaceStats,
  unit,
  volumeCentroid,
} from './mesh.mjs';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    source: process.env.ALC_BP3D_DIR ?? null,
    centreline: 'body',
    azimuths: 72,
    bodyFraction: 0.4,
    endplatePad: 1.2,
    endplateBandMm: 8,
    sacralAxisRule: 'endplate-normal',
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
    else if (a === '--endplate-pad') opts.endplatePad = Number(next());
    else if (a === '--endplate-band') opts.endplateBandMm = Number(next());
    else if (a === '--sacral-axis') opts.sacralAxisRule = next();
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
  if (opts.sacralAxisRule !== 'endplate-normal' && opts.sacralAxisRule !== 'entry-tangent') {
    throw new Error(
      `--sacral-axis must be "endplate-normal" or "entry-tangent", got ${JSON.stringify(opts.sacralAxisRule)}`,
    );
  }
  if (!Number.isInteger(opts.azimuths) || opts.azimuths < 12) {
    throw new Error('--azimuths must be an integer of at least 12 (the template validator\'s floor)');
  }
  opts.id ??= `bp3d-4.0-adult-${opts.centreline}-centroid`;
  if (opts.sacralAxisRule !== 'endplate-normal') opts.id += `-${opts.sacralAxisRule}`;
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
    return { point: whole.centroid, whole, apExtentMm: hi[1] - lo[1], footprint: { lo, hi } };
  }
  // anterior is +y in template space; keep the anterior `fraction` of the extent.
  const cut = hi[1] - (hi[1] - lo[1]) * fraction;
  const keep = (_x, y) => y >= cut;
  const region = areaCentroid(mesh.V, mesh.F, keep);
  if (region.area === 0) throw new Error(`${mesh.fma}: no triangles anterior of y=${cut.toFixed(1)}`);
  // Bounds of the kept region, so a caller can use this vertebra's own body as
  // a mask on a messier mesh. See sacralAxis().
  const rlo = [Infinity, Infinity, Infinity];
  const rhi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < mesh.F.length; t += 3) {
    const a = mesh.F[t] * 3; const b = mesh.F[t + 1] * 3; const d = mesh.F[t + 2] * 3;
    const g = [
      (mesh.V[a] + mesh.V[b] + mesh.V[d]) / 3,
      (mesh.V[a + 1] + mesh.V[b + 1] + mesh.V[d + 1]) / 3,
      (mesh.V[a + 2] + mesh.V[b + 2] + mesh.V[d + 2]) / 3,
    ];
    if (!keep(g[0], g[1], g[2])) continue;
    for (let k = 0; k < 3; k += 1) {
      if (g[k] < rlo[k]) rlo[k] = g[k];
      if (g[k] > rhi[k]) rhi[k] = g[k];
    }
  }
  return {
    point: region.centroid,
    whole,
    apExtentMm: hi[1] - lo[1],
    cutMm: cut,
    regionArea: region.area,
    footprint: { lo: rlo, hi: rhi },
  };
}

/**
 * `S01`'s axis: the upper sacral endplate, measured.
 *
 * docs/alc-1-admissibility.md §5 requirement 2 says this level's axis follows
 * the upper sacral endplate rather than the sacrum's chord, and §3 measures
 * why: the chord leaves a ~30 degree kink at L5/S1, and the kink is what
 * limits the frame. So "upper sacral endplate" has to become an operation on a
 * mesh, and the first attempt at one is why this function has a long comment.
 *
 * WHAT DID NOT WORK, because it is the obvious thing. Take the cranial band of
 * the sacrum, take its anterior half, use that centroid as the axis point, and
 * take the axis direction from `L05`'s centroid to it. Measured: the axis point
 * landed 25 mm POSTERIOR of `L05`'s own centroid, because the cranial band's
 * "anterior half" still contains the sacral canal and the superior articular
 * processes. The L05 -> S01 direction came out 58 degrees off vertical, the
 * bisector plane at L5/S1 fanned out accordingly, and `S01` claimed posterior
 * skin as far up as `L03`. `L05` reached utilisation 1.20 and three levels
 * folded. That is a measurement of a bad construction, not of the anatomy.
 *
 * SECOND ATTEMPT, ALSO WRONG, for the same underlying reason. Sample the
 * sacral body column at two heights with the same anterior-fraction rule the
 * presacral vertebrae use, and take the direction between the two centroids.
 * Measured: a sacral slope of 12.6 degrees, where a human sacrum is 35-45, and
 * a column that moved ANTERIORLY as it descended, where a sacrum curves
 * posteriorly. The anterior fraction of a sacral band is not the sacral body.
 * The alae span the same antero-posterior range as the body, reach 59 mm
 * laterally, rise about 20 mm ABOVE the endplate, and carry most of the
 * surface area in the band. Both attempts failed by letting the alae in.
 *
 * WHAT THIS DOES. The ala is excluded by a mask that is itself a measurement,
 * taken from a mesh that contains no alae: the S1 endplate lies directly under
 * the body of `L05`, so `L05`'s own body region — already computed, by the same
 * anterior-fraction rule, from a clean single-vertebra mesh — supplies the
 * lateral and antero-posterior footprint. Within that footprint the cranial
 * `endplateBandMm` of the sacrum is the endplate and nothing else.
 *
 * The plane is then fitted by least variance (`principalAxes`), so the normal
 * comes from the endplate's own shape rather than from a second sample point
 * somewhere down the bone. An endplate is a shallow dome a few millimetres
 * deep and 30-50 mm across, so its least-variance direction is its normal by a
 * wide margin; the margin is published as `planarityRatio` rather than
 * assumed.
 */
function sacralAxis(mesh, opts, footprint) {
  const pad = opts.endplatePad;
  const cx = (footprint.lo[0] + footprint.hi[0]) / 2;
  const cy = (footprint.lo[1] + footprint.hi[1]) / 2;
  const hx = ((footprint.hi[0] - footprint.lo[0]) / 2) * pad;
  const hy = ((footprint.hi[1] - footprint.lo[1]) / 2) * pad;
  const inFootprint = (x, y) => Math.abs(x - cx) <= hx && Math.abs(y - cy) <= hy;

  // Cranial extreme of the sacrum WITHIN the footprint. Measured inside the
  // mask, not from the bone's bounding box, because the alae are higher.
  let zTop = -Infinity;
  for (let t = 0; t < mesh.F.length; t += 3) {
    const i = mesh.F[t] * 3; const j = mesh.F[t + 1] * 3; const k = mesh.F[t + 2] * 3;
    const gx = (mesh.V[i] + mesh.V[j] + mesh.V[k]) / 3;
    const gy = (mesh.V[i + 1] + mesh.V[j + 1] + mesh.V[k + 1]) / 3;
    if (!inFootprint(gx, gy)) continue;
    const gz = (mesh.V[i + 2] + mesh.V[j + 2] + mesh.V[k + 2]) / 3;
    if (gz > zTop) zTop = gz;
  }
  if (!Number.isFinite(zTop)) {
    throw new Error('sacrum: no triangle lies under the L05 body footprint; the meshes are not in one frame');
  }

  const keep = (x, y, z) => inFootprint(x, y) && z >= zTop - opts.endplateBandMm;
  const fit = principalAxes(mesh.V, mesh.F, keep);
  if (!fit) throw new Error('sacrum: S1 endplate band is empty');

  // Least-variance axis, signed to point caudally.
  const least = fit.axes[2];
  const normal = least[2] > 0 ? unit([-least[0], -least[1], -least[2]]) : unit(least);

  return {
    endplateMm: fit.mean,
    normal,
    planarityRatio: round(fit.variances[1] / Math.max(1e-12, fit.variances[2]), 2),
    zTopMm: round(zTop, 2),
    bandTriangles: fit.triangles,
    bandAreaMm2: Math.round(fit.area),
    footprintMm: {
      x: [round(cx - hx, 1), round(cx + hx, 1)],
      y: [round(cy - hy, 1), round(cy + hy, 1)],
    },
    slopeDeg: (Math.acos(Math.min(1, Math.max(-1, -normal[2]))) * 180) / Math.PI,
  };
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

  let lastFootprint = null;
  for (const lv of presacral) {
    const a = axisPoint(lv.mesh, opts.centreline, opts.bodyFraction);
    points.push(a.point);
    lastFootprint = a.footprint;
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

  const sacrum = sacralAxis(sacral.mesh, opts, lastFootprint);
  // Two readings of "the axis follows the upper sacral endplate", and they are
  // the same thing only if the sacrum's first segment is a straight body: the
  // plane's own normal, or the direction the column is travelling as it
  // reaches that plane. Both are built and both are gated; see
  // ci/bd-centreline-trials.json and docs/alc-1-body-template-audit.md.
  const sacralNormal = opts.sacralAxisRule === 'entry-tangent'
    ? unit(sub(sacrum.endplateMm, points[points.length - 1]))
    : sacrum.normal;

  // --- boundary nodes -----------------------------------------------------
  // A presacral boundary sits halfway between the two vertebral axis points it
  // separates, which puts it in the intervertebral disc. The cranial end
  // mirrors the first interval, so C01 gets the height of its own spacing.
  //
  // The L5/S1 boundary is NOT a midpoint. It is the measured S1 endplate: the
  // endplate IS the boundary between the lumbar column and the sacrum, and
  // using it directly is what keeps L05's axis and S01's axis nearly parallel
  // there. Taking that boundary as mid(L05 centroid, some sacral centroid)
  // instead is the construction that produced a 58 degree kink and three
  // folding levels; see sacralAxis() above.
  const nodes = [];
  for (let i = 0; i < points.length - 1; i += 1) nodes.push(mid(points[i], points[i + 1]));
  nodes.unshift(add(points[0], sub(points[0], nodes[0])));
  nodes.push(sacrum.endplateMm);

  // S01 runs from the endplate along the endplate's own normal, far enough to
  // cover the whole bone. The sacrum has no successor to bisect against, so
  // its caudal face is its own extent rather than a boundary.
  let sacralReach = 0;
  for (let i = 0; i < sacral.mesh.V.length; i += 3) {
    const d = dot(
      sub([sacral.mesh.V[i], sacral.mesh.V[i + 1], sacral.mesh.V[i + 2]], sacrum.endplateMm),
      sacralNormal,
    );
    if (d > sacralReach) sacralReach = d;
  }
  nodes.push(add(sacrum.endplateMm, sacralNormal, sacralReach));

  points.push(mid(sacrum.endplateMm, add(sacrum.endplateMm, sacralNormal, sacralReach)));
  perLevelMeasurement.push({
    level: sacral.label,
    fma: sacral.fma,
    term: sacral.term,
    triangles: sacral.mesh.F.length / 3,
    axisPointMm: points[points.length - 1].map((v) => round(v, 2)),
    wholeCentroidMm: volumeCentroid(sacral.mesh.V, sacral.mesh.F).centroid.map((v) => round(v, 2)),
    endplateMm: sacrum.endplateMm.map((v) => round(v, 2)),
    endplateNormal: sacrum.normal.map((v) => round(v, 6)),
    endplateSlopeDeg: round(sacrum.slopeDeg, 2),
    endplatePlanarityRatio: sacrum.planarityRatio,
    endplateBandTriangles: sacrum.bandTriangles,
    endplateBandAreaMm2: sacrum.bandAreaMm2,
    endplateFootprintMm: sacrum.footprintMm,
    axialRule: opts.sacralAxisRule,
    axialMm: sacralNormal.map((v) => round(v, 6)),
    note: 'axis from the measured S1 endplate: admissibility §5 requirement 2',
  });

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
    // Tangent turn at this level's cranial boundary. This is the quantity the
    // frame's fold radius is inversely proportional to, so it is the first
    // number to look at when a level folds: 1 degree over a 30 mm level is a
    // fold radius of about 1 700 mm, 30 degrees is about 57 mm.
    perLevelMeasurement[i].kinkAtCranialBoundaryDeg = i === 0
      ? null
      : round((Math.acos(Math.min(1, Math.max(-1, dot(slabs[i - 1].axial, axial)))) * 180) / Math.PI, 2);
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
        sacralAxisRule: opts.sacralAxisRule,
        endplatePad: opts.endplatePad,
        endplateBandMm: opts.endplateBandMm,
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

export { parseArgs, build, round };
