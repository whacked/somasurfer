# Drivers

A `--build` driver for `qa-journey`, so the §7 matrix runs against the product
instead of the reference stand-in.

## `integrated-state.mjs`

Puts the **product's own** `viewer/*` modules under the matrix — `select.js`,
`state.js`, `research.js`, `deeplink.js`, `camera.js` — rather than
re-implementing their behaviour. What it does not touch is `app.js`: there is no
browser in this runner, so the panel, the research list and the highlight draw
path are not executed. `buildId` says so, and the runner prints it next to every
verdict.

It binds data from the same world as the template the matrix asks for:

| `?qa_template=` | templates | name index | research |
| --- | --- | --- | --- |
| `body`, `fold-fixture`, `brain`, `no-brain` | harness fixture | fixture structures | fixture papers |
| *(driver default)* `real-assets` | shipped `atlas-assets` payloads | real 57-structure index | the dataset **the page serves** |

The split matters. The behaviour rows need templates that *produce* the findings
under test, and the real body template produces none of fold, variant or clamp —
it is admissible, it does not fold, and it realises every level it claims. The
real-asset binding is for the rows that are about those payloads.

`labels` is withheld from `capabilities()`: there is no label state in
`state.js`, none in `ATLAS_LAYERS`, and `encodeView` has no parameter for it.
Withholding it makes the label rows report `unverified`; no-opping `setLabels`
would have let them pass unexamined.

    node packages/atlas-qa/bin/qa-journey.mjs \
      --build packages/atlas-qa/drivers/integrated-state.mjs --strict --own-fixture
