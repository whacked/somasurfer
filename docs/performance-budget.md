# Atlas performance budget

The budget the atlas is built to, the machine it is stated for, and what is
measured in CI today.

Authoritative numbers live in `ci/performance-budget.json`; this document
explains them. The gate is `tools/perf-budget.mjs`, which runs on every push
and fails the build when any line is over.

## The reference machine

A budget stated without a machine is not a budget. Ours is a **mid-range
laptop**, deliberately not a developer machine — the atlas is for clinicians
and students on institutional hardware:

| | |
| --- | --- |
| CPU | 4 physical cores, ~2.4 GHz sustained, no discrete GPU |
| Memory | 8 GB |
| Network | 25 Mbit/s down, 40 ms RTT |
| Browser | current Chrome or Firefox, cold HTTP cache, warm DNS |

## The two numbers that matter

| what the user feels | budget |
| --- | --- |
| Navigation start → low-resolution geometry on screen | **2.5 s** |
| Navigation start → first click handled | **3.5 s** |

Under 2.5 s an atlas feels like a document. Over it, it feels like an
application that is loading. 3.5 s to first interaction is the outer edge of
acceptable for a first visit, and the number to beat once the viewer lands —
not a target to grow into.

## The component budgets

These are what CI actually gates on, because these are what the build
controls and where a regression comes from: one careless asset export, one
library added to the page shell.

| line | budget | covers |
| --- | --- | --- |
| `bundleGzipBytes` | 150 KiB | `index.html` + `app/*.js` + `app/*.css`, gzipped |
| `indexGzipBytes` | 256 KiB | `data/*.json` **plus the name index**, gzipped |
| `lowResAssetGzipBytes` | 2.5 MiB | `dist/assets/**`, gzipped, less LICENSE, ATTRIBUTION.md, the name index and every file a mesh set declares lazy |
| `lowResBrainAssetGzipBytes` | 1.00 MiB | the brain's share of the line above (DOG-127), counted in both |
| `fullResBrainAssetGzipBytes` | 5.25 MiB | the lazily fetched full-resolution brain tier (DOG-127) |
| `indexParseMsNormalised` | 40 ms | parse `data/*.json` and build the lookup maps |
| `nameIndexBuildMsNormalised` | 100 ms | build the name index: `joinNameIndex` + `buildNameIndex` over the emitted documents |
| `nameIndexBuildUsPerCell` | 28 us/cell | the same measurement, per cell the index binds |
| `lowResAssetParseMsNormalised` | 400 ms | parse the low-resolution asset payloads: JSON, or the ATLM binary mesh reader |

2.5 MiB at 25 Mbit/s is about 0.84 s of transfer, which fits the 2.5 s budget
with room for parse. It is also roughly where a 20k-triangle body shell plus
label sets lands, so it constrains the asset pipeline without being
unachievable.

### Brain meshes: the shared low-resolution line, and a lazy tier (DOG-127)

The real brain (W2, DOG-127) and the full-body human (W3, DOG-128) share the
2.5 MiB `lowResAssetGzipBytes` line. The split, agreed in W2 and binding on W3:

| share | gzip | what it holds | today |
| --- | ---: | --- | ---: |
| brain, low tier | 1.00 MiB | `assets/brain/**` that is not declared lazy | 759 KiB |
| body, low tier | 1.25 MiB | W3's equivalent; W3 adds its own line | — |
| v1 templates and labels | 0.25 MiB | everything else under `assets/` | about 0.13 MiB |

The body gets the larger share because it has more structures in view at once.
`lowResBrainAssetGzipBytes` holds the brain to its share, so a brain that grows
cannot spend the body's room. Those bytes are still counted in
`lowResAssetGzipBytes` too; the share is a line inside it, not beside it.

**The full-resolution tier is fetched lazily**, so it is not a low-resolution
asset and has no business in `derivedLowResAssetLoadMs`. A file is lazy because
its mesh set's `structures.json` says so (`tiers.*.loading: "lazy"`), never
because of its name. That makes the failure one-sided: a lazy file nobody
declared is costed as low-resolution, where it is paid for.

