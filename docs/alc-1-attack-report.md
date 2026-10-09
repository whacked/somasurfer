# ALC-1 adversarial conformance — QA report

**Task:** DOG-7
**Target:** `packages/alc` at `029df91`, re-verified against the working tree including `a2a4cdf`
**Date:** 2026-10-08
**Author:** QA Engineer
**Scope:** address parser, comparison semantics, template admissibility gate, precision honesty.
Viewer journeys, deep links and research-data import are out of scope — no artefacts yet.

## Summary

Attacked the parser **160 470 ways** across twenty-two invariants, the template gate with
**nine** constructed templates, and the comparison layer with a static scan, seven
injected mutants and a 3 424-pair disjointness sweep. **Thirteen defects, all with a
minimal reproduction, all committed as executable tests.** No crash, no unbounded work,
no undocumented exception, and no failure of the hierarchy, covering or containment
guarantees.

The four that matter most are not parser bugs:

1. **QA-2** — `auditBodyTemplate()` clears a level that demonstrably folds, on a
   *committed preset*. `docs/alc-1-admissibility.md` §4 claims "the exact verdict
   matches the observed failures in every row". It does not: `S05` of
   `anat-adult-p50-split-sacrum` is cleared with **+34 mm of margin** and
   **utilisation 0.74**, and `measureRoundTrip` observes two failures there. The audit's
   condition is sound per level against its own two bisector planes; level assignment is
   a first-match scan over the whole column, so a distant level can claim a point the
   audit never considered. No per-level condition can see this.
2. **QA-1** — spec §9 promises "deterministic fallback plus an explicit note naming the
   level" when a template is inadmissible. **No such note was reachable through
   `locate()`.** `locate('BD-S02-12O')` answered `homology: 'exact'` with no note, while
   its cell centre re-encoded to `BD-S01-12O` — a different vertebra. `encodeBody()` was
   silent in the same case: both directions swallowed it. Since fixed, along with QA-2.
3. **QA-3** — `recommendedDigits()`, whose documented job is "how many digits should I
   display?", recommends **8** digits for a template that justifies **5**, a precision
   `locate()` itself flags `overPrecise`. The honesty flag exists; the function a UI will
   actually call routes around it.
4. **QA-12** — `samePlace()`, the function the spec mandates *instead of* `a === b`,
   reports **1 329 of 3 424 disjoint cell pairs (38.8 %)** as the same place at
   `toleranceMm: 0`, including the two cerebral hemispheres (68 mm apart) and two whole
   vertebral levels. The budget is built from half the cell *diagonal* and charged against
   a one-axis separation. A screen that follows spec §6 gets a false "yes" where string
   equality would have said no.

`BD-T07-02O-9` is properly fixed: digit-alphabet validation is in `parse()` for all
three frames, verified exhaustively over all 36 alphanumerics × 3 frames. The Node 24
zero-tests problem is fixed and now gated by `tools/check-test-count.mjs`.

## What was committed

| Artefact | What it does |
| --- | --- |
| `packages/alc/test/fuzz/corpus.ts` | The documented three-layer corpus, seed `20261008`, replayable |
| `packages/alc/test/fuzz/invariants.ts` | Twenty-two invariants plus the bidirectional defect ledger |
| `packages/alc/test/fuzz.test.ts` | The fuzz suite, ~9 s in CI |
| `packages/alc/test/guards/addressEquality.ts` | The `a === b` scanner, scope rules and reviewed-exception list |
| `packages/alc/test/equality-guard.test.ts` | The standing guard, demonstrated against 7 mutants |
| `packages/alc/src/testing/templateAcceptance.ts` | The reusable four-stage template acceptance gate |
| `packages/alc/test/template-acceptance.test.ts` | The gate over all 5 presets, and the attacks on the gate |
| `packages/alc/test/precision-honesty.test.ts` | Spec §9's promises, asserted at the library boundary |
| `packages/alc/test/known-defects.test.ts` | Minimal repros and the defect index |

Every defect is pinned by a test that **fails when the defect is fixed**, with a message
saying what to do. CI stays green while they are open; nobody has to remember.

---

## 1. Fuzzing the address parser

### Corpus

Three layers, all deterministic. Seed and size are environment-overridable so a failure
replays exactly:

```
cd packages/alc
node --test test/fuzz.test.ts                                   # 8 000 rounds, ~9 s
ALC_FUZZ_ITERATIONS=400000 ALC_FUZZ_SEED=12345 \
  node --test test/fuzz.test.ts                                 # soak
```

| Layer | Size at default | What it covers |
| --- | --- | --- |
| `curatedCorpus()` | 991 fixed vectors | Every attack idea, one vector each. Where regressions go. |
| `mutatedCorpus()` | 8 000 | 1–3 random edits to ten seed addresses, from ASCII and 32 confusables |
| `wellFormedCorpus()` | 2 666 | Addresses legal by construction, to exercise the deep grammar |

11 657 inputs per CI run, 8 304 of them distinct, **4 363 accepted** by `parse()` —
the accepted fraction is what matters, since every invariant is conditional on acceptance.
The 160 470 figure is the exploratory sweep this corpus was distilled from.

