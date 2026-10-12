# W8a — pre-release acceptance on the merged candidate (DOG-133)

**Declared SHA:** `7aea295a0b9cdabb2db0e4966ac0ff17b3c91fc0`. This is DOG-186's C: W7 `bfa6989` (#21) plus W5b `64a13bc` (#18), approved by the CTO on DOG-190 and published as PR #22.
**Thresholds:** fixed by the plan (§6) and the DOG-123 17:02 hand-off. The brain-picking rule is the CTO's, accepted on DOG-143 at 21:05.
**Fixture:** `packages/atlas-qa/fixtures/brain-structure-sample.json`, byte-identical at C to W2's `366e782`.

## Verdict: FAIL (2 of the 12 rows below fail)

| row | result at C | evidence |
|---|---|---|
| Both atlases one click from the landing page and from each other | **pass**: landing→brain, landing→body, brain→body, body→brain, one click each | `browser-rows.json` `nav` |
| Brain picking, 40 structures | **FAIL: 36/40** pick back to their own key and `expect.name` (21 distinct structures). Category floor min(2, ships): `cortex` 0/2, `brainstem` 2/4. See DOG-192 | `browser-rows.json` `picking` |
| Withheld controls must not render or pick | **pass: 1/1**. Anterior commissure (id 15) is not drawn and not pickable | `picking-controls` |
| Withheld controls: the page says why | **FAIL: 0/1**. Searching the name shows nothing, and `excluded[].heldBecause` is never read. See DOG-193 | `picking-controls-say-why` |
| The body renders a full human | **pass**: 1,605 BodyParts3D structures (full tier), skin, head to foot; 27,297 px against an all-hidden view | `browser-rows.json` `body`, `shots/body-default.png` |
| Paper→regions: non-empty or a stated reason | **pass: 30/30**. 29 have regions, and 1 is empty with the API's `emptyBecause` | `paper-regions.json` |
| Coverage against the 31/170 baseline | **109/170 mappings, 29/30 papers**. The v1 baseline was 31/170 and 10/30 | `npm-run-ci.txt` (`✓ crosswalk`) |
| Region→papers round-trips for every linked structure | **pass**: 53 drawn linked structures, 0 mismatches in either direction | `region-papers.json` |
| API responses validate and equal the library | **pass**: 120/120 served files pass `validateApiDocument`. The contract check ran 123 queries: 120 equal the library, 3 are absent on both sides, every link returns 200, every file is reached, and the self-test is red | `api-validate.json`, `npm-run-ci.txt` |
| Licence gates red on staged leaks | **pass**: BY-SA→bundle ×6 and NC→default ×3 are caught, and the segregated-NC control is let through. The full suite caught 72/72 breakages and let 18/18 non-defects through | `npm-run-ci.txt` |
| Perf | **pass**: first brain frame 1,290 / 3,500 ms modelled; low-res tiers 2,381.7 / 2,560 KiB; full-res brain 5,184.7 / 5,376 KiB (committed literal, unchanged) | `npm-run-ci.txt` |
| v1 deep links restore | **pass**: 35/35 matrix rows at state level, including `brain-deep-link-restores` and `cross-atlas-link-honours-the-explicit-atlas`, and 34/34 URL rows in Chromium with round-trips | `journey-state.json`, `deeplinks/deeplinks-dom.json` |

`npm run ci` at C exited 0 on a clean checkout.

## Failures

**1. Four sample structures cannot be picked (W4 → DOG-192).** In each case, clicks on the structure's own pixels, from 6 camera views, pick something else:
- **ids 6 and 7, the accessory nucleus of the oculomotor nerve (left and right):** sits inside the midbrain, in the same `brainstem` layer.
- **ids 122 and 123, the hippocampus (left and right):** sits inside the ICBM152 lobe surfaces, in the same `cortex` layer.

The repro coordinates are in DOG-192.

**2. A withheld structure is not explained (W4 → DOG-193).** The must-not-pick half passes; the "should say why" half does not.

## Pre-existing, not a v2 regression

`journey/paper-reveals-all-its-regions`: Fischl 2012's findings are not marked region-level only. It fails identically on `origin/main` `e560eb8` and on every v2 PR tip, and v1's committed `qa-evidence/state-curated-fixture.json` already records it. It is not one of the W8a rows.

## Observations (not §6 failures)

- **Whole-organ regions are named but never drawn.** Heart (`FMA7088`), liver (`FMA7197`), both lungs (`FMA7309`, `FMA7310`) and spinal cord (`FMA7647`) have region documents with papers. The body draws those organs only as BodyParts3D parts, such as "Wall of ventricle" (`FMA13884`). So no drawn structure carries those region keys. Paper→regions names them; region→papers is unreachable by clicking the heart. That is a W5/W7 question: should a part inherit its whole's papers?
- **The perf row's 600 ms render allowance is a stated placeholder**, per `perf-budget`'s own NOT MEASURED line. The row is "modelled", as the threshold says.
- **The fixture's `drawnFrom` is stale.** It records 248 structures and 189 excluded; the build ships 244 and 193. None of the 40 is affected.
- **Body render:** grey and red patches show through the skin on the legs in `shots/body-default.png`, which looks like z-fighting of the anatomy beneath. This is cosmetic.

## How this was run

- **Drivers.** The browser rows come from `packages/atlas-qa/browser/w8a-acceptance-dom.mjs` (Chromium 1248 headless shell, SwiftShader, 1400×900, canvas pinned at 700 px, a dist server on a free port). The deep links come from `deeplinks-dom.mjs` on a verified free port, and the state matrix from `qa-journey --build drivers/integrated-state.mjs --strict`. The API row also uses `packages/atlas-qa/w8a/api-validate.mjs`.
- **What was served.** The page came from a build of the branch C + the W8a drivers. That `dist/` is byte-identical to a build of a clean C checkout: the content hash `f05d1ecb52416974` matches and so does `build-manifest.json`.
- **How a pick is judged.** Only the entry's category is isolated, and the other hemisphere is hidden. The entry's own pixels are the difference between the view with and without it selected. Each click goes through `__atlas.pickAt` (the page's `pick()`). A pick passes only on the entry's own key, with `expect.name` in the panel. Seventeen left/right pairs share a name, which is why the key is checked.
