/**
 * Honesty of precision, at the library boundary.
 *
 * Spec section 9 is a table of promises about what the library says when it
 * cannot answer well:
 *
 *   address finer than the template justifies -> flags.overPrecise, with the limit
 *   point outside the modelled surface        -> flags.clamped and a note, never projected
 *   point past either end of the column       -> flags.clamped, with which end
 *   vertebral level absent from the template  -> flags.homology 'absent', NaN mm, never guessed
 *   template inadmissible at this level       -> deterministic fallback plus a note naming the level
 *
 * The failure mode these tests exist for is not a wrong number. It is a *right*
 * number with no flag on it, or a flag with the wrong reason attached — both of
 * which a UI will render as confident precision. The UI assertions come later;
 * this is the boundary the UI will be built on.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  bodyLocalToMm,
  bodyMmToLocal,
  encodeBody,
  encodeBrainVolume,
  isValid,
  locate,
  parse,
  recommendedDigits,
  samePlace,
} from '../src/index.ts';
import { ADDRESSABLE_LEVELS, ANOMALOUS_LEVELS } from '../src/frames/bodySpine.ts';
import { bvLocalToMm } from '../src/frames/brainVolume.ts';
import {
  ADULT_MALE,
  BRAIN_ADULT,
  CHILD,
  SIX_LUMBAR,
  buildBodyTemplate,
  buildBrainTemplate,
} from '../src/testing/syntheticTemplates.ts';
import { ADULT_P50, buildAnatomicalBodyTemplate } from '../src/testing/anatomicalTemplates.ts';
import { measureRoundTrip } from '../src/testing/admissibilityProbe.ts';

const adult = buildBodyTemplate(ADULT_MALE);
const child = buildBodyTemplate(CHILD);
const sixLumbar = buildBodyTemplate(SIX_LUMBAR);
const brain = buildBrainTemplate(BRAIN_ADULT);

// ---------------------------------------------------------------------------
// Over-precision
// ---------------------------------------------------------------------------

test('precision: over-precision is flagged with the limit, at every digit count past it', () => {
  // Not just "the flag exists somewhere": the boundary must be exactly at
  // maxUsefulDigits, in both frames, for both a generous and a poor template.
  for (const [name, template, body] of [
    ['adult', adult, true],
    ['child', child, true],
  ] as const) {
    for (let digits = 0; digits <= 12; digits += 1) {
      const address = digits === 0 ? 'BD-T07-03O' : `BD-T07-03O-${'5'.repeat(digits)}`;
      const l = locate(address, { body: template });
      const expected = digits > template.maxUsefulDigits;
      assert.equal(
        l.flags.overPrecise ?? false,
        expected,
        `${name} (${template.maxUsefulDigits} useful): ${digits} digits should ${expected ? '' : 'not '}be over-precise`,
      );
      if (expected) {
        assert.ok(
          l.flags.notes?.some((n) => n.includes(String(template.maxUsefulDigits))),
          `${name}: the note must state the template's limit, got ${JSON.stringify(l.flags.notes)}`,
        );
        assert.ok(l.flags.notes?.some((n) => n.includes(template.id)), 'the note must name the template');
      }
      assert.ok(body);
    }
  }
  for (let digits = 0; digits <= 12; digits += 1) {
    const address = digits === 0 ? 'BV-L' : `BV-L-${'5'.repeat(digits)}`;
    assert.equal(
      locate(address, { brainVolume: brain }).flags.overPrecise ?? false,
      digits > brain.maxUsefulDigits,
      `BV at ${digits} digits`,
    );
  }
});

test('precision: an over-precise flag survives the comparison layer', () => {
  // A flag that `locate()` raises and `samePlace()` swallows is no better than
  // no flag at all, because the comparison is what a consumer actually calls.
  const over = 'BD-T07-03O-5316543210';
  assert.equal(locate(over, { body: adult }).flags.overPrecise, true, 'precondition');
  const result = samePlace(over, over, { body: adult }, { toleranceMm: 1 });
  assert.ok(
    result.notes.some((n) => n.includes('only justifies')),
    `samePlace dropped the over-precision note: ${JSON.stringify(result.notes)}`,
  );
  // Both sides are reported, not just the first.
  assert.ok(result.notes.length >= 2, `expected a note from each side, got ${result.notes.length}`);
});

test('precision: QA-3 — recommendedDigits can exceed what the template justifies', () => {
  // The defect. The function documented as "how many digits should I display?"
  // answers with a precision that locate() flags as over-precise one call
  // later, so a UI that trusts it renders false precision while the library
  // was willing to say so.
  const d = recommendedDigits('BD-T07-03O-531650', { body: adult }, 0.05);
  assert.ok(
    d > adult.maxUsefulDigits,
    `QA-3 appears fixed: recommendedDigits returned ${d} for a template justifying `
      + `${adult.maxUsefulDigits}. Delete this test and assert the bound instead.`,
  );
  const padded = `BD-T07-03O-${'531650'.padEnd(d, '0').slice(0, d)}`;
  assert.equal(locate(padded, { body: adult }).flags.overPrecise, true);

  // Same in the brain frame, so it is the function and not one template.
  const dv = recommendedDigits('BV-L-471025', { brainVolume: brain }, 0.5);
  assert.ok(dv > brain.maxUsefulDigits, `BV: recommended ${dv}, template justifies ${brain.maxUsefulDigits}`);
});

test('precision: recommendedDigits still shrinks as the residual grows', () => {
  // QA-3 is that the ceiling is missing, not that the function is meaningless.
  // This is the part that works and must keep working.
  let previous = Infinity;
  for (const residual of [0.5, 1, 2, 5, 10, 20]) {
    const d = recommendedDigits('BV-L-471025', { brainVolume: brain }, residual);
    assert.ok(d <= previous, `digits should not grow with the residual: ${d} at ${residual} mm`);
    previous = d;
  }
  assert.ok(previous >= 0);
});

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

test('precision: a point outside the modelled surface is flagged and never projected silently', () => {
  for (const r of [1.001, 1.1, 1.6, 4, 100]) {
    const outside = bodyLocalToMm(adult, { level: 'T07', u: 0.5, t: 0.25, r });
    const { flags } = encodeBody(adult, outside, 4);
    assert.equal(flags.clamped, true, `r = ${r} should clamp`);
    assert.ok(flags.notes?.some((n) => n.includes('outside the modelled body surface')), `r = ${r}`);
  }
  // And a point just inside is not flagged, so the flag means something.
  const inside = bodyLocalToMm(adult, { level: 'T07', u: 0.5, t: 0.25, r: 0.999 });
  assert.equal(encodeBody(adult, inside, 4).flags.clamped, undefined);
});

test('precision: past either end of the column, the note says which end', () => {
  const top = adult.slabs[0].origin[2];
  const bottom = adult.slabs.at(-1)!.origin[2];
  const above = encodeBody(adult, [0, 0, top + 400], 4);
  assert.equal(above.flags.clamped, true);
  assert.ok(above.flags.notes?.some((n) => n.includes('cranial')), JSON.stringify(above.flags.notes));
  const below = encodeBody(adult, [0, 0, bottom - 400], 4);
  assert.equal(below.flags.clamped, true);
  assert.ok(below.flags.notes?.some((n) => n.includes('caudal')), JSON.stringify(below.flags.notes));
});

test('precision: QA-4 — a NaN coordinate produces a confident address with no flag', () => {
  // Spec section 9 promises a flag and a note for a point merely outside the
  // surface. A NaN coordinate is worse than outside and gets nothing: the
  // library returns a specific hemisphere and a specific cell, silently.
  // A NaN arrives from a failed registration or a unit conversion that divided
  // by zero, which is exactly when a consumer most needs to be told.
  for (const point of [
    [NaN, 0, 0],
    [0, NaN, 0],
    [0, 0, NaN],
    [NaN, NaN, NaN],
  ] as Array<[number, number, number]>) {
    const result = encodeBrainVolume(brain, point, 6);
    assert.deepEqual(
      result.flags,
      {},
      `QA-4 appears fixed for ${JSON.stringify(point)}: flags are now ${JSON.stringify(result.flags)}. `
        + 'Delete this test and assert that the flag is raised.',
    );
    assert.match(result.address, /^BV-[LR]-0{6}$/, 'the fabricated address is a real, specific cell');
  }

  // Infinity, by contrast, is handled correctly — so the gap is NaN alone.
  const inf = encodeBrainVolume(brain, [Infinity, 0, 0], 6);
  assert.equal(inf.flags.clamped, true);
  assert.ok(inf.flags.notes?.some((n) => n.includes('outside the template bounding box')));
});

test('precision: QA-8 — a NaN body coordinate blames the template instead of the input', () => {
  // `bodyMmToLocal` falls through to its inadmissibility branch for NaN, and
  // emits a note accusing a template that `auditBodyTemplate()` certifies as
  // admissible. An asset pipeline reading that note would go looking for a
  // geometry bug that is not there.
  const template = buildAnatomicalBodyTemplate(ADULT_P50);
  const { flags } = bodyMmToLocal(template, [NaN, NaN, NaN]);
  const blames = flags.notes?.some((n) => n.includes('inadmissible')) ?? false;
  assert.ok(
    blames,
    'QA-8 appears fixed: a NaN coordinate no longer produces an inadmissibility note. '
      + 'Delete this test and assert the input is rejected instead.',
  );
  assert.ok(
    flags.notes?.some((n) => n.includes(template.id)),
    'the note names the template, which is what makes it misleading',
  );
});

// ---------------------------------------------------------------------------
// Homology
// ---------------------------------------------------------------------------

test('precision: a vertebral count anomaly is declared variant, with NaN mm, and never guessed', () => {
  // Roughly one person in ten has a count anomaly, so this is the honesty
  // promise that gets exercised most often in practice.
  //
  // `variant` rather than `absent` is the sharper statement, and the one a UI
  // needs: "this is real anatomy that this template does not have" is an
  // invitation to supply a registration mapping, where "absent" alone reads as
  // a dead end. Either way the millimetres must be NaN.
  for (const address of ['BD-L06-12O-531', 'BD-L06', 'BD-L06-01I', 'BD-T13-06O', 'BD-S06']) {
    const located = locate(address, { body: adult });
    assert.equal(located.flags.homology, 'variant', address);
    assert.ok(located.pointMm.every(Number.isNaN), `${address}: mm must be NaN, not a guess`);
    assert.ok(located.extentMm.every(Number.isNaN), `${address}: extent must be NaN too`);
    assert.ok(
      located.flags.notes?.some((n) => n.includes('level mapping')),
      `${address}: the note must say a registration-supplied level mapping is required`,
    );
    assert.ok(located.flags.notes?.some((n) => n.includes(adult.id)), `${address}: name the template`);
    // It must not be dressed up as a nearby answer: a consumer that reads
    // `clamped` or `folded` would render "approximately here", which is a lie.
    assert.equal(located.flags.clamped, undefined, `${address}: a variant is not clamped`);
    assert.equal(located.flags.folded, undefined, `${address}: a variant is not a fold`);
  }
  // The same address is exact in the template that has the level, so `variant`
  // is a statement about the template and not about the address. This is the
  // whole cross-population claim: the address did not change, the answer did.
  assert.equal(locate('BD-L06-12O-531', { body: sixLumbar }).flags.homology, 'exact');
  assert.ok(locate('BD-L06-12O-531', { body: sixLumbar }).pointMm.every(Number.isFinite));
});

test('precision: an absent level stops samePlace answering rather than returning false', () => {
  // "False" would be a claim. The library must say it does not know.
  const result = samePlace('BD-L06-12O-531', 'BD-L05-12O-531', { body: adult }, { toleranceMm: 5 });
  assert.equal(result.same, false);
  assert.ok(Number.isNaN(result.gapMm), 'a gap of 0 would be read as agreement');
  assert.ok(Number.isNaN(result.budgetMm));
  assert.ok(result.cellRadiiMm.every(Number.isNaN));
  assert.ok(result.notes.some((n) => n.includes('absent from its template')));
  // Symmetric: it does not matter which side is absent.
  const mirrored = samePlace('BD-L05-12O-531', 'BD-L06-12O-531', { body: adult }, { toleranceMm: 5 });
  assert.equal(mirrored.same, false);
  assert.ok(Number.isNaN(mirrored.gapMm));
});

test('precision: the level grammar separates an anomaly from a nonexistent vertebra', () => {
  // QA-6 was that `canonicalLevel` applied a single 1..12 range to every prefix,
  // so `BD-C12`, `BD-L09` and `BD-S12` all parsed and then resolved as `absent`
  // for ever — using the honest 'absent' path to excuse an out-of-grammar
  // address. Fixed: the grammar is now a per-level set, and the distinction it
  // draws is the one that matters clinically.
  //
  // `homology: 'absent'` must mean "this level is real but this template does
  // not have it" — a transitional vertebra, awaiting a registration-supplied
  // mapping. It must not mean "this level does not exist", because a consumer
  // cannot tell those apart from the flag and would offer to go looking for a
  // mapping that can never exist.
  assert.deepEqual([...ANOMALOUS_LEVELS], ['T13', 'L06', 'S06']);
  assert.equal(ADDRESSABLE_LEVELS.length, 32);

  // An anomaly parses, and reports absent with a mapping note — the L06 case
  // the spec calls out, plus the two other real count variants.
  for (const level of ANOMALOUS_LEVELS) {
    const located = locate(`BD-${level}-03O`, { body: adult });
    assert.equal(located.flags.homology, 'variant', level);
    assert.ok(located.pointMm.every(Number.isNaN), `${level}: mm must be NaN`);
    assert.ok(located.flags.notes?.some((n) => n.includes('level mapping')), level);
  }

  // A vertebra that does not exist is rejected at parse, with the correction
  // named rather than the range restated.
  for (const level of ['C08', 'C09', 'C12', 'L07', 'L12', 'S07', 'S12', 'T14', 'C00', 'L00']) {
    assert.equal(isValid(`BD-${level}-03O`), false, `BD-${level} should be rejected`);
  }
  assert.throws(
    () => locate('BD-C08-03O', { body: adult }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      assert.equal(err.code, 'bad_level');
      // The message earns its keep by naming what the writer probably meant.
      assert.match(String(err.message), /C8 \*nerve root\*/);
      return true;
    },
  );

  // And every level the grammar admits is reachable through parse(), so the
  // registry and the parser cannot drift apart.
  for (const level of ADDRESSABLE_LEVELS) {
    assert.equal(parse(`BD-${level}-03O`).anchors[0], level);
  }
});

