# The mesh viewer (W4, DOG-129)

How the viewer draws the W2/W3/W2c mesh sets, and why each choice was made.
The code is `packages/atlas-web/src/viewer/meshset.js` (decode, pick,
search), `catalogue/asset-meshes.mjs` (which sets, declared first-party) and
`src/app.js` (fetch order, scene, panels). The code is shipped, so its comments
are kept short and the argument lives here.

## One reader

`src/viewer/atlm.js` is the ATLM reader. `tools/lib/meshbin.mjs` re-exports it
beside the writer, so the gates read the format with the same module the page
runs. `meshes.test.js` checks that the two `readMeshBin` exports are the same
function, not just functions that agree today.

## World coordinates per atlas

| atlas | world | sets | how each gets there |
| --- | --- | --- | --- |
| brain | MNI152 2009c asymmetric, RAS mm: the `BV` template's own space | `icbm152-2009c` | native (its `mapping` says identity) |
| | | `zanatomy-2929e94` | W2's `meshToMni` affine, from glTF metres |
| body | BodyParts3D 4.0 mm: the chart `BD` was measured in | `bp3d-4066585` | identity (W3's `registration.transform`) |

The world is the frame's own space, so a clicked point goes straight into
`encodeBrainVolume` / `encodeBody`. The address and its flags come from the
frame's encoder, never from the structure that was hit.

**The affine is not exact, and the page says so.** Every Z-Anatomy structure
carries `placedBy` with the registration's held-out error (8.55 mm at the
red nucleus). The structure panel prints it on every pick or search of one, so
an address clicked on that surface is not read as closer to the anatomy than
the affine allows.

**Normals** go through the inverse transpose of the affine's linear part and
are renormalised. Their sign does not matter: the shader lights whichever face
points at the eye.

**No back-face culling.** The anatomy includes open sheets (dura, skin, the
cortex's cut faces), and winding is not consistent across sources. With
culling, half of a sheet would vanish depending on which way it faces.

## Structures, groups and draws

`decodeMeshSet` lays the triangles out grouped by `category|parts`. That makes
a layer one contiguous run of triangles. The scene then merges adjacent
structures that have the same colour and opacity into one draw, so a frame is
a few dozen draws, not 1,605.

Each structure carries `key` (`set.id`, which is what `s=` and the API use),
`name` (the source's), `title` (what a reader sees: `Caudate nucleus (left)`),
`category`, `parts`, and its box.

- **Cortex lobes.** The ICBM cortex is cut into the first-party lobes of
  `lobes.json`. Each triangle takes the majority label of its three vertices.
  Triangles labelled 0 keep the geometry's id and are titled with the lobe
  file's own words, "Not cortex (medial wall, cut faces)". They are not titled
  "Cerebral cortex", because naming a cut face as cortex would be wrong. The
  panel notes that lobe boundaries have an unstated precision, as `lobes.json`
  itself says.

## Layers: two axes

A structure is drawn when its **category** layer is on **and** at least one of
its **parts** layers is on:

- **brain:** parts is its hemisphere (`left` / `right`). A midline structure has
  both, so it shows while either hemisphere does.
- **body:** parts is every vertebral band its box spans on the spine axis
  (`cranial`, `cervical`, `thoracic`, `lumbar`, `sacral`, `caudal`). The skin
  spans all six, so hiding one band never hides the skin. A femur spans
  sacral and caudal, because its head sits beside the sacrum.

Opacity is the category's opacity times the most opaque visible part.
Isolate works within one axis: isolating `cortex` keeps the hemisphere choice.

The v1 ids keep their meaning (`left`, `right`, `cervical` … `sacral`,
`spine`), so a v1 link's `hide=` / `iso=` / `op=` still does what it said.
The v1 brain's two layers were the hemisphere boxes; they are now the
hemisphere axis.

**Picking skips layers faded below half opacity**, so fading the skin lets you
click the organ behind it. The hint under the canvas says so.

## The selected structure

The selected structure is a view facet like the labels toggle. It is per atlas,
it is in the URL as `s=<set>.<id>`, it is restored by *Back*, and changing it
moves nothing else. A click sets both the structure and the address. A search
sets only the structure and frames it.

It is drawn in its layer's opacity, so a faded skin stays faded. When it is
opaque, or its layer is hidden, an x-ray pass also draws it at 30% with depth
off, so a deep nucleus can be found through the cortex. A faded structure gets
no x-ray, because you are already looking through it; for the skin, an x-ray
would paint over the whole body.

An `s=` naming a structure this build does not draw is not an error. The panel
says the structure is not drawn in this atlas of this build, or that the meshes
are still loading.

## Loading order, and what degrades

1. Right after the atlas index loads, the URL's atlas starts fetching its
   documents and low tier.
2. Once the renderer is up: that atlas's low tier is decoded and drawn, then
   the other atlas's low tier, then the current atlas's full tier. Opening an
   atlas loads its full tier.
3. A full tier replaces a low one per set and is never traded back.

Geometry is never on the path to an address. If a set fails, that set's meshes
are lost and nothing else: the atlas shows one *Some anatomy could not be
drawn* notice, while addresses still parse and resolve and cells are still
drawn at their true extent. `?fail=meshes` forces this for QA.
`__atlas.meshStatus()` reports `pending | loading | low | full | failed | none`
per atlas.

**Framing.** The brain is framed on the `BV` template box, not on the
arteries and nerves that run far below the brain. The body is framed on all of
its anatomy. A camera that came from a link or a drag is never refitted.

## Performance

`derivedFirstBrainFrameMs` (see `docs/performance-budget.md`) prices exactly
the brain link: the files it fetches and this module's decode of them, gated at
3,500 ms.

The full tiers decode on the main thread. A body full tier takes a few hundred
ms on a runner, which shows as a hitch after the low tier is already up. Moving
the decode to a worker is the obvious next step; v2 does not need it to meet
its lines.
