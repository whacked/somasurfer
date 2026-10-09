# ALC-1 — Anatomical Location Code

**Status:** draft, reference implementation passing conformance (`packages/alc`)
**Date:** 2026-10-08
**Owner:** CTO

A short, human-transcribable, hierarchical address for a location in the human
body or brain. What Open Location Code is to the Earth's surface, ALC is to
anatomy.

```
BD-T07-03O-531      body, T7 level, three o'clock, outer, cell 531
BV-L-471025         brain, left hemisphere, AC-PC proportional cell 471025
BR-L-7A3F           left cortical surface, HEALPix cell 7A3F   (experimental)
```

---

## 1. Why this exists

The project needs to attach research findings to places in the body and brain,
and then ask "what else is here?" Existing systems each solve part of it:

| System | What it gives | Why it is not enough |
| --- | --- | --- |
| MNI / Talairach mm coordinates | Precise, continuous | Not human-readable, not hierarchical, template-bound, no containment |
| Brodmann areas | Human-readable names | ~52 regions per hemisphere. Far too coarse, and cytoarchitectonic boundaries are not where most findings are |
| HCP-MMP1 (Glasser), AAL, Desikan-Killiany | Finer named parcels | Still 180–360 parcels; a parcellation, so it changes with the atlas version; cortex only |
| UBERON / FMA / SNOMED body structures | Rich named ontology | No coordinates at all. Cannot express "2 cm left of midline at T7" |
| HuBMAP Common Coordinate Framework | Real registration machinery for the whole body | A registration and ontology framework, not a short address a person can read out |
| Open Location Code, geohash, S2, H3 | Exactly the right ergonomics | Defined on a sphere or a plane, not on a body |

Nothing in that list is a short string a person can say over a phone that names
a sub-millimetre anatomical location and whose prefix names the region
containing it. ALC is that string.

The prior-art survey found no existing anatomical geocode. If one surfaces,
ALC should become a translator for it rather than a competitor.

## 2. The one idea that makes it work

**Separate the address space from the body.**

An ALC address denotes a cell in a *frame* — a dimensionless, normalised
coordinate domain. There are no millimetres anywhere in an address. A
*template* is a concrete geometry that realises a frame (an adult male mesh, a
seven-year-old, a population-specific average). A *registration* maps a
particular subject into a frame.

```
   address  ──denotes──▶  cell in a frame        (dimensionless, portable)
                              │
                     ┌────────┴────────┐
                     ▼                 ▼
               template A         template B      (mm, population-specific)
            adult male mesh    7-year-old mesh
```

The consequence is the whole point: **the same address means the same
anatomical place in every template**, to the extent the normalisation is
anatomically homologous. Age, sex and population variation become a
*registration* problem, not an *addressing* problem. Supporting a new
population means shipping a new template, not a new address scheme, and every
address ever issued keeps working.

This is validated, not asserted. The conformance suite builds three body
templates differing in spine curvature, vertebral heights, girth,
cross-sectional shape and left-right asymmetry, then checks that homologous
points produce byte-identical addresses in all of them. They do, exactly.

The CEO's framing was Banach–Tarski: can a body be decomposed into addressable
pieces at all? The useful formalism turned out not to be paradoxical
decomposition but **diffeomorphic normalisation plus a hierarchical
discretisation of the normalised domain**. The pieces are measurable and
well-behaved; what is hard is choosing a normalisation that stays
anatomically homologous across bodies, and being honest about where it does not.

## 3. Grammar

```
address   ::= frame "-" anchor ( "-" anchor )* [ "-" digits ] [ "~" check ]
```

- ASCII, case-insensitive on input, canonical form is uppercase.
- `-` separates structural segments. `~` introduces the check symbol.
- Legal characters are exactly `0123456789ABCDEFILORSTV-` plus `~` and the
  check symbol. 24 symbols, deliberately under 32 (see §7).
- Maximum length 64 characters. Maximum 16 refinement digits, and each frame
  caps lower than that.

**Prefix truncation is the core guarantee.** Dropping trailing refinement
digits, and then trailing anchor segments, always yields a valid address whose
cell strictly contains the original. `BD-T07-03O-53` contains
`BD-T07-03O-531`; `BD-T07` contains both. This is what lets a single string
serve as both "the T7 level" and "this 2 mm cell", and lets a database answer
containment queries with a prefix range scan.

