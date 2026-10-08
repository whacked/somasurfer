/**
 * Reproductions for the DOG-2 pre-landing structural review of `@gstack/alc`.
 *
 *   node --experimental-strip-types test/structural-review.probe.mjs
 *   node --experimental-strip-types test/structural-review.probe.mjs 1   # one section
 *
 * This is a measurement harness, not a conformance test. It exists so every
 * number in the review can be re-derived, and so the five findings can be
 * turned into failing assertions once the fixes are agreed. Each section
 * prints what it measured and why it matters; none of them assert, because
 * four of the five describe behaviour that is currently intended-looking.
 *
 * Findings, in the order the sections appear:
 *
 *   1. auditBodyTemplate is per-level, so it misses NON-LOCAL folds. 5% of a
 *      physiological parameter box is cleared by the audit and still fails the
 *      project's own round-trip probe.
 *   2. The fold note in bodyMmToLocal is unreachable; a fold is reported as
 *      "point is outside the modelled body surface", or not at all.
 *   3. samePlace reports left hemisphere == right hemisphere at tolerance 0,
 *      because the budget sums circumscribed-sphere radii instead of testing
 *      box separation per axis.
 *   4. coveringIntersection and normalizeCovering are quadratic with a parse()
 *      per comparison: 50 s and 13 s respectively at ~1,700 cells.
 *   5. The grammar admits 19 vertebral labels that exist in no human, and
 *      rejects T13, which is the one that does.
 */
import {
  parse, contains, children, normalizeCovering, canonicalLevel,
  samePlace, recommendedDigits, coveringIntersection, coveringsIntersect,
  locate, spineGeometry, auditBodyTemplate, bodyLocalToMm, bodyMmToLocal, checkSymbol,
} from '../src/index.ts';
import { measureRoundTrip } from '../src/testing/admissibilityProbe.ts';
import {
  buildBodyTemplate, buildBrainTemplate, ADULT_MALE, BRAIN_ADULT, rng,
} from '../src/testing/syntheticTemplates.ts';
import { buildAnatomicalBodyTemplate, ADULT_P50 } from '../src/testing/anatomicalTemplates.ts';

const only = process.argv[2] ? Number(process.argv[2]) : null;
const section = (n, title, fn) => {
  if (only !== null && only !== n) return;
  console.log(`\n=== ${n}. ${title} ===`);
  fn();
};
const line = (s) => console.log(s);

const templates = {
  body: buildBodyTemplate(ADULT_MALE),
  brainVolume: buildBrainTemplate(BRAIN_ADULT),
};

/** The counterexample template: short, hyperkyphotic, large girth. */
const GATE_CLEARED_BUT_FOLDS = {
  ...ADULT_P50,
  id: 'gate-cleared-but-folds',
  cervicalLordosisDeg: 0,
  thoracicKyphosisDeg: 60, // their own comment: "hyperkyphosis of ageing reaches 60+"
  lumbarLordosisDeg: 30,
  sacralCurveDeg: 55,
  axialScale: 0.8, // short
  radialScale: 1.6, // large girth
  sacralLevels: 1,
  sacralTangentFraction: 0,
};

/** Which levels' bisector-plane regions claim a millimetre point. */
function levelsClaiming(template, p) {
  const g = spineGeometry(template);
  const sigma = (k) => {
    const d = [p[0] - g.nodes[k][0], p[1] - g.nodes[k][1], p[2] - g.nodes[k][2]];
    return d[0] * g.normals[k][0] + d[1] * g.normals[k][1] + d[2] * g.normals[k][2];
  };
  const out = [];
  for (let i = 0; i < g.dirs.length; i += 1) {
    if (sigma(i) >= 0 && sigma(i + 1) < 0) out.push(template.slabs[i].label);
  }
  return out;
}

