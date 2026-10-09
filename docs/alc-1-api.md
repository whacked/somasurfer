# ALC-1 library API — `@gstack/alc`

**Status:** v0.2, conformance suite green
**Date:** 2026-10-08
**Spec:** [`alc-1-spec.md`](./alc-1-spec.md) · **Template admissibility:** [`alc-1-admissibility.md`](./alc-1-admissibility.md)

The reference implementation of ALC-1, and the library the viewer and the
research layer both consume. No dependencies, no framework, no Node built-ins.

```bash
cd packages/alc
npm test          # conformance suite, including the browser build
npm run build     # dist/esm/**.js and dist/alc.js
npm run measure   # regenerates the precision tables in the spec
```

---

## 1. Layers, and why they are separate

```
         translate.ts     address <-> readable/spoken English
              │
  resolve.ts  │           address -> ranked structure names (versioned index)
       │      │
  covering.ts │           sets of addresses: construct, roll up, intersect
       │      │
   query.ts   │           prefix range scans, parameterised
       │      │
  compare.ts  │           the sanctioned comparisons
       │      │
  locate.ts   │           address <-> millimetres, in a named template
       │      │
  address.ts ─┘           parse, format, truncate, refine
       │
   codec.ts               alphabet, grammar, check symbol
```

The arrows only point one way, and that is load-bearing rather than tidy:

- **`address.ts` and `codec.ts` cannot see a template.** That is what makes the
  same address mean the same anatomical place in an adult, a child and a
  population-specific average. Only the millimetres differ.
- **Neither can see a name index.** That is what makes a parcellation revision
  unable to invalidate an address that has already been issued, printed or
  pasted into a URL.

Both statements are asserted in `test/surface.test.ts`, which reads the import
graph, rather than left to review.

## 2. Addresses

```ts
import { parse, format, isValid, parent, ancestors, children, contains } from '@gstack/alc';

parse('bd-t7-3o-531').canonical;   // 'BD-T07-03O-531'
parse('BD-T07-03O-531').withCheck; // 'BD-T07-03O-531~…'  transcription guard
format('  bd-T07  ');              // 'BD-T07'
isValid('BD-T07-02O-9');           // false — 9 is not an octal digit

parent('BD-T07-03O-531').canonical;              // 'BD-T07-03O-53'
ancestors('BD-T07-03O-53').map((a) => a.canonical);
// ['BD-T07', 'BD-T07-03O', 'BD-T07-03O-5']
contains('BD-T07', 'BD-T07-03O-531');            // true
contains('BD-T07', 'BD-T08-03O');                // false
```

`parse` is the single validation gate. Grammar, frame registry, anchor ranges,
digit alphabets, the 64-character length cap, the 16-digit global cap, the
per-frame digit cap and the check symbol are all enforced there, before any
geometry runs. Every other entry point in the library — including the
translator and the name index — ends up going through it, so there is one place
to audit and one place where hostile input stops.

Errors are always `AlcError` with a stable `code`. The viewer branches on
`code`, so `test/bundle.test.ts` asserts the codes survive the build.

## 3. Coverings

A structure or a finding occupies a *set* of cells. The useful representation is
the shortest set of address prefixes whose union is that set.

```ts
import { covering, coveringUnion, coveringIntersect, coveringRollUp } from '@gstack/alc';

const c = covering(['BV-L-471', 'BV-L-47', 'BV-L-4']);
c.cells;   // ['BV-L-4']  — redundant descendants dropped
c.frames;  // ['BV']
```

`Covering` is a type rather than a `string[]`, and the distinction matters:
every operation below assumes the cells are canonical, pairwise disjoint and
maximally rolled up. A bare array carries no such promise, so the constructors
normalise and the operations reject anything they did not build.

| Call | Does |
| --- | --- |
| `covering(addresses)` | Parse, normalise, freeze. Invalid input throws — a silently shrunk covering is a silently wrong query |
| `coveringUnion(...cs)` | Union, re-normalised |
| `coveringIntersect(a, b)` | Exact intersection. Cells are nested or disjoint, so the intersection of two cells is the finer one |
| `coveringsOverlap(a, b)` | Do they share any volume? Exact, and valid **within one template** |
| `coveringContains(c, addr)` | Does one cell of `c` wholly contain `addr`? |
| `coveringOverlapsAddress(c, addr)` | Does `c` touch `addr` in either direction? |
| `coveringRollUp(c, maxDigits)` | Coarsen to a stated precision. A superset: coarsening can only add volume |
| `coveringMeasureWithin(c, addr)` | Fraction of the cell `addr` that `c` occupies |
| `relativeMeasure(outer, inner)` | Exact fraction of `outer` that `inner` is |
| `coveringMeasure(c)` | Total measure, in units of frame roots |