## 4. Frames

### `BD` — body, spine-relative

```
BD-T07-03O-531
│  │   │   └── octree refinement, octal digits, optional
│  │   └────── azimuth clock sector 01-12 + depth half I or O
│  └────────── vertebral level: C01-C07, T01-T12, L01-L05, S01
│              (S02-S05 reserved, not realised by any template;
│               T13, L06, S06 are count anomalies — see Level set)
└───────────── frame
```

Spoken: *"body, T7, three o'clock, outer, five-three-one."*

Three dimensionless local coordinates:

- `u` — axial fraction within the vertebral level, 0 cranial, 1 caudal
- `t` — azimuth in turns about the spine axis, 0 at the anterior midline,
  increasing toward the subject's **left** (0.25 left, 0.5 posterior, 0.75 right)
- `r` — depth from the spine axis divided by the body surface radius in that
  same direction at that same level. 0 at the axis, 1 at the skin.

`r` being *normalised* is what absorbs body habitus: a thin child and a large
adult both have skin at `r = 1`.

Clock sector 12 is **centred** on the anterior midline, not bounded by it, so
midline structures (sternum at 12, spinous process at 06) sit in the middle of
a cell rather than straddling a boundary. Sectors follow the radiological
clock-face convention clinicians already use.

Octree digit = `u_bit * 4 + t_bit * 2 + r_bit`.

**Level assignment uses bisector planes.** Two earlier designs failed and the
reason matters for anyone extending this:

1. Projecting onto each level's own axis and keeping the level whose fraction
   lands in `[0,1)` is not a partition — a point on a vertebral boundary
   satisfies both neighbours.
2. Breaking that tie by perpendicular distance is also not a partition. At any
   bend the two adjacent levels' perpendicular regions overlap in a wedge on
   the convex side and leave a gap on the concave side. A point 42 mm off-axis
   at a 3° bend projects across the boundary by ~2 mm — more than a whole cell.

The fix is to cut space with the angle-bisector plane at each vertebral
boundary. Levels then tile space exactly, and they fan out on the convex side
of a curve, which is also how a clinician reads "the T7 level" on a curved
spine. `bodyLocalToMm` solves the matching linear equation so forward and
inverse are exact inverses.

**Level set.** Templates realise `C01`-`C07`, `T01`-`T12`, `L01`-`L05` and a
single sacral level `S01` covering the whole fused sacrum. `S02`-`S05` remain
reserved in the grammar — so a finer sacral frame can be added later without a
breaking change — but no template realises them, and `locate()` reports them as
`homology: 'absent'` rather than guessing. This is a measured requirement, not
a convenience: see **template admissibility** below.

Those 29 labels are the *canonical* set. Three more are addressable, and they
are the recognised **vertebral count anomalies**:

| label | anatomy |
| --- | --- |
| `T13` | a supernumerary thoracic level with a thirteenth rib |
| `L06` | six lumbar vertebrae (lumbarisation of S1) |
| `S06` | an extra sacral segment (sacralisation of L5) |

The level set is validated as a **set**, not as a numeric range, and anything
outside it is rejected by `parse()` with `bad_level`. That is the whole point
of enumerating it. A single `1..12` bound used to be applied to every prefix,
which failed in both directions at once: `C08`-`C12`, `L06`-`L12` and
`S06`-`S12` all parsed, earned a valid check symbol and were URL-linkable
while existing in no human, and `T13` — which does exist, about as often as the
six lumbar vertebrae the same bound happened to admit — could not be written
down at all.

So there are four outcomes, and they are deliberately four:

| case | result |
| --- | --- |
| canonical level the template realises | `homology: 'exact'` |
| canonical level the template lacks | `homology: 'absent'` |
| count anomaly the template lacks | `homology: 'variant'` |
| anything else | rejected, `bad_level` |

`'variant'` exists because the previous behaviour conflated the last two. Every
out-of-grammar label resolved to `'absent'` with the note "a
registration-supplied level mapping is required" — the signal reserved for a
genuine count anomaly — so a typo and a patient needing a level mapping
produced the same flag and the same sentence. A consumer could not tell them
apart, which devalues the flag the design leans on hardest for anatomical
honesty. `'variant'` means real anatomy this template does not realise, and a
registration can map it; `'absent'` means a canonical level this template does
not realise, and no registration will conjure one. Both return `NaN`
millimetres and neither is ever guessed.

