/**
 * The CI gate on the shipped templates and naming layer.
 *
 *   node tools/verify-asset-templates.mjs
 *
 * `tools/audit-real-template.mjs` gates the `BD` template's admissibility —
 * folds, round trip, the sacral level count. This gates everything else that
 * has to be true of the asset package for an address to mean what it says, and
 * it needs no mesh data: the committed JSON plus the library.
 *
 * Seven checks, each one a property the acceptance criteria name:
 *
 *   1. The `BV` template loads, round-trips, and its AC-PC landmarks say which
 *      of them were measured. An UNVERIFIED landmark must not carry a value.
 *   2. The name index builds, declares a non-empty version, and `coverings.json`
 *      agrees with it on which version it is.
 *   3. Every structure's covering round-trips: the covering the index reports
 *      is the covering the file carries, and every cell of it resolves back to
 *      that structure.
 *   4. Ranked containment fractions add up: each one is exactly its structure's
 *      own measure within the cell, the ranking is actually ranked, and
 *      `unclaimedFraction` is exactly the complement of the union. NOT that the
 *      fractions sum to 1 - see the comment there, which is a measurement.
 *   5. Addresses survive a parcellation revision. The same address against a
 *      deliberately different index version returns the same millimetres and
 *      different names.
 *   6. The declared vertebral anomalies resolve `variant` with NaN millimetres
 *      and a note demanding a level mapping; the reserved sacral levels resolve
 *      `absent`. Four distinct outcomes, and the two that look alike are
 *      checked to be different.
 *   7. `BR` is still disabled.
 *
 * Why this is tooling rather than a test in `packages/alc`: reading asset JSON
 * from a code package is the dependency edge tools/check-licence-separation.mjs
 * exists to forbid. tools/ is CI, is not published, and is not linked into any
 * code package, so it is the right place for a gate that has to see both.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, fail, pass, rel } from './lib/repo.mjs';

const ASSETS = join(REPO_ROOT, 'packages', 'atlas-assets');
const BODY = join(ASSETS, 'templates', 'bp3d-4.0-adult-body-centroid.body.json');
const BRAIN = join(ASSETS, 'templates', 'icbm152-2009c-asym.brain-volume.json');
const NAMES = join(ASSETS, 'labels', 'names.json');
const COVERINGS = join(ASSETS, 'labels', 'coverings.json');

const problems = [];
const report = [];

for (const f of [BODY, BRAIN, NAMES, COVERINGS]) {
  if (!existsSync(f)) problems.push(`${rel(f)} is missing.`);
}
if (problems.length > 0) fail('asset templates', problems);

const body = JSON.parse(readFileSync(BODY, 'utf8'));
const brain = JSON.parse(readFileSync(BRAIN, 'utf8'));
const names = JSON.parse(readFileSync(NAMES, 'utf8'));
const coveringsFile = JSON.parse(readFileSync(COVERINGS, 'utf8'));

const {
  AlcError, buildNameIndex, locate, resolve, structureCovering, covering, coveringMeasureWithin, coveringUnion,
  encodeBrainVolume, bvLocalToMm, bvMmToLocal,
} = await import('../packages/alc/src/index.ts');

const templates = { body, brainVolume: brain };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// --- 1. the BV template ----------------------------------------------------

{
  const l = locate('BV-L-0', templates);
  if (!Number.isFinite(l.pointMm[0])) problems.push('BV-L-0 did not locate to finite millimetres.');

  // Round trip through the frame's own encode, at the template's own precision.
  const probes = [[0, 0, 0], [30, -20, 25], [-45, 40, -30], [10, -90, 60]];
  let worst = 0;
  for (const p of probes) {
    const { local, hemisphere, flags } = bvMmToLocal(brain, p);
    if (flags.clamped) {
      problems.push(`BV round trip: ${JSON.stringify(p)} clamped, but it is inside the published box.`);
      continue;
    }
    const back = bvLocalToMm(brain, hemisphere, local);
    worst = Math.max(worst, Math.hypot(back[0] - p[0], back[1] - p[1], back[2] - p[2]));
  }
  if (!(worst < 1e-9)) problems.push(`BV mm -> local -> mm drifted by ${worst} mm; it is not an exact inverse.`);

  // The AC must be inside the box, or "extents from the AC" is not what the
  // numbers mean.
  for (const [k, v] of Object.entries(brain.extents)) {
    if (!(v > 0)) problems.push(`BV extent ${k} is ${v}; the AC is not inside the published box.`);
  }

  // An UNVERIFIED landmark must not carry a value. This is the whole point of
  // the status field: a plausible number with a caveat beside it gets used.
  const landmarks = brain.provenance?.landmarks ?? {};
  if (!landmarks.ac || landmarks.ac.status !== 'MEASURED') {
    problems.push('BV template does not record a MEASURED `ac` landmark.');
  }
  if (!landmarks.acpcLine || landmarks.acpcLine.status !== 'MEASURED') {
    problems.push('BV template does not record a MEASURED `acpcLine` landmark.');
  }
  for (const [name, lm] of Object.entries(landmarks)) {
    if (lm.status !== 'UNVERIFIED') continue;
    for (const key of ['mm', 'distanceFromAcMm']) {
      if (lm[key] !== null && lm[key] !== undefined) {
        problems.push(
          `BV landmark ${name} is UNVERIFIED but carries ${key} = ${JSON.stringify(lm[key])}.`,
          '  An unverified landmark must be null. A value with a caveat beside it gets used anyway.',
        );
      }
    }
  }
  if (brain.provenance?.header?.sformCode !== 4) {
    problems.push(
      `BV provenance records sform_code ${brain.provenance?.header?.sformCode}, not 4 (mni_152).`,
      '  Without that the AC-at-the-origin landmark is an assumption about somebody else\'s file.',
    );
  }
  report.push(
    `BV ${brain.id}: AC at the world origin, ${brain.provenance.header.declaredSpace} declared by the header; `
    + `extents L${brain.extents.left} R${brain.extents.right} A${brain.extents.anterior} `
    + `P${brain.extents.posterior} S${brain.extents.superior} I${brain.extents.inferior} mm; `
    + `inverse exact to ${worst.toExponential(1)} mm; PC ${landmarks.pc?.status}`,
  );
}

// --- 2. the index and its version -----------------------------------------

const byId = new Map(coveringsFile.coverings.map((c) => [c.id, c]));
const index = buildNameIndex({
  version: names.version,
  structures: names.structures.map((s) => ({
    id: s.id,
    name: s.name,
    source: s.source,
    cells: byId.get(s.id)?.cells ?? [],
  })),
});

if (typeof names.version !== 'string' || names.version.trim() === '') {
  problems.push('names.json has no non-empty `version`.');
}
if (coveringsFile.indexVersion !== names.version) {
  problems.push(
    `coverings.json says indexVersion ${JSON.stringify(coveringsFile.indexVersion)} but names.json says `
    + `${JSON.stringify(names.version)}. They are generated together and must agree.`,
  );
}
if (coveringsFile.template !== body.id) {
  problems.push(
    `coverings.json was built against template ${JSON.stringify(coveringsFile.template)}, but the `
    + `shipped body template is ${JSON.stringify(body.id)}. The cells would denote other millimetres.`,
  );
}
for (const s of names.structures) {
  if (!byId.has(s.id)) problems.push(`names.json lists ${s.id} with no covering in coverings.json.`);
}
for (const c of coveringsFile.coverings) {
  if (!names.structures.some((s) => s.id === c.id)) {
    problems.push(`coverings.json carries ${c.id}, which names.json does not name.`);
  }
}

// --- 3. coverings round-trip to their structure ----------------------------

let cellsChecked = 0;
for (const s of names.structures) {
  const fromIndex = structureCovering(s.id, index);
  const fromFile = covering(byId.get(s.id).cells);
  if (fromIndex.cells.join(',') !== fromFile.cells.join(',')) {
    problems.push(
      `${s.id} (${s.name}): the covering the index reports is not the covering the file carries.`,
      `  file ${fromFile.cells.length} cells, index ${fromIndex.cells.length} cells.`,
    );
    continue;
  }
  // Every cell must resolve back to this structure. Sampled at both ends and
  // the middle for the big coverings, exhaustively for the small ones.
  const cells = fromIndex.cells;
  const pick = cells.length <= 12
    ? cells
    : [cells[0], cells[1], cells[Math.floor(cells.length / 2)], cells[cells.length - 2], cells[cells.length - 1]];
  for (const cell of pick) {
    cellsChecked += 1;
    const r = resolve(cell, index);
    if (!r.matches.some((m) => m.structure.id === s.id)) {
      problems.push(
        `${s.id} (${s.name}): cell ${cell} is in its own covering but does not resolve to it.`,
        `  resolved to ${r.matches.map((m) => m.structure.id).join(', ') || '(nothing)'}.`,
      );
    }
    if (r.indexVersion !== names.version) {
      problems.push(`resolve(${cell}) stamped indexVersion ${r.indexVersion}, not ${names.version}.`);
    }
  }
}

// --- 4. ranked containment fractions add up -------------------------------

{
  // The first version of this check asserted `sum(fractions) + unclaimed == 1`
  // and it was WRONG, which the measurement said immediately: `BD-T10` summed
  // to 1.505. The reason is anatomy, not arithmetic. A cell here is 25 mm or
  // more across, and at that scale the liver, the diaphragm, the ribs and the
  // stomach genuinely share cells. Containment fractions are per structure, so
  // overlapping structures each count their own share and the total exceeds 1.
  // Only a PARTITION sums to 1, and a real anatomical index is not one.
  //
  // So the exact identity is the one about the union: whatever the overlaps,
  // the share of a cell that SOME structure claims is the measure of the union
  // of all the coverings within that cell, and `unclaimedFraction` must be
  // exactly its complement. That holds for any index, overlapping or not, and
  // it is what makes `unclaimedFraction` trustworthy.
  const probes = [
    ...body.slabs.map((s) => `BD-${s.label}`),
    'BD-T07-03O', 'BD-T07-03O-5', 'BD-L03-12O-1', 'BD-C04-06I',
  ];
  const union = coveringUnion(...names.structures.map((s) => structureCovering(s.id, index)));
  let worstComplement = 0;
  let worstOverlap = 0;
  for (const address of probes) {
    const r = resolve(address, index);

    // The identity.
    const claimed = coveringMeasureWithin(union, r.address);
    worstComplement = Math.max(worstComplement, Math.abs(1 - claimed - r.unclaimedFraction));
    if (!near(1 - claimed, r.unclaimedFraction, 1e-12)) {
      problems.push(
        `resolve(${address}): unclaimedFraction is ${r.unclaimedFraction}, but the union of every`
        + ` covering occupies ${claimed} of the cell, so it should be ${1 - claimed}.`,
      );
    }

    // Each fraction is exactly that structure's own measure within the cell.
    for (const m of r.matches) {
      const exact = coveringMeasureWithin(structureCovering(m.structure.id, index), r.address);
      if (!near(m.fraction, exact, 1e-12)) {
        problems.push(
          `resolve(${address}): ${m.structure.id} reported fraction ${m.fraction}, but its covering`
          + ` measures ${exact} within the cell.`,
        );
      }
      if (!(m.fraction > 0) || m.fraction > 1 + 1e-12) {
        problems.push(`resolve(${address}): ${m.structure.id} has fraction ${m.fraction}, outside (0, 1].`);
      }
    }

    // Ranked, descending, ties broken by id.
    for (let i = 1; i < r.matches.length; i += 1) {
      const prev = r.matches[i - 1];
      const cur = r.matches[i];
      if (prev.fraction < cur.fraction - 1e-12) {
        problems.push(
          `resolve(${address}): matches are not ranked by fraction descending `
          + `(${prev.structure.id} ${prev.fraction} before ${cur.structure.id} ${cur.fraction}).`,
        );
        break;
      }
      if (near(prev.fraction, cur.fraction, 1e-12) && prev.structure.id > cur.structure.id) {
        problems.push(
          `resolve(${address}): equal fractions are not broken by id `
          + `(${prev.structure.id} before ${cur.structure.id}).`,
        );
        break;
      }
    }

    const sum = r.matches.reduce((n, m) => n + m.fraction, 0);
    worstOverlap = Math.max(worstOverlap, sum - claimed);
    // Overlap can only ever ADD. If the sum were less than the union's measure,
    // a structure would be claiming less of the cell than its own cells cover.
    if (sum < claimed - 1e-12) {
      problems.push(
        `resolve(${address}): fractions sum to ${sum}, below the union's ${claimed}. `
        + 'A structure is under-reporting its own covering.',
      );
    }
  }

  const sacrum = structureCovering('FMA16202', index);
  const within = coveringMeasureWithin(sacrum, 'BD-S01');
  if (!(within >= 0 && within <= 1 + 1e-12)) {
    problems.push(`coveringMeasureWithin(sacrum, BD-S01) is ${within}, outside [0, 1].`);
  }
  report.push(
    `coverings: ${names.structures.length} structures, ${coveringsFile.provenance.totals.cells} cells, `
    + `${cellsChecked} cells round-tripped`,
  );
  report.push(
    `fractions: exact to their own covering's measure; unclaimed is the union's complement to `
    + `${worstComplement.toExponential(1)} over ${probes.length} probes; structures overlap by up to `
    + `${worstOverlap.toFixed(3)} of a cell, which is anatomy at ${coveringsFile.digits}-digit cells, not error`,
  );
}

// --- 5. an address outlives a parcellation revision ------------------------

{
  // A deliberately different index: a new version, and the second half of the
  // structures removed. This is what a parcellation revision does to a name
  // index, and the address must not care.
  const revised = buildNameIndex({
    version: `${names.version}+revision-test`,
    structures: names.structures.slice(0, Math.ceil(names.structures.length / 2)).map((s) => ({
      id: s.id,
      name: s.name,
      cells: byId.get(s.id)?.cells ?? [],
    })),
  });
  // Two probes, because one direction alone would not prove it. The first is
  // a level the surviving half still names, so a name is expected to persist;
  // the second resolves only to structures the revision dropped, so its names
  // are expected to disappear. Both must keep their millimetres.
  // Taken FROM a surviving structure's covering rather than guessed. The first
  // guess was `BD-C07-12O`, on the reasoning that C07 survives the revision;
  // it resolved to nothing, because C07 is a posterior structure and 12 o'clock
  // is the anterior midline. A cell of the covering cannot be wrong that way.
  const survivingId = names.structures[6].id;
  const survives = structureCovering(survivingId, index).cells[0];
  const loses = 'BD-T07-03O-5';
  let kept = 0;
  let dropped = 0;
  for (const address of [survives, loses]) {
    const before = locate(address, templates);
    const a = resolve(address, index);
    const b = resolve(address, revised);
    const after = locate(address, templates);

    for (const k of [0, 1, 2]) {
      if (!near(before.pointMm[k], after.pointMm[k], 0)) {
        problems.push(`${address} decoded to different millimetres across a name-index revision.`);
        break;
      }
    }
    if (a.indexVersion === b.indexVersion) {
      problems.push('the revised index reported the same version as the original; the test proves nothing.');
    }
    if (a.address !== b.address) {
      problems.push(`${address} canonicalised differently across index versions: ${a.address} vs ${b.address}.`);
    }
    if (address === survives) {
      kept = b.matches.length;
      if (!(a.matches.length > 0)) problems.push(`${survives} resolves to nothing even in the full index.`);
      if (!(b.matches.length > 0)) {
        problems.push(
          `${survives} lost every name in the revised index, although it is a cell of `
          + `${survivingId}'s own covering and ${survivingId} survives the revision.`,
        );
      }
    } else {
      dropped = a.matches.length - b.matches.length;
      if (!(dropped > 0)) {
        problems.push(
          `${loses} did not lose any name across the revision, so the probe does not show that names `
          + 'are index-relative.',
        );
      }
    }
  }
  report.push(
    `index revision: millimetres and canonical form unchanged across `
    + `${names.structures.length} -> ${revised.structures.length} structures; `
    + `${survives} keeps ${kept} name(s), ${loses} loses ${dropped}; only the stamped version moves`,
  );
}

// --- 6. the four homology outcomes -------------------------------------

{
  const ANOMALIES = ['T13', 'L06', 'S06'];
  const RESERVED = ['S02', 'S03', 'S04', 'S05'];

  for (const level of ANOMALIES) {
    const address = `BD-${level}-03O`;
    let l;
    try {
      l = locate(address, templates);
    } catch (e) {
      problems.push(`${address} threw ${e.message}; a declared anomaly must resolve, not throw.`);
      continue;
    }
    if (l.flags?.homology !== 'variant') {
      problems.push(`${address}: homology is ${JSON.stringify(l.flags?.homology)}, expected 'variant'.`);
    }
    if (l.pointMm.some((v) => !Number.isNaN(v))) {
      problems.push(
        `${address}: pointMm is ${JSON.stringify(l.pointMm)}, expected all NaN.`,
        '  A level this template does not realise has no millimetres, and guessing one is the defect.',
      );
    }
    const note = (l.flags?.notes ?? []).join(' ');
    if (!/level mapping/i.test(note)) {
      problems.push(
        `${address}: notes do not demand a level mapping (${JSON.stringify(l.flags?.notes ?? [])}).`,
      );
    }
  }

  for (const level of RESERVED) {
    const address = `BD-${level}-03O`;
    let l;
    try {
      l = locate(address, templates);
    } catch (e) {
      problems.push(`${address} threw ${e.message}; reserved grammar must resolve as absent.`);
      continue;
    }
    if (l.flags?.homology !== 'absent') {
      problems.push(
        `${address}: homology is ${JSON.stringify(l.flags?.homology)}, expected 'absent'.`,
        '  Reserved space is not anatomy, and it must not read as a subject variant.',
      );
    }
    if (l.pointMm.some((v) => !Number.isNaN(v))) {
      problems.push(`${address}: pointMm is ${JSON.stringify(l.pointMm)}, expected all NaN.`);
    }
  }

  // The two outcomes must be DIFFERENT, or neither flag is worth reading.
  const variant = locate('BD-T13-03O', templates).flags?.homology;
  const absent = locate('BD-S02-03O', templates).flags?.homology;
  if (variant === absent) {
    problems.push(`T13 and S02 both resolve as ${variant}; the distinction the flag exists for is gone.`);
  }

  // And a typo must still be rejected rather than admitted as either.
  for (const bad of ['C08', 'T14', 'L07', 'S07']) {
    let threw = false;
    try {
      locate(`BD-${bad}-03O`, templates);
    } catch (e) {
      threw = e instanceof AlcError && e.code === 'bad_level';
    }
    if (!threw) {
      problems.push(`BD-${bad} was not rejected with bad_level; a typo must not look like an anomaly.`);
    }
  }

  // Every level the template DOES realise must be exact.
  for (const slab of body.slabs) {
    const l = locate(`BD-${slab.label}-03O`, templates);
    if (l.flags?.homology !== undefined && l.flags.homology !== 'exact') {
      problems.push(`BD-${slab.label} is realised by the template but reports homology ${l.flags.homology}.`);
    }
    if (!Number.isFinite(l.pointMm[0])) {
      problems.push(`BD-${slab.label} is realised by the template but has no finite millimetres.`);
    }
  }
  report.push(
    `homology: ${ANOMALIES.join(', ')} variant with NaN mm and a level-mapping note; `
    + `${RESERVED.join(', ')} absent; C08/T14/L07/S07 rejected bad_level; `
    + `all ${body.slabs.length} realised levels exact`,
  );
}

// --- 7. BR stays disabled --------------------------------------------------

{
  let code = null;
  try {
    locate('BR-L-7A3F', templates);
  } catch (e) {
    code = e instanceof AlcError ? e.code : `threw ${e.name}`;
  }
  if (code !== 'frame_disabled') {
    problems.push(
      `locate('BR-L-7A3F') gave ${JSON.stringify(code)}, expected 'frame_disabled'.`,
      '  BR needs a redistributable fsaverage-class surface template with per-vertex spherical',
      '  coordinates. It is not a v1 blocker and must not be enabled to make a test pass.',
    );
  }
  // It must still PARSE and refine, which is the thing that lets it ship later
  // without a grammar change.
  try {
    encodeBrainVolume(brain, [0, 0, 0], 1);
  } catch (e) {
    problems.push(`encodeBrainVolume failed on the AC: ${e.message}`);
  }
  report.push(`BR: locate() refuses with frame_disabled; the codec still parses, so v1 ships it disabled`);
}

// --- declarations are present, if the template carries any -----------------

{
  const declarations = body.provenance?.measurement?.declarations ?? [];
  for (const d of declarations) {
    for (const key of ['id', 'severity', 'affects', 'summary', 'why', 'detection', 'completeness', 'fix']) {
      if (d[key] === undefined) problems.push(`template declaration ${d.id ?? '(no id)'} is missing \`${key}\`.`);
    }
    for (const level of d.affects ?? []) {
      if (!body.slabs.some((s) => s.label === level)) {
        problems.push(`template declaration ${d.id} affects ${level}, which is not a level of this template.`);
      }
    }
  }
  const limb = declarations.find((d) => d.id === 'surface-is-limb');
  if (limb) {
    for (const row of limb.perLevel ?? []) {
      const m = body.provenance.measurement.levels.find((l) => l.level === row.level);
      if (!m?.surfaceIsLimb) {
        problems.push(`declaration surface-is-limb lists ${row.level}, but that level has no surfaceIsLimb flag.`);
      }
    }
    for (const m of body.provenance.measurement.levels) {
      if (m.surfaceIsLimb && !limb.affects.includes(m.level)) {
        problems.push(`level ${m.level} is flagged surfaceIsLimb but the declaration does not list it.`);
      }
    }
  }
  report.push(
    `declarations: ${declarations.length} (${declarations.map((d) => d.id).join(', ') || 'none'})`,
  );
}

if (problems.length > 0) fail('asset templates', problems);
pass('asset templates', report);
