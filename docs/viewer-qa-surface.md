# The viewer's QA surface

What an integrated-QA harness may drive, read and assert against. Everything
here is a deliberate, supported contract; anything not here is an
implementation detail and may move without notice.

Two rules shape it:

- **Nothing in the shell reads `window.__atlas`.** It cannot drift into being a
  second code path, because no product behaviour depends on it.
- **Assert against this surface, not against rendered text.** Scraping prose
  for a conclusion produces false passes — a panel that says "no structure
  overlaps this cell" and a panel that says "this frame ships without names"
  are different verdicts, and only the codes below tell them apart reliably.

## Bound data

The default build binds the asset pipeline's real templates and the real name
index. The synthetic templates still ship, and are bindable.

| Thing | Value in the default build |
| --- | --- |
| Body template | `bp3d-4.0-adult-body-centroid`, `maxUsefulDigits` **2** |
| Brain volume template | `icbm152-2009c-asym`, `maxUsefulDigits` **6** |
| Name index | 57 FMA structures, 3 478 cells, frame `BD` only |
| Name index version | `bp3d-4.0+uberon-…` — read it, never hard-code it |
| Research corpus | the 5-paper fixture (`fixture-research/0.1-5-papers`) |

`maxUsefulDigits` is **not** in the catalogue. It is read off the bound
template, which is the only reading that can be right; a harness asserting a
precision limit must read `__atlas.maxUsefulDigits(atlas)` rather than state a
number.

## `window.__atlas`

Set once, after boot. `ready: true` is the signal that boot finished; poll for
it rather than for a timeout.

### Stage A, unchanged

| Member | Returns |
| --- | --- |
| `ready` | `true` once boot has completed |
| `viewer` | the state machine (`viewer/state.js`) |
| `selection` | the last selection model, or `null` |
| `select(address, {fly, push})` | selects; returns the selection model |
| `openAtlas('body'\|'brain')` | the explicit cross-atlas move |
| `returnToPrevious()` | restores the view that was left |
| `resetCamera()` | refits the camera to the bound subject |
| `view()` / `href()` | the current view, and its deep link |
| `encodeView` / `parse` | the deep-link encoder and `@gstack/alc`'s `parse` |
| `templateIds()` | every id in the catalogue |
| `boundTemplateId(atlas)` | the id actually bound |
| `maxUsefulDigits(atlas)` | the bound template's own cap |
| `nameIndexVersion` | the bound index's version string |
| `rendererAvailable()` | `false` when the 3D view degraded |
| `atlasAvailable(atlas)` | `false` when that atlas's geometry failed |
| `research()` | the loaded research model, or `null` |

### Stage B additions

| Member | Returns |
| --- | --- |
| `nameIndexSourceTemplate` | the template `coverings.json` was sampled against |
| `requestedTemplate` | what `?template=` asked for, or `null` |
| `revealPaper(paperId)` | reveals a paper and returns **all** its mappings |
| `papersHere()` | ids of papers overlapping the current selection |
| `comparePapers(a, b)` | `{shared, onlyA, onlyB, disjoint}`, by overlap |
| `highlightCount()` | how many highlight volumes are uploaded |

## `data-notice` codes

Every notice card carries `data-notice="<code>"`. Distinct states have distinct
codes **and** distinct titles; the suite asserts no two share a title, so a
harness may treat a code as a verdict.

| Code | Severity | Means |
| --- | --- | --- |
| `over-precise` | warning | More refinement than the template justifies. Resolved, then drawn **and named** at the limit. |
| `folded` | error | The point is *inside* the body and the coordinate system fails there. |
| `clamped` | warning | The point is *outside* the modelled body and was pulled to the boundary. |
| `homology-variant` | error | A real count anomaly this template does not realise. Nothing is drawn. |
| `homology-absent` | warning | Reserved in the grammar, realised by no template (`S02`–`S05`). |
| `no-template` | error | No template for this frame. Names still resolve. |
| `frame-disabled` | error | `BR` ships disabled in v1. Names still resolve. |
| `frame-unnamed` | **info** | No name index covers this frame. See below. |
| `rejected` | error | `parse()` refused it. Names the first problem; changes nothing else. |
| `atlas-unavailable` | error | A template or index failed to load. |
| `names-other-template` | info | **Stage B.** The name index was sampled against a different template than the one bound. |
| `template-unknown` | warning | **Stage B.** `?template=` named an id not in the catalogue; the default was bound. |
| `renderer-unavailable` | — | On `#canvas-message`, not a notice card. The 3D view failed; everything else works. |
| `renderer-failed` | — | Likewise, but the renderer died after starting. |

