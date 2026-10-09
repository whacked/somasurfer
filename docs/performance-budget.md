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
reported, and the scaled number is only printed when the factor is within
`[0.25, 4]` of the reference — beyond that the correction would be doing more
work than the measurement.

**Outside that window the gate still returns a verdict, one-sidedly.** It used
to refuse and exit non-zero, and that was wrong: on 2026-10-09 a hosted runner
measured 4.75× — just past the edge — and reded `main` on a tree byte-identical
to one that had passed twice on the same workflow. A gate whose colour depends
on which runner you draw trains people to re-run gates, which is the same
disease as a gate that never fails.

The fix uses the one thing that stays reliable when the magnitude does not: the
*direction*. A machine that runs the calibration in 25 ms against a 120 ms
reference is certainly faster, whatever the exact ratio. So

| runner vs reference | raw number is | it can prove | it cannot prove |
| --- | --- | --- | --- |
| faster (factor > 1) | a **lower** bound on the reference number | over budget | under budget |
| slower (factor < 1) | an **upper** bound | under budget | over budget |

The provable half decides the build. The other half is printed as
`UNVERIFIED`, counted, and explicitly **not** treated as a pass — a consumer
reading `perf-measurement.json` gets `null` for those lines and a
`calibration.decisionBasis` of `one-sided-bound-from-raw`, so a null can never
be mistaken for a zero. Byte budgets are machine-independent and always decide,
on any runner.

**What this costs, stated rather than implied.** GitHub's hosted runners
measure 4.75–5.55× the reference machine on this calibration — both numbers
observed on 2026-10-09, in the run that reded `main` and in the run that fixed
it. So in practice **every CI run reports the four parse-dependent lines as
`UNVERIFIED`**, and the only lines CI actually decides are the three byte
budgets. That is a real loss of coverage and it is not papered over: the
one-sided bound on a 5.5× machine only catches a parse regression large enough
to breach the budget *before* correction, i.e. about 5.5× worse than the
budget, so it is a gross-regression tripwire rather than a budget check.

The honest options from here, in preference order: measure the two felt numbers
in a headless browser on the deployed page, which replaces the derived lines
with observations and makes the scalar irrelevant (this is the viewer task's
step, and `app.js` already emits the marks); or re-base
`calibration.referenceMs` on hardware someone has actually measured, so a
hosted runner falls inside the window honestly. Widening `maxSpeedFactor`
until the runner fits is the one thing not to do — it would restore a number
whose correction is doing more work than the measurement, which is how the
gate got here.

Both halves are demonstrated in CI by `tools/verify-gates.mjs`:
`perf-gate-survives-a-fast-runner` asserts a fast runner inside budget does
**not** go red, and `perf-budget-over-before-correction` asserts a line already
over budget raw still fails. The first is the only case in that file that
asserts a gate must pass, because the failure it guards against is a false red
rather than a false green.

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
