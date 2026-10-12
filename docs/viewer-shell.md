# The viewer: the reasoning behind the shipped modules

`packages/atlas-web/src/` is shipped to the browser byte for byte, and every
comment in it is counted by `bundleGzipBytes`. So the longer explanations of
`app.js`, `viewer/state.js`, `viewer/renderer.js` and `viewer/corpus.js` live here, each under the
line of code it explains, and the code keeps a one-line summary that points back
to this file. They were moved verbatim by DOG-129 when the mesh viewer took the
bundle over its line; nothing was reworded. DOG-132 moved `viewer/corpus.js`'s
header the same way, verbatim, when the region↔paper panels did the same.

Search this file for the code line to find its note.

## `app.js`

### Module header

The browser shell: DOM wiring over the viewer core.

This file owns the DOM and nothing else. Every decision it renders — what is
visible, what an address resolves to, which messages apply, what the URL
says — is made in `viewer/`, where it is testable in Node without a browser.
The rule that keeps it that way: no module under `viewer/` imports this file,
and this file holds no state that `viewer/state.js` does not.

#### Loading order is a requirement, not a preference

The shell paints, then loads indexes, then loads the renderer — in that
order, because that is what makes the stage-A degradation criterion true:

  1. DOM, address bar, name resolution. Needs `@gstack/alc` and the name
     index, and nothing else.
  2. Templates. A failure marks that atlas unavailable and leaves (1) working.
  3. The renderer, by `await import()`. A failure reports "3D view
     unavailable" and leaves (1) and (2) working.

Each of those three failures has its own message, and `?fail=index,names,
templates,renderer` forces them, so the degraded states are demonstrable
rather than theoretical. QA should not have to break a server to test them.

#### `window.__atlas`

A deliberate, documented test handle. The §7 harness has to drive the viewer
and read what it concluded, and scraping rendered text for that produces
false passes. It exposes the state machine and the last selection; nothing in
the shell reads it, so it cannot drift into being a second code path.

### `const ui = {`

Shell-only state: the things that are not part of the view.

Label visibility used to be here, as `ui.labels`. It is in the viewer now —
it is one of the facets a link restores, so it has to be somewhere the state
machine and the URL can both see. Anything left in here is either a loaded
asset or a transient of the DOM, and nothing in here belongs in a deep link.

### `let nameIndex = null;`

--- 1. names, which need no geometry --------------------------------------

Two documents with two different shapes, joined by id. Neither is a name
index on its own, so the join is explicit and validated — see
`viewer/nameindex.js`, which also explains why a version mismatch between
them is refused rather than reconciled.

### `const requestedTemplate = new URLSearchParams(location.search).get('template');`

Which template to bind, by id, from `?template=`.

The catalogue ships the synthetic templates alongside the real ones because
three of `locate()`'s five findings need a template that produces them and
the real body template produces none of the three — it is admissible, it
does not fold, and it realises every level it claims. Without a way to bind
`anat-hyperkyphotic-short-wide`, the `folded` message is reachable only in
the suite, and QA cannot see it in a running build.

Read straight off the query string rather than through `deeplink.js`, and
deliberately NOT part of the encoded view. Which template is bound is a
property of the build you loaded, not of the view you are looking at; if it
round-tripped through `encodeView` then every link anyone copied would pin a
template id, and the deep-link matrix would have to prove that a link made
against a retired template still restores the same view. It cannot.

### `if (nameIndex && nameIndexSource && templates.body && templates.body.id !== nameIndexSource) {`

The name index's cells were sampled against one body's meshes. Binding a
different body still resolves — fractions are frame measure, so they stay
exact — but the structure boundaries then describe anatomy that is not on
screen, and that has to be said. Unreachable in the default build, where the
bound body IS the template the index was derived from; reachable the moment
`?template=` binds another.

### `try {`

--- 3. the research corpus, RESOLVED HERE against the real name index ------

Validated at load, like every other fetched document: a malformed mapped
address must surface here rather than inside a render loop. A failure costs
the research panel and nothing else.