`folded` and `clamped` are never conflated and share no vocabulary. A harness
that treats either as "something is wrong with the address" has lost the
distinction the codes exist for.

### `frame-unnamed` is not a failure

`BV` ships as coordinates without names, because no brain parcellation cleared
licensing for redistribution (`docs/asset-licensing.md` §4). This is the
shipping state, not a gap. For a `BV` selection a harness must find:

- `selection.names.covered === false`
- `selection.names.indexVersion === null` — no index spoke, so none is cited
- `selection.names.unclaimedFraction === 0` — not `1`; nothing is claimed either way
- exactly one `frame-unnamed` notice, severity `info`
- **no** `names-unavailable` and **no** `atlas-unavailable`
- `[data-testid="names"][data-covered="false"]`, headed "Location only", with
  no version, no fraction language and no spinner
- exact millimetres in `[data-testid="cell-centre"]`, and a drawn cell

Treating an empty name list as the same thing is the misreport this code
exists to prevent: `BD` is covered by the same index, so this is a per-frame
fact and not a blanket opt-out.

## `data-testid` hooks

`rejection`, `copy-address`, `copy-link`, `demoted-to`, `cell-extent`,
`cell-centre`, `names`, `offer-ancestor`, `cross-atlas-offer`,
`offer-open-atlas`, `layers`, `layer-toggle-<id>`, `layer-opacity-<id>`,
`layer-isolate-<id>`, `search-input`, `search-scope`, `search-results`.

Stage B adds: `research-scope`, `research-list`, `research-reveal`,
`research-paper-<id>`, `reveal-summary`, `reveal-cell-<address>`,
`region-only`, `compare-papers`, `comparison`.

## Forcing the degraded states

`?fail=` forces a load failure, so every degradation is demonstrable without
breaking a server: `index`, `names`, `templates`, `renderer`, `research`,
comma-separated.

- `?fail=index` — the one fatal case. `#boot-error` explains; nothing else shows.
- `?fail=names` — addresses still parse, locate and draw. No names.
- `?fail=templates` — `atlas-unavailable`; addresses still resolve to names.
- `?fail=renderer` — `renderer-unavailable`; panel, names and deep links work.
- `?fail=research` — the research panel explains itself; nothing else changes.

## `?template=<id>`

Binds a catalogue template by id instead of the default. **Not** part of the
encoded view, and deliberately: which template is bound is a property of the
build you loaded, not of the view you are looking at, and pinning an id into
every copied link would oblige the deep-link matrix to prove that a link made
against a retired template still restores the same view.

It is how the template-defect messages are reachable in a running build. The
real body template is admissible, does not fold, and realises every level it
claims, so it produces none of them:

| To reach | Bind |
| --- | --- |
| `folded` | `?template=anat-hyperkyphotic-short-wide` |
| `names-other-template` | any `anat-*` or `syn-brain-adult` |
| `clamped` | a click or paste outside the modelled body — not a template |

`homology-variant` (`BD-T13`, `BD-L06`, `BD-S06`) and `homology-absent`
(`BD-S02`–`BD-S05`) are reachable on the real template.

## What stage B does not cover

- **No browser measurement.** Every journey step is executed through the state
  machine in Node. `derivedFirstInteractionMs` in the performance budget
  remains a stated placeholder, not an observation; the 600 ms render
  allowance inside it is unmeasured. A real-browser pass is DOG-39's.
- **The research corpus is the 5-paper fixture**, not DOG-37's curated set.
  The *behaviour* is corpus independent and asserted as such, but no claim is
  made here about the real corpus's content.
- **`BR` ships disabled** and has no template, by design.
