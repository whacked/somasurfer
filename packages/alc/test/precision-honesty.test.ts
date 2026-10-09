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
  FRAMES,
  auditBodyTemplate,
  bodyLocalToMm,
  bodyMmToLocal,
  encodeBody,
  encodeBrainVolume,
  isValid,
  locate,
  parse,
  recommendedDigits,
  recommendedPrecision,
  samePlace,
} from '../src/index.ts';
import { ADDRESSABLE_LEVELS, ANOMALOUS_LEVELS } from '../src/frames/bodySpine.ts';
import { bvLocalToMm, bvMmToLocal } from '../src/frames/brainVolume.ts';
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

test('precision: recommendedDigits never recommends a precision locate() calls over-precise', () => {
  // Was the QA-3 characterisation test, which asserted the opposite: the
  // function documented as "how many digits should I display?" answered with a
  // precision locate() flagged as over-precise one call later, so a UI that
  // trusted it rendered false precision while the library was willing to say
  // so. 32 552 corpus hits. This is `INV-RECOMMENDED-NOT-OVERPRECISE`, which
  // now stands unqualified in fuzz/invariants.ts; here are the two vectors the
  // report gives, plus the general sweep.
  const d = recommendedDigits('BD-T07-03O-531650', { body: adult }, 0.05);
  assert.equal(d, adult.maxUsefulDigits, `recommended ${d}, template justifies ${adult.maxUsefulDigits}`);
  assert.equal(
    locate(`BD-T07-03O-${'531650'.slice(0, d)}`, { body: adult }).flags.overPrecise,
    undefined,
  );

  // And in the brain frame, so this is the function and not one template.
  const dv = recommendedDigits('BV-L-471025', { brainVolume: brain }, 0.5);
  assert.equal(dv, brain.maxUsefulDigits, `BV: recommended ${dv}, template justifies ${brain.maxUsefulDigits}`);

  // The general statement, over both frames, three templates and a range of
  // residuals down to zero — a zero residual asks for the finest precision
  // there is, which is where a missing ceiling shows up first.
  for (const [address, templates, template] of [
    ['BD-T07-03O-531650', { body: adult }, adult],
    ['BD-T07-03O-531650', { body: child }, child],
    ['BD-L03-07I-04213', { body: sixLumbar }, sixLumbar],
    ['BV-L-471025', { brainVolume: brain }, brain],
    ['BV-R-0', { brainVolume: brain }, brain],
  ] as const) {
    const a = parse(address);
    for (const residualMm of [0, 0.01, 0.05, 0.5, 1, 2, 5, 10, 50, 500]) {
      const n = recommendedDigits(address, templates, residualMm);
      assert.ok(
        n <= template.maxUsefulDigits,
        `${address} at ${residualMm} mm: recommended ${n} over a ceiling of ${template.maxUsefulDigits}`,
      );
      const padded = n === 0
        ? `${a.frame}-${a.anchors.join('-')}`
        : `${a.frame}-${a.anchors.join('-')}-${(a.digits + '0'.repeat(16)).slice(0, n)}`;
      assert.equal(
        locate(padded, templates).flags.overPrecise,
        undefined,
        `${padded}, recommended for ${address} at ${residualMm} mm, is flagged over-precise`,
      );
    }
  }
});