// -------------------------------------------------------------------------
section(1, 'the audit clears templates that fold (non-local folds)', () => {
  const t = buildAnatomicalBodyTemplate(GATE_CLEARED_BUT_FOLDS);
  const audit = auditBodyTemplate(t);
  const probe = measureRoundTrip(t, { samplesPerLevel: 600, seed: 99 });
  line(`template: kyphosis 60 deg, stature x0.8, girth x1.6, one sacral level`);
  line(`  audit says admissible=${audit.admissible}, worst margin +${audit.worstMarginMm.toFixed(1)} mm`);
  line(`  ground-truth round trip: ${probe.failures}/${probe.samples} failures at ${probe.failuresByLevel.map((f) => f.level).join(',')}`);
  for (const f of probe.failuresByLevel.slice(0, 3)) {
    const l = audit.levels.find((x) => x.level === f.level);
    line(`  audit for failing level ${f.level}: utilisation ${l.utilisation.toFixed(3)}, margin +${l.marginMm.toFixed(1)} mm -- cleared`);
  }
  line('  mechanism: the fold is NOT between a level and its own two planes.');
  const rand = rng(99);
  let shown = 0;
  for (const slab of t.slabs) {
    for (let k = 0; k < 600 && shown < 3; k += 1) {
      const u = 0.02 + rand() * 0.96;
      const tt = rand();
      const r = rand() * 0.995;
      let mm;
      try { mm = bodyLocalToMm(t, { level: slab.label, u, t: tt, r }); } catch { continue; }
      const back = bodyMmToLocal(t, mm);
      if (back.local.level === slab.label) continue;
      shown += 1;
      line(`    encoded at ${slab.label} (t=${tt.toFixed(3)}, r=${r.toFixed(3)}) -> claimed by [${levelsClaiming(t, mm).join(',')}] -> decoded as ${back.local.level}`);
    }
  }
  line('  so a level can be swallowed by one FIVE levels away, which a per-level');
  line('  criterion cannot see. Consequence: the template acceptance gate cannot');
  line('  rely on auditBodyTemplate alone; it must also run measureRoundTrip.');
});

// -------------------------------------------------------------------------
section(2, 'the fold note is unreachable, and folds are misreported', () => {
  const folded = buildBodyTemplate({ ...ADULT_MALE, id: 'syn-r3', radialScale: 3 });
  const audit = auditBodyTemplate(folded);
  line(`inadmissible template (audit violations: ${audit.violations.map((v) => v.level).join(',')})`);
  const g = spineGeometry(folded);
  let total = 0; let zeroClaim = 0; let multiClaim = 0; let note = 0; let wrong = 0; let wrongSilent = 0;
  for (const slab of folded.slabs) {
    for (let k = 0; k < 48; k += 1) {
      for (let j = 1; j <= 24; j += 1) {
        for (const u of [0.05, 0.5, 0.95]) {
          let mm;
          try { mm = bodyLocalToMm(folded, { level: slab.label, u, t: k / 48, r: (j / 24) * 0.99 }); } catch { continue; }
          total += 1;
          const claims = levelsClaiming(folded, mm).length;
          if (claims === 0) zeroClaim += 1;
          if (claims >= 2) multiClaim += 1;
          const back = bodyMmToLocal(folded, mm);
          const hasNote = Boolean(back.flags.notes?.some((n) => n.includes('inadmissible')));
          if (hasNote) note += 1;
          if (back.local.level !== slab.label) {
            wrong += 1;
            if (!hasNote && !back.flags.clamped) wrongSilent += 1;
          }
        }
      }
    }
  }
  line(`  probed ${total} points inside the body`);
  line(`  claimed by 2+ levels (a real fold): ${multiClaim}`);
  line(`  claimed by 0 levels (the ONLY branch that emits the note): ${zeroClaim}`);
  line(`  "inadmissible" notes actually emitted: ${note}`);
  line(`  decoded to the WRONG level: ${wrong}, of which with no note and no clamp flag: ${wrongSilent}`);
  const rt = measureRoundTrip(folded, { samplesPerLevel: 400 });
  line(`  measureRoundTrip on the same template: ${rt.failures}/${rt.samples} failures, inadmissibleNotes=${rt.inadmissibleNotes}`);
  line('  note that admissibility.test.ts asserts inadmissibleNotes === 0, which is');
  line('  a counter that cannot increment -- the assertion passes vacuously.');
  line('  On the gate-cleared template of section 1 every wrong-level decode IS');
  line('  flagged, but as "point is outside the modelled body surface" -- the');
  line('  wrong reason, because r clamps against the wrong level\'s radius.');
});