Two shapes arrive through this one slot, and `role` is the discriminator:

  curated   a `research/1` dataset — papers, findings, structure ids, no
            geometry. The geometry is decided HERE, by `curatedModel()`,
            against the name index joined above and both bound templates.
            It cannot be decided in the build: resolving a structure id
            means reading the index, the index is an asset payload, and rule
            6 holds `dist/data/` to deriving nothing from asset content.
  fixture   a pre-resolved document, carrying cells. Still what the viewer's
            own suite drives, no longer what the page serves.

The templates are passed deliberately and it is worth 3 mappings and 2
papers: without a BV template the three `coordinates` mappings resolve
`no-template`, and a locus we cannot place is not the same claim as a region.

### `if (ui.research?.role === 'curated') {`

What the page resolved, against what the build said it would.

This comparison is the only thing that can tell a broken join from an honest
one. 20 of the 30 curated papers have no placed geometry at all, so a paper
list with nothing painted is the CORRECT rendering for two thirds of the
corpus — and is pixel-for-pixel what a join that silently resolved nothing
would produce. Without a number, the two are indistinguishable; with one,
the disagreement is a notice instead of a shrug.

Reported, not enforced. A mismatch means the declaration is stale or the join
changed, and neither is a reason to withhold the research panel from a reader
— but it is a reason not to let a §7 row report pass on it.

### `const away = selection.elsewhere ? ` in the ${selection.elsewhere} atlas` : '';`

An address that lives in the other atlas has no millimetres HERE.

The viewer withholds them, so these read from `elsewhereCell` and say
whose answer they are. "not placed in this template" would be the wrong
sentence twice over: a template did place this cell, and the reason the
numbers are not this view's is not the reason that sentence reports.

### `if (selection.names.covered === false) {`

A frame with no index gets its own presentation, not an empty list.

No heading citing a version — no index spoke, so quoting the `BD` index's
version here would borrow its provenance for a frame it says nothing
about. No "0 structures overlap", no fraction language, no spinner: those
all imply a lookup that ran and came back empty, and would read as a gap
about to close. What the viewer has here is a location, and it says so.

### `function renderResearch() {`

The research panel: which papers mapped here, and what one paper mapped.

Two lists with deliberately different rules, and the difference is the whole
point (see `viewer/research.js`):

  the LIST    narrowed by the current selection. A paper that mapped nothing
              near here is not shown.
  the REVEAL  every mapping of the selected paper, including ones outside
              the current selection and ones in the other atlas. Nothing is
              withheld; cells outside the filter are marked, and the count
              is stated so the user can see that the filter was ignored on
              purpose rather than wonder what it did.

### `provenance.dataset.role = ui.research.role;`

The corpus, named. Written before the counts for the same reason the name
index version is written beside a name list rather than under it: the
reader needs to know what they are reading before they read it, and a
fixture paper is indistinguishable from a real one row by row.

`dataset.role` carries the machine-readable half, so the §7 harness can
assert which corpus a row measured instead of inferring it from a paper
id — the false green DOG-68 exists to close.

### `const mappingRow = (mapping) => {`

One curated mapping: what it claims, and either where it is or why not.

An unresolved mapping is a row like any other. It is listed, it is
described, and it has no cell list — nothing is placed that the index did
not place, so there is nothing here to click and nothing to paint. The
reason comes from the dataset's own partition and never says "unknown
structure"; `viewer/corpus.js` has the argument.

### `function uploadHighlights() {`

Upload the revealed paper's cells as highlight volumes — or, while two
papers are compared, both papers' cells in one colour each and their
covering intersection hatched in both.

Every uploaded highlight names its paper and finding (an overlap cell names
the findings of both papers that contain it), so `__atlas.highlights()` can
trace any volume on screen back to what was reported.

Only the cells of the CURRENT atlas are uploaded, because a `BV` cell has no
geometry in the body template and there is nothing to draw. That is a
rendering fact, not a filter: every mapping is still listed in the panel,
and the ones belonging elsewhere say so.

### `function renderLabels() {`

Labels as a DOM overlay rather than in GL.

Text in a WebGL scene means a glyph atlas and a pile of code; text in the DOM
is selectable and styleable for free. The cost is that labels are not
occluded by geometry — which for level markers along a spine is what you want
anyway, since the point of the label is to find the level you cannot
currently see.

The overlay stays `aria-hidden`, and that is not an oversight to fix later. A
label here carries its meaning in where it sits on a canvas nobody reading by
screen reader can see; flattened into the accessibility tree it is 29
context-free level codes between the canvas and the address panel. The
non-visual route to the same information is the address panel's ranked names
and the structure search, which are real DOM with real text.