### Measure is frame measure, not millimetres

`relativeMeasure` and everything built on it measure the *frame* — the
dimensionless domain — not template millimetres. A cell's children are exactly
equal fractions of it by construction, so frame measure is exact, template
independent, and sums to 1 over any partition. That is what makes `resolve()`'s
fractions add up.

Millimetre volume is a different quantity and is deliberately not offered here:
the `BD` radial coordinate is normalised, so a cell's mm volume grows with
depth even though its frame measure does not. Anything that needs mm volume has
to integrate against a template and say which template.

### Construction from geometry

```ts
import { coveringFromRegion, ballRegion, brainVolumeFrameRoots, bodyFrameRoots } from '@gstack/alc';

const roi = coveringFromRegion(ballRegion({ brainVolume: template }, [12, -4, 30], 15), {
  roots: brainVolumeFrameRoots(),
  maxDigits: 4,
});
```

Recursive subdivision: classify the frame roots, keep what is wholly inside,
discard what is wholly outside, subdivide the boundary to `maxDigits`.

`onPartial` decides what happens to a cell still straddling the boundary at the
refinement limit. The default `'include'` makes the covering a *superset* of
the region, which is the right answer to "what might be here?" and the only
choice that cannot lose a finding. `'exclude'` keeps only cells proven inside,
for the rarer "what is certainly here?".

A custom `CellRegion` only has to implement `classify(address)`. It **must** be
conservative — return `'partial'` whenever it cannot prove `'inside'` or
`'outside'`. Claiming `'outside'` for a cell that does overlap loses data
silently, which is the one failure mode a covering must not have.

`maxCells` (default 200 000) bounds the work an unlucky region can cause.

From a mask or a point cloud instead:

```ts
const { covering, clampedPoints, notes } = coveringFromPointsMm(
  { body: template }, 'BD', pointsMm, 4,
);
```

Clamped points are **counted, not dropped**. A segmentation reaching outside the
modelled body surface is a real condition the caller needs to see.

## 4. Prefix range scans

Truncating an address yields its ancestor, so containment is a string prefix
test, so "everything inside this cell" is one half-open range scan on an
ordinary B-tree index. No recursive CTE, no materialised path table, no GiST
index.

```ts
import { coveringScan, overlapScan, renderScan } from '@gstack/alc';

const plan = coveringScan(structureCovering('UBERON:0002048', index));
const { text, params } = renderScan(plan, { column: 'findings.alc_address' });
// text:   (("findings"."alc_address" COLLATE "C" >= $1 AND … ) OR … )
// params: ['BD-T07-03O', 'BD-T07-03P', …]
await db.query(`SELECT * FROM findings WHERE ${text}`, params);
```

| Call | Selects |
| --- | --- |
| `prefixRange(addr)` | `{ lower, upperExclusive }` for one cell and its descendants |
| `descendantScan(addr)` | Rows at or below `addr` |
| `ancestorScan(addr)` | Rows strictly above `addr`, as exact keys |
| `overlapScan(addr)` | Everything whose cell overlaps `addr`, either direction |
| `coveringScan(c)` | Everything overlapping any cell of a covering |
| `scanSorted(sorted, plan)` | The same plan against an in-memory sorted array |

### Two rules the module enforces rather than documents

**Scans are parameterised, never interpolated.** `renderScan` emits only
placeholders and returns the values separately. The column name is the one part
of a query that cannot be a bind parameter, so it is validated against
`/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/` and rejected rather than escaped.
`test/query.test.ts` asserts that no value reaches the SQL text, and scans the
package's own source for an interpolated query path.

**The range scan needs binary collation.** This is the bug that survives CI. A
prefix range depends on `-` (0x2D) sorting below every alphanumeric character.
That is true of C/byte ordering and **not** true of ICU or most locale
collations, which treat punctuation as ignorable at the primary level. Under
`en_US.UTF-8`, `BD-T07-02O` and `BDT0702O` compare equal at the first level and
the bounds stop meaning what they say — a scan that returns subtly wrong rows
and never errors. So every rendered comparison carries an explicit binary
collation (`COLLATE "C"`, `COLLATE BINARY`, `COLLATE utf8mb4_bin`), and the
stored column should be declared that way too:

