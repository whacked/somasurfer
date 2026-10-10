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
| `indexGzipBytes` | 256 KiB | `data/*.json`, gzipped |
| `lowResAssetGzipBytes` | 2.5 MiB | `dist/assets/**`, gzipped, less LICENSE and ATTRIBUTION.md |
| `indexParseMsNormalised` | 40 ms | parse the indexes and build the lookup maps |
| `lowResAssetParseMsNormalised` | 400 ms | parse the low-resolution asset payloads |

2.5 MiB at 25 Mbit/s is about 0.84 s of transfer, which fits the 2.5 s budget
with room for parse. It is also roughly where a 20k-triangle body shell plus
label sets lands, so it constrains the asset pipeline without being
unachievable.

## Headroom, and why a green line can still be news

A line at 98% of its limit passes. It is also one small module away from
failing, and until DOG-83 the gate printed those two states identically: a
budget was met or it was busted, and the room left over was not reported at
all.

Any line at or above `headroom.warnAtFraction` of its limit — **0.9** — is now
reported as `TIGHT` on a run that still passes:

```
bundleGzipBytes                    146.5 KiB /    150.0 KiB    98%  TIGHT

TIGHT — within 10% of the limit, passing but nearly full:
  bundleGzipBytes: 98% of 150.0 KiB, 3.5 KiB left
    covers: index.html + app/*.js + app/*.css, gzipped
```

**This is not a second budget.** It changes no verdict, it changes no exit
status, and it cannot fail a build. It exists so the cost of filling a budget
lands on the change that fills it rather than on the next person to touch the
page, who would otherwise meet the line as a red build for a change that was
not the one that spent the room.

One line is deliberately exempt. On a runner too slow to normalise, a
calibrated line is an **upper** bound — "at most 95% of the limit" is equally
consistent with 5% — so `at-most` figures are never reported as tight however
high their utilisation reads. Calling one of them nearly full would be
manufacturing a shortage out of slow hardware and sending someone to trim a
budget that was never under pressure. `exact` and `normalised` figures are the
occupancy and settle it; `at-least` is a lower bound on it, so a tight reading
there can only understate how full the line is and is sound to report.

Raising `warnAtFraction` to quiet a warning achieves nothing — it hides the
notice and leaves the shortage. Raising a **limit** to make a change fit is the
thing that must not happen; see "Changing a budget" below.

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
  `at-least`, `at-most`) says what it is. This is where the bound lives, with
  its direction attached.
- `calibration.decisionBasis` is `normalised` or `one-sided-bound-from-raw`.
  Anything branching on the report should branch on that.
- `headroom` is `{ warnAtFraction, tight }`, where `tight` lists the lines that
  passed with less than `1 - warnAtFraction` of their limit to spare. Advisory
  by construction: a consumer deciding whether the build is acceptable reads
  `verdicts`, and will find nothing in `headroom` that contradicts it. A line
  known only as an upper bound is never listed, however high its `utilisation`.

Byte lines are exact on every runner and are never nulled; nulling them would
be the fallback swallowing what it is supposed to gate.

Four cases in `tools/verify-gates.mjs` pin all of this: that a fast runner alone
does not fail the build, that its JSON report nulls what it did not establish
while keeping the bound and the byte lines, that an off-band parse line still
fails when the unnormalised time alone busts it, and that byte budgets survive a
useless calibration.

Two more pin the headroom reporting, and both are must-pass cases: a line staged
at 95% of its limit is reported as `TIGHT` while the gate still exits 0, and a
line known only as an upper bound is not, even at the same 95%. Each stages its
limit from what the build actually measures — the bundle is 4 KiB on `main` and
146 KiB with the viewer merged, so a written-down size would test a different
thing on each branch and nothing at all on one of them. A warning is the kind of
output that can stop appearing without anything going red, so the only thing
that would notice is a case asserting it is still there.

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

### The table above is `main`, and `main` has no viewer

Those numbers are what this branch builds, and they are why a 3% bundle line
appears in a document about a budget under pressure. With the viewer and the
research layer merged, the same line reads **146.5 KiB of 150.0 KiB, 98%**
(measured on `dog-78-research-curated-corpus` at `5c7f801`, `gzip -9`, DOG-83).
The felt line is not under pressure at all on that build:
`derivedFirstInteractionMs` is 741 ms of 3500 ms, 21%. Bytes are the binding
constraint, not time.

What fills the line is library code, not the renderer. `app/alc.js` (54,156 B)
and `app/atlas-research.js` (24,113 B) are 78 KB of the 150 KiB between them,
over half the limit; the hand-written WebGL2 renderer is 5,854 B, 3.9%. DOG-41
had argued the *shape* of this line was wrong because a 126 KiB three.js build
did not belong on it — that argument did not survive the renderer shipping
without three.js. The line is measuring what it was written to measure: "the
point at which a 25 Mbit/s link spends more time on our own code than on a
round trip".

**The limit does not move.** 98% is an honest reading of a line doing its
stated job, and there is no change in the product that would justify restating
it — which is the only thing that justifies restating one.

The room comes back from the bundle instead. `dist/app/atlas-research.js` is
all of `src/index.ts`, 6 modules and 24 exports, and the page imports three
functions from it at one site: `loadDataset`, `buildResearchIndex` and
`formatCitation` in `packages/atlas-web/src/viewer/corpus.js`. `browse.ts` and
`layers.ts` are unreachable from those three and nothing in the viewer imports
either. Bundling an entry module that exports only those three measures:

| | raw | gzip -9 |
| --- | --- | --- |
| `dist/app/atlas-research.js`, all 24 exports | 91,182 B | 24,012 B |
| the same, three exports | 54,741 B | 14,828 B |

**9,184 B of gzip, which takes the line from 98% to 92%** and the headroom from
3.6 KB to 12.5 KB — about 3.5× — measured end to end through this gate, not
estimated. The trimmed bundle was imported from `dist/app/` as emitted and
resolves 28 of 170 mappings against the real name index with no templates
passed, which is the figure `corpus.js` documents for that call. It is tracked
in DOG-84; `packages/atlas-research/scripts/build.mjs` already walks module
reachability from its entry, so what it needs is a second entry module and a
restatement of the export-name parity check, not a bundler.

## Changing a budget

Edit `ci/performance-budget.json` and this document in the same commit, and
say in the commit message what changed about the product that justified it.
Raising a budget to make CI green is the failure this file exists to make
visible.

"To make CI green" includes making it *stay* green. A limit raised while a line
reads `TIGHT`, by whoever is trying to land the change that would have busted
it, is the same failure arriving a commit earlier.