Visibility is `viewer.labelsOf()`, per atlas and in the URL — see the header
of `viewer/state.js` for why it is not a field on `ui`.

### `if (fly && model.cell) {`

There is deliberately no `elsewhere` branch here: an address living in
the other atlas comes back from the viewer with no `cell`, so there is
nothing to upload and nothing to fly to. Keeping the rule in the viewer
instead of copying it into the shell is the point — a second copy is how
this panel came to say "the view has not been changed" while the camera
was already at the other atlas's coordinates (DOG-75).

### `function pick(event) {`

Click -> address.

The millimetre point goes back through the frame's own encoder, never through
the level the triangle belongs to. `encodeBody` is what produces the flags,
including `folded` — which is exactly the case where the triangle's level and
the frame's answer differ, so trusting the triangle would hide the one defect
the flag exists to show.

### `if (viewer.atlas === 'body') {`

The address comes from the millimetres through the frame's own encoder,
never from the structure, so its flags (folded, clamped) reach the user.
A body miss still encodes where it points (DOG-116); a brain miss selects
nothing. The brain's flags are carried now that the surface is anatomy,
not the template's own boundary box.

### `function loadMeshes(atlas, tier) {`

One tier of an atlas's mesh sets, decoded and uploaded, replacing what was
drawn. Low first, full lazily: the current atlas's low tier, then the other
atlas's, then the current atlas's full tier (and the other's when opened).

### `setLabels: (visible) => {`

Labels, through the same path the checkbox takes.

Deliberately not `viewer.setLabels` straight: a hook that skipped `commit`
would report the new state while the overlay and the URL still showed the
old one, and a QA pass on that proves nothing about the page.

### `researchCorpus: () => (ui.research`

Which corpus the page is actually serving — one call, no inference.

DOG-68: a §7 row that drove the page, found a fixture paper and reported
**pass** would be measuring the invented corpus while the Node-side oracle
measured the curated seed set, and nothing in the surface made the two
distinguishable without recognising a paper id. A row can now name its
dataset, and a row that forgot to is visibly a row that did not ask.

`null` rather than a guess when the document failed to load: "no corpus"
and "the fixture corpus" are different results and must not print alike.

On a curated corpus the counts alone are not enough to judge a row by.
Twenty of the thirty papers have no placed geometry, so `resolution` —
measured from the join that just ran, not declared — is what tells an
honestly empty panel from a broken one. `nameIndexVersion` is carried for
the same reason it is carried beside every name list: a resolution is only
true relative to the index it came from.

## `viewer/state.js`

### Module header

The viewer's state machine. No DOM, no WebGL, no fetch.

Everything the §7 journey asserts about *behaviour* lives here, which is what
lets the journey be driven in Node: open the body atlas, change layers,
select a structure, navigate explicitly to the brain atlas, come back and
find the previous view intact. The browser shell is a renderer of this
object, not a second implementation of it.

#### Selection never switches the atlas

This is the rule with the most ways to get violated by accident, so it is
structural here rather than a convention. `select()` cannot change
`state.atlas` — there is no code path from it to the assignment. An address
belonging to the other atlas still selects, still resolves, still reports its
names and flags; what it does *not* do is move the camera somewhere else and
swap the geometry out from under the user. Instead the selection carries
`elsewhere`, naming the atlas the address lives in, and the shell offers the
explicit action. A viewer that teleports on click makes the body's brain and
the brain atlas feel like one continuous space, which is exactly the
confusion the plan's §2 refuses.

The only transitions that change the atlas are `openAtlas()` and
`returnToPrevious()`, both of which are user actions.

#### Not switching is not enough: it must not DRAW there either

Reporting `elsewhere` and leaving `state.atlas` alone was only the first half,
and for a while the second half was missing: the selection still carried its
mesh and its millimetres, so the shell uploaded a brain cell into the body
scene and flew the body camera to brain coordinates while the panel said the
view had not changed. Those numbers are the other template's; next to a view
of this one they are not a smaller truth but a different coordinate system,
and the camera move is the teleport this rule exists to refuse.

So an address whose frame lives in the other atlas has NO geometry in this
view. `cell`, `pointMm`, `extentMm` and `templateId` come back null and the
resolution is kept under `elsewhereCell`, where the panel reports it as that
atlas's answer and nothing that draws can pick it up by accident. The guard
is here and not in the shell because this object is the behaviour of record —
a rule the shell implements privately is a rule the journey cannot measure,
and that is exactly how the two halves came apart (DOG-75).

#### A cross-atlas selection is still a view, so it is still a link

`state.address[a]` means "the address atlas `a` is showing", not "an address
belonging to frame `a`". It used to mean the second, which made the first
unrepresentable: `toView()` reads the current atlas's slot, so the brain
address you had just selected in the body atlas was missing from the URL the
page then showed, and copying that link lost the selection (plan §7: every
view is linkable). Filing it under the atlas being viewed also makes the
return stack's snapshot true — it restores what you were looking at.

The destination atlas's own slot is therefore not written on selection. The
address rides to it through `openAtlas`, which is where the move actually
happens, so the offer still lands on the cell it offered.

#### Camera and layers are per atlas, and the return is a snapshot

Two mechanisms, because they answer two different questions. Per-atlas
`camera`, `layers` and `labels` mean each atlas remembers how you were
looking at it, so switching back and forth does not reset anything. The
`returnStack` additionally snapshots the whole view — atlas, camera, layers,
label visibility and the selected address — at the moment of an explicit
switch, which is what the "route back that restores the previous camera and
layer state" requirement actually asks for: not "the body atlas's current
state" but "the state you left".

#### Label visibility is view state, not shell state

It used to live in `app.js` as one boolean on the DOM shell, which made it
invisible in three ways at once: one flag shared by both atlases, so turning
the markers off in the brain atlas turned them off in the body atlas you came
back to; absent from `toView()`, so no link carried it and "every link
restores the same view" was false by one facet; and unreachable from anything
driving the viewer in Node, so the §7 label behaviour could not be measured
at all — the gap DOG-71 was filed for. Whether labels are showing is part of
what you are looking at, so it is here with the rest of the view.

### `const layer = (axis) => ([id, label]) => Object.freeze({ id, label, axis });`

The layers each atlas offers, in display order, on two independent axes.

A structure is drawn when its CATEGORY layer and one of its second-axis
layers are on: hemisphere in the brain, vertebral region in the body (every
band its extent spans on the spine axis). Isolate works within one axis, so
isolating the cortex keeps the hemisphere choice. The v1 ids (`left`,
`right`, `cervical`… `spine`) keep their meaning, so v1 links restore.

### `export function isLayerVisible(layers, id) {`

Whether a layer is drawn, given the layer state.

Isolate is not "hide all the others" written into `hidden`. It is a separate,
reversible mode, so turning it off restores whatever show/hide state the user
had built up rather than leaving them with everything hidden. Making isolate
destructive is the standard way this control becomes annoying.

### `export function structureLayers(layers, structure) {`

Whether a mesh structure is drawn, and how opaque: its category layer times
the most opaque of its second-axis layers (`parts`: one hemisphere, both for
a midline structure, or every body band it spans) that is on.

### `labels: { body: DEFAULT_LABELS, brain: DEFAULT_LABELS },`

Per atlas too, and for the same reason: the body atlas's level markers
and the brain atlas's hemisphere markers are different enough that
wanting one is not wanting the other.

### `select(input, { encodeFlags } = {}) {`

Select an address.

Returns the selection model. On rejection nothing in `state` moves except
`selection`, which holds the rejection so the shell can render the
message inline — the address that was showing stays showing, the camera
does not move, and the layers are untouched.

Never changes `state.atlas`. See the module header.

### `setLabels(visible, atlas = state.atlas) {`

Show or hide the labels in the current atlas.

Changes nothing else. Labels are an annotation over the view, so toggling
them is not a navigation and not a selection: the camera, the layers and
the selected address are all untouched, which is what the §7 row asserts
and the reason this is not folded into the layer state.

### `openAtlas(atlas) {`

Move to another atlas, explicitly.

Snapshots the view being left onto the return stack first. The snapshot
is a deep copy: the whole point is that it still describes the old view
after the new atlas has been panned and had its layers changed.

### `atlasExplicit: state.selection?.ok === true && state.selection.elsewhere !== null,`

Say the atlas out loud when the address does not imply it.

`encodeView` omits a default, so a brain address selected in the
body atlas would otherwise encode as a bare `?a=BV-…`, and which
atlas that link reopens in would depend on a rule rather than on
what it says. One link, one meaning: the view that is only half
about this atlas is the one that states it.

### `applyView(view, problems = []) {`

Apply a decoded view.

The atlas comes from the URL, which is not a selection-driven switch: a
link is an explicit act by whoever followed it. The address is applied
after the atlas, so a brain address in a `atlas=brain` link lands in the
atlas that can draw it, and a brain address in a body link selects
without switching — same rule as a click.

### `export function atlasForAddress(address) {`

The atlas an address would be drawn in, without selecting it.

Used by the shell to label the cross-atlas offer before the user commits.
Returns `null` for an address that does not parse — the caller shows the
rejection instead, and this must not be the thing that throws.

## `viewer/renderer.js`

### Module header

The renderer. WebGL2, no dependency, loaded by dynamic `import()`.

#### Why this is not three.js, for now

`docs/viewer-bundle-budget.md` measured the renderer options and ruled out
React Three Fiber on cost: three.js tree-shaken to the stage-A surface is
126,469 bytes gzipped against a 153,600-byte line, and react-dom's 42.8 KiB
on top does not fit. That measurement assumed a bundler.

This repository has no bundler, and that is not an oversight that can be
fixed in passing:

  - `packages/atlas-web/build.mjs` copies `src/*.js` verbatim as native ES
    modules. There is no tree-shaking and no minification step.
  - `.github/workflows/ci.yml` never runs `npm ci` or `npm install`, so
    `node_modules` does not exist on the runner and the build cannot copy a
    dependency out of it.
  - `ci.yml` asserts that the root `package.json` has gained no runtime
    `dependencies`, failing with "root gained runtime dependencies; update
    CI". Adding one is a deliberate decision point, by design.

So shipping three.js here means committing its build into the repository and
serving it unminified and un-tree-shaken: 2.1 MB raw, ~407 KiB gzipped —
three times the figure the budget decision was based on. That is a
cross-cutting change to the build spine, the licence gate and the budget, and
it belongs with Release Engineering alongside DOG-41, not bolted onto this
commit.

The seam is the point. This module's whole interface is `createRenderer`
returning the handful of methods below. Nothing above it knows what draws:
`app.js` loads it with `await import()` and runs without it. Replacing the
body of this file with three.js calls changes no other file.

#### It is loaded lazily, and that is a requirement rather than a nicety

Stage A requires that a failure to load geometry leaves addresses parsing and
resolving to names. If the address bar sat behind the renderer, that
requirement would be unsatisfiable by construction. So the renderer is
imported after first paint, and every entry point here is allowed to fail
without taking the shell down.

### `const SOLID_FRAGMENT = `#version 300 es`

Solid region colour mode: one flat colour per region, shaded only enough to
read as a solid. No texture, no specular, no gradient — the one display mode
v1 ships, and the colour has to mean "this region" rather than "this light".

Two headlights rather than one, because a single light leaves the half of the
body facing away from it unreadably dark, and a user reads a dark region as a
different colour.

### `export const REGION_COLOURS = Object.freeze({`

The solid region palette.

Chosen for distinguishability rather than realism — these are regions of an
address space, not tissue. The cell highlight is deliberately the only warm
colour, so what you selected never competes with the anatomy around it.

### `export const ANATOMY_COLOURS = Object.freeze({`

Anatomy, by layer id (viewer/state.js) and, for the cortex lobes, by label.
Tissue tones, muted, so the cell's orange and the paper colours still read
as annotation over them. `chosen` is the selected structure.

### `export const PAPER_COLOURS = [[0.28, 0.52, 1.0], [0.93, 0.30, 0.72]];`

One colour per paper when two are compared: blue and magenta, far apart in
hue from each other, from the selection's orange and from the body's
blue-green region tones. Their overlap is hatched in both.

### `export function createRenderer(canvas) {`

Create a renderer on a canvas.

Throws if WebGL2 is unavailable, which the caller turns into a visible
"3D view unavailable" rather than a blank canvas. A blank canvas is the worst
outcome: it looks like the atlas has no content.

### `function render(scene) {`

Draw a frame.

`scene` is plain data assembled by `app.js` from viewer state — uploaded
meshes, which layers are visible and at what opacity, and the selected
cell. The renderer makes no decisions about what should be visible; that
belongs to the state machine, where it is testable.

### `const volumes = [`

--- research highlights, then the selected cell -----------------------
Drawn last, blended, with culling off so each reads as a volume from
both inside and outside, and with depth writes off so none of them hides
the anatomy it is meant to locate.

Highlights go FIRST so a selection inside a highlighted group still
reads as the selection, and each carries its own colour: a highlight
that looked like the selection would make "the address you are at" and
"somewhere a paper reported" indistinguishable, which is the whole value
of the research panel.

### `function projectPoint(point, camera, width, height) {`

World millimetres -> canvas CSS pixels, or `null` when behind the camera.

Lives here rather than in the shell so labels are projected with the same
matrices the geometry was drawn with. A label derived from an independently
re-derived projection drifts from the thing it labels as soon as either
side's near plane or field of view changes, and a label a few pixels off
the structure it names is worse than no label.

## `viewer/corpus.js`

### Module header

The curated corpus, resolved in the browser, against the real name index.

`research.js` validates a document whose geometry is already decided: each
finding arrives carrying cells. That shape is all a build can honestly emit,
because deciding the cells means resolving a structure id against the name
index, the name index is an asset payload, and rule 6 of
`tools/check-licence-separation.mjs` holds `dist/data/` to deriving nothing
from asset content. So `dist/data/research.json` ships the curated dataset as
TEXT — papers, findings, structure ids, provenance — and the join happens
here, at load, where the index has already been fetched.

That is the whole architectural point of R2, and it is also what makes the
numbers below possible to state at all: they are measurements against the
index the page actually binds, not estimates.

#### What the join actually yields, measured

Against `bp3d-4.0+uberon-uberon/releases/2026-10-01/uberon-basic.owl+8772477294da`
with both shipped templates bound, `research-seed-2026.10.1` resolves **31 of
its 170 mappings**, across **10 of 30 papers** and **24 of 120 findings**.
139 mappings resolve to nothing at all.

Those are not disappointing numbers to be smoothed over. They are the
honest extent of what v1 can place, and the entire job of this module is to
carry them to the screen intact:

  - **Nothing is placed that the index did not place.** There is no fallback
    to a structure's covering, no synthetic index, no inferred position. An
    unresolved mapping contributes zero cells, and `buildResearchIndex()`
    already guarantees that by giving it `EMPTY_COVERING`; this module must
    simply not invent one.
  - **The residue is listed, described, and painted nowhere.** A paper with
    no placed geometry is still a paper. It stays in the list, stays
    selectable, and reveals all of its mappings — each one saying why it has
    no extent.

#### Why the unresolved reason is NOT "unknown structure"

All 139 come back from the resolver with `unresolvedReason:
'unknown-structure'`, and that string is correct about the mechanism and
badly wrong as a sentence to show a reader. DOG-46 reserved those words
deliberately, to mean *a mistyped accession* — an id that should have
resolved and did not. Printing them 139 times would accuse the curator of
139 typos, when in fact the dataset predicted every one of them in advance.

It did so in `authoredAgainst.partitions`, which exists for exactly this.
Each partition states, per structure id, which index was supposed to name it
and whether that index is real or a declared placeholder. Joining against it
turns a mechanism into a cause, and the measured split is:

  brain-parcellation  placeholder, 46 ids   135 unresolved,  5 resolved
  body-bd             real,        14 ids     0 unresolved, 26 resolved
  body-not-in-index   placeholder,  3 ids     4 unresolved,  0 resolved

**The 139 do not share one cause, so they do not share one sentence.** 135
are blocked by licensing — no brain parcellation cleared redistribution, and
`docs/asset-licensing.md` §4 is final for v1. The other 4 are a coverage gap:
the cleared BodyParts3D subset has a generic rib but no individual rib, and
carries neither the coronary artery nor the quadratus lumborum. The dataset
separates those two partitions on purpose and says why in each `reason`
("a coverage gap in the index rather than a licence refusal, and it is
recorded separately for that reason"), so collapsing them into one message
about licensing would introduce a fresh conflation while fixing another — the
same error as conflating `folded` with `clamped`.

So the explanation is keyed off each mapping's OWN partition, and the cause
shown is the partition's own recorded `reason`, verbatim. Verbatim rather
than paraphrased because that text is the decision, written by whoever made
it; a paraphrase of a licence verdict is a new claim about a licence.

And `unknown-structure` keeps its DOG-46 meaning, now exclusively: it is
said only when the id belongs to a partition declared `real` against the
very index that just failed to name it. That case is a genuine data error,
and today it happens zero times — which is a fact worth being able to see
change.

#### Resolved does not imply named

5 of the 31 resolved mappings sit in the `placeholder` brain partition, and
that is not a contradiction. Only `region-level` precision needs the index to
name anything — `cells` and `coordinates` mappings carry their own geometry.
Those 5 are therefore **placed but unnameable**: real extent, with a label
that came from the curator rather than from any index. They keep
`labelFromIndex: false` so the panel can say so, because a curated label
rendered identically to an index name is a quiet upgrade of one to the other.

Three states, then, not two: placed and named (26), placed but unnameable
(5), not placed (139).

## `viewer/regionpapers.js` and the region↔paper panels (DOG-132)

### Module header

Region → papers and paper → regions are read from W6's static research API
(`packages/atlas-research/schema/api-1.md`), from the **region tree** under
`index.researchApi.assetsRoot`. The documents there are already joined: every
link carries its `how`, its precision and the curated term it came from. The
viewer does not resolve anything. It finds a document through the region
index's own `href`s, refuses one that is not the `atlas-research-api/1` kind it
asked for or whose `href` leaves the tree, and displays it.

Paper titles and finding statements come from the corpus the page has already
loaded (`data/research.json`), which is the same dataset version the API
names. So a region panel costs one small fetch, and nothing is fetched until a
structure is selected or a paper is revealed. The first frame does not wait on
the API.

**Why not `createStaticApiClient`.** W6 left the choice to W7. Adding it to the
viewer entry costs 7.9 KB of gzip, mostly the validator and its comments, with
4.2 KiB of `bundleGzipBytes` left. The API's documents are validated where they
are made and served: by `tools/build-research-api.mjs`, and over HTTP by
`tools/check-research-api-contract.mjs`. The page checks only kind, schema and
containment.

**Which structure is which region.** `catalogue/asset-meshes.mjs` declares,
per mesh set, the API representation its structures belong to and which field
is the id there: `zanatomy-gross-anatomy` by `id`, `bodyparts3d-bd` by `fma`.
`meshSetFrom` stamps each structure with that `regionKey`.
`test/region-papers.test.js` holds every region the served tree lists to that
declaration. The ICBM cortex declares none: its lobes are not in the region
tree until DOG-157, and its panel says so rather than "no papers".

### `function regionPapersSection(s) {`

Region → papers. Every paper and finding the region document lists, each link
with its `how`, its precision and the curated term. An approximate link reads
as approximate in words, in italics and on a striped `how` tag. An HCP-MMP1 link
always shows its original area name, because the structure it was projected
onto is not what the paper said. "Loading", "the API could not be read", "no
representation covers this set" and "no paper links this structure" are four
different sentences.

### `function paperRegionsSection(paperId) {`

Paper → regions. All of the paper's structures, never narrowed by the selection.
A paper with none prints the API's stated reasons (`emptyBecause`), code and
detail verbatim. A structure in the other atlas is named there and is not
opened: selection never switches the atlas. A region with no single drawn
structure in this build is listed and says so. Six body regions (heart, liver,
both lungs, spinal cord) are BodyParts3D wholes that the body mesh ships only
as parts.

### `const regions = ui.revealed ? paperRegionsOf(ui.revealed).model : null;`

The overlay is computed once per commit, not per frame. A structure is drawn
**solid** in the paper colour when any link to it is exact, and **striped**
when every link is approximate. So a crosswalk or coordinate link looks
approximate in 3D as well as in the panel. Marked structures are also drawn in
the x-ray pass, so a thalamic nucleus shows through the cortex and through a
hidden layer: a layer setting never hides a paper's mapping.

The camera is framed on the paper's structures in this atlas once, on reveal,
as soon as they are drawn. A reveal before the meshes arrive frames when they
do. It never refits afterwards, so the user's own camera moves stand.