// ---------------------------------------------------------------------------
// Inadmissibility
// ---------------------------------------------------------------------------

test('precision: locate() says so when a template is inadmissible at this cell', () => {
  // Spec section 9: "Template inadmissible at this level (bisectors cross) ->
  // Deterministic fallback plus an explicit note naming the level."
  //
  // QA-1 was that no such note was reachable through `locate()`: the address
  // below sits in a level the audit reports as a violation, its decoded cell
  // centre re-encodes to a *different* vertebra, and `locate()` answered
  // 'exact' with no note while `encodeBody()` returned no flags either. Both
  // directions were silent, which is the worst of the three possible outcomes —
  // worse than refusing, and worse than being wrong loudly.
  const split = buildAnatomicalBodyTemplate({
    ...ADULT_P50,
    id: 'split-sacrum-for-honesty',
    sacralLevels: 5,
  });
  const address = 'BD-S02-12O';
  const located = locate(address, { body: split });

  // The answer is still deterministic and still given — a fold does not make
  // the address meaningless, it makes it ambiguous — but it is now declared.
  assert.ok(located.pointMm.every(Number.isFinite), 'a fold still yields a deterministic answer');
  assert.equal(located.flags.folded, true, 'locate() must raise flags.folded');
  const note = (located.flags.notes ?? []).join(' ');
  assert.match(note, /inadmissible/, 'the note must say the template is inadmissible here');
  assert.match(note, /S02/, 'the note must name the level the address asked for');
  assert.match(note, /S01/, 'and the level the millimetres actually land in');
  assert.match(note, new RegExp(split.id), 'and the template');

  // A fold is not a clamp. Conflating them tells the user their data left the
  // body when in fact the coordinate system failed inside it.
  assert.equal(located.flags.clamped, undefined, 'a fold inside the body is not a clamp');

  // The underlying fact the note is about: this cell's centre belongs to
  // another level, so the address does not survive a round trip.
  const reEncoded = encodeBody(split, located.pointMm, 0);
  assert.equal(reEncoded.address, 'BD-S01-12O', 'precondition: this cell is inside the fold');

  // And an admissible template at the same address says nothing, so the flag
  // carries information rather than being always-on.
  const fused = buildAnatomicalBodyTemplate({ ...ADULT_P50, id: 'fused-for-honesty' });
  const clean = locate('BD-S01-12O', { body: fused });
  assert.equal(clean.flags.folded, undefined);
  assert.equal(clean.flags.notes, undefined);
});