Curated coverage: case and whitespace forms; leading-zero loose forms; all four vertebral
prefixes `00`–`14` in one- and two-digit forms; all clock sectors `0`–`13` × `{I,O,X}`;
refinement depth 0–18 against each frame's cap and the global 16; wrong-alphabet digits
per frame; 30 malformed anchor and separator shapes; lengths 60–1 024 against the 64-char
cap; all 32 Crockford characters as check symbols on canonical **and** loose bodies;
32 Unicode confusables in six positions each, including NFD pairs and lone surrogates.

The confusable list is derived from the actual attack surface: `splitAddress` calls
`toUpperCase()` *before* validating the alphabet, so the surface is "every code point
whose uppercase form is a legal ALC character", plus invisibles and hyphen lookalikes.

### Invariants

Asserting "this string should be rejected" is the wrong test for a parser — for most
hostile strings either verdict is defensible. Every invariant is therefore conditional
on acceptance and asks whether the *rest of the library* honours what the parser let
through. That is the `BD-T07-02O-9` shape.

| Invariant | Status |
| --- | --- |
| `INV-IDEMPOTENT` canonicalisation is a fixed point | clean |
| `INV-CANONICAL-REPARSE` the canonical form re-parses | clean |
| `INV-CHECK-ACCEPTS-CANONICAL` canonical form + its own check is accepted | clean |
| `INV-CHECK-ALPHABET` no non-Crockford check symbol is accepted | clean |
| `INV-ANCESTOR-CONTAINS` / `INV-ANCESTOR-COARSER` truncation contains, strictly | clean |
| `INV-CHILD-CONTAINED` every child is contained by its parent | clean |
| `INV-COVERING-SINGLETON` `normalizeCovering([a]) === [a]` | clean |
| `INV-LOCATE-NAN-UNDECLARED` NaN mm only ever as declared `absent` | clean |
| `INV-LOCATE-EXTENT-NAN/NEGATIVE` extents finite and non-negative | clean |
| `INV-LOCATE-UNDOCUMENTED-THROW` only spec §9 error codes escape | clean |
| `INV-SELF-SAMEPLACE` an address is the same place as itself | clean |
| `INV-ASCII` an accepted input was ASCII | **QA-7** |
| `INV-CHECK-CANONICAL` an accepted check symbol is the canonical one | **QA-5** |
| `INV-CHECK-ACCEPTS-LOOSE-CANONICAL` loose body + canonical check is accepted | **QA-5** |
| `INV-GRAMMAR-LEVEL` the `BD` anchor is in the spec's level set | **QA-6** |
| `INV-RECOMMENDED-NOT-OVERPRECISE` the display recommendation is honest | **QA-3** |

The ledger is bidirectional: an unfiled violation fails the suite, **and so does a ledger
entry that stops reproducing**. A fix cannot leave a stale exception behind.

### Attacked and found nothing

Worth recording, because these were the stated targets:

- **Unbounded work.** None. A hostile 64-character address costs ~4 µs; the suite
  asserts a 0.4 ms per-parse ceiling over seven worst-case shapes. The length cap,
  the per-frame digit caps (`BD` 12, `BV` 12, `BR` 7) and the global 16 all hold, and
  cannot be smuggled past with extra segments, extra separators, or a check symbol used
  as padding. No regex in the parser backtracks. The largest amplification found anywhere
  was `normalizeCovering()` at 73 ms for a caller-supplied 1 536-cell covering — driven
  by argument size, not by any single address.
- **Non-`AlcError` escapes.** None over the whole corpus. `parse()` on `undefined`,
  `null`, numbers, `NaN`, objects, arrays, `Symbol`, `BigInt`, functions and an object
  that stringifies to a valid address all raise `AlcError`, never a `TypeError`.
- **Malformed anchor shapes.** All 30 rejected with the right code: empty segments,
  leading and doubled separators, a 3-digit level, clock `00` and `13`, a bare depth
  half, `BV-LL`, `BR-L` without digits, base face `C`, `BR-L-FFFFFFF`. `BR-L-BFFFFFF`
  is accepted and is correct — it is exactly `npix(12) - 1`.
- **Check symbol strength.** The §7 claim holds. Every single-character substitution
  within the alphabet is caught, and a non-Crockford check symbol is never accepted.
  The defect is which body it covers (QA-5), not the algorithm.
- **Hierarchy, containment and covering.** Zero violations over 160 470 inputs.
  Truncation always yields a strictly coarser containing ancestor, children are always
  contained, and `normalizeCovering` is identity on a singleton.

---

## 2. Comparison semantics — the standing guard

`test/guards/addressEquality.ts` scans `src/**/*.ts` for comparisons on address
*values* and requires each to be signed off in `REVIEWED` with a reason.

**Scope rule.** In scope: `.canonical`, `.withCheck`, `.digits`, an indexed
`.anchors[...]`, an address-*named* identifier, a bare `parse()`/`format()` result, and
anything tainted as a collection of those. Out of scope, with the reason stated in the
module: `.frame` and `.length`. A frame id is a coordinate system, not a place —
comparing frames is how `samePlace()` *refuses* to answer — and a segment count is arity.
Neither can express a cross-subject identity claim. Keeping them out is what stops the
guard going red every time unrelated code moves a line.

