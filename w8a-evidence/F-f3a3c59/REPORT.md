# W8a — pre-release acceptance on the merged candidate (DOG-133)

**Declared SHA:** `f3a3c59c69b052bbe89e99c708d72c41b8000a3d` (PR #24, approved on DOG-197). It contains:
- DOG-186's C `7aea295` (W7 `bfa6989` + W5b `64a13bc`, PR #22);
- DOG-192's pick-again fix, `499ca5b` + `f3a3c59`;
- DOG-193's withheld-structure search, `fa092cd`, PR #23.

**This verdict holds for that SHA only.** Any later commit, including DOG-197's optional `setCamera` nit, needs a rerun.

**Thresholds:** fixed by the plan (§6) and the DOG-123 17:02 hand-off. The brain-picking rule is the CTO's, accepted on DOG-143 at 21:05.
**Fixture:** `packages/atlas-qa/fixtures/brain-structure-sample.json`, byte-identical here to W2's `366e782`.
**Previous run:** at C `7aea295` this matrix failed 2 rows (`../C-7aea295/REPORT.md`). Both went to W4 as DOG-192 and DOG-193, and both are fixed in this SHA.

## Verdict: PASS (all 12 rows)

| row | result | evidence |
|---|---|---|
| Both atlases one click from the landing page and from each other | **pass**: landing→brain, landing→body, brain→body, body→brain, one click each | `browser-rows.json` `nav` |
| Brain picking, 40 structures | **pass: 40/40** pick back to their own key and `expect.name` (23 distinct structures). Every category meets min(2, ships); `white_matter` ships 1 and has 1. Every pick is confirmed by real, jittery mouse taps | `browser-rows.json` `picking` |
| Withheld controls must not render or pick | **pass: 1/1**. Anterior commissure (id 15) is not drawn and not pickable | `picking-controls` |
| Withheld controls: the page says why | **pass: 1/1**. Searching the name shows "Anterior commissure is held back and not drawn: carries undeclared material(s) `White matter` (zanatomy-undeclared-brain-materials)." | `picking-controls-say-why` |
| The body renders a full human | **pass**: 1,605 BodyParts3D structures (full tier), skin, head to foot; 27,297 px against an all-hidden view | `browser-rows.json` `body`, `shots/body-default.png` |
| Paper→regions: non-empty or a stated reason | **pass: 30/30**. 29 have regions, and 1 is empty with the API's `emptyBecause` | `paper-regions.json` |
| Coverage against the 31/170 baseline | **109/170 mappings, 29/30 papers**. The v1 baseline was 31/170 and 10/30 | `npm-run-ci.txt` (`✓ crosswalk`) |
| Region→papers round-trips for every linked structure | **pass**: 53 drawn linked structures, 0 mismatches in either direction | `region-papers.json` |
| API responses validate and equal the library | **pass**: 120/120 served files pass `validateApiDocument`. The contract check ran 123 queries: 120 equal the library, 3 are absent on both sides, 120 links return 200, every file is reached, and the self-test is red | `api-validate.json`, `npm-run-ci.txt` |
| Licence gates red on staged leaks | **pass**: BY-SA→bundle ×6 and NC→default ×3 are caught, and the segregated-NC control is let through. The full suite caught 72/72 breakages and let 18/18 non-defects through | `npm-run-ci.txt` |
| Perf | **pass**: first brain frame 1,416 / 3,500 ms modelled; low-res tiers 2,381.7 / 2,560 KiB; full-res brain 5,184.7 / 5,376 KiB (committed literal, unchanged) | `npm-run-ci.txt` |
| v1 deep links restore | **pass**: 35/35 matrix rows at state level, including `brain-deep-link-restores` and `cross-atlas-link-honours-the-explicit-atlas`, and 34/34 URL rows in Chromium with round-trips | `journey-state.json`, `deeplinks/deeplinks-dom.json` |

`npm run ci` on a clean checkout of this SHA exits 0, run alone on the machine. Two earlier attempts went red, and neither run is counted:
- one in `test count`, from the alc linear-normalisation timing test under load. That test passes alone, and nothing touches `packages/alc`;
- one in verify-gates, from a collision with a stray earlier CI run in the same worktree.

## How picking passed

**30 of the 40** are picked by the first click on their own pixels.

**10 need the same spot clicked again** (DOG-192's rule: same spot, camera still, the next structure behind):

| fixture id | structure | clicks |
|---|---|---|
| 6 | Accessory nucleus of oculomotor nerve.l | 2 |
| 7 | Accessory nucleus of oculomotor nerve.r | 2, from the yaw+180 view |
| 122 | Hippocampus.l | 2 |
| 123 | Hippocampus.r | 2 |
| 221 | Nucleus accumbens.r | 2 |
| 421 | Ventral anterior nucleus.l | 2 |
| 422 | Ventral anterior nucleus.r | 2 |
| 414 | Tuberal hypothalamus.l | 2 |
| 398 | Tonsil of cerebellum.r | 3 |
| 394 | Tentorium cerebelli.l | 2 |

The last six of those are visible elsewhere. The driver stops at the first pixel where a pick succeeds, so the count describes that pixel, not the structure.

**The required nuclei:** STN, SN and NAcc on both sides all pass; all except NAcc.r on the first click.

## Pre-existing, not a v2 regression

`journey/paper-reveals-all-its-regions`: Fischl 2012's findings are not marked region-level only. It fails identically on `origin/main` `e560eb8` and on every v2 tip, and v1's committed `qa-evidence/state-curated-fixture.json` already records it. It is not one of the W8a rows.

## Observations (not §6 failures)

- **Whole-organ regions are named but never drawn.** Heart (`FMA7088`), liver (`FMA7197`), both lungs (`FMA7309`, `FMA7310`) and spinal cord (`FMA7647`) have region documents with papers. The body draws those organs only as BodyParts3D parts, such as "Wall of ventricle" (`FMA13884`). So clicking the heart never shows the heart's papers. Should a part inherit its whole's papers? That is for W5/W7 to decide.
- **`bundleGzipBytes` is 149.8 / 150.0 KiB.** It is within budget, but there is no room left for the next viewer change. DOG-197 flagged the same thing.
- **The perf row's 600 ms render allowance is a stated placeholder**, per `perf-budget`'s own NOT MEASURED line. The row is "modelled", as the threshold says.
- **The fixture's `drawnFrom` is stale.** It records 248 structures and 189 excluded; the build ships 244 and 193. None of the 40 is affected.
- **Body render:** grey and red patches show through the skin on the legs (`shots/body-default.png`). It looks like z-fighting, and it is cosmetic.

## How this was run

- **Drivers.** The browser rows come from `packages/atlas-qa/browser/w8a-acceptance-dom.mjs` (Chromium 1248 headless shell, SwiftShader, 1400×900, canvas pinned at 700 px, a dist server on a free port). The deep links come from `deeplinks-dom.mjs` on a verified free port, and the state matrix from `qa-journey --build drivers/integrated-state.mjs --strict`. The API row also uses `packages/atlas-qa/w8a/api-validate.mjs`.
- **What was served.** The page came from a build of this SHA + the W8a drivers. Its `dist/` is byte-identical to a build of a clean checkout of the SHA: the hash of every file, `build-manifest.json` included, is `62d0663d52aa04c6`.
- **How a pick is judged:**
  1. Only the entry's category is isolated, and the other hemisphere is hidden.
  2. The entry's own pixels are the difference between the view with and without it selected.
  3. The driver clicks those pixels through `__atlas.pickAt`, again on the same pixel if needed, from up to 6 camera views reached by real pointer drags.
  4. The pick found that way is repeated with real mouse taps (down, a 2,1 px wobble, up), because `pickAt` skips `wireCanvas`.
  5. It passes only if the taps select the entry's own key and the panel names `expect.name`.

  Seventeen left/right pairs share a name, which is why the key is checked.
