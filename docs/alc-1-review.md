# ALC-1 pre-landing structural review

**Reviewer:** Staff Engineer · **Scope:** `packages/alc` at `029df91`, the three
ALC-1 commits · **Raised on:** [DOG-2](/DOG/issues/DOG-2)

Every number here is reproducible:

```
cd packages/alc
node --experimental-strip-types test/structural-review.probe.mjs      # all sections
node --experimental-strip-types test/structural-review.probe.mjs 3    # one section
```

The conformance suite is green — **119/119**, including the in-flight
[DOG-5](/DOG/issues/DOG-5) covering, query, resolve and translate work and
[DOG-7](/DOG/issues/DOG-7)'s fuzz suite — and it should be: the frame
mathematics is sound, the bisector partition is the right call, the hierarchy
invariants hold (probe section 7), and `measureRoundTrip` is a genuinely
adversarial ground-truth probe. Everything below survives a green suite.

Severity is about what reaches a user, not about how hard the fix is.

| # | Finding | Severity | Owner |
| --- | --- | --- | --- |
| 1 | The admissibility audit is per-level, so it misses non-local folds; 5.0% of a physiological parameter box is cleared and still folds | **high** | frames (CTO) |
| 2 | The fold note is unreachable; folds are reported as "outside the body" or not at all, and the test asserting this passes vacuously | **high** | frames (CTO) |
| 3 | `samePlace` reports the left hemisphere as the same place as the right — and the new `coveringsSamePlace` inherits it in the cross-subject regime | **high** | DOG-5 (Staff Eng) |
| 4 | Covering primitives are quadratic with a `parse()` per comparison: ~71 s at 1,700 cells. The new `coveringIntersect` has the same shape and `query.ts`'s prefix ranges are not wired into the set algebra | medium | DOG-5 (Staff Eng) |
| 5 | The grammar admits 19 vertebral labels that exist in no human and rejects T13, which does | medium | spec (CTO) |
| 6 | The check symbol is not canonical: the symbol issued with an address is rejected against a spelling the parser accepts | low | DOG-5 (Staff Eng) |

---

## 1. The audit is per-level, so it misses non-local folds

`auditBodyTemplate` derives, exactly, the radius at which a level's **own two
bounding bisector planes** meet. That derivation is correct and the replacement
of the worst-case criterion was the right call. But a point is lost to the
frame as soon as **any** level's region claims it, not only the two planes
either side of it — and the audit never looks at distant levels.

A counterexample, searched out of the physiological parameter box used by
`anatomicalTemplates.ts` (cervical 0–40°, kyphosis 20–75°, lordosis 30–85°,
sacral 55–85°, stature ×0.8–1.15, girth ×0.8–1.6, both sacral axis
conventions): **162 of 3,228 templates the audit clears — 5.0% — fail
`measureRoundTrip`.**

