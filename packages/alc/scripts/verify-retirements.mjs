/**
 * DOG-10 step 1: re-run the *original* DOG-7 measurement for each defect whose
 * characterisation test has been retired, against the committed library — so a
 * retirement rests on the finding measurement, not on an assertion flipping.
 *
 * Reads only. Run: node scripts/verify-retirements.mjs
 */
import {
  auditBodyTemplate,
  bodyLocalToMm,
  bodyMmToLocal,
  canonicalLevel,
  encodeBody,
  levelsAddressing,
  levelsClaiming,
  locate,
  samePlace,
  scanBodyTemplateFolds,
} from '../src/index.ts';
import {
  ADULT_P50,
  ADULT_P50_SPLIT_SACRUM,
  ADULT_HYPERKYPHOTIC_SHORT_WIDE,
  PRESETS,
  buildAnatomicalBodyTemplate,
} from '../src/testing/anatomicalTemplates.ts';
import { measureRoundTrip } from '../src/testing/admissibilityProbe.ts';

const say = (s) => console.log(s);
const verdicts = [];
const verdict = (id, ok, detail) => {
  verdicts.push({ id, ok });
  say(`\n  ==> ${id}: ${ok ? 'FIXED' : 'STILL REPRODUCES'} — ${detail}`);
};

const split = buildAnatomicalBodyTemplate(ADULT_P50_SPLIT_SACRUM);

// ---------------------------------------------------------------------------
// QA-1 — locate() never reports that a template is inadmissible.
// Original measurement (report §QA-1): locate('BD-S02-12O', {body: split})
// returned flags {homology:'exact'} with no note, and re-encoding the point it
// returned gave a *different* vertebra, silently.
say('--- QA-1: locate() on an inadmissible level of anat-adult-p50-split-sacrum');
const audit = auditBodyTemplate(split);
say(`audit violations: ${JSON.stringify(audit.violations.map((v) => v.level))}`);
const loc1 = locate('BD-S02-12O', { body: split });
say(`locate('BD-S02-12O').flags = ${JSON.stringify(loc1.flags)}`);
const re = encodeBody(split, loc1.pointMm, 0);
say(`encodeBody(locate(...).pointMm, 0) = ${JSON.stringify(re)}`);
{
  const noteNamesLevel = (loc1.flags.notes ?? []).some((n) => /S02/.test(n))
    || /S02/.test(String(loc1.flags.note ?? ''));
  const silentExact = loc1.flags.homology === 'exact'
    && !loc1.flags.note && !(loc1.flags.notes ?? []).length && !loc1.flags.folded;
  verdict(
    'QA-1',
    !silentExact && (noteNamesLevel || Boolean(loc1.flags.folded)),
    silentExact
      ? 'still a bare exact answer with no note'
      : `flags now carry ${JSON.stringify(Object.keys(loc1.flags))}`,
  );
}

// ---------------------------------------------------------------------------
// QA-2 case 1 — the audit cleared S05 on the committed split-sacrum preset,
// and the S05 skin point decoded as S01 with empty flags.
say('\n--- QA-2 case 1: S05 on anat-adult-p50-split-sacrum (audit cleared it)');
const s05Audit = audit.levels.find((l) => l.level === 'S05');
say(`audit S05: utilisation ${s05Audit?.utilisation?.toFixed(3)}, ` +
  `foldRadiusMm ${s05Audit?.foldRadiusMm?.toFixed(1)}, marginMm ${s05Audit?.marginMm?.toFixed(1)}` +
  ` (so this level's OWN criterion clears it: ${(s05Audit?.marginMm ?? 0) > 0})`);
const s05Mm = bodyLocalToMm(split, { level: 'S05', u: 0.02, t: 0, r: 0.95 });
const s05Res = bodyMmToLocal(split, s05Mm);
const s05Back = s05Res.local;
say(`bodyMmToLocal(S05 u0.02 t0 r0.95) -> level ${s05Back.level}, ` +
  `u ${s05Back.u.toFixed(3)}, r ${s05Back.r.toFixed(3)}`);
say(`  flags = ${JSON.stringify(s05Res.flags ?? {})}`);
say(`levelsClaiming(that point) = ${JSON.stringify(levelsClaiming(split, s05Mm))}`);
{
  const notes = [s05Res.flags?.note, ...(s05Res.flags?.notes ?? [])].filter(Boolean).join(' | ');
  const namesBoth = /S01/.test(notes) && /S05/.test(notes);
  const outsideClaim = /outside the modelled body/.test(notes);
  verdict(
    'QA-2 (local)',
    Boolean(s05Res.flags?.folded) && namesBoth && !outsideClaim,
    `folded=${Boolean(s05Res.flags?.folded)}, names S01+S05=${namesBoth}, ` +
      `misreports as outside=${outsideClaim}`,
  );
}
const scan = scanBodyTemplateFolds(split);
say(`scanBodyTemplateFolds(split): sound=${scan.sound}, foldedPoints=${scan.foldedPoints}` +
  `/${scan.probed}, sites=${scan.sites.length}`);

