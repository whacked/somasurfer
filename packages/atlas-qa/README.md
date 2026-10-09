# `@gstack/atlas-qa` — the §7 journey and the deep-link matrix

The QA harness for plan task 7, **authored before the viewer exists**.

Plan §7 puts two rows on QA that need a viewer — "viewer journeys" and "deep
links" — and the deep-link half is the one that rots if it is written late.
Every case in it is a failure or degradation case, and the natural way to write
those against a finished build is to try things until something breaks. That
produces a suite shaped like the bugs that happened to be present on the day.
Authored from DOG-1 §7 and plan §6 first, the suite is shaped like the
requirement, and the build has to come to it.

```
npm run qa:journey              # run the journey + matrix, print the report
npm run qa:journey -- --strict  # a must-pass case that cannot be evaluated FAILS
npm run qa:negative-control     # the thirteen broken builds, and what catches each
npm test --workspace @gstack/atlas-qa    # the 56 gates that work with no viewer
```

Today `qa:journey` exits **2** — `UNVERIFIED`. There is no product build to
point it at, so it runs against the reference stand-in and says so.

---

## The one rule

**`unverified` never becomes `pass`.**

Three outcomes, not two. A case passes, fails, or could not be evaluated, and
the third is a first-class result:

| situation | outcome |
| --- | --- |
| the build lacks a capability the case needs | `unverified` |
| the fixture cannot pose the question | `unverified` |
| a step this one depends on failed | `unverified` (blocked, not a second failure) |
| the case declared itself and produced no result | **suite FAILS** |
| the case threw | `fail` — an exception is evidence, not an absence of it |

A must-pass case that is `unverified` fails the suite under `--strict`, and in
every mode prevents a `PASS`. There is no configuration in which an unevaluated
must-pass case reports a pass; `test/unverified.test.ts` asserts that across
both modes, because "never" is the claim.

### Two verdicts, because "the harness is green" and "§7 is verified" differ

`harnessVerdict` says whether the suite is self-consistent and whether the build
it was pointed at satisfied it. `productVerdict` says whether that build was the
*product*. A green run against the stand-in is `harnessVerdict: PASS,
productVerdict: UNVERIFIED` — the harness works, and §7 is not verified.
Collapsing those into one word is how a suite that has never seen the real build
comes to be cited as evidence that the real build works.

Exit codes: **0** product pass · **1** failure · **2** could not measure.

---

## For the Web/3D Engineer (DOG-36): what makes a build testable

Implement `ViewerDriver` from [`src/contract.ts`](src/contract.ts) — about twenty
methods over a `ViewState` that is **everything a human sitting in front of the
page can see**. Expected shape: a thin adapter over a `window.__atlasQa` test
surface reading the same state the UI renders from. Not a parallel model — a
parallel model is a second implementation that can agree with the suite while
the screen disagrees with both.

Then:

```js
// qa-driver.mjs
export default async ({ fixture }) => new MyViewerDriver({ fixture });
```
```
npm run qa:journey -- --build ./qa-driver.mjs --strict
```

Three things worth knowing before you start:

**Messages are codes, not prose.** `MESSAGE_CODES` is a closed set. "Which
message appears" is an acceptance criterion, and asserting it against English
fails on a copy edit and passes on a wrong message with the right words in it.
Prose is asserted only where the prose *is* the behaviour — `C08`, where naming
the correction is the requirement.

**`capabilities()` is how you say what you cannot do yet.** A case whose
requirement is missing reports `unverified`, never `pass`. Please use it rather
than no-opping an action: a build that silently returns an unchanged state sails
through an assertion that was only ever checking nothing blew up.

**Three QA seams, as URL parameters.** Declared rather than discovered, because
the alternative is QA reaching into your internals. Each exists because a
required behaviour is otherwise unreachable from outside:

| parameter | why |
| --- | --- |
| `qa_template=fold-fixture` | `folded` needs a folding template |
| `qa_template=no-brain` | `no_template` needs a missing template |
| `qa_assets=fail` | asset-load failure needs a failing load |

The templates are published as code in [`src/templates.ts`](src/templates.ts) —
import the same function, or the matrix asserts against one geometry while your
screen shows another.

---

## Decisions this matrix pins

Writing an executable matrix forces decisions the plan left open. Leaving them
implicit would smuggle them into the product, so each is stated here. **Disagree
with any of them now** — that is much cheaper than discovering it during task 7.

1. **A replayed clamped address does not re-announce the clamp.** The clamp was a
   fact about the original *point*, not about the address. Showing the notice
   again would tell a user their perfectly good address is out of bounds.
   (`clamped-address-replayed-is-not-a-clamp`)

2. **With no geometry loaded, nothing is drawn and the camera does not move** —
   but the address still resolves and the names are still shown. Plan §6 states
   the resolution half and says nothing about the camera; presenting an empty
   viewport as a located result would claim more than the build can deliver.
   (`assets-unavailable-addresses-still-resolve`)

3. **A `BV` address in the URL enters the brain atlas directly.** That is not the
   automatic navigation DOG-1 §2 forbids — the user named a brain cell in the
   address. Selection *inside* an atlas still never navigates.

4. **An over-precise address is left intact in the URL and drawn at the
   template's limit.** Not silently truncated: the user's address is not wrong,
   only finer than this template can answer.