`fullResBrainAssetGzipBytes` is **5,505,024 B (5.25 MiB), a literal derived
once** on 2026-10-11 from the first full-tier build, which read 4,972,008 B:
1.10 × that, rounded up to the next 256 KiB. It is not re-derived at gate time,
so it cannot ratchet to whatever the next build weighs. The 10% covers
re-encoding the same 245 structures. A new clearance group, such as the cortex
if it ever clears, is a new decision about this line, not headroom inside it.
At 25 Mbit/s the tier is about 1.8 s of transfer after the low tier has drawn.

**Binary meshes are parsed by the format's own reader.** `tools/lib/meshbin.mjs`
is the single definition of the ATLM format. The gate recognises an ATLM file by
its magic bytes, reads it with that module, and walks positions and indices
once, which is the same work a JSON mesh gets. Before this, `JSON.parse` on a
binary asset threw and took the gate down with it.

### The name index is an index, not an asset (DOG-80)

`assets/labels/names.json` and `assets/labels/coverings.json` are served out of
the assets tree for licence and attribution reasons, but `app.js` awaits them in
step 1, before templates and before the page can answer a click. They are an
index on the critical path that happens to live in the assets directory.

This gate used to partition the build by **directory**, so both files fell into
the asset lines. That mattered more than a misfiled byte count: the asset parse
term only walks `positions` and `indices`, so `covering()` — which
`buildNameIndex` calls once per structure — was measured by no line at all.
`indexParseMsNormalised` reported 0.9 ms raw and 4% utilisation for a row whose
stated subject is building the lookup maps, while the real build took seconds.
That is the defect DOG-80 was filed about, and the quadratic `covering()`
underneath it was invisible for the same reason.

The gate now classifies by **role**: the name index counts as index on the byte
line, so the critical path is costed once and consistently. `indexGzipBytes` was
written for this — "256 KiB holds the full ALC-1 level and frame tables with room
for a label index per frame".

### Why it then got two lines of its own (DOG-98)

DOG-80 put the name index build inside `indexParseMsNormalised`, which made that
row measure the right total against a limit written for part of it: 40 ms set for
`data/*.json` alone, now also carrying an index build that read 55–85 ms on a
best-of-three (the figure quoted throughout DOG-80 and DOG-97; it reads lower
here for the reason under "Why the reading is a best-of-15"). The row was
declared `UNVERIFIED` rather than quoting a verdict the gate did not have, and
DOG-97 settled it as a **scope split, not a raise** — no existing limit moved.

So `indexParseMsNormalised` is back to `data/*.json` plus the lookup maps, keeps
its 40 ms, and lands around 1–2 ms normalised. The name index has two lines:

- **`nameIndexBuildMsNormalised`** — what the main thread can afford at boot.
  Found through the atlas index's own `nameIndex` descriptor, the way `app.js`
  finds it, so a build that moves the index does not quietly stop being measured.
- **`nameIndexBuildUsPerCell`** — the same measurement over the cells it bound.

The second line is the one that carries the decision. Today's 57 structures and
3478 cells are the **smallest index v1 will ever bind**, so an absolute limit
says less every time the atlas grows, while growth cannot consume a per-cell
limit. It is also what stops the quadratic `covering()` coming back: with the
pre-DOG-80 prune deliberately restored, both lines go red at about 3.6× (356 ms
and 102 us/cell against 100 and 28).

Both lines stay inside the derived critical path. Splitting the measurement
changed which line reports the cost, not when the page pays it — dropping it from
`derivedFirstInteractionMs` while giving it a line of its own would be DOG-80's
defect wearing a different hat.

#### How the two limits were derived

The rule, from DOG-98:

```
nameIndexBuildMsNormalised.limit = roundUpTo10( 1.5 x the gate's own best-of-N reading )
                                   and must be <= 5% of derivedFirstInteractionMs.limit
nameIndexBuildUsPerCell.limit    = roundUpTo2(  1.5 x that reading / cells )
```