```sql
CREATE TABLE findings (
  alc_address text COLLATE "C" NOT NULL,
  ...
);
CREATE INDEX findings_alc_address ON findings (alc_address COLLATE "C");
```

Pass `omitCollate: true` only once the column is declared byte-ordered.

An empty plan renders as `FALSE`, not as an empty string. A predicate that
disappears turns "nothing matches" into "everything matches".

## 5. Name resolution

```ts
import { buildNameIndex, resolve, structureCovering } from '@gstack/alc';

const index = buildNameIndex({
  version: 'name-index-2026.10.1',
  structures: [
    { id: 'UBERON:0008946', name: 'lower lobe of left lung', source: 'UBERON',
      cells: ['BD-T07-03O-5', 'BD-T07-03O-4'] },
    …
  ],
});

resolve('BD-T07-03O-5', index);
// {
//   address: 'BD-T07-03O-5',
//   indexVersion: 'name-index-2026.10.1',
//   measure: 'frame',
//   matches: [
//     { structure: { id: 'UBERON:0002048', name: 'left lung' },               fraction: 1     },
//     { structure: { id: 'UBERON:0008946', name: 'lower lobe of left lung' }, fraction: 1     },
//     { structure: { id: 'UBERON:0002228', name: '7th rib' },                 fraction: 0.25  },
//     { structure: { id: 'UBERON:0001103', name: 'intercostal muscle' },      fraction: 0.125 },
//   ],
//   unclaimedFraction: 0,
//   notes: [],
// }
```

Three properties, all tested:

- **A ranked list, never a single name.** A cell generally overlaps several
  structures. Collapsing that to one winner is how an atlas starts lying, so
  there is no API that does it.
- **Fractions sum correctly.** Over a partition of the queried cell they sum to
  1 and `unclaimedFraction` is 0. `unclaimedFraction` is measured on the *union*
  of the matches, so structures that overlap each other can legitimately sum
  past 1 without it going negative.
- **Every result pins the index version.** Addresses are stable, names are not.
  A stored resolution without a version is not reproducible, so an index
  without a version is refused at construction.

| Call | Does |
| --- | --- |
| `buildNameIndex(input)` | Validate every address, normalise every covering, build the lookup tables. Throws on a malformed entry, naming the structure |
| `resolve(addr, index, opts?)` | Ranked fractions for one cell. `minFraction`, `limit` |
| `resolveCovering(c, index, opts?)` | The same for a multi-cell finding, measure-weighted over the covering |
| `structureCovering(id, index)` | `name -> covering`, the reverse direction |
| `containingStructures(addr, index)` | Structures that wholly contain the cell, coarsest first |
| `findStructures(query, index, limit?)` | Case-insensitive name search for a UI |

Lookups go through the prefix range scan: the index keeps one sorted array of
every cell, so a query is a binary search plus a walk — the same shape the
caller's database will use. `test/resolve.test.ts` checks that optimisation
against a brute-force scan over every structure.

Malformed input is refused at **build** time, not query time. A bad cell
discovered at query time is not an error, it is a wrong answer: the structure
would quietly resolve as smaller than it is.

## 6. The translator

```ts
import { toReadable, toSpoken, fromReadable, describe, frameSummary } from '@gstack/alc';

toReadable('BD-T07-03O-531');  // "body, T7 level, three o'clock, outer, cell 531"
toSpoken('BD-T07-03O-531');    // "body, T7 level, three o'clock, outer, cell five three one"
toReadable('BV-L-471025');     // 'brain, left hemisphere, cell 471025'
toReadable('BR-L-7A3F');       // 'left cortical surface, cell 7A3F'

fromReadable("body, T7 level, three o'clock, outer, cell 531").canonical;  // 'BD-T07-03O-531'
```

The contract is exact, not decorative: `fromReadable(toReadable(a))` and
`fromReadable(toSpoken(a))` both return the canonical form of `a`, for every
address in every frame. Checked over a generated sweep of every vertebral
level, every clock sector and depth half, both hemispheres, and digit runs up
to each frame's cap.