`C08` is deliberately **not** in the anomaly set. There is no eighth cervical
vertebra; the C8 *nerve root* is universal and exits below `C07`, which is what
`BD-C08` almost always means. Admitting it as a variant would silently accept
a category error, so it is rejected with that correction named in the message.
The asymmetry is safe in one direction only: adding a label to the anomaly set
later is additive, while removing one breaks addresses already issued.

This is grammar, so it had to be settled before the asset pipeline issues a
first address — the same argument §1.1 makes for the sacral level count.
`ADDRESSABLE_LEVELS` is the set, exported, and `canonicalLevel()` validates
against it.

**Template admissibility.** The frame is a tubular neighbourhood of a curve, so
it folds where the body is thicker than the distance at which a level's two
bounding bisector planes meet. Beyond the fold two addresses denote the same
millimetre point and `encode(locate(a))` no longer returns `a`.

The condition is *directional*, and that is the whole of it. For a level of
length `len` whose bounding planes have normals `n_i`, `n_i+1`, the frame
survives along azimuth direction `e` out to

```
foldRadius(e) = len / ( (e . n_i+1)/(d . n_i+1) - (e . n_i)/(d . n_i) )
```

when that denominator is positive, and out to infinity when it is not — the
convex side, where adjacent normal rays diverge forever. In the symmetric
small-angle limit this reduces to `R_curvature / cos(psi)`, but it stays exact
at a junction of unequal segment lengths, and needs no special case at the ends
of the column.

Two conclusions from the measured sweep in `docs/alc-1-admissibility.md`, both
of which contradict the obvious guess:

1. **The lumbar lordosis is not the binding constraint.** The lordosis is
   concave *posteriorly*, and the spinal canal sits far posterior, so only
   ~65 mm of tissue faces the binding side while the ~165 mm of abdomen faces
   the harmless convex side. Mid-lumbar levels run at about half the fold
   radius even on a wide-waisted adult. A worst-case-radius test condemns them
   anyway, which is why this spec uses the directional one.
2. **The sacrum is where it binds**, if the fused sacrum is cut into five short
   addressable levels: each cut shortens the chord and tightens the turn, and
   the sacral concavity faces the deep pelvis. Measured cost: 1.2-3.2% of body
   volume ambiguous, all of it pelvis. Hence the single `S01` level above.
   With one sacral level, that level's axis direction must follow the **upper
   sacral endplate** rather than the sacrum's chord; the chord convention puts
   a ~30° kink at L5/S1 and folds bodies past roughly a 110 cm waist.

`auditBodyTemplate()` checks the exact condition and returns a per-level table
of fold radius, body radius, margin and utilisation. **Every real template must
be audited before it ships**, violations must be published rather than
discovered in production, and the audit must run in CI.
`auditBodyTemplateWorstCase()` exists only to keep the superseded criterion
available for comparison; do not gate on it.

### `BV` — brain volume, AC-PC proportional

```
BV-L-471025
│  │  └── octree refinement, octal digits
│  └───── hemisphere half-box
└──────── frame
```

Talairach's proportional grid, not millimetres:

- `a` — lateral fraction, 0 at the midsagittal plane, 1 at the lateral edge
- `b` — 0 posterior edge, **0.5 at the AC coronal plane**, 1 anterior edge
- `c` — 0 inferior edge, **0.5 at the AC-PC axial plane**, 1 superior edge

`b` and `c` are *piecewise* proportional about those planes rather than a
single affine stretch. That is the classical Talairach normalisation, and it
keeps deep landmarks aligned across brains whose anterior and posterior
extents differ by different ratios — exactly the age and population variation
to absorb.

`x == 0` is assigned to `L`. Midline structures therefore have coverings
spanning both `BV-L` and `BV-R`, which the covering algorithm handles without
a special case.

Octree digit = `a_bit * 4 + b_bit * 2 + c_bit`.

