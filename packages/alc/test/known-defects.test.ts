/**
 * The minimal reproduction of every open defect from the adversarial pass.
 *
 * Full write-ups, severities and suggested fixes: docs/alc-1-attack-report.md.
 *
 * Each test here asserts that a defect *still reproduces*. That is deliberate.
 * It keeps CI green while the defects are open, it makes each one a single
 * named line in the test output rather than a paragraph in a document nobody
 * re-reads, and when a fix lands the test fails with instructions — which is
 * the only reliable way to notice that a characterisation test has become a
 * guarantee.
 *
 * So: a failure here is good news. Read the message, delete the test, and move
 * the assertion into the suite that should own it from then on.
 *
 * Defects with a natural home elsewhere are pinned there instead, and listed in
 * INDEX below so this file is still the single place to look:
 *
 *   QA-1  locate() is silent on an inadmissible level  -> precision-honesty.test.ts
 *   QA-2  the audit clears templates that fold         -> template-acceptance.test.ts
 *   QA-3  recommendedDigits recommends over-precision  -> precision-honesty.test.ts, fuzz ledger
 *   QA-4  NaN mm produce a confident address           -> precision-honesty.test.ts
 *   QA-5  the check symbol covers the wrong body       -> here, and the fuzz ledger
 *   QA-6  the BD level range is over-permissive        -> precision-honesty.test.ts, fuzz ledger
 *   QA-7  Unicode confusables are accepted             -> here, and the fuzz ledger
 *   QA-8  a NaN coordinate blames the template         -> precision-honesty.test.ts
 *   QA-9  inadmissibleNotes never fires                -> precision-honesty.test.ts
 *   QA-10 duplicate slab labels pass both gates        -> template-acceptance.test.ts
 *   QA-11 recommendedDigits returns an illegal BR precision -> here
 *   QA-12 samePlace calls disjoint cells the same place     -> equality-guard.test.ts
 *   QA-13 a displacing fold carries no flag                -> template-acceptance.test.ts
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BR,
  checkSymbol,
  format,
  isValid,
  parse,
  recommendedDigits,
} from '../src/index.ts';
import { BRAIN_ADULT, buildBrainTemplate } from '../src/testing/syntheticTemplates.ts';

/** Every defect id, so the index above cannot drift from the report. */
export const INDEX = [
  'QA-1', 'QA-2', 'QA-3', 'QA-4', 'QA-5', 'QA-6', 'QA-7', 'QA-8', 'QA-9', 'QA-10', 'QA-11',
  'QA-12', 'QA-13',
] as const;

const brain = buildBrainTemplate(BRAIN_ADULT);

// ---------------------------------------------------------------------------
test('QA-5: the check symbol is validated against the input body, not the canonical one', () => {
  // Spec section 7: "Position-weighted sum mod 32 over the canonical body."
  // `splitAddress` computes it over the uppercased *input* instead, and `parse`
  // accepts loose input such as `BD-T7-3O`. Both directions are wrong.
  const canonical = 'BD-T07-03O';
  const canonicalCheck = checkSymbol(canonical);
  assert.equal(parse(canonical).withCheck, `${canonical}~${canonicalCheck}`);

  // 1. A human drops the leading zeros — which parse() accepts — and transcribes
  //    the check symbol correctly. The code is rejected as damaged.
  assert.equal(
    isValid(`BD-T7-3O~${canonicalCheck}`),
    false,
    'QA-5 appears fixed: a canonical check symbol on a loose body is now accepted. Delete this test.',
  );
  assert.throws(
    () => parse(`BD-T7-3O~${canonicalCheck}`),
    (e: unknown) => (e as { code?: string }).code === 'check_failed',
  );

  // 2. The mirror image: a check symbol that does NOT match the address's own
  //    canonical form is accepted, and the address silently re-emits a different
  //    one. A guard that validates something other than what it resolves to is
  //    not a guard.
  const looseCheck = checkSymbol('BD-T7-3O');
  assert.notEqual(looseCheck, canonicalCheck, 'precondition: the two bodies differ');
  assert.equal(isValid(`BD-T7-3O~${looseCheck}`), true);
  assert.equal(parse(`BD-T7-3O~${looseCheck}`).withCheck, `${canonical}~${canonicalCheck}`);
  assert.equal(format(`BD-T7-3O~${looseCheck}`, { check: true }), `${canonical}~${canonicalCheck}`);

  // Suggested fix: canonicalise first, then verify the supplied symbol against
  // the canonical body. That makes both cases come out right and costs one
  // reordering in parse().
});