**Current state:** 2 in-scope sites, both reviewed.

| Site | Why it is safe |
| --- | --- |
| `src/address.ts` `o.anchors[k] !== i.anchors[k]` | `contains()`: the structural prefix test inside one frame. Cells in a frame are nested or disjoint by construction. |
| `src/covering.ts` `cur.canonical !== o.canonical` | `relativeMeasure()`: termination test for walking `inner` up its own ancestor chain. Same frame, dimensionless result. |

**Demonstrated to fail.** `equality-guard.test.ts` injects seven mutants and requires all
seven to be caught: the obvious `parse(a).canonical === parse(b).canonical`; via named
locals; via `addressA === addressB`; via the digit segment alone; via `Set.has`; via
`Array.includes` on an array of canonical forms; and `parse(a) === parse(b)`. Nine negative
controls must *not* fire, including the same comparison written inside a line comment and
inside a block comment.

**The naming rule reads words, not substrings — and that was a bug first.** The rule
started as `/addr|alccode/i` against the whole identifier, which fired on `ADDRESSABLE`,
the registry of vertebral levels an address may name, and failed the suite on a
level-label lookup that holds no address value at all. A guard that goes red on English
is a guard somebody switches off, which costs more than the false negative narrowing it
buys. Identifiers are now split on camel-case and separator boundaries and matched word
by word, with adjacent words joined so `alcCode` still counts and `ALC_VERSION` does not.
Every real form — `address`, `addrB`, `findingAddr`, `subjectAddresses`, `ADDRESS_A` —
still matches, and the dangerous collection case is untouched because taint reads the
*initialiser*: `const levels = new Set(addresses)` is still caught under a name with no
address word in it. Both halves are pinned as positive and negative controls.

**Disjointness, the other way round.** Forbidding `a === b` only blocks the wrong answer
in one direction. The complementary assertion — every *disjoint* pair of cells, at every
depth, in both frames, must report `same: false` at `toleranceMm: 0` — is the stronger
statement, and running it found **QA-12** below: it fails for 38.8 % of pairs.

**Known limit, stated rather than papered over.** The scanner is regex-based. A collection
of addresses built by `push` in a loop, under a name with no address word anywhere in its
provenance, is not detected. That residual is why the guard has a second half: four tests
re-measure *why* the rule exists, so renaming variables past the scanner still leaves a
suite that says string equality is the wrong question. Measured here, not quoted from the
spec: at a 5 mm residual and 5 digits, string equality recognises **< 10 %** of matching
pairs and `samePlace` recognises **> 99 %**, while the mean centre gap stays near the
residual. And the sharpest form — identical address strings resolved in two templates are
*not* at the same millimetres, so equality is not merely lossy across subjects, it is
answering a different question.

---

## 3. Template admissibility as an acceptance gate

`src/testing/templateAcceptance.ts` — `acceptBodyTemplate(template)` returns a report;
it asserts nothing and throws nothing, so the asset pipeline can publish it.

**The criterion is `scanBodyTemplateFolds` (DOG-9): every point generated from a
level's own coordinates must be claimed by exactly that level.** It is not
`locallyAdmissible` and it is not `failures === 0`; both of those pass templates that
fold, for different reasons, and both are demonstrated doing so below.

| Stage | What it checks |
| --- | --- |
| `STRUCTURE` | Duplicate labels, unaddressable labels, sacral level count, finite and unit geometry, `maxUsefulDigits` against the frame cap |
| `AUDIT` | `auditBodyTemplate()` violations, plus a utilisation ceiling (default 0.95). Evidence and localisation, **not** the gate |
| `PROBE` | `measureRoundTrip()` — zero failures, zero inadmissible notes, exact inverse |
| `ADMISSIBILITY-CONSISTENCY` | `scanBodyTemplateFolds().sound`, reported by failure mode (`ambiguous` / `lost` / `unclaimed`), plus both directions of disagreement with the audit |

All five presets pass all four stages. The rejected `anat-adult-p50-split-sacrum` fails
all four. The gate also rejects marginal-but-admissible templates, unaddressable labels,
over-claimed precision, and survives five kinds of malformed geometry by reporting rather
than throwing.

Why the criterion is the scan and not the two obvious candidates, each measured on a
committed fixture:

- **`locallyAdmissible` passes folding templates.** It tests a level against its own two
  bisector planes only; a non-adjacent level can claim the point. 162 of 3 228 templates
  across the parameter box satisfy it and fold (5.0%). `ADULT_HYPERKYPHOTIC_SHORT_WIDE`
  clears it with **+7.8 mm** of margin and folds at 597 of 54 000 skin points.
- **`failures === 0` also passes them**, and became *weaker* when `bodyMmToLocal` started
  picking the nearest claimant instead of the most cranial: the repair fixes the decode
  while leaving the point denoted by two addresses in two levels. On that same fixture the
  `PROBE` stage passes at 60 samples per level while the scan finds 597 folded points.
  `acceptance: the gate rejects a folding template the round trip calls clean` pins
  exactly that pair of facts, so neither stage can later be pruned as redundant.