// ---------------------------------------------------------------------------
// QA-2 case 2 — the 250 mm posterior bulge at L05 the audit gave 24x margin.
say('\n--- QA-2 case 2: 250 mm posterior bulge at L05, audit margin 24x');
const bulged = buildAnatomicalBodyTemplate(ADULT_P50);
const bulge = 250;
bulged.slabs = bulged.slabs.map((sl) => {
  if (sl.label !== 'L05') return sl;
  const radii = [...sl.surfaceRadiiMm];
  // posterior is t = 0.5 of the turn, measured from the anterior midline.
  const k = Math.round(0.5 * radii.length) % radii.length;
  radii[k] = bulge;
  say(`bulged L05 azimuth sample ${k} of ${radii.length} to ${bulge} mm ` +
    `(was ${sl.surfaceRadiiMm[k].toFixed(1)} mm)`);
  return { ...sl, surfaceRadiiMm: radii };
});
const bAudit = auditBodyTemplate(bulged);
const bL05 = bAudit.levels.find((l) => l.level === 'L05');
say(`audit locallyAdmissible=${bAudit.locallyAdmissible}, ` +
  `L05 utilisation=${bL05?.utilisation?.toFixed(3)} ` +
  `(margin ${(1 / (bL05?.utilisation || 1)).toFixed(1)}x)`);
const bulgeMm = bodyLocalToMm(bulged, { level: 'L05', u: 0.1, t: 0.5, r: 0.8 });
const bulgeRes = bodyMmToLocal(bulged, bulgeMm);
const bulgeBack = bulgeRes.local;
say(`bodyMmToLocal(L05 u0.1 t0.5 r0.8) -> level ${bulgeBack.level}, ` +
  `r ${bulgeBack.r.toFixed(3)}`);
say(`  flags = ${JSON.stringify(bulgeRes.flags ?? {})}`);
say(`levelsClaiming = ${JSON.stringify(levelsClaiming(bulged, bulgeMm))}`);
const bScan = scanBodyTemplateFolds(bulged);
say(`scanBodyTemplateFolds(bulged): sound=${bScan.sound}, ` +
  `foldedPoints=${bScan.foldedPoints}/${bScan.probed}, sites=${bScan.sites.length}`);
{
  const notes = [bulgeRes.flags?.note, ...(bulgeRes.flags?.notes ?? [])]
    .filter(Boolean).join(' | ');
  verdict(
    'QA-2 (non-local)',
    bulgeBack.level === 'L05' && !/outside the modelled body/.test(notes)
      && bScan.sound === false,
    `round-trips to ${bulgeBack.level} (was L01), reported-outside=` +
      `${/outside the modelled body/.test(notes)}, gate rejects it=${bScan.sound === false}`,
  );
}

// ---------------------------------------------------------------------------
// QA-6 — the BD level range was over-permissive: C08/L09/S12 parsed.
say('\n--- QA-6: the over-permissive level range');
const probe = ['C08', 'L09', 'S12', 'T13', 'L06', 'S06', 'C07', 'L05'];
const rows = probe.map((lv) => {
  try {
    return [lv, `accepted -> ${canonicalLevel(lv)}`];
  } catch (e) {
    return [lv, `rejected: ${String(e.message).slice(0, 72)}`];
  }
});
for (const [lv, r] of rows) say(`  ${lv}: ${r}`);
{
  const rejected = ['C08', 'L09', 'S12'].every((lv) => /^rejected/.test(
    rows.find((r) => r[0] === lv)[1],
  ));
  const anomaliesKept = ['T13', 'L06', 'S06'].every((lv) => /^accepted/.test(
    rows.find((r) => r[0] === lv)[1],
  ));
  verdict('QA-6', rejected && anomaliesKept,
    `C08/L09/S12 rejected=${rejected}, T13/L06/S06 addressable=${anomaliesKept}`);
}