// -------------------------------------------------------------------------
section(3, 'samePlace says left hemisphere is the same place as right', () => {
  for (const [a, b, what] of [
    ['BV-L', 'BV-R', 'whole left vs whole right hemisphere'],
    ['BV-L-0', 'BV-L-7', 'opposite corners of one hemisphere'],
    ['BV-L-00', 'BV-R-00', 'mirror cells across the midline'],
    ['BD-T06-12O', 'BD-T07-12O', 'adjacent vertebral levels, anterior'],
    ['BD-T07-12O-5', 'BD-T08-12O-5', 'adjacent vertebral levels, 1 digit'],
    ['BD-T07-12O', 'BD-T07-06O', 'sternum vs spinous process (control: correct)'],
  ]) {
    const r = samePlace(a, b, templates, { toleranceMm: 0 });
    line(`  ${a.padEnd(13)} vs ${b.padEnd(13)} same=${String(r.same).padEnd(5)} gap=${r.gapMm.toFixed(1).padStart(6)}mm budget=${r.budgetMm.toFixed(1).padStart(6)}mm  ${what}`);
  }
  const l = locate('BV-L', templates);
  line(`  cause: BV-L cell extent is [${l.extentMm.map((x) => x.toFixed(0)).join(', ')}] mm, so cellRadiusMm`);
  line(`  (half the DIAGONAL) is ${(Math.hypot(...l.extentMm) / 2).toFixed(1)} mm, while the half-extent along the axis`);
  line(`  that actually separates the two cells is only ${(l.extentMm[0] / 2).toFixed(1)} mm.`);
  line('  Fix: inflate each cell box by the tolerance and test box separation');
  line('  per axis in the frame\'s own coordinates, instead of summing radii.');
});

// -------------------------------------------------------------------------
section(4, 'covering primitives are quadratic with a parse() per comparison', () => {
  const cov = (n, seed) => {
    let s = seed >>> 0;
    const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s; };
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const v = next();
      let d = '';
      for (let k = 0; k < 4; k += 1) d += String((next() >>> 3) % 8);
      out.push(`BD-T${String(1 + (v % 12)).padStart(2, '0')}-${String(1 + ((v >>> 8) % 12)).padStart(2, '0')}${(v >>> 16) % 2 ? 'O' : 'I'}-${d}`);
    }
    return [...new Set(out)];
  };
  for (const n of [200, 800, 2000]) {
    const a = cov(n, 12345);
    const b = cov(n, 98765);
    let t0 = performance.now();
    const ix = coveringIntersection(a, b);
    const tIx = performance.now() - t0;
    t0 = performance.now();
    normalizeCovering(a);
    const tNorm = performance.now() - t0;
    t0 = performance.now();
    coveringsIntersect(a, b);
    const tAny = performance.now() - t0;
    line(`  |a|=${String(a.length).padEnd(5)} intersection=${String(ix.length).padEnd(4)} coveringIntersection=${tIx.toFixed(0).padStart(6)}ms  normalizeCovering=${tNorm.toFixed(0).padStart(6)}ms  coveringsIntersect=${tAny.toFixed(0).padStart(4)}ms`);
  }
  line('  normalizeCovering returns every input unchanged here, so that time is');
  line('  pure overhead. It calls children(parent).length -- 24 parses -- just to');
  line('  learn a sibling-group size it could get from the frame descriptor.');
  try {
    coveringIntersection(['BD-T07-03O-531'], ['BD-T07-03O-531', 'NOT-AN-ADDRESS']);
  } catch (e) {
    line(`  and one malformed member aborts the whole query: ${e.code}`);
  }
});