- **Counting claimants alone is not enough either.** Past its own fold radius a level's
  planes stop bracketing its own points, so a point can be claimed *solely by a
  neighbour*: one claimant, nothing ambiguous at runtime, and the original address gone.
  That is QA-13, and it is the scan's `lost` kind.

Ambiguity is the defect; a wrong answer was only ever its symptom. The consistency stage
also keeps the one check nothing else makes — a level the audit *flags* that the scan
finds sound, which means the published per-level margin is mis-stated even where the
template is usable.

---

## Status

The CTO began landing fixes while this pass was still running, so the statuses
below are the ones the committed tests assert. Every "fixed" row was re-verified
against the working tree, and the test that pinned the defect was converted into
a positive guarantee rather than deleted.

| id | severity | status |
| --- | --- | --- |
| QA-1 | High | **fixed** — `locate()` now raises `flags.folded` and carries a note naming both the level the address asked for and the level its millimetres land in. Pinned as a positive guarantee by `precision: locate() says so when a template is inadmissible at this cell`. |
| QA-2 | High | **fixed** — `bodyMmToLocal` now detects multiple bracketing levels, raises `flags.folded`, names the competing levels and states the point is not outside the body. `admissible` was renamed `locallyAdmissible` with the sufficiency caveat, and `scanBodyTemplateFolds()` is the gate. The per-level criterion is still incomplete *by design*, which is now documented and measured: 162 of 3 228 templates in the physiological box (5.0%) satisfy it and fold anyway. |
| QA-3 | High | **open** — `recommendedDigits()` still returns 8 for a template justifying 5. |
| QA-4 | High | **open** — `encodeBrainVolume(t, [NaN,NaN,NaN], 6)` still returns `BV-R-000000` with `flags: {}`. |
| QA-5 | Medium-High | **open** |
| QA-6 | Medium-High | **fixed** — `canonicalLevel` now holds a per-level set. `ANOMALOUS_LEVELS = ['T13','L06','S06']` are addressable and report the new `homology: 'variant'`; everything else is rejected with the correction named (`BD-C08` explains the C8 *nerve root*). The fix went further than the finding: `variant` vs `absent` distinguishes "real anatomy this template lacks" from "not a level", which is the distinction a UI needs. |
| QA-7 | Medium | **open** |
| QA-8 | Medium | **open** — a NaN body coordinate still produces an inadmissibility note against a template the audit certifies. |
| QA-9 | Medium | **fixed** — falls out of QA-2. `inadmissibleNotes` now reads 31 on the split-sacrum template and stays 0 on a clean one, so the assertion is no longer vacuous. |
| QA-10 | Low | **fixed** |
| QA-11 | Low | **open** |
| QA-12 | High | **fixed** — `cellRadiusMm`'s 3-D diagonal replaced by `cellReachMm`, the box's directional support function, plus a structural short-circuit: disjoint cells of one template are a definitive no at `toleranceMm: 0`, scoped to zero so a stated tolerance is still a geometric question. All 3 424 disjoint pairs now report `same: false`; the characterisation test is now the invariant itself. |
| QA-13 | Medium | **open** — filed on the resumed run. The displacement half of a fold carries no flag; only reachable on a template the gate rejects. |

Eight of the thirteen are closed. The two High ones still open, QA-3 and QA-4,
are the same shape — a confident answer with the flag missing — and neither needs
more than a few lines. Every open defect has an owner and a bounded task:
QA-3, QA-4, QA-8 and QA-11 on DOG-16; QA-5 and QA-7 on DOG-17; QA-13 on DOG-18.

A note on this table, because it drifted once already: a row here is a claim
about the tests, and `known defects: the index matches the report` only verifies
that an id *appears* in both places, which is how the stale QA-1 row survived a
run. Tightening that check into one that reads the ledger and fails on a
contradiction is scoped on DOG-10.


## Defects

Severity is about what reaches a user: **High** = a wrong answer presented as a right
one. **Medium** = a wrong answer that is at least visible, or a correct answer with a
misleading reason. **Low** = a trap for the next change.

### QA-1 — `locate()` never reports that a template is inadmissible — High

Spec §9: *"Template inadmissible at this level (bisectors cross) → Deterministic fallback
plus an explicit note naming the level."* Unimplemented. The note exists only in
`bodyMmToLocal`, and only on the branch where **no** level brackets the point — which is
not what happens inside a fold, where a *different* level brackets it.

```js
const split = buildAnatomicalBodyTemplate({ ...ADULT_P50, sacralLevels: 5 });
locate('BD-S02-12O', { body: split });
// -> flags: { homology: 'exact' }          // no note, no clamp
encodeBody(split, locate('BD-S02-12O', { body: split }).pointMm, 0);
// -> { address: 'BD-S01-12O', flags: {} }  // a different vertebra, silently
```

`auditBodyTemplate(split)` lists S02 as a violation, so the library *knows*. Both
directions stay silent. **Fix:** have `bodyLocate` consult the audit (or a cached
per-level admissibility flag on the template) and attach the note §9 promises.
**Pinned:** `precision-honesty.test.ts` "QA-1".