// ---------------------------------------------------------------------------
// QA-9 — measureRoundTrip().inadmissibleNotes never fired (read 0 on the one
// template whose levels the audit condemns), so the assertion was vacuous.
say('\n--- QA-9: inadmissibleNotes on folding vs clean templates');
for (const [name, t] of [
  ['anat-adult-p50-split-sacrum', split],
  ['ADULT_HYPERKYPHOTIC_SHORT_WIDE', buildAnatomicalBodyTemplate(ADULT_HYPERKYPHOTIC_SHORT_WIDE)],
  ['anat-adult-p50 (clean)', buildAnatomicalBodyTemplate(ADULT_P50)],
]) {
  const r = measureRoundTrip(t, { samplesPerLevel: 200 });
  say(`  ${name}: failures=${r.failures}/${r.samples}, inadmissibleNotes=${r.inadmissibleNotes}`);
  if (r.failuresByLevel) {
    const by = Object.entries(r.failuresByLevel).filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}x${n}`);
    if (by.length) say(`      failuresByLevel: ${by.join(', ')}`);
  }
}
{
  const folding = measureRoundTrip(split, { samplesPerLevel: 200 });
  const clean = measureRoundTrip(buildAnatomicalBodyTemplate(ADULT_P50), { samplesPerLevel: 200 });
  verdict('QA-9', folding.inadmissibleNotes > 0 && clean.inadmissibleNotes === 0,
    `folding=${folding.inadmissibleNotes} notes, clean=${clean.inadmissibleNotes} notes`);
}

// ---------------------------------------------------------------------------
// QA-12 — samePlace() called disjoint cells the same place at toleranceMm 0.
// Original measurement: 1 329 of 3 424 disjoint pairs reported same:true.
say('\n--- QA-12: samePlace() over all disjoint cell pairs at toleranceMm 0');
{
  const t = buildAnatomicalBodyTemplate(ADULT_P50);
  const addrs = [];
  for (const slab of t.slabs.slice(0, 8)) {
    for (const clock of ['12', '03', '06', '09']) {
      for (const ring of ['I', 'O']) addrs.push(`BD-${slab.label}-${clock}${ring}`);
    }
  }
  let disjoint = 0; let wrong = 0;
  for (let i = 0; i < addrs.length; i++) {
    for (let j = i + 1; j < addrs.length; j++) {
      const r = samePlace(addrs[i], addrs[j], { body: t }, { toleranceMm: 0 });
      disjoint++;
      if (r.same) { wrong++; if (wrong <= 3) say(`  same:true for ${addrs[i]} vs ${addrs[j]}`); }
    }
  }
  say(`  distinct-address pairs: ${disjoint}, reported same at tolerance 0: ${wrong}`);
  verdict('QA-12', wrong === 0, `${wrong} of ${disjoint} distinct pairs called the same place`);
}

// ---------------------------------------------------------------------------
// QA-13 — a fold that DISPLACES rather than duplicates was silent.
// Original measurement (report §QA-13): the S02 skin point at t = 0.9917,
// r = 0.76 came back as S01 with `flags: {}`, because exactly one level claims
// it and the detector counted claimants.
say('\n--- QA-13: the displacement half of a fold on anat-adult-p50-split-sacrum');
{
  const AZ = 0.9917;
  const ray = (r) => bodyMmToLocal(split, bodyLocalToMm(split, { level: 'S02', u: 0.5, t: AZ, r }));
  const reported = ray(0.76);
  const mm = bodyLocalToMm(split, { level: 'S02', u: 0.5, t: AZ, r: 0.76 });
  say(`bodyMmToLocal(S02 u0.5 t${AZ} r0.76) -> level ${reported.local.level}`);
  say(`  flags = ${JSON.stringify({ ...reported.flags, notes: undefined })}`);
  say(`  notes = ${JSON.stringify(reported.flags.notes ?? [])}`);
  say(`levelsClaiming(that point)   = ${JSON.stringify(levelsClaiming(split, mm))}`);
  say(`levelsAddressing(that point) = ${JSON.stringify(
    levelsAddressing(split, mm).map((a) => `${a.level}${a.claims ? '' : ' (planes crossed)'} r=${a.at.r.toFixed(3)}`),
  )}`);

  // The four regimes the finding tabulated, and whether each is now declared.
  for (const r of [0.6, 0.68, 0.72, 0.76]) {
    const res = ray(r);
    say(`  r=${r.toFixed(2)} -> ${res.local.level}, folded=${Boolean(res.flags.folded)}`);
  }

  // And the other direction: the check must stay quiet on every preset, or the
  // flag stops meaning anything.
  let falsePositives = 0;
  let probed = 0;
  for (const params of PRESETS) {
    const t = buildAnatomicalBodyTemplate(params);
    for (const slab of t.slabs) {
      const knots = slab.surfaceRadiiMm.length;
      for (let k = 0; k < knots; k += 1) {
        for (const r of [0.5, 0.9, 0.995]) {
          probed += 1;
          if (bodyMmToLocal(t, bodyLocalToMm(t, { level: slab.label, u: 0.5, t: k / knots, r })).flags.folded) {
            falsePositives += 1;
          }
        }
      }
    }
  }
  say(`  presets: ${falsePositives} of ${probed} knot points falsely declared folded`);

  const notes = (reported.flags.notes ?? []).join(' | ');
  verdict(
    'QA-13',
    Boolean(reported.flags.folded) && /S02/.test(notes) && falsePositives === 0,
    `displaced point folded=${Boolean(reported.flags.folded)}, note names S02=${/S02/.test(notes)}, `
    + `preset false positives=${falsePositives}`,
  );
}

say('\n=== SUMMARY');
for (const v of verdicts) say(`  ${v.ok ? 'PASS' : 'FAIL'}  ${v.id}`);
process.exitCode = verdicts.every((v) => v.ok) ? 0 : 1;