The cap is **5% of 3500 ms = 175 ms**: the index may have a twentieth of the
first-visit budget and no more, because the rest is transfer, parse and the
viewer's first paint.

The reading is **64.2 ms**, the highest normalised figure in **22 runs of this
gate** on the branch this landed on. Those 22 runs read 26.3–64.2 ms normalised,
from a raw figure of only 21.1–33.4 ms: nearly all of the spread is the
calibration workload's own noise (it read 52–153 ms across the same runs), not
the index's. Taking the highest rather than a typical reading is deliberate — the
limit has to survive the worst reading the gate produces, because a false red is
what gets a line switched off.

```
ms      = roundUpTo10(1.5 x 64.2 = 96.2) =  100 ms     (under the 175 ms cap, so the cap does not bind)
perCell = roundUpTo2 (1.5 x 64.2 / 3478 = 27.7) = 28 us/cell
```

The worst combination actually observed — the slowest build against the fastest
calibration — is 77.8 ms, or 22.4 us/cell: 78% and 80% of the two limits.

At 3478 cells the per-cell limit is equivalent to 97.4 ms, marginally **tighter**
than the 100 ms absolute line, because `roundUpTo10` rounds up by 4% where
`roundUpTo2` rounds up by 1%. So at today's scale a per-cell regression reds
first, and the absolute line only leads once the index has grown. That is the
right way round.

DOG-97 expected roughly 130 ms and 36 us/cell. **The rule won and the document's
numbers are wrong**, for a stated reason: the reading moved because the gate's
own measurement changed.

#### Why the reading is a best-of-15, and what that costs

Best-of-three was measuring the JIT warming up rather than the work. Interleaved
against the calibration in one process, best-of-three read 72–92 ms normalised
where best-of-fifteen read 47–63 ms from the same build, with the raw figure
falling from about 53 ms to about 24 ms and then stopping. The first few attempts
are the optimiser. A 1.5x allowance cannot cover a spread that is mostly warm-up,
so the attempt count behind this one measurement is **15**, printed on every run
as `(best of 15)`.

The **calibration stays at best-of-three** on purpose: raising it would move
`speedFactor` and therefore every other normalised line on this gate, against
limits set with the current reading. That is a change to lines DOG-98 is not
about.

What this costs is worth stating plainly, because it is a real caveat and not a
rounding error. A best-of-N figure is the machine's **capability**, which is the
right thing to gate on — comparable run to run, and how every other line here is
measured. It is **not what a user pays**: `app.js` builds this index exactly once,
on a cold JIT, and the cold attempt runs about twice the steady state (60.5 ms
against 29.6 ms raw on one run). So this line and `derivedFirstInteractionMs` are
both **optimistic about this term by roughly a factor of two**.

The cold attempt is therefore reported beside the gated one — in the detail block
and as `raw.nameIndexBuildFirstAttemptMs` in the JSON — but nothing is gated on
it, because a single cold sample is far too noisy to carry a limit. Closing the
gap needs a browser-observed first interaction, which is already the largest
item under "What is not measured yet".

#### When the absolute line is over and the per-cell line is not

That pair of verdicts is the one case whose remedy is not the obvious one, and
the gate says so in its own voice rather than leaving it to be re-derived:

```
THIS IS NOT A REGRESSION, AND RAISING THE LINE IS THE WRONG FIX.
```

The per-cell cost has not moved; the index got bigger. Raising the absolute limit
buys one more index's worth of growth and spends first-interaction budget the
viewer needs. The fix is to move the build **off the critical path** — a worker —
which is DOG-97 §2.4. It is not implemented yet because there is no "after first
interaction" to move it to while a deep link consumes the index before anything
is drawn; holding the sentence in the gate is what keeps the decision from being
forgotten. `perf-name-index-growth-is-not-a-regression` proves it fires.

If the per-cell line is **also** over, the sentence does not appear: that is a
real regression in `covering()` or the join, and the per-cell line's own failure
explains it.

## How the two felt numbers are derived