### QA-2 — `auditBodyTemplate()` clears levels that demonstrably fold — High — FIXED

The audit's condition is local: for level *i*, is the interval between *i*'s own two
bisector planes non-empty along azimuth *e*? When the denominator is non-positive it
concludes the frame survives "out to infinity — the convex side, where adjacent normal
rays diverge forever". True for *adjacent* planes. But `bodyMmToLocal` assigns a level by
scanning the whole column cranial-to-caudal and taking the first *i* with
`sigma(i) >= 0 && sigma(i+1) < 0`. Far enough off-axis those sets overlap for
**non-adjacent** *i*, and a distant level claims the point first. No per-level condition
can see that.

Two reproductions. The first needs no synthetic template:

```js
// Committed preset anat-adult-p50-split-sacrum
const t = buildAnatomicalBodyTemplate(ADULT_P50_SPLIT_SACRUM);
auditBodyTemplate(t).violations.map(v => v.level);   // ['S02','S03','S04'] — S05 cleared
auditBodyTemplate(t).levels.find(l => l.level === 'S05');
//   utilisation 0.739, foldRadiusMm 130.8, marginMm +34.1   -> admissible

bodyMmToLocal(t, bodyLocalToMm(t, { level: 'S05', u: 0.02, t: 0, r: 0.95 }));
//   -> { level: 'S01', u: 0.968, t: 0, r: 0.604 }, flags: {}
encodeBody(t, bodyLocalToMm(t, { level: 'S05', u: 0.02, t: 0, r: 0.95 }), 2);
//   -> 'BD-S01-12O-64'
measureRoundTrip(t, { samplesPerLevel: 200 }).failuresByLevel;
//   -> [S04 x16, S02 x12, S03 x12, S05 x2]   <- S05 fails; the audit cleared it
```

This contradicts `docs/alc-1-admissibility.md` §4 directly: that table reports "exact
verdict FAIL S02,S03,S04" and "observed failures 42" in the same row, and concludes *"the
exact verdict matches the observed failures in every row"*. Two of those 42 are at S05.
**The document's central claim is false on the document's own data.**

The second shows the general case and how large the mis-statement can be — the audit's
margin here is **24×**:

```js
// anat-adult-p50 with a 250 mm posterior radius at L05 (gluteal shelf, or a
// whole-body mesh that includes the thighs at hip level)
auditBodyTemplate(bulged).admissible;                       // true
auditBodyTemplate(bulged).levels.find(l => l.level==='L05').utilisation;  // 0.078
bodyMmToLocal(bulged, bodyLocalToMm(bulged, { level:'L05', u:0.1, t:0.5, r:0.8 }));
//   -> level 'L01', r clamped to 1.0,
//      note: 'point is outside the modelled body surface'
```

Note the second failure inside the first: the point is at `r = 0.8`, **200 mm inside** a
250 mm surface, and is reported as *outside the body* — 138 mm from where it belongs, at
the wrong vertebra. The one flag that does fire gives the wrong reason.

The audit is sharp over the smooth parametric family it was validated on: a smooth
cosine enlargement of the posterior lumbar radii tracks the probe exactly (clean at
utilisation 0.86, both fail at 1.03). The unsoundness needs azimuthal non-convexity,
which the parametric presets cannot express and a real mesh certainly can.

**Fix:** the audit cannot stay per-level. Either bound the fold globally — for each level,
test its skin against *every* other level's plane pair, not just its own — or make
`bodyMmToLocal` detect that more than one level brackets a point and flag it, which also
delivers QA-1. The second is cheaper and honest: it converts a silent wrong answer into
a declared one. **Pinned:** `template-acceptance.test.ts`, two "QA-2" tests, plus the
`ADMISSIBILITY-CONSISTENCY` stage as a standing gate.

### QA-3 — `recommendedDigits()` recommends a precision the library calls dishonest — High

```js
recommendedDigits('BD-T07-03O-531650', { body: adult }, 0.05);   // 8
adult.maxUsefulDigits;                                            // 5
locate('BD-T07-03O-53165000', { body: adult }).flags.overPrecise; // true
recommendedDigits('BV-L-471025', { brainVolume: brain }, 0.5);    // 7  (justifies 6)
```

The function compares cell extent against the residual and never consults
`maxUsefulDigits`. Spec §9 requires "UI must not render false precision"; the one API a
UI would ask is the one that routes around the flag. 32 552 corpus hits.
**Fix:** clamp to `template.maxUsefulDigits` and return the binding reason, so a caller
can tell "the residual limits you" from "the template does". **Pinned:**
`precision-honesty.test.ts` "QA-3", and `INV-RECOMMENDED-NOT-OVERPRECISE`.

### QA-4 — a NaN coordinate yields a confident address with no flag — High

```js
encodeBrainVolume(brain, [NaN, NaN, NaN], 6);  // { address: 'BV-R-000000', flags: {} }
encodeBrainVolume(brain, [NaN, 0, 0], 6);      // { address: 'BV-R-000000', flags: {} }
encodeBrainVolume(brain, [Infinity, 0, 0], 6); // flags.clamped = true   <- correct
```