5. **A refusal with no resolvable ancestor still offers a route forward.** For a
   `BR` address or a missing template, nothing in the address's own frame
   resolves, so the message names the enabled frame to use instead and says
   plainly that no ancestor resolves. A dead end with an apology is what plan §4
   is avoiding.

6. **The body atlas's brain is addressed at `BD-C01`.** The `BD` frame is
   anchored to the vertebral column and cannot address above `C01` at all, so
   "the brain, seen from the body atlas" is the top cervical cells. A real
   limitation of the frame rather than of the fixture — flagged for task 4.

---

## Why some things are derived and others pinned

Every expectation was **measured** against `@gstack/alc` before being written
down, and `oracle` claims record what was measured so
[`test/oracle.test.ts`](test/oracle.test.ts) can re-derive them on every run. A
library or template change then reports the matrix as *stale* rather than letting
it quietly assert history.

But not everything should be a literal. `flags.overPrecise` is raised relative to
**the bound template's** `maxUsefulDigits`; nothing clamps to an absolute
precision. The synthetic stage-A template justifies 5 digits, the real decimated
BodyParts3D one declares 2. A row pinning the boundary at 5 inverts the moment
the real asset is bound — and silently, because an over-precise address takes the
truncating display path and then no longer matches the address in the URL.

So the rule is: **behaviour is pinned, arithmetic the template owns is derived.**
Which message appears, what the camera does, what does not change — all literal.
Digit counts and encoded addresses — derived from the bound template. `maxUsefulDigits`
is a measured property of the mesh that will legitimately rise when the mesh gets
finer, and a test that hard-pins it goes red on a *correct* improvement to the
asset. A false red in a suite carrying thirteen deliberate failures is worse than
a missing case: it teaches everyone to discount the colour.

The fold address stays literal, with its reason in the code: it has to be an
address whose cell *centre* lands in the fold, which came out of running
`scanBodyTemplateFolds()` and walking the reported sites. The oracle test guards
it in both directions instead.

---

## The negative control

A harness nobody has watched fail is decoration. `src/mutants.ts` holds thirteen
builds, each breaking exactly **one** guarantee, each declaring which case must
notice — and `caughtBy` is asserted, so a mutant failing for an unrelated reason
does not count. The unmutated control passes 40/40 in the same run, which is what
makes a mutant's failure attributable to its mutation rather than to ambient
breakage.

The thirteenth breaks nothing about the viewer at all. It declines a capability a
must-pass row needs — the shape a false green actually takes: no error, no red,
and the case simply did not run. **If that one ever passes, the other twelve are
worthless**, because any of them could be skipped the same way.

Running it caught two of this suite's own assertions being *vacuous*: "a ranked
name list, never one name" was untestable against a fixture where every cell had
exactly one owner, and the view-restore step passed against a build that restored
nothing because nothing had touched the body view while the brain atlas was open.
Both are fixed, and both were invisible without the mutants.

`UNMUTATED_CLASSES` lists the case classes with no mutant, each with the reason —
the same reviewed-exception scheme the address-equality guard uses. One entry is
an admitted gap rather than an argument: `assets-unavailable` needs a build that
reports assets fine while failing to load them, which cannot be expressed without
a second asset path. Close it against the real build in task 7.

---

## The fixture

Prefers DOG-37's curated dataset at `packages/atlas-research/fixtures/` the moment
it is there, and falls back to [`fixtures/journey-5papers.json`](fixtures/journey-5papers.json)
otherwise. Whichever it used goes in the report **with its sha256**, because a §7
result against an unnamed fixture is not reproducible.

The harness's own fixture is not deleted now the real one has landed: a suite
whose only input is another team's in-progress deliverable cannot be run while
that deliverable is broken, and the self-tests use `--own-fixture` so they keep
asserting against a known input.

`FIXTURE_REQUIREMENTS` checks a fixture can actually *pose* each question — two
papers sharing a region, a paper reaching outside one region, a finding with no
spatial detail, a cell claimed by more than one structure. A fixture missing one
makes the affected step `unverified`, **not** `pass`. That distinction is the
whole file: "the build got this wrong" and "nothing here could have tested it"
must never print the same.

---

## Layout

| file | what |
| --- | --- |
| `src/contract.ts` | the `ViewerDriver` and `ViewState` a build must expose |
| `src/matrix.ts` | 32 enumerated deep-link rows, 30 must-pass |
| `src/journey.ts` | the eight DOG-1 §7 clauses as ordered, dependency-aware steps |
| `src/runner.ts` | the pass/fail/unverified algebra and the report |
| `src/referenceViewer.ts` | the conformant stand-in that makes the suite executable |
| `src/mutants.ts` | thirteen broken builds and what must catch each |
| `src/templates.ts` | the templates harness and build must agree on |
| `src/fixture.ts` | fixture loading, pinning, and the curated-schema adapter |
| `test/` | the 56 gates that work with no viewer in existence |
| `bin/qa-journey.mjs` | the CLI task 7 executes |

## What is *not* here

Executing the matrix against the integrated build. That is task 7
([DOG-39](/DOG/issues/DOG-39)), it is blocked on tasks 5 and 6, and it is where
defects get filed.