CI does not have a mid-range laptop or a 25 Mbit/s link, so the felt numbers
are **derived** from the measured ones through a model stated in the budget
file, not observed:

```
critical path     = 2 × RTT + (bundle + index) / downlink + index parse
low-res asset load = critical path + 1 × RTT + assets / downlink + asset parse
first interaction  = critical path + render allowance
```

Two round trips for the critical path and one for the assets: HTTP/2 over a
static host serves each round of requests together. The model is pessimistic
about bandwidth — no CDN edge, no compression beyond gzip — and optimistic
about nothing.

**Parse times are normalised.** A CI runner is faster than the reference
laptop and varies run to run, so a raw parse time measured there cannot be
compared to a budget stated for a laptop. `tools/perf-budget.mjs` runs a fixed
calibration workload alongside the measurement and scales by
`referenceMs / observedMs`. It is a crude single scalar that corrects for
clock speed and little else, so raw and normalised numbers are both always
reported, and the gate will not quote a normalised number at all if the runner
is more than 4× off the reference — at that distance the correction would be
doing more work than the measurement.

## When the runner is too far from the reference

GitHub's runner pool is heterogeneous. The same tree measured 25 ms on one
runner and over 100 ms on another, so the speed factor is not a property of the
build and can land anywhere from under 1× to nearly 5×.

For a while, landing outside `[0.25, 4]` failed the build. That was wrong, and
it cost a day: run [`37890971145`][dog29] went red on a merge commit that
changed no file contents, on a tree that had passed the same gate twice. The
gate was saying "over budget" when the truth was "not measurable from here".
Those are different claims and only one of them is about the code.

What the gate does now is use the bound that the direction of the error leaves
sound. The correction is untrustworthy, but its **sign** is not:

| runner | unnormalised time is | over budget means | under budget means |
| --- | --- | --- | --- |
| faster than the reference | a **lower** bound — the reference pays at least this | over budget, proven | nothing: `not evaluated` |
| slower than the reference | an **upper** bound — the reference pays at most this | nothing: `not evaluated` | within budget, proven |

So the gate still only ever fails on certainty, it never reports a normalised
number it cannot stand behind, and a line it cannot settle is printed as
`not evaluated` rather than folded into either verdict. Byte budgets do not
touch the calibration at all and stay exact and hard on every runner.

The cost is sensitivity, and it is worth stating: on a 4.8× runner, a parse
regression has to be 4.8× larger before the unnormalised lower bound catches
it. With 40× headroom on `lowResAssetParseMsNormalised` that is tolerable, and
it is inside the range this document already declares untrustworthy below.

**Widening the band is not the fix.** Raising `maxSpeedFactor` to cover the
reading we happened to see would buy sensitivity by quoting a larger correction
as though it were a measurement, which is the thing the refusal exists to
prevent. The evidence that would justify a wider band is a measured
distribution of the calibration workload across the runner pool, and a stated
view on how large a correction is still worth believing. Neither exists yet.

Lengthening the calibration workload — the other obvious move — does not fix
this either, and it is worth writing down why. The speed factor is a *ratio* of
the same workload on two machines, so scaling the workload leaves it where it
was; a 6× longer workload measured here moved the spread from 2.1× to 1.5× but
did not move the ratio. It would also invalidate `referenceMs`, which is stated
for the workload as it is and cannot be re-measured without the reference
machine. The 4.8× reading is mostly real hardware difference, not timer noise.

## When the measurement is sound and the limit is not

`not evaluated` above is for a line the runner cannot measure. There is a second
and quite different situation: the gate measures the line perfectly well, and
the number beside it was written for something narrower than what the line now
covers. Gating either way would be inventing an answer.

A line in that state carries an `unverified` block in
`ci/performance-budget.json` and is reported `UNVERIFIED`: its measurement and
utilisation are printed on every run, and it gates in neither direction.

**No line is in that state today.** `indexParseMsNormalised` was, for the reason
in the section above, and DOG-98 settled the limit and deleted the block — which
is what a declaration is for. It is a terminal state for one issue, not a resting
state for the budget, and `perf-no-line-ships-ungated` is the case that keeps it
that way: it breaks nothing, reads the committed tree's own report, and **fails
if any line ships measured-but-not-gated**. A new `unverified` block is a
five-line diff that reads like paperwork, so adding one has to be a decision
somebody defends here.