`clampUnit` tests `v < 0 || v >= 1`; both are false for NaN, so it returns NaN unflagged,
and `bvEncodeLocal`'s `NaN >= mid` comparisons all take the zero branch. The result is a
specific hemisphere and a specific 1 mm cell, from nothing. Spec §9 promises a flag and a
note for a point merely *outside* the surface. A NaN arrives from a failed registration or
a unit conversion that divided by zero — exactly when a consumer most needs telling.
**Fix:** reject non-finite input at the `encodeBody`/`encodeBrainVolume` boundary, or set
`clamped` with a note naming the axis. **Pinned:** `precision-honesty.test.ts` "QA-4".

### QA-5 — the check symbol is validated against the wrong body — Medium-High

Spec §7: *"Position-weighted sum mod 32 over the canonical body."* `splitAddress`
computes it over the uppercased **input**, and `parse` accepts loose forms such as
`BD-T7-3O`. Both directions are wrong:

```js
checkSymbol('BD-T07-03O');                 // 'X'
isValid('BD-T7-3O~X');                     // false  <- correct symbol rejected
isValid('BD-T7-3O~9');                     // true   <- wrong symbol accepted
parse('BD-T7-3O~9').withCheck;             // 'BD-T07-03O~X'  (not the '9' supplied)
```

Dropping a leading zero is exactly what a human does with a code read aloud, which is the
only thing this symbol is for. 1 072 corpus cases where a loose body plus its canonical
check symbol is rejected. **Fix:** canonicalise first, then verify against the canonical
body — a reordering in `parse()`. **Pinned:** `known-defects.test.ts` "QA-5", plus two
invariants.

### QA-6 — the `BD` vertebral range is over-permissive and inconsistent — Medium-High — FIXED

`canonicalLevel` applies a single `1..12` range to all four prefixes:

```js
isValid('BD-C12-03O');   // true   — no human has a twelfth cervical vertebra
isValid('BD-L09-03O');    // true
isValid('BD-S12-03O');    // true   — the spec reserves only S02-S05
isValid('BD-T13-03O');    // false  — same defect class, opposite outcome
```

Spec §4 fixes the set at `C01-C07, T01-T12, L01-L05, S01` with `S02-S05` reserved; §10
says anchor ranges are "validated before any geometry runs". These addresses are accepted
by every consumer, written to databases and deep links, and are permanently unresolvable:
`locate()` answers `homology: 'absent'` with a note saying a registration-supplied level
mapping is required. For `L06` that is true and is the designed behaviour. For `C12` it is
false — there is nothing to map — so the honest `absent` path is being used to excuse an
out-of-grammar address. 5 405 corpus hits. **Fix:** per-prefix maxima in
`canonicalLevel`. **Pinned:** `precision-honesty.test.ts` "QA-6", and
`INV-GRAMMAR-LEVEL`.

### QA-7 — Unicode confusables survive case mapping into a valid address — Medium

```js
format('bd-t07-03ı');   // 'BD-T07-03I'   U+0131 DOTLESS I  -> depth half I
format('bd-ſ01-03o');   // 'BD-S01-03O'   U+017F LONG S     -> sacral prefix
```

`splitAddress` calls `toUpperCase()` before validating the alphabet, so the effective
alphabet is every code point whose uppercase form is legal. Spec §3 says ASCII; §10 says
the alphabet is validated first. Two distinct byte sequences become one address, so any
consumer that compares a raw URL parameter against a stored canonical form — or does the
prefix range scan §10 describes on the unnormalised string — disagrees with the library
about whether two addresses are the same. The gap is narrow: confusables whose uppercase
form is not a legal character (`U+212A`, `U+2170`, fullwidth, Cherokee) are all caught.
**Fix:** reject any non-ASCII code point before uppercasing. **Pinned:**
`known-defects.test.ts` "QA-7", and `INV-ASCII`.

Mild sub-case, same root: `trim()` strips Unicode whitespace, so `U+00A0` and `U+2007`
padding is silently accepted. Harmless, and the same one-line fix covers it.

### QA-8 — a NaN body coordinate accuses an admissible template — Medium

```js
bodyMmToLocal(buildAnatomicalBodyTemplate(ADULT_P50), [NaN, NaN, NaN]).flags;
// { clamped: true, notes: ['template anat-adult-p50 is inadmissible near C01: its
//    bisector planes cross inside the body, so the level assignment here is
//    deterministic but not reliable'] }
```

All the `sigma` comparisons are false for NaN, so the function falls through to its
inadmissibility branch and blames a template `auditBodyTemplate()` certifies as
admissible with 123 mm of margin. An asset pipeline reading that note would go hunting a
geometry bug that does not exist — and the message is the one piece of diagnostic output
the pipeline is told to trust. `encodeBody` then throws `bad_azimuth` about an anchor
literally spelled `NANI`. **Fix:** guard non-finite input at the top of `bodyMmToLocal`.
**Pinned:** `precision-honesty.test.ts` "QA-8".

### QA-9 — `measureRoundTrip().inadmissibleNotes` never fires — Medium — FIXED

```js
measureRoundTrip(splitSacrum, { samplesPerLevel: 200 });
// { failures: 42, inadmissibleNotes: 0, ... }
```