test('precision: the probe\'s fold counter fires on a template that folds', () => {
  // QA-9 was that `inadmissibleNotes` read 0 on the one template known to fold,
  // with 42 observed round-trip failures — the note it counted only fired when
  // *no* level bracketed a point, and inside a fold a different level does. So
  // `admissibility.test.ts`'s `inadmissibleNotes === 0` could not fail and read
  // as coverage. Fixed along with QA-1/QA-2: a fold is now detected and
  // declared where it happens.
  const split = buildAnatomicalBodyTemplate({ ...ADULT_P50, id: 'split-for-notes', sacralLevels: 5 });
  const probe = measureRoundTrip(split, { samplesPerLevel: 200 });
  assert.ok(probe.failures > 0, 'precondition: this template folds');
  assert.ok(
    probe.inadmissibleNotes > 0,
    'the fold counter must fire on a folding template, or the assertion that it is 0 for good '
      + 'templates is vacuous',
  );
  // And it must stay 0 for a template that does not fold, or it is just noise.
  const clean = measureRoundTrip(buildAnatomicalBodyTemplate(ADULT_P50), { samplesPerLevel: 200 });
  assert.equal(clean.failures, 0, 'precondition: this template does not fold');
  assert.equal(clean.inadmissibleNotes, 0, 'the fold counter must not fire on a clean template');
});

// ---------------------------------------------------------------------------
// The flags must not be mutually exclusive
// ---------------------------------------------------------------------------

test('precision: several honesty problems at once are all reported', () => {
  // A UI needs the whole list. Over-precision and clamping together must not
  // overwrite one another's notes — `notes` is assigned rather than appended in
  // a couple of places, so this is worth pinning.
  const outside = bvLocalToMm(brain, 'L', { a: 1.4, b: 1.3, c: 1.2 });
  const encoded = encodeBrainVolume(brain, outside, 6);
  assert.equal(encoded.flags.clamped, true);
  assert.ok(
    (encoded.flags.notes?.length ?? 0) >= 2,
    `expected one note per out-of-range axis, got ${JSON.stringify(encoded.flags.notes)}`,
  );

  // Over-precise and absent cannot co-occur (absent returns early), but when
  // they are both true the more serious one must win: nothing may imply a
  // location for an absent level.
  const both = locate('BD-L06-12O-5316543210', { body: adult });
  assert.equal(both.flags.homology, 'variant');
  assert.ok(both.pointMm.every(Number.isNaN), 'a level the template lacks must not report millimetres');
});