// -------------------------------------------------------------------------
section(5, 'the grammar admits levels that exist in nobody and rejects one that does', () => {
  const accepted = [];
  const rejected = [];
  for (const p of ['C', 'T', 'L', 'S']) {
    for (let n = 1; n <= 14; n += 1) {
      try { accepted.push(canonicalLevel(`${p}${n}`)); } catch { rejected.push(`${p}${String(n).padStart(2, '0')}`); }
    }
  }
  const real = new Set(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07',
    'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12',
    'L01', 'L02', 'L03', 'L04', 'L05', 'S01', 'S02', 'S03', 'S04', 'S05']);
  const bogus = accepted.filter((x) => !real.has(x));
  line(`  accepted but in no human: ${bogus.join(' ')}  (${bogus.length} labels)`);
  line(`  rejected: ${rejected.join(' ')}`);
  line('  T13 is the thirteenth-rib variant, about as common as six lumbar');
  line('  vertebrae -- which IS accepted (L06). The 1..12 bound is thoracic and');
  line('  was applied to every prefix, so the asymmetry is incidental.');
  for (const a of ['BD-C12-03O-531', 'BD-L09-03O-531']) {
    const f = locate(a, templates).flags;
    line(`  locate('${a}') -> homology='${f.homology}' : ${f.notes?.[0]}`);
  }
  line('  That is the same signal the plan reserves for a genuine count anomaly,');
  line('  so a typo is indistinguishable from a patient needing a level mapping.');
});

// -------------------------------------------------------------------------
section(6, 'the check symbol is not canonical', () => {
  line(`  checkSymbol('BD-T07-02O') = ${checkSymbol('BD-T07-02O')}   (canonical form)`);
  line(`  checkSymbol('BD-T7-2O')   = ${checkSymbol('BD-T7-2O')}   (loose form of the SAME address)`);
  for (const s of [`BD-T7-2O~${checkSymbol('BD-T7-2O')}`, `BD-T7-2O~${checkSymbol('BD-T07-02O')}`]) {
    try { line(`  parse('${s}') -> ${parse(s).withCheck}`); } catch (e) { line(`  parse('${s}') -> rejected: ${e.code}`); }
  }
  line('  So the check symbol issued WITH an address fails against a loose');
  line('  spelling the parser otherwise accepts, and a spelling-specific symbol');
  line('  passes. splitAddress validates it against the raw input, before');
  line('  canonicalisation; it should validate against Address.canonical.');
  line(`  recommendedDigits('BR-L-7A3F', 5mm) = ${recommendedDigits('BR-L-7A3F', templates, 5)} -- always 0 for BR, because the`);
  line('  d=0 candidate "BR-L" is rejected by BR\'s own parser and the catch breaks.');
  line(`  recommendedDigits('BD-T07-03O') = ${recommendedDigits('BD-T07-03O', templates, 5)} vs ('BD-T07-03I') = ${recommendedDigits('BD-T07-03I', templates, 5)}: padding with '0'`);
  line('  picks the innermost octant, whose azimuthal extent scales with depth, so');
  line('  deep cells under-report the precision they can justify.');
});

// Keep the hierarchy invariants visible: these are the things that are RIGHT,
// and a fix to any of the above must not disturb them.
section(7, 'controls: hierarchy invariants that currently hold', () => {
  line(`  normalizeCovering(8 octal siblings)  -> ${JSON.stringify(normalizeCovering([...'01234567'].map((d) => `BD-T07-03O-${d}`)))}`);
  const anchors = [];
  for (let c = 1; c <= 12; c += 1) for (const d of ['I', 'O']) anchors.push(`BD-T07-${String(c).padStart(2, '0')}${d}`);
  line(`  normalizeCovering(24 anchor siblings) -> ${JSON.stringify(normalizeCovering(anchors))}`);
  line(`  normalizeCovering(7 of 8 siblings)    -> ${normalizeCovering([...'0123456'].map((d) => `BD-T07-03O-${d}`)).length} cells (no false roll-up)`);
  line(`  contains('BD-T07', 'BD-T07-03O-531')  -> ${contains('BD-T07', 'BD-T07-03O-531')}`);
  line(`  children('BD-T07').length             -> ${children('BD-T07').length}`);
  line(`  admissible template round trip        -> ${JSON.stringify(measureRoundTrip(buildBodyTemplate(ADULT_MALE), { samplesPerLevel: 120 }).failures)} failures`);
});