That case is a no-op `break` for a reason worth knowing if you extend this file:
**`audit` runs while a staged breakage is still in place**, so a claim about the
*committed* tree cannot be an audit hung off a case that mutates it. An earlier
draft of its predecessor asserted the verdict it had just deleted.

**The machinery stays, and it is not a suppression. Three cases make that true
rather than merely claimed, and all three now construct what they assert over
instead of inheriting it from the committed file:**

- `perf-unverified-declaration-is-load-bearing` drops the limit to 1 ms with **no
  declaration** over the line, and requires **red**.
- `perf-unverified-declaration-suppresses-a-red-line` stages the **same 1 ms
  limit with a declaration**, and requires the gate to **pass** and print
  `UNVERIFIED`. The only difference between the two cases is the block, so
  together they prove it is the block doing the work.

  This pair replaced a single case that deleted the committed declaration. Once
  DOG-98 removed the last declaration from the tree, that break degenerated into
  "set the limit to 1 ms": still red, still passing, and no longer saying anything
  about a declaration — a must-pass case passing for a reason unrelated to its own
  criterion, which is worse than no case because it reads as cover.

  The limit is dropped on purpose rather than using the real 40 ms. Requiring red
  at 40 ms made the colour depend on whether the runner's raw parse happened to
  land above it, which wandered between 38 ms and 66 ms on one machine and made
  the case pass and fail alternately.
- `perf-unverified-needs-a-stated-reason` empties the `reason` and requires the
  gate to **fail naming the line**. Without it, `"unverified": {}` would be a
  one-line way to turn any budget line off with no sentence attached.

So an `unverified` line is louder than it was when it was green, not quieter, it
cannot be added without saying why and how it ends, and it cannot be left behind
once it has ended.

### A budget line cannot be deleted either

The verdict loop walks `budget.budgets`, which made deleting a line the quietest
way to silence it: no row printed, no verdict taken, nothing able to go red,
while the gate went on measuring the cost and exiting 0. The gate now requires
the budget file and the set of things it measures to name **exactly** the same
lines, and fails either way round.

`perf-name-index-absolute-line-cannot-be-deleted` and
`perf-name-index-per-cell-line-cannot-be-deleted` are both cases, separately,
rather than one case about "a line". The per-cell line is the one with a motive:
it is the limit growth cannot consume, so it is the one that reds when the index
gets bigger and the one somebody under deadline would reach for.

### What `--json` promises

The console output is for a human reading a failed build. `perf-measurement.json`
is for whatever reads it later, and it has to survive being read carelessly:

- `measurements[line]` is **`null`** for a line this run could not establish.
  Never a zero, never a pass, and deliberately *not* the bound — these keys are
  named for a normalised figure, so publishing an unnormalised number under
  `indexParseMsNormalised` would make the key a false claim about its own
  contents. `utilisation[line]` is `null` alongside it rather than a ratio
  derived from a number that is not there.
- `verdicts[line]` carries `{ kind, verdict, reported }`. `reported` is the
  figure the verdict was taken from, and `kind` (`exact`, `normalised`,
  `at-least`, `at-most`, `absent`) says what it is. This is where the bound
  lives, with its direction attached. `absent` means this build produced nothing
  to measure — `main` declares no name index at all, so its two DOG-98 lines have
  no subject rather than a cheap one, and that is reported as `not evaluated`
  with its own sentence rather than folded in with an off-band runner. A
  different runner changes one and not the other.
- `calibration.decisionBasis` is `normalised` or `one-sided-bound-from-raw`.
  Anything branching on the report should branch on that.

Byte lines are exact on every runner and are never nulled; nulling them would
be the fallback swallowing what it is supposed to gate.