test('precision: the recommendation says which of the three ceilings bound it', () => {
  // The other half of QA-3's fix, and the half a UI acts on: a bare number
  // cannot distinguish "collect better data and you may print more" from "this
  // template will never justify more, whatever you measure".
  //
  // Template-bound — the reported vector. A 0.05 mm residual would allow more
  // digits; `maxUsefulDigits` is what stops it.
  const tight = recommendedPrecision('BD-T07-03O-531650', { body: adult }, 0.05);
  assert.equal(tight.limitedBy, 'template');
  assert.equal(tight.digits, adult.maxUsefulDigits);
  assert.equal(tight.maxUsefulDigits, adult.maxUsefulDigits);
  assert.equal(tight.templateId, adult.id);
  assert.ok(
    tight.notes.some((n) => n.includes(adult.id) && n.includes('over-precise')),
    `the note must name the template and the flag it would have earned: ${JSON.stringify(tight.notes)}`,
  );

  // Residual-bound — the same address at a residual coarser than the finest
  // cell the template justifies. Both the number and the reason must change.
  const loose = recommendedPrecision('BD-T07-03O-531650', { body: adult }, 10);
  assert.equal(loose.limitedBy, 'residual');
  assert.ok(loose.digits < tight.digits, `${loose.digits} should be coarser than ${tight.digits}`);
  assert.ok(
    loose.notes.some((n) => n.includes('10 mm')),
    `the note must name the residual that bound it: ${JSON.stringify(loose.notes)}`,
  );
  // It still reports the template's ceiling, so a UI can say "2 of the 5 this
  // template could justify" rather than just "2".
  assert.equal(loose.maxUsefulDigits, adult.maxUsefulDigits);

  // Frame-bound — a `BD` level with no azimuth segment cannot carry refinement
  // digits at all, whatever the residual or the template would allow.
  const rootward = recommendedPrecision('BD-T07', { body: adult }, 0);
  assert.equal(rootward.limitedBy, 'frame');
  assert.equal(rootward.digits, 0);

  // A level the template does not realise has no millimetre extent, so no
  // precision is justified — and the template, not the residual, is what binds.
  const variant = recommendedPrecision('BD-L06-12O', { body: adult }, 0.05);
  assert.equal(variant.limitedBy, 'template');
  assert.equal(variant.digits, 0);
  assert.ok(
    variant.notes.some((n) => n.includes('level mapping')),
    `the note must say what would change it: ${JSON.stringify(variant.notes)}`,
  );

  // A non-finite residual is refused rather than absorbed. Left alone, every
  // "is this cell smaller than the residual?" test is false for NaN, so the
  // answer would be the deepest precision the template allows: maximum
  // confidence, from the absence of information.
  for (const bad of [NaN, Infinity, -1, 'big' as unknown as number]) {
    assert.throws(
      () => recommendedPrecision('BD-T07-03O-531650', { body: adult }, bad),
      (e: unknown) => (e as { code?: string }).code === 'bad_residual',
      `residualMm ${String(bad)} should be refused`,
    );
  }
});