The counter watches for the note QA-1 shows is unreachable, so it reads 0 on the one
template known to be inadmissible. `admissibility.test.ts:104` asserts
`probe.inadmissibleNotes === 0` for good templates — an assertion that cannot fail, i.e.
vacuous, and it reads as coverage. **Fix:** falls out of QA-1; until then the assertion
should be deleted rather than trusted. **Pinned:** `precision-honesty.test.ts` "QA-9".

### QA-10 — duplicate slab labels pass the audit *and* the probe — Low (gate defect) — FIXED

```js
const dup = { ...p50, slabs: p50.slabs.map((s,i) => i===21 ? {...s, label:'L02'} : s) };
auditBodyTemplate(dup).admissible;                           // true
measureRoundTrip(dup, { samplesPerLevel: 120 }).failures;    // 0
// and yet:
encodeBody(dup, pointInTheSecondL02Slab, 3);  // 'BD-L02-03O-601', flags: {}
locate('BD-L02-03O-601', { body: dup });      // 32.4 mm away, flags: { homology: 'exact' }
```

`findSlab` resolves to the first match, so the second slab's anatomy has no address and
points inside it encode to a cell 32 mm away. The probe cannot see it because it only
asks for labels it read off the slabs, and the first match answers every time. Severity
is Low for the library — no shipped template does this — but it is the reason the
acceptance gate cannot be audit-plus-probe alone, which is why `STRUCTURE` exists.
A mesh-derived template with a transitional vertebra is a realistic way to produce it.
**Fix:** reject duplicate labels in the audit, or key slabs by label. **Pinned:**
`template-acceptance.test.ts` "QA-10".

### QA-11 — `recommendedDigits()` returns an illegal `BR` precision — Low

```js
recommendedDigits('BR-L-7A3F', templates, 1);   // 0
isValid('BR-L');                                 // false — BR needs >= 1 digit
```

Also `src/compare.ts` hardcodes `maxDigits = a.frame === 'BR' ? 6 : 12` while
`BR.maxDigits === 7`. Harmless today because `BR` has no template; a trap the moment it
gets one. **Fix:** read `FRAMES[frame].maxDigits`, and return `null` for a frame that
cannot be located rather than an out-of-range count. **Pinned:**
`known-defects.test.ts` "QA-11".

### QA-12 — `samePlace()` calls two disjoint cells the same place — High — FIXED

The sanctioned replacement for string equality answers "yes" for cells that share no
millimetre point, at `toleranceMm: 0`.

```js
samePlace('BV-L',       'BV-R',       templates, { toleranceMm: 0 });  // same: true, gap 68.0mm, budget 218.3mm
samePlace('BD-T06',     'BD-T08',     templates, { toleranceMm: 0 });  // same: true, gap 49.5mm, budget 284.5mm
samePlace('BD-T06-12O', 'BD-T07-12O', templates, { toleranceMm: 0 });  // same: true, gap 16.3mm, budget  78.0mm
```

**Blast radius, measured.** Over every disjoint pair reachable at depths 1–3 from
`BD-T07` and `BV-L` — 3 424 pairs, both frames, four precisions —
**1 329 (38.8 %) report `same: true` at zero tolerance.** The eight first-level children
of a hemisphere are unanimous: all 28 of their disjoint pairs compare equal.

| sweep arm | disjoint pairs | misreported |
| --- | --- | --- |
| `BD-T07` depth 1 / 2 / 3 | 276 / 780 / 780 | 118 / 268 / 323 |
| `BV-L` depth 1 / 2 / 3 | 28 / 780 / 780 | 28 / 281 / 311 |

**Cause.** `cellRadiusMm()` is half the cell's 3-D *diagonal*, and `same` is
`gapMm <= toleranceMm + ra + rb` where `gapMm` is a centre-to-centre distance along one
direction. A diagonal budget charged against a one-axis separation overstates a cell's
reach along its finest axis by **3.4× in `BV` and up to 5.3× in `BD` at five digits** —
at every tolerance, not only at zero. For two adjacent siblings the gap is one cell width
and the budget is two half-diagonals, so they can never come out disjoint.

**Why it is worse than the defect it replaces.** Spec §6 and the v1 plan both route
cross-subject matching away from `a === b` and into this function. A screen that follows
that instruction gets a false "same place" here, where string equality would at least
have said no. `overlaps()` — the within-template primitive — answers the same question
correctly, so the recommendation to callers does not change.

**Fix:** widen by each cell's half-extent *projected onto the separation direction*
(equivalently, test box-against-box separation) rather than by its half-diagonal. Then
disjoint cells report `same: false` at zero tolerance exactly, and a real residual still
behaves as a residual. `coveringsSamePlace`'s `across: 'subjects'` regime delegates here
and inherits this; its `within: 'template'` regime is already correct.

**Credit:** the two coarse cases were found by the DOG-5 pre-landing review; the sweep,
the rate and the inflation factors are this pass. **Owner:** Staff Engineer, under DOG-5.
**Pinned:** `equality-guard.test.ts` "QA-12", with the rate bounded both ways so the
defect can neither widen nor be silently retired.

---

### QA-13 — a fold that *displaces* rather than duplicates is still silent — Medium