Four cases in `tools/verify-gates.mjs` pin all of this: that a fast runner alone
does not fail the build, that its JSON report nulls what it did not establish
while keeping the bound and the byte lines, that an off-band parse line still
fails when the unnormalised time alone busts it, and that byte budgets survive a
useless calibration.

[dog29]: https://github.com/whacked/somasurfer/actions/runs/37890971145

## What is not measured yet

The two felt numbers, in a real browser. That needs the viewer and a headless
browser in CI, and neither exists yet.

Specifically, the `renderAllowanceMs` of **600 ms** in
`derivedFirstInteractionMs` — layout, first paint, and the viewer's first GPU
upload — is a placeholder with a stated basis, not an observation. Every
report prints this. To close the gap, the viewer task should add a headless
Chrome step that drives the deployed page and reports
`navigation → click handled` and `navigation → geometry ready` from
`performance.mark()`; `packages/atlas-web/src/app.js` already emits both
marks, and the page reports them in its own "This session" panel.

## Current measurement

Measured on 2026-10-08, build at base `/`, against the committed fixture
(`packages/atlas-assets/geometry/placeholder-body-shell.lowres.json` —
9,600 vertices, 19,072 triangles). Reproduce with:

```
node packages/atlas-web/build.mjs
node tools/perf-budget.mjs --json perf-measurement.json
```

| line | measured | budget | used |
| --- | --- | --- | --- |
| `bundleGzipBytes` | 4.1 KiB | 150.0 KiB | 3% |
| `indexGzipBytes` | 0.8 KiB | 256.0 KiB | 0% |
| `lowResAssetGzipBytes` | 96.2 KiB | 2560.0 KiB | 4% |
| `indexParseMsNormalised` | 0.2 ms | 40 ms | 0% |
| `lowResAssetParseMsNormalised` | 5–29 ms | 400 ms | 1–7% |
| `derivedLowResAssetLoadMs` | **158–183 ms** | 2500 ms | 6–7% |
| `derivedFirstInteractionMs` | **682 ms** | 3500 ms | 19% |

> **Stale as of DOG-80, deliberately not re-measured here.** The
> `indexParseMsNormalised` row above is the 0.2 ms this gate reported when the
> name index was not in that line — it is a measurement of a different line than
> the one that key names today, which is the whole point of DOG-80. The byte
> rows are from a base with no viewer in the bundle and read 3% where an
> integrated build reads 74%, so re-measuring one row of this table against a
> different base would make the table less comparable, not more. Re-measure it
> whole, on one base, and date it; until then read the live gate output, which
> prints the name index's structure and cell count on every run.
>
> **DOG-98's two lines are deliberately absent from this table** for the same
> reason: adding two rows measured on a third base would make it read as one
> measurement when it is three. Their 22-run sample, taken on one base and dated,
> is under "How the two limits were derived" above — 26.3–64.2 ms normalised and
> 21.1–33.4 ms raw, which is also the honest statement of this gate's spread on a
> contended machine.

Byte lines are exact and reproduce identically on every run. Parse lines are
given as the range over three consecutive runs on a contended machine, where
calibration landed between 66 ms and 127 ms against the 120 ms reference. A
6× spread on a line with 40× headroom does not threaten the gate, but it is
the honest number and it is worth stating plainly: if a parse line ever comes
within about 4× of its budget, this gate needs more samples per run before it
can be trusted to distinguish a regression from a noisy runner.

A GitHub runner has since read as low as 25 ms on the same workload, a 4.8×
speed factor, which is outside the band and reports the parse lines as bounds
rather than as normalised values. See "When the runner is too far from the
reference" above for what the table means on a run like that.

Read the whole table as headroom, not as an achievement. 600 of the 682 ms is
the render allowance placeholder, and the fixture is an analytic shell at
1/26th of the asset budget. The real mesh and the real viewer will consume
most of the remaining room, which is the point of writing the budget down
before either arrives: when the number moves, it will be obvious which line
moved it.

## Changing a budget

Edit `ci/performance-budget.json` and this document in the same commit, and
say in the commit message what changed about the product that justified it.
Raising a budget to make CI green is the failure this file exists to make
visible.
