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

Three cases in `tools/verify-gates.mjs` pin all of this: that a fast runner
alone does not fail the build, that an off-band parse line still fails when the
unnormalised time alone busts it, and that byte budgets survive a useless
calibration.

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

## Changing a budget

Edit `ci/performance-budget.json` and this document in the same commit, and
say in the commit message what changed about the product that justified it.
Raising a budget to make CI green is the failure this file exists to make
visible.