**Known limitation:** the hemisphere half-box is roughly 68 × 172 × 116 mm, so
cells stay anisotropic at every depth (1 : 3 : 2.2). Acceptable because the
anterior-posterior axis is the brain's longest. The planned remedy is a `BV2`
frame whose root pre-splits the box 1 × 2 × 2 for near-isotropic cells; because
the frame id is part of the address, that is a clean additive change rather
than a migration.

### `BR` — cortical surface, HEALPix on the registered sphere (experimental)

```
BR-L-7A3F
│  │  └── HEALPix NESTED index, hex, first digit 0-B for the 12 base faces
│  └───── hemisphere
└──────── frame
```

Cortex is a sheet. Two points 3 mm apart in the volume can be on opposite banks
of a sulcus, 30 mm apart along the sheet, in different areas with different
connectivity. `BV` cannot express that; a surface frame can.

The standard cross-subject correspondence for cortex is already a registration
of each hemisphere to a sphere. A sphere is exactly the domain Earth geocoding
was built for, so HEALPix transfers with no adaptation: equal-area cells,
4-way hierarchical subdivision so `pix >> 2` is the parent, no polar
singularity. The spherical registration carries the population normalisation;
the address is just an index on the sphere.

One hex digit per 2 HEALPix orders, so one digit is the base face and each
further digit refines 16×. The codec is complete and tested. The frame ships
**disabled** in v1 because it needs a cortical surface template with per-vertex
spherical coordinates under a redistributable licence, and `locate()` refuses
rather than pretending.

**Honest caveat:** HEALPix cells are equal-area on the *sphere*, and spherical
inflation is not area-preserving on the folded cortex. Cortical area per cell
varies between gyral crowns and sulcal fundi. The published mean is a mean; the
asset pipeline must measure and publish the distribution per template.

### Frames specified but not implemented

Limbs cannot be anchored to the spine. The same `(axial, azimuth, radial)`
pattern works with a different anchor: fractional distance along the limb's
skeletal chain. Reserved frame ids `LU`, `RU`, `LL`, `RL`. Not in v1.

## 5. Precision ladders

Measured from the reference implementation (`node test/measure.mjs`).

**`BD` — adult template, at T07 and L03**

| digits | axial mm | arc mm at r=0.8 | radial mm | cells per level | L03 axial mm |
| --- | --- | --- | --- | --- | --- |
| 0 | 21.9 | 63.4 | 80.7 | 24 | 29.3 |
| 1 | 10.9 | 36.8 | 40.2 | 192 | 14.6 |
| 2 | 5.5 | 19.7 | 20.0 | 1 536 | 7.3 |
| 3 | 2.7 | 10.2 | 10.0 | 12 288 | 3.7 |
| 4 | 1.4 | 5.2 | 5.0 | 98 304 | 1.8 |
| 5 | 0.7 | 2.6 | 2.5 | 786 432 | 0.9 |

**`BV` — adult brain template**

| digits | lateral mm | ant-post mm | sup-inf mm | cells per hemisphere |
| --- | --- | --- | --- | --- |
| 1 | 34.0 | 102.0 | 74.0 | 8 |
| 2 | 17.0 | 51.0 | 37.0 | 64 |
| 3 | 8.5 | 25.5 | 18.5 | 512 |
| 4 | 4.3 | 12.8 | 9.3 | 4 096 |
| 5 | 2.1 | 6.4 | 4.6 | 32 768 |
| 6 | 1.1 | 3.2 | 2.3 | 262 144 |

**`BR` — mean over one hemisphere**

| digits | cells per hemisphere | mean area mm² | equivalent square mm |
| --- | --- | --- | --- |
| 1 | 12 | 7 500 | 86.6 |
| 2 | 192 | 469 | 21.7 |
| 3 | 3 072 | 29.3 | 5.4 |
| 4 | 49 152 | 1.83 | 1.35 |
| 5 | 786 432 | 0.114 | 0.34 |

Three `BR` digits give 3 072 cells per hemisphere: **59× finer than Brodmann's
52 areas and 17× finer than HCP-MMP1's 180 parcels**, in a nine-character
string. That is the "too coarse" complaint answered concretely.

## 6. The rule that is easy to get wrong

> **Never compare addresses across subjects with string equality.**

Measured: displace a point by a 5 mm registration residual, re-encode, and
compare.