Two deliberate asymmetries:

- **Output is one form per address; input is permissive.** `toReadable` emits
  exactly one string, so the round-trip is single-valued. `fromReadable` accepts
  `T7`/`T07`/`thoracic 7`, `3 o'clock`/`three o'clock`/`three oclock`,
  `outer`/`O`, hyphenated or spaced digit runs, `oh` for zero, `niner` for nine,
  and either text form. Anyone transcribing by ear or by hand lands in that set.
- **Only the refinement run is spelled out.** Clinicians already say "T7, three
  o'clock". The octal or hex run is the part that gets misheard, so that is the
  part `toSpoken` spells symbol by symbol, using NATO letters for hex.

Readable text is as untrusted as any other input — it arrives from dictation,
email and OCR. Length and clause count are capped, and every parse ends by
going through `parse()`. Mistranscription throws `AlcError`; there is no
best-effort guess, because an address that resolves to the wrong place is worse
than one that fails.

For a UI:

```ts
describe('BD-T07-03O-531');
// {
//   address, withCheck, frame: 'BD', frameSummary, experimental: false,
//   readable, spoken,
//   parts: [ { segment: 'BD',  kind: 'frame',      label: 'body',               detail: … },
//            { segment: 'T07', kind: 'level',      label: 'T7 level',           detail: … },
//            { segment: '03O', kind: 'azimuth',    label: "three o'clock, outer", detail: … },
//            { segment: '531', kind: 'refinement', label: 'cell 531',           detail: … } ],
//   ancestors: ['BD-T07', 'BD-T07-03O', 'BD-T07-03O-5', 'BD-T07-03O-53'],
// }
```

`describe` needs no template and no name index, so it is safe to call before
either has loaded. `frameSummary(id)` and `frameSummaries()` give the one-line
descriptions for a frame picker.

## 7. Comparison — the rule that is easy to get wrong

> **Never compare addresses across subjects with string equality.**

Measured on the body frame at 3 digits with a 5 mm registration residual, and
reproduced as an assertion in `test/surface.test.ts` so the number cannot drift
from the behaviour:

| metric | value |
| --- | --- |
| exact string agreement | **0.04** |
| median gap between the two decoded cell centres | **5.9 mm** |
| p95 gap | 10.4 mm |
| `samePlace` with a stated 5 mm tolerance | **0.998** |

The strings agree 4% of the time while the decoded cells stay 5.9 mm apart —
i.e. exactly the residual. **The addresses still localise correctly; only the
strings differ.** This is intrinsic to every discrete geocode: any grid splits
some neighbouring points into different cells however small the displacement.
Open Location Code behaves the same way.

So cross-subject matching by `a === b` is not reachable through the public API.
There is no exported function that answers an equality question
(`test/surface.test.ts` enumerates the exports and asserts it), and the two
sanctioned comparisons have **no default tolerance** — a caller must state what
"same" means:

```ts
samePlace(a, b, templates, { toleranceMm: 5 });

coveringsSamePlace(A, B, { within: 'template' });                 // exact, no tolerance exists
coveringsSamePlace(A, B, { across: 'subjects',                    // tolerance required
  toleranceMm: 5, templatesA, templatesB });
```

The regime is a discriminated union, so the caller picks one. Within one
template, cells are nested or disjoint and overlap is exact — there is no
tolerance to state. Across subjects a registration residual stands between the
two coverings, and a missing, `NaN`, infinite, negative or non-numeric
tolerance throws `bad_tolerance`.

| Question | Call |
| --- | --- |
| Do these two cells share volume, in one template? | `overlaps(a, b)` |
| Do these two structures touch, in one template? | `coveringsOverlap(A, B)`, `coveringIntersect(A, B)` |
| Are these the same place, across subjects or templates? | `samePlace`, `coveringsSamePlace` with `across: 'subjects'` |
| How many digits should I display? | `recommendedDigits(addr, templates, residualMm)` |

`samePlace` widens by each cell's own radius, so a coarse address is not
penalised for being coarse; refuses to compare across frames, because their
millimetres are not interchangeable; and reports `homology: 'absent'` rather
than answering when a level is missing from a template.

## 8. Browser build

```bash
npm run build
# dist/esm/**.js   one file per module, `.ts` specifiers rewritten to `.js`
# dist/alc.js      single ESM file, 139 kB, no further resolution needed
```