test('precision: every recommendation is a precision its frame can express', () => {
  // Was the QA-11 characterisation test in known-defects.test.ts, which pinned
  // `recommendedDigits('BR-L-7A3F', templates, 1) === 0` — and `BR-L` is not an
  // address, because a `BR` address needs at least one digit for the HEALPix
  // base face. The function also hardcoded `maxDigits = frame === 'BR' ? 6 : 12`
  // while `BR.maxDigits` is 7, so the two would have disagreed the moment `BR`
  // got a template. Both bounds now come from the frame descriptor.
  assert.equal(FRAMES.BR.minDigits, 1, 'BR needs a base-face digit');
  assert.equal(FRAMES.BD.minDigits, 0, 'BD-T07 is an address on its own');
  assert.equal(FRAMES.BV.minDigits, 0);

  // A frame the library cannot locate gets locate()'s own refusal rather than a
  // number: there is no honest recommendation about a frame with no template,
  // and 0 was being read as one.
  assert.throws(
    () => recommendedDigits('BR-L-7A3F', { brainVolume: brain }, 1),
    (e: unknown) => (e as { code?: string }).code === 'frame_disabled',
  );
  // Same refusal when the frame is locatable but its template was not supplied.
  assert.throws(
    () => recommendedDigits('BD-T07-03O-531', {}, 1),
    (e: unknown) => (e as { code?: string }).code === 'no_template',
  );

  // Wherever a recommendation is given, truncating to it yields an address that
  // parses — which is what a caller displaying it depends on.
  for (const [address, templates] of [
    ['BD-T07-03O-531650', { body: adult }],
    ['BD-T07', { body: adult }],
    ['BV-L-471025', { brainVolume: brain }],
  ] as const) {
    const a = parse(address);
    for (const residualMm of [0, 0.05, 1, 5, 50]) {
      const r = recommendedPrecision(address, templates, residualMm);
      assert.ok(r.digits >= FRAMES[a.frame].minDigits, `${address}: ${r.digits} is below the frame floor`);
      assert.ok(r.digits <= r.frameMaxDigits, `${address}: ${r.digits} exceeds ${r.frameMaxDigits}`);
      assert.equal(r.frameMaxDigits, FRAMES[a.frame].maxDigits, 'the ceiling must come from the descriptor');
      const truncated = r.digits === 0
        ? `${a.frame}-${a.anchors.join('-')}`
        : `${a.frame}-${a.anchors.join('-')}-${(a.digits + '0'.repeat(16)).slice(0, r.digits)}`;
      assert.equal(isValid(truncated), true, `${truncated} is not an address`);
    }
  }
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

test('precision: a NaN coordinate is refused, by axis, instead of yielding a confident cell', () => {
  // Was the QA-4 characterisation test. `encodeBrainVolume(brain, [NaN,NaN,NaN], 6)`
  // returned `{ address: 'BV-R-000000', flags: {} }` — a specific hemisphere and
  // a specific 1 mm cell, from nothing. `clampUnit` tests `v < 0 || v >= 1`, and
  // both are false for NaN, so it passed the range test unflagged and the
  // octree's `NaN >= mid` comparisons then took the zero branch at every level.
  //
  // Spec section 9 promises a flag and a note for a point merely *outside* the
  // surface. NaN is worse than outside: it is unordered, so there is no edge it
  // is past and nothing a clamp could honestly report. It is refused.
  for (const [point, axis] of [
    [[NaN, 0, 0], 'x'],
    [[0, NaN, 0], 'y'],
    [[0, 0, NaN], 'z'],
    [[NaN, NaN, NaN], 'x'],
  ] as Array<[[number, number, number], string]>) {
    assert.throws(
      () => encodeBrainVolume(brain, point, 6),
      (e: unknown) => {
        const err = e as { code?: string; message?: string };
        assert.equal(err.code, 'nan_coordinate', `${JSON.stringify(point)}`);
        // The axis is the diagnostic: it is what tells a caller which of three
        // upstream conversions produced the NaN.
        assert.match(String(err.message), new RegExp(`the ${axis} coordinate`));
        assert.match(String(err.message), new RegExp(brain.id));
        return true;
      },
      `${JSON.stringify(point)} must be refused, not encoded`,
    );
    // Through the lower-level converter too, since a probe or an asset pipeline
    // calls that directly and must not be the one unguarded route in.
    assert.throws(
      () => bvMmToLocal(brain, point),
      (e: unknown) => (e as { code?: string }).code === 'nan_coordinate',
    );
  }

  // An infinity is a different statement and keeps its different answer: it IS
  // past an edge, in a known direction, so `clamped` plus a note is the truth
  // about it. This is the behaviour the report pointed to as the intent.
  for (const point of [[Infinity, 0, 0], [0, -Infinity, 0]] as Array<[number, number, number]>) {
    const inf = encodeBrainVolume(brain, point, 6);
    assert.equal(inf.flags.clamped, true, JSON.stringify(point));
    assert.ok(inf.flags.notes?.some((n) => n.includes('outside the template bounding box')));
  }

  // And a finite point in the same template still answers cleanly, so the guard
  // is a boundary check and not an always-on refusal.
  const inside = bvLocalToMm(brain, 'L', { a: 0.4, b: 0.6, c: 0.55 });
  assert.match(encodeBrainVolume(brain, inside, 6).address, /^BV-L-\d{6}$/);
  assert.deepEqual(encodeBrainVolume(brain, inside, 6).flags, {});
});

test('precision: a NaN body coordinate is charged to the input, never to the template', () => {
  // Was the QA-8 characterisation test: every `sigma` comparison in
  // `bodyMmToLocal` is false for NaN, so the function fell through to its fold
  // branch and filed an inadmissibility note against a template
  // `auditBodyTemplate()` certifies with 123 mm of margin. An asset pipeline
  // reading that note would go hunting a geometry bug that does not exist — and
  // that note is the one piece of diagnostic output it is told to trust.
  const template = buildAnatomicalBodyTemplate(ADULT_P50);
  for (const point of [
    [NaN, NaN, NaN],
    [NaN, 0, 0],
    [0, 0, NaN],
  ] as Array<[number, number, number]>) {
    for (const [what, call] of [
      ['bodyMmToLocal', () => bodyMmToLocal(template, point)],
      ['encodeBody', () => encodeBody(template, point, 3)],
    ] as const) {
      assert.throws(
        call,
        (e: unknown) => {
          const err = e as { code?: string; message?: string };
          assert.equal(err.code, 'nan_coordinate', `${what} ${JSON.stringify(point)}`);
          // The whole point of the fix: whatever is said about this input, the
          // template's geometry is not what is being accused.
          assert.doesNotMatch(String(err.message), /inadmissible/);
          assert.doesNotMatch(String(err.message), /fold/);
          return true;
        },
        `${what}${JSON.stringify(point)} must refuse the input`,
      );
    }
  }

  // The template is still admissible and still answers for a real point, so
  // nothing here was bought by making the template look worse.
  assert.equal(auditBodyTemplate(template).locallyAdmissible, true);
  const real = bodyLocalToMm(template, { level: 'T07', u: 0.5, t: 0.25, r: 0.5 });
  assert.deepEqual(bodyMmToLocal(template, real).flags, {});
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