| frame | digits | residual mm | exact string agreement | median centre gap mm | p95 centre gap mm |
| --- | --- | --- | --- | --- | --- |
| BD | 2 | 2 | 0.65 | 0.0 | 14.7 |
| BD | 3 | 5 | 0.04 | 5.9 | 10.4 |
| BV | 4 | 2 | 0.57 | 0.0 | 10.2 |
| BV | 5 | 5 | 0.01 | 5.5 | 8.2 |

At 5 mm residual and 3 digits the strings agree **4%** of the time — yet the
median distance between the two decoded cells is 5.9 mm, i.e. the residual
itself. **The addresses still localise correctly; only the strings differ.**
This is intrinsic to every discrete geocode: any grid splits some neighbouring
points into different cells however small the displacement. Open Location Code
behaves the same way.

Two consequences:

1. **Fine precision is safe to display.** Localisation error stays at
   roughly the residual plus one cell as digits increase; it does not blow up.
2. **Cross-subject comparison must use cell-set overlap, not equality.** "Do
   these two findings refer to the same place?" is answered by intersecting
   coverings at a precision matched to the residual, never by `a === b`.
   Equality is valid only *within* one template.

This is a product requirement, not just a library note. Any screen or query
that matches findings across subjects by comparing address strings is wrong.

### The sanctioned comparisons

`packages/alc/src/compare.ts` provides them, and deliberately makes the wrong
one hard to reach:

| Question | Call | Notes |
| --- | --- | --- |
| Do these two cells share volume? | `overlaps(a, b)` | Exact and cheap. Hierarchy cells are nested or disjoint, never partial. Valid **within one template** |
| Do these two structures/findings touch? | `coveringsOverlap(A, B)`, `coveringIntersect(A, B)` | Operates on coverings; the finer cell of each overlapping pair is the intersection |
| Are these the same place, across subjects or templates? | `samePlace(a, b, templates, { toleranceMm })`, `coveringsSamePlace(A, B, regime)` | **No default tolerance.** The caller must state what "same" means. `coveringsSamePlace` takes a regime — `{ within: 'template' }` or `{ across: 'subjects', toleranceMm, … }` — so the choice is explicit. Widens by each cell's own radius so a coarse address is not penalised for being coarse. Refuses to compare across frames, because their millimetres are not interchangeable. Reports `homology: 'absent'` instead of answering |
| How many digits should I display? | `recommendedPrecision(address, templates, residualMm)`, or `recommendedDigits(...)` for the number alone | One cell should be no smaller than the uncertainty it stands in for. Bounded by the lowest of three ceilings — the residual, the template's `maxUsefulDigits` (§9), and the frame's own digit range — and `limitedBy` says which one bound it, because "collect better data" and "this template will never justify more" call for opposite things from the user |

No exported function answers an equality question, and
`packages/alc/test/surface.test.ts` enumerates the public surface and asserts
it — so `a === b` across subjects is not reachable through the API rather than
merely discouraged by this section.

Measured on the brain template at 5 digits with a 5 mm residual: string
equality recognises under 10% of matching pairs, `samePlace` with a 5 mm
tolerance recognises over 99%.

## 7. Check symbol

Optional, validated whenever present: `BD-T07-03O-531~K`.

Position-weighted sum mod 32 over the canonical body, weights being the odd
numbers 1, 3, 5, … Odd weights are invertible mod 32, and the legal alphabet is
24 symbols so no substitution can differ by a multiple of 32. Therefore:

- **Every** single-character substitution within the legal alphabet is caught
  (verified exhaustively over 452 mutations in the conformance suite).
- Characters outside the legal alphabet are caught by the grammar.
- Transpositions are caught unless the two characters differ by exactly 16 and
  sit an odd distance apart: 31 of every 32 pairs.

It is a transcription guard for codes read aloud or retyped. It is not a
signature and not a storage integrity check. Adding a frame that needs a new
character extends the alphabet and changes every check symbol, so that
requires a spec version bump.

## 8. The human-friendly translator

The code is purely geometric. **Names are a separate lookup layer**, and that
separation is deliberate: parcellations are versioned, contested and revised,
and an address must not change when a parcellation does.