test('QA-7: Unicode confusables survive case mapping into a valid address', () => {
  // Spec section 3 says an address is ASCII and section 10 says the alphabet is
  // validated before anything runs. `splitAddress` uppercases first and
  // validates second, and JavaScript's `toUpperCase` maps several non-ASCII
  // code points onto legal ALC characters.
  const cases: Array<[string, string, string]> = [
    ['U+0131 LATIN SMALL LETTER DOTLESS I', 'bd-t07-03ı', 'BD-T07-03I'],
    ['U+017F LATIN SMALL LETTER LONG S', 'bd-ſ01-03o', 'BD-S01-03O'],
  ];
  for (const [name, input, canonical] of cases) {
    assert.equal(
      isValid(input),
      true,
      `QA-7 appears fixed for ${name}: ${JSON.stringify(input)} is now rejected. `
        + 'Delete this case and assert the rejection in fuzz.test.ts instead.',
    );
    assert.equal(parse(input).canonical, canonical);
    // The damage: two distinct byte sequences are one address, so a consumer
    // comparing a raw URL parameter against a stored canonical form disagrees
    // with the library about whether they are the same address.
    assert.notEqual(input.toUpperCase(), input);
    assert.equal(parse(canonical).canonical, parse(input).canonical);
  }

  // Characters whose uppercase form is not a legal ALC character are caught, so
  // the gap is narrow and the fix is correspondingly cheap: reject any input
  // containing a non-ASCII code point before uppercasing it.
  for (const bad of ['bd-t07-03K', 'bd-t07-03ⅰ', 'Ｂd-t07']) {
    assert.equal(isValid(bad), false, `${JSON.stringify(bad)} should still be rejected`);
  }
});

test('QA-11: recommendedDigits returns a precision the BR frame cannot express', () => {
  // `BR` requires at least one refinement digit, so zero is not a legal BR
  // precision — but recommendedDigits returns 0 for a BR address, and a caller
  // that truncates to the recommendation builds an invalid address.
  const d = recommendedDigits('BR-L-7A3F', { brainVolume: brain }, 1);
  assert.equal(
    d,
    0,
    `QA-11 appears fixed: recommendedDigits returned ${d} for BR. Delete this test.`,
  );
  assert.equal(isValid('BR-L'), false, 'and zero digits is indeed not a BR address');

  // Separately, the function hardcodes its own digit ceiling instead of reading
  // the frame descriptor, so the two disagree. Harmless today because BR has no
  // template, and a trap the moment it gets one.
  assert.equal(BR.maxDigits, 7);
  // src/compare.ts: `const maxDigits = a.frame === 'BR' ? 6 : 12;`
  const hardcoded = 6;
  assert.notEqual(hardcoded, BR.maxDigits, 'the hardcoded ceiling still disagrees with BR.maxDigits');

  // Suggested fix: read FRAMES[frame].maxDigits, and return null (or throw) for
  // a frame that cannot be located, rather than a count that is out of range.
});

test('known defects: the index matches the report', () => {
  // Cheap guard against the ledger and the document drifting apart. Every id in
  // INDEX must appear in the report, and the report must not describe a defect
  // that is missing from INDEX.
  const report = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'alc-1-attack-report.md'),
    'utf8',
  );
  for (const id of INDEX) {
    assert.ok(report.includes(id), `${id} is in the test index but not in docs/alc-1-attack-report.md`);
  }
  for (const m of report.matchAll(/\bQA-(\d+)\b/g)) {
    assert.ok(
      (INDEX as readonly string[]).includes(`QA-${m[1]}`),
      `the report describes QA-${m[1]}, which is missing from INDEX in this file`,
    );
  }
});
