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
| Research corpus | the curated 30-paper corpus, role `curated`, resolved at load — **read `__atlas.researchCorpus()`, never assume it.** See *The curated corpus* below |

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
| `researchCorpus()` | **which corpus this page served**: `{ version, role, caveat, paperCount, findingCount }`, plus `nameIndexVersion`, `resolution` and `partitions` when the role is `curated`; `null` if it failed to load |
| `researchDeclared()` | what the build said it would serve: `atlas-index.json`'s `research` block, including `expectedResolution` and `authoredAgainst` |

**Name the dataset every research row measured.** The page and the Node-side
oracle now read the *same* curated corpus, which closes the mismatch DOG-68
found — a row could drive the page, recognise a fixture paper id and report
**pass** against invented papers. That is no longer possible through the page,
but the fixture still exists for the viewer's own suite, so the question is
still worth asking rather than assuming. `researchCorpus().role` is `fixture`
or `curated` and is the one call that settles it; report it per row rather than
inferring it from a paper id.

### The curated corpus: what resolves, and what the numbers mean

This is what the page serves. `dist/data/research.json` is the curated dataset
emitted **verbatim as text** — papers, findings, structure ids, provenance, no
geometry — and the geometry is decided at load by `curatedModel()` in
`src/viewer/corpus.js`, against the real name index and both bound templates.

It cannot be decided in the build: resolving a structure id means reading the
name index, the index is an asset payload, and rule 6 of
`tools/check-licence-separation.mjs` holds `dist/data/` to deriving nothing from
asset content. The 5-paper fixture still exists in `fixtures/fixtures.mjs` for
the viewer's own suite; it is no longer page content, and no `FXP-*` id or
`example.invalid` URL appears anywhere in `dist/` (guarded by a test and by the
build itself).

Measured against `bp3d-4.0+uberon-…+8772477294da` with both templates bound:

| | |
| --- | --- |
| Mappings placed | **31 of 170** |
| Papers with any geometry | **10 of 30** |
| Findings with any geometry | **24 of 120** |
| Placed but unnameable | **5** — real extent, curated label, no index name |
| Not placed | **139** |

Without the brain template bound this drops to 28 across 8 papers, because the
three `coordinates` mappings resolve `no-template`. A row that binds
`?template=` must re-read the counts rather than assume these.

**Do not read an empty research panel as a failure.** Twenty of the thirty
papers legitimately have no geometry at all, so "nothing is painted" is the
*correct* rendering for two thirds of the corpus — and is visually identical to
a broken join. A count is the only thing that separates them: compare
`researchCorpus().resolution` with
`researchDeclared().expectedResolution` and report a disagreement rather than a
verdict — the page already does, as the two notices below. `test/curated-corpus.test.js` pins every figure above on the
committed tree, and `CURATED_CORPUS_RESOLUTION` in the catalogue is where the
declared copy lives.

**The 139 do not share one reason, and a row must not report them as if they
did.** Joined against the dataset's `authoredAgainst.partitions`:

| Partition | Status | Placed | Not placed | Why not |
| --- | --- | --- | --- | --- |
| `brain-parcellation` | placeholder, 46 ids | 5 | 135 | no brain parcellation cleared redistribution (`docs/asset-licensing.md` §4) |
| `body-bd` | real, 14 ids | 26 | 0 | — |
| `body-not-in-index` | placeholder, 3 ids | 0 | 4 | coverage gap in the cleared subset, **not** a licence refusal |

A mapping's `unresolved.reason` is `placeholder-partition` for all 139, never
`unknown-structure`. Those words are reserved — DOG-46 — for an id declared
against the index that is actually loaded and still failing to resolve, which is
a mistyped accession. **A row that sees `unknown-structure` has found a real
data defect and must not report it as the licence gap.** It happens zero times
today, and `unresolved.partitionId` is what a row should group by.

Note the five that are placed *and* unresolvable by name: `cells` and
`coordinates` mappings carry their own geometry and never needed the index to
name anything, so they have real extent under a curated label. They carry
`labelFromIndex: false`. A row must not report that label as an index name.

### Stage B additions

| Member | Returns |
| --- | --- |
| `nameIndexSourceTemplate` | the template `coverings.json` was sampled against |
| `requestedTemplate` | what `?template=` asked for, or `null` |
| `revealPaper(paperId)` | reveals a paper and returns **all** its mappings. On a curated corpus, `.mappings` is every mapping placed or not, and `.unresolvedMappings` counts those with no extent |
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
| `research-resolution-drift` | warning | Fewer mappings resolved than the build declared. Says both counts. Not an empty panel — see *The curated corpus*. |
| `research-index-mismatch` | warning | The declared research counts were measured against a different name index than the one loaded, so they are not comparable. |
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

Stage B adds: `research-provenance`, `research-scope`, `research-list`,
`research-reveal`, `research-paper-<id>`, `reveal-summary`,
`reveal-cell-<address>`, `region-only`, `compare-papers`, `comparison`.

`research-provenance` is the corpus line above the paper list. It carries
`data-role` (`fixture` / `curated` / `none`) and `data-version`, and it is
rendered on every build, not only on a fixture build — a DOM row asserting
anything about papers can read the role off it.

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
| `clamped` | a click on the body canvas that misses the model (above C01 → cranial, below S01 → caudal, beside the trunk → surface); the end is named in `notes`. Never a paste or link — an address replayed is not a clamp |

`homology-variant` (`BD-T13`, `BD-L06`, `BD-S06`) and `homology-absent`
(`BD-S02`–`BD-S05`) are reachable on the real template.

## What stage B does not cover

- **No browser measurement.** Every journey step is executed through the state
  machine in Node. `derivedFirstInteractionMs` in the performance budget
  remains a stated placeholder, not an observation; the 600 ms render
  allowance inside it is unmeasured. A real-browser pass is DOG-39's.
- **No §7 row has yet been run against the curated corpus through a browser.**
  The resolution is measured in Node by `test/curated-corpus.test.js` and the
  page is wired to the same `curatedModel()`, but the panel's *rendering* of the
  residue is DOM and this repo has no headless browser in CI. Every DOM row over
  the research panel is `UNVERIFIED` until one is provisioned. Read
  `researchCorpus().role` per row regardless: it is the call that says which
  corpus a row measured.
- **`bundleGzipBytes` is at 92% of budget** (138.0 KiB of 150.0 KiB), with
  12.0 KB of headroom. It read 98% / 3.6 KB when `dist/app/atlas-research.js`
  first shipped; DOG-84 made that file the three exports the page imports
  rather than all 24 of `@gstack/atlas-research`, recovering 8,702 B of gzip.
  DOG-41 owns the line itself. One consequence for a QA pass: the browser's
  research surface is now narrower than the one every §7 row is driven through
  in Node, so a viewer importing a fourth name is a build failure rather than
  something a row could discover. See `packages/atlas-web/src/atlas-research.js`.
- **`BR` ships disabled** and has no template, by design.