The package has no runtime dependencies and uses no Node built-ins, so the only
thing a browser build has to do is remove the type annotations. Node's own
`stripTypeScriptTypes` does that, which means this package needs **no bundler
and no toolchain** — nothing to keep up to date, and nothing between the source
the conformance suite runs against and the code the viewer loads.

```ts
import { parse, toReadable } from '@gstack/alc';           // source .ts, or dist/alc.js in a browser
import { parse } from '@gstack/alc/bundle';                // the single file, explicitly
import { parse } from '@gstack/alc/esm/index.js';          // the per-module build
import { BD } from '@gstack/alc/src/frames/bodySpine.ts';  // a single source module
```

`exports` keeps `types` and `default` pointed at the `.ts` source, so
TypeScript consumers read the real annotations and their doc comments rather
than a generated approximation, and the package works with no build step at
all. The `browser` condition points at `dist/alc.js`.

`dist/` is generated and not committed, so `test/bundle.test.ts` runs the build
itself and then exercises the output: export names against the source module,
one call into each layer, the `AlcError` codes, and a check that the private
helpers several modules define under the same names (`dot`, `cross`, `unit`,
`add`, `normalize`, and `parseHemisphere`, exported by two different frames) did
not collide. The single-file bundle wraps each module in an IIFE rather than
hoisting everything into one scope, which is why.

## 9. Error codes

`AlcError.code` is stable and safe to branch on.

| Code | Meaning |
| --- | --- |
| `empty`, `too_long`, `bad_type`, `non_ascii` | Input shape. `non_ascii` is raised on the raw input, before trimming and case mapping, because §3 of the spec makes ASCII part of the grammar |
| `unknown_frame`, `missing_anchor`, `too_many_segments`, `empty_segment`, `bad_segment` | Grammar |
| `bad_level`, `bad_azimuth`, `bad_hemisphere`, `bad_base_face`, `bad_index` | Anchor out of range. `bad_index` is a `BR` HEALPix index out of range for its order |
| `bad_digit`, `bad_precision`, `missing_digits`, `missing_azimuth` | Refinement |
| `bad_character`, `bad_check`, `check_failed` | Check symbol |
| `no_template`, `frame_disabled`, `absent_level`, `degenerate_template`, `bad_template`, `empty_template` | Template |
| `bad_covering`, `covering_too_large`, `bad_radius`, `bad_frame` | Coverings |
| `bad_column`, `bad_dialect`, `bad_range` | Query construction |
| `bad_name_index`, `bad_index_version`, `bad_structure`, `bad_structure_covering`, `duplicate_structure`, `unknown_structure` | Name index |
| `bad_tolerance`, `bad_regime`, `frame_mismatch`, `bad_fraction` | Comparison |

`test/surface.test.ts` checks this table against the codes the source actually
throws, in both directions, so it cannot drift. Note that `bad_index` and
`bad_name_index` are deliberately distinct: a malformed `BR` pixel index and a
caller passing something that is not a name index are different problems, and
the viewer branches on the code.

## 10. Superseded calls

`compare.ts` still exports the two string-array covering helpers that predate
the `Covering` type:

| Superseded | Use instead | Why |
| --- | --- | --- |
| `coveringsIntersect(a: string[], b: string[])` | `coveringsOverlap(a, b)` | Bare arrays carry no normalisation guarantee |
| `coveringIntersection(a: string[], b: string[])` | `coveringIntersect(a, b)` | The old one can return a cell alongside its own ancestor |

They are kept because the conformance suite uses them. Note that
`coveringsIntersect` and `coveringIntersect` differ by one character and take
different types — a rename is a small mechanical change, but it touches the
conformance suite, so it is left for whoever next edits that suite deliberately.

## 11. What is deliberately absent

- **No equality predicate on addresses.** See §7.
- **No default tolerance anywhere.** Guessing it is how this gets used wrongly.
- **No single-name resolution.** See §5.
- **No millimetre volume measure.** See §3; it needs a named template.
- **No type declarations in `dist/`.** `types` points at the source.
- **No `BR` location.** The frame parses and refines, but `locate()` throws
  `frame_disabled` rather than pretending it has a cortical surface template.
- **No frame geometry changes.** The frame mathematics, the level set and the
  template admissibility audit are owned by the spec and
  `docs/alc-1-admissibility.md`.