- `address → names` returns a **ranked list with containment fractions**, never
  a single name. A cell generally overlaps several structures.
  Example: `BD-T07-03O-531` → *left lung, lower lobe (71%); 7th rib (18%);
  intercostal muscle (11%)*.
- `name → address` returns a **covering**: the minimal set of maximal address
  prefixes whose union is the structure. `normalizeCovering()` drops redundant
  descendants and rolls complete sibling groups up to their parent, which keeps
  coverings small enough to ship and makes database queries prefix range scans.
- Every resolution carries the name-index version it came from, because the
  address is stable while names are not.

The UI must display both: the code for precision and linking, the names for
comprehension. Neither alone is adequate.

All of this is implemented and documented in
[`docs/alc-1-api.md`](./alc-1-api.md): `toReadable`/`toSpoken`/`fromReadable`
for the text forms, `resolve()` for the ranked names, the `Covering` type for
the reverse direction, and the prefix range scans the coverings are queried
with.

## 9. Failure modes and what the library does

| Situation | Behaviour |
| --- | --- |
| Address finer than the template justifies | `flags.overPrecise = true` with the template's limit. UI must not render false precision |
| Point outside the modelled body surface | `flags.clamped = true` and a note. Never silently projected |
| Point beyond the cranial or caudal end of the column | `flags.clamped = true` with which end |
| Vertebral level absent from the template (L06, transitional variants) | `flags.homology = 'absent'`, `pointMm` is NaN, note requires a registration-supplied level mapping. **Never guessed** |
| Template inadmissible at this level (bisectors cross) | Deterministic fallback plus an explicit note naming the level |
| Template missing for the frame | throws `no_template` |
| `BR` requested in v1 | throws `frame_disabled` |
| Spine bends too sharply to invert | throws `degenerate_template` |

Vertebral count anomalies deserve emphasis: lumbosacral transitional vertebrae,
C7 rib variants and six-lumbar configurations affect a meaningful share of
people. A spine-anchored scheme cannot ignore this. The address is defined in
its template's level sequence; a subject with a different count needs an
explicit level mapping in their registration, and resolution reports the
homology status rather than quietly shifting by one vertebra.

## 10. Trust boundary

Addresses arrive from URLs, pasted text and imported datasets. All of it is
untrusted input.

- Length capped at 64 characters; refinement digits capped per frame and
  globally at 16, so no input can drive unbounded subdivision work.
- Alphabet, frame registry, anchor ranges and digit alphabets all validated
  before any geometry runs. Digit-alphabet validation happens once in `parse()`
  for every frame — an earlier version left it to each frame's decoder, and
  `BD-T07-02O-9` parsed cleanly and only failed later inside a frame-specific
  code path.
- Check symbol, when present, must match or the address is rejected.
- Prefix range scans must be parameterised, never string-interpolated.
- Research data is curator-supplied: every finding-to-address link carries
  provenance, and external links are rendered, never fetched.

## 11. Versioning

- The frame id is part of the address, so a better frame is an additive change
  (`BV2`) and old addresses keep resolving.
- Templates are versioned separately and named in every resolution result.
- The name index is versioned separately again, because names move and
  addresses must not.
- Changing the legal alphabet or the check algorithm requires a new spec
  version, since it invalidates existing check symbols.

## 12. Conformance

`packages/alc` — 30 conformance tests, all passing. Any implementation or new
template must pass the same suite.

```
cd packages/alc
node --test test/conformance.test.ts test/compare.test.ts   # correctness
node test/healpix.probe.mjs                                 # HEALPix properties
node test/measure.mjs                                       # the tables in §5 and §6
```

Load-bearing tests:

- HEALPix prefix property: `ang2pix(p, k) >> 2 === ang2pix(p, k-1)`, zero
  failures over 120 000 random directions across six orders.
- Truncation yields a containing ancestor, for every frame.
- Homologous points produce identical addresses across all three body
  templates and both brain templates. **This is the cross-age and
  cross-population claim, stated as an executable test.**
- Exhaustive single-character mutation of three representative addresses: all
  452 are rejected.
- Vertebral count anomaly is reported, not guessed.
- Over-precision is declared, not implied.
- `samePlace` recognises over 99% of 5 mm-displaced pairs that string
  equality rejects, and still reports an absent anatomical level rather than
  answering.