The gap half of the non-partition, and the half QA-2's fix does not cover.

Spec §4 describes both halves of what goes wrong without bisector planes:
adjacent regions "overlap in a wedge on the convex side and **leave a gap on the
concave side**". The bisector design removes that for *adjacent* levels, and
QA-2's fix detects the overlap half by counting how many levels claim a point.
But where the map folds, the regions globally are neither a partition nor merely
overlapping: there is also territory whose *sole* claimant is some other level.
One level claims it, so the multi-claim detector is correctly quiet — and the
answer is a different vertebra.

```js
const t = buildAnatomicalBodyTemplate(ADULT_P50_SPLIT_SACRUM);
const mm = bodyLocalToMm(t, { level: 'S02', u: 0.5, t: 0.9917, r: 0.76 });
bodyMmToLocal(t, mm);
//   -> { level: 'S01', ... }, flags: {}      <- wrong level, no flag at all
```

Counting the claimants along that ray shows why, and shows that **"the fold
radius" is not a threshold**:

| r | levels claiming the point | resolves to | flags |
| --- | --- | --- | --- |
| 0.64–0.66 | S02, S05 | S02 | `folded` — right, and flagged |
| 0.67–0.69 | S02, S05 | S05 | `folded` — wrong, and flagged |
| 0.70–0.74 | S02 alone | S02 | none — right, correctly quiet |
| 0.75–1.00 | **S01 alone** | **S01** | **none — wrong, and silent** |

Two consequences:

1. **The honesty guarantee has a hole.** `flags.folded` exists precisely so a
   fold is never silent. In the displacement branch it is.
2. **The folded set is not radially connected.** S02 round-trips at r = 0.66,
   fails at 0.68, round-trips again at 0.72, and fails from 0.75. Any assertion
   of the form "safe inside the predicted radius, folded outside it" is
   therefore ill-posed — which is why `admissibility.test.ts`'s *"the exact
   criterion is sharp in both directions"* is the one test still red in the
   tree. Measured: S03's first failure is at r = 0.675 against a predicted
   0.721, 6.4% tighter and just outside that test's 5% band.

**Severity is Medium, not High, and the reason is worth stating:** it needs a
template that folds, and the acceptance gate rejects those on three separate
stages. Over 180 000 probes across all five shipping presets there is **not one
unflagged wrong answer** — that is now asserted as a standing test
(`acceptance: no shipping preset ever answers with the wrong level unflagged`),
so it would go red the moment a fold reached a shipped template.

**Fix:** the detector asks "does more than one level claim this point?" when the
question it wants is "does the level I was asked for claim this point?". One
extra `sigma` pair in `bodyLocalToMm`, or equivalently a check in
`bodyMmToLocal` that the recovered level's own region contains the point.
That covers both halves with one condition.

**For `admissibility.test.ts`:** the per-level radius is a one-sided bound, not
a sharp threshold, so the two-sided 5% assertion cannot hold. The defensible
replacement is: for every level the audit flags, *some* radius at or below the
prediction fails — `assert.ok(firstFailureRadius(level) <= foldRatio * 1.05)` —
plus the existing requirement that a flagged level does fail somewhere. Dropping
the `foldRatio * 0.95` direction is not a loss of rigour; it is removing a claim
the geometry does not support, and `docs/alc-1-admissibility.md` §4's "not
merely a safe bound" should lose the same claim with it.

**Pinned:** `template-acceptance.test.ts` "QA-13", with the four regimes and the
non-monotonicity asserted individually.


## Running it

```
cd packages/alc
node --test 'test/*.test.ts'                   # everything, including the four new suites
node --test test/fuzz.test.ts                  # the fuzz suite alone, ~9 s
node --test test/equality-guard.test.ts        # the a === b guard
node --test test/template-acceptance.test.ts   # the template gate
node --test test/precision-honesty.test.ts     # spec section 9
node --test test/known-defects.test.ts         # the minimal repros
```

All four suites are picked up by the existing `test/*.test.ts` pattern, so
`tools/check-test-count.mjs` gates them with no change to the CI workflow. The
test-count floor in `ci/expected-test-counts.json` was raised accordingly.

## Recommended order of fixes

QA-1 and QA-2 together — one change to `bodyMmToLocal` (detect multiple bracketing
levels, flag it, name the level) delivers both the missing §9 note and a sound
inadmissibility signal, and it turns the audit from a guarantee into what it actually is,
a cheap predictor. Then QA-3 and QA-4, which are small and both about not presenting
garbage as precision. Then QA-5, QA-6 and QA-7, which are three independent few-line
changes in `codec.ts` and `bodySpine.ts`. QA-8 to QA-11 are cleanups that fall out of the
above.

QA-12 is independent of all of them and should go first if anything is already being
built on `samePlace()`: it is a handful of lines in `cellRadiusMm`/`samePlace`, and until
it lands the sanctioned cross-subject comparison is wrong in the permissive direction —
the direction that produces a confident false match rather than a visible miss.

`docs/alc-1-admissibility.md` §4 needs correcting regardless of whether QA-2 is fixed:
the claim that the exact verdict matches observed failures in every row is not true of
the S05 row.