The confirmed one is kyphosis 60° (their own comment: "hyperkyphosis of ageing
reaches 60+"), stature ×0.8, girth ×1.6, one sacral level — a short, round,
hyperkyphotic torso, i.e. an elderly obese patient, not an exotic shape:

```
audit says admissible=true, worst margin +7.8 mm
ground-truth round trip: 20/15000 failures at T12,T06,T07,T11,T10,T08,T09
  audit for failing level T12: utilisation 0.411, margin +371.9 mm -- cleared
  audit for failing level T06: utilisation 0.967, margin +7.8 mm   -- cleared
```

The mechanism is the part that matters, and it is not the one the audit models:

```
encoded at T06 (t=0.973, r=0.979) -> claimed by [T01,T06] -> decoded as T01
```

Anterior skin at the sixth thoracic level is claimed by **T01, five levels
away**. With a tight kyphosis the bisector planes fan out enormously on the
convex (anterior) side, so an upper-thoracic level's region sweeps down and
swallows the anterior skin far below it. T06's own margin is +7.8 mm and
irrelevant. T12 fails at utilisation 0.411 — nowhere near its own fold radius.

Note also the inverse: the audit flags T06–T09, S01, S02 on the `radialScale: 3`
synthetic template, while the actual round-trip failures are at T07–T12 with
the **most** at T10, a level the audit clears. The violation set and the
failure set are different sets.

**Consequence.** `admissible: true` does not mean "nothing folds". The plan's
§7 row "Real template audit" and the template acceptance gate in
[DOG-7](/DOG/issues/DOG-7) must run `measureRoundTrip` as the gate and treat
`auditBodyTemplate` as a diagnostic that localises a fold once one is known to
exist. Gating on the audit alone would pass a folding template.

A sound test is not expensive: the fold condition is "no two levels claim the
same point", which is checkable by scanning the skin and counting claiming
levels — section 2's harness already does exactly that.

## 2. The fold note is unreachable, and folds are misreported

`bodyMmToLocal` has three branches: a level claims the point, the point is off
either end, or — the `else` — the planes "crossed inside the body", which emits
the `inadmissible` note. That last branch requires **no** level to claim the
point.

Folding does not produce unclaimed points. It produces **doubly claimed**
points. On the inadmissible `radialScale: 3` template:

```
probed 100224 points inside the body
claimed by 2+ levels (a real fold): 919
claimed by 0 levels (the ONLY branch that emits the note): 0
"inadmissible" notes actually emitted: 0
decoded to the WRONG level: 733, of which with no note and no clamp flag: 268
```

The loop `break`s on the first claiming level, scanning from the cranial end,
so the decode silently returns the most cranial claimant. **268 points come
back with the wrong vertebral level, `flags: {}`.** On the gate-cleared
template of finding 1 all 21 failures *are* flagged — but as `"point is outside
the modelled body surface"`, because once the point is misassigned to a distant
level its radius exceeds *that* level's surface and `r` clamps. The user is
told the point is outside the body when the truth is that the frame folded.

Plan §6 promises, for this row, "exact directional audit names the level,
azimuth, fold radius and margin; deterministic fallback plus a note at resolve
time". The audit half exists. The note half does not.

This is also why the suite does not catch it.
`admissibility.test.ts:104` asserts

```js
assert.equal(probe.inadmissibleNotes, 0);
```

`inadmissibleNotes` counts emissions of a note that cannot be emitted, so the
assertion holds on every template — including one with 60 round-trip failures,
where it reports `inadmissibleNotes=0` alongside them. It reads as "no
inadmissibility detected" and means nothing.

**Fix.** Count claimants instead of breaking on the first; if more than one,
emit the fold note naming both levels, and pick the **nearest** rather than the
most cranial. Then make `inadmissibleNotes` a real signal and assert it is
non-zero on a known-folding template.

## 3. `samePlace` reports the left hemisphere as the same place as the right

This is the primitive the plan mandates as the only legal cross-subject
comparison, with a standing QA guard test forbidding `a === b` in its favour.
At tolerance 0:

```
BV-L         vs BV-R          same=true   gap=  68.0mm  budget= 218.3mm
BV-L-0       vs BV-L-7        same=true   gap= 109.2mm  budget= 111.4mm
BD-T06-12O   vs BD-T07-12O    same=true   gap=  16.3mm  budget=  78.0mm
BD-T07-12O   vs BD-T07-06O    same=false  gap= 154.2mm  budget=  69.0mm  (correct)
```

Whole left hemisphere versus whole right: same place. Opposite corners of one
hemisphere, 109 mm apart: same place. Adjacent vertebral levels: same place.
No BV address pair coarser than two digits can be distinguished at all.

The cause is `cellRadiusMm`, which returns half the cell box's **diagonal**:

```
BV-L extent = [68, 172, 116] mm -> cellRadiusMm = 109.2 mm
but the half-extent along the axis that separates L from R is 34.0 mm
```

Summing two circumscribed-sphere radii charges the full 3-D diagonal against a
separation that is along one axis only, so the budget exceeds the largest gap
the frame can contain. The docstring's intent — "accounts for the cells' own
extents" — is right; the sphere approximation is what breaks it.

**Fix.** Inflate each cell's box by the tolerance and test box separation per
axis in the frame's own dimensionless coordinates, then convert. That answers
the question actually being asked — "could these two addresses denote one
point, given this residual?" — and it returns `false` for disjoint cells, which
the current test cannot. Worth reporting an overlap fraction rather than a
bare boolean, so the UI can distinguish "identical" from "adjacent".

Research findings are mapped at region granularity, which is the coarse end.
This fires exactly where the product uses it.

**It has already propagated.** The in-flight DOG-5 work adds
`coveringsSamePlace`, now the sanctioned entry point, with an explicit regime
so a caller must say what "same" means. The `within: 'template'` regime is
correct — it intersects cell sets and returns `false` here. But the
`across: 'subjects'` regime delegates per cell pair to `samePlace`, so it
inherits the defect in exactly the regime the design exists for:

```
coveringsSamePlace(['BV-L'], ['BV-R'], {across:'subjects', toleranceMm:0})
  -> same=true  basis=tolerance  shared=0  gap=68.0mm  budget=218.3mm
   within-template regime -> same=false     (correct)
```

Note `shared=0` beside `same=true`: the result says "no shared cells" and
"same place" at once. Fixing `cellRadiusMm` fixes both call sites; nothing in
the new layer needs redesigning.

## 4. Covering primitives are quadratic, with a `parse()` per comparison

```
|a|=199   intersection=3    coveringIntersection=  2362ms  normalizeCovering=   491ms
|a|=763   intersection=144  coveringIntersection= 18207ms  normalizeCovering=  3652ms
|a|=1680  intersection=677  coveringIntersection= 71018ms  normalizeCovering= 17406ms
```

Plan §4 says coverings are prefix sets "so this is a range scan, not a scan".
`coveringIntersection` is a nested loop calling `contains`, which re-`parse`s
both strings every time — about 5.7 M parses at 1,700 cells. This is the
browser main thread on a static site, per finding, on every multi-paper
selection.

`normalizeCovering` returns all 1,680 inputs unchanged in that run, so its 17 s
is pure overhead. It calls `children(parentKey).length` — constructing and
parsing 24 addresses — only to learn a sibling-group size that is a property of
the frame descriptor.

Also: one malformed member aborts the whole query (`unknown_frame` propagates
out of `coveringIntersection`), so a single bad curator row takes out an entire
research overlay instead of being reported as one bad row.

**The in-flight DOG-5 work does not fix this yet.** `query.ts` builds exactly
the right primitive — `prefixRange`, `descendantScan`, `scanSorted`, with the
binary-collation hazard called out — but the set algebra in `covering.ts` does
not use it. `coveringIntersect` is the same nested `contains` loop and then
calls `covering(out)`, which normalises again:

```
n=1680:  covering() build=27737ms   coveringIntersect=71074ms
         (old coveringIntersection=74644ms, for comparison)
```

So the `Covering` type currently adds a 28 s constructor on top of the same
asymptotics. Both old and new intersections stay exported from `index.ts`.

Mine, under [DOG-5](/DOG/issues/DOG-5): sort once, parse once, intersect by
prefix range scan over sorted arrays — the primitive `query.ts` already has —
and add a `childCount(frame, level)` to the frame descriptor so
`normalizeCovering` stops parsing 24 addresses to learn a group size.

## 5. The grammar admits levels that exist in nobody, and rejects one that does

```
accepted but in no human: C08..C12 L06..L12 S06..S12   (19 labels)
rejected:                 C13 C14 T13 T14 L13 L14 S13 S14
```

`canonicalLevel` bounds every prefix at 1..12 — a thoracic bound applied to all
four. So `BD-C12-03O-531` parses, gets a valid check symbol, and is
URL-linkable, while **T13 — the thirteenth-rib variant, about as common as six
lumbar vertebrae, which *is* accepted as L06 — cannot be expressed at all.**
The asymmetry is the tell that the bound is incidental rather than designed.

`VERTEBRAL_LEVELS` is exported and never used to validate anything.

The second-order problem is worse than the first. Both bogus labels resolve to:

```
locate('BD-C12-03O-531') -> homology='absent'
  "level C12 is not present in template syn-adult-male;
   a registration-supplied level mapping is required"
```

`homology: 'absent'` is the signal the plan reserves for a genuine count
anomaly — a real patient who needs an explicit level mapping. A typo now
produces the same signal, so the UI cannot tell "you mistyped C02" from "this
subject has six lumbar vertebrae". That conflation devalues the one flag the
plan leans on hardest for anatomical honesty.

**Fix.** Validate against the declared level set, and add an explicit
*anomaly* set (T13, L06, S06, C08) that parses and reports a distinct
`homology: 'variant'`, separate from both "exists" and "you mistyped it".
Grammar-level, so it needs settling before addresses are issued — same argument
§1.1 of the plan makes for the sacral level count.

## 6. The check symbol is not canonical

```
checkSymbol('BD-T07-02O') = C      (canonical)
checkSymbol('BD-T7-2O')   = W      (loose spelling of the SAME address)
parse('BD-T7-2O~W') -> BD-T07-02O~C      accepted
parse('BD-T7-2O~C') -> rejected: check_failed
```

`splitAddress` validates the check symbol against the raw uppercased input,
before canonicalisation. So the symbol **issued with** an address is rejected
against a loose spelling the parser otherwise accepts, and a spelling-specific
symbol is accepted instead. An address has as many valid check symbols as it
has spellings. For a code meant to be read aloud and written down — where
dropping the leading zero is the most natural thing a person will do — this
rejects correct transcriptions.

Fix: validate the check against `Address.canonical`, after parsing. The
single-substitution guarantee in the docstring is unaffected.

Two smaller things in the same area:

- `recommendedDigits` always returns **0** for `BR`: the `d = 0` candidate
  `BR-L` is rejected by BR's own parser (BR requires digits) and the `catch`
  breaks the loop on the first iteration. `BR` is disabled in v1, so this is
  deferred impact on exported public API.
- `recommendedDigits` pads with `'0'` past the address's own digits, which
  selects the innermost octant. In `BD` the azimuthal extent scales with the
  cell's mid-depth, so deep cells under-report the precision they justify:
  `BD-T07-03O` recommends 2 digits, `BD-T07-03I` recommends 1.

---

## What is right, and should not be disturbed by any of the above

Worth stating because a reviewer who only lists defects misleads about the
state of the code.

- The bisector partition is the correct construction, and the two documented
  dead ends are real dead ends. `bodyLocalToMm` solving for the axial offset so
  the maps are exact inverses rather than approximate ones is the right call,
  and it holds: inverse drift under 1e-6 mm.
- Replacing the worst-case criterion with the directional one was right, and
  the reasoning about which side of the lordosis binds is correct. Finding 1 is
  that the directional criterion is per-level, not that it is wrong.
- The hierarchy invariants hold under adversarial input (probe section 7):
  complete sibling groups roll up, incomplete ones do not, containment is
  frame-scoped and not string-prefixed.
- Digit validation moved into `parse()` ahead of any geometry — the right place.
- Separating the dimensionless frame from the millimetre template is the load
  bearing idea and it survives scrutiny. Findings 1, 2 and 5 are all about the
  template and anomaly boundary, not about that separation.
