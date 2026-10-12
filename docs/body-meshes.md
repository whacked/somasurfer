# Body meshes (DOG-128, Atlas v2 W3)

This document covers how the full human body gets from BodyParts3D into the
atlas: where it comes from, what ships, in what frame, and what checks each
claim. The figures are in `docs/body-mesh-report.md`, which CI regenerates and
compares against the committed files on every run. This document carries no
figure that the report cannot check.

## The source is BodyParts3D 4.0, not the Z-Anatomy scene

The plan's D2 named "Z-Anatomy/BodyParts3D whole-body surface meshes". Of those
two, the body ships from **BodyParts3D 4.0 directly**: the 99%-reduced OBJ set,
pinned by SHA-256 in `attribution.json` (`bodyparts3d.pinned`).

- **Z-Anatomy ships its body only as a Blender scene** (`Z-Anatomy.zip` at the
  pinned commit holds a `.blend`). Reading it needs Blender, which nobody on the
  team runs and CI does not have; the plan already named that as the cost of
  the Blender route for the brain (D1). brainproject exported the brain to glTF;
  nobody has exported the body.
- **The licence is the one D1 already decided.** BodyParts3D is CC BY-SA 2.1
  Japan, held share-alike (`docs/asset-licensing.md` §3). Nothing new is cleared
  or assumed.
- **It removes every W3 exclusion in §7.6 by construction.** Z-Anatomy's body
  contains two non-commercial models (the Dundee inner ear, BY-NC-SA, and the
  Cowley kidney, BY-NC) and objects whose materials are undeclared. None of
  those is in BodyParts3D; the kidney and inner ear here are DBCLS's own. §7.6
  asked W3 to publish the Z-Anatomy objects it dropped and the material that
  dropped each one; with no Z-Anatomy object read, there is nothing to drop.
- **It is the set `BD` was measured on**, so the mesh is in `BD`'s frame
  without a fitted transform (below).

The output directory is therefore `packages/atlas-assets/body/bp3d-<sha7>/`,
named for what it is, not `zanatomy-<sha>/` as the plan's sketch put it. The
Z-Anatomy archive's SHA-256, which §7.5 left for W3 to record when it fetched
the archive, stays unrecorded: W3 does not fetch or read it.

## What ships, and what does not

**One structure per FMA concept that an element file names itself.** Every
element OBJ states its own concept id and English name in its header. A
structure is one such concept and every element file that names it: the eight
pieces of the left anterior segmental artery are one structure; the left and
right external obliques are two. Its id in both mesh files is its FMA number,
which is unique by construction and is what W5's crosswalk keys on.

17 files have a blank header. Each joins the smallest IS-A concept that holds
it, and only when every other file of that concept names that concept itself.
In practice each is the unnamed side of a bilateral concept whose other side is
named, as the IS-A table states. Anything that does not resolve that way is
excluded and listed, never guessed. `structures.json` records `resolvedBy` for
each file resolved through the table.

**Excluded, and listed by file in `structures.json` `excluded`:**
- **the brain** (PART-OF `FMA50801`). It is its own atlas (W2, DOG-127), and
  two brains in one scene would disagree with each other by the brain
  registration's error. The skull, the cerebral vessels and the spinal cord ship.

Each structure has a **category** (skin, skeleton, muscle, nervous,
cardiovascular, respiratory, alimentary, urinary, genital, endocrine, other)
for the viewer's layer toggles. It is decided by the source's own concepts, in a
fixed precedence (`BODY_CATEGORIES`, `tools/lib/body-structures.mjs`), and each
rule's term is checked against the source's name table on every build. Its
**side** comes from its own name and is never inferred from where it sits.

## Limbs and the skull have names, not addresses

`BD` is a 25-level spine-centred frame. The limbs, the skull and everything else
off the trunk are visible and pickable **by structure name only**. No structure
in these files carries an ALC-1 address; the mesh gate fails if one does. A
limb frame would be a change to `docs/alc-1-spec.md`, and it is out of scope.

## The frame is `BD`'s, and that is measured

Positions are BodyParts3D millimetres in LAS (`+x` the subject's left, `+y`
anterior, `+z` superior): the chart `tools/lib/bp3d.mjs` reads the source into
and the chart the BD template was measured in. So the registration is the
identity, and `structures.json` says so.

That is a claim, so the mesh gate checks it. For each of the 25 BD levels it
takes the shipped full-tier vertebra, re-derives the level's axis point and
volume centroid with the template builder's own `axisPoint`
(`tools/lib/bd-template.mjs`), and compares them with what the template
recorded. The tolerance, 1 mm, was set before the first measurement: it is under
4% of BD's smallest cell side, so a mesh inside it cannot put a point in a
different cell than BD does. S01's recorded axis point is its endplate fit, so
S01 is compared on its volume centroid only. The per-level residuals are in the
report.

`BD` stays the addressing frame. The mesh is display geometry.

## Two tiers, both decimated

The source is 6.4 million triangles once the brain is out, about 46 MB gzip in
ATLM. That is not a web asset at any tier, so unlike the brain the full tier is
decimated too. The parameters are fixed in `tools/lib/body-asset-paths.mjs`:

- **Full** (`meshes.fullres.bin`, fetched lazily): each structure decimated from
  the source to `fullRatio`, with a floor of `fullFloorTriangles` (or all of its
  triangles if it has fewer). The build measures each structure's deviation from
  the source and publishes it as `fullVsSourceMm`. That figure is the build's:
  the gate has the two tiers and not the source. **One exception:** the 25 BD
  vertebrae ship at source resolution in the full tier
  (`build.fullTierUndecimated`), because the registration check measures BD
  from them. The first gate-complete build decimated them, and BD's T07 and
  T09 axis points moved 1.03 and 1.31 mm, past the 1 mm tolerance. That
  violation is what this exception fixes. The gate's tolerance was not changed.
- **Low** (`meshes.lowres.bin`, fetched eagerly): each structure decimated from
  the full tier to `ratio`, with a floor of `floorTriangles`, exactly as the
  brain's low tier is.

Both go through the brain's tier builder (`buildMeshTiers`,
`tools/lib/brain-meshes.mjs`): the same weld, quantisation, simplifier, open
border lock and error measure. The parameters were chosen by dry run
(`tools/build-body-meshes.mjs --dry-run`) against the body's share of the
low-resolution budget; see `docs/performance-budget.md` under "Body meshes".

## The format and the gates are W2's

The files are ATLM (`tools/lib/meshbin.mjs`), read by the same reader in the
perf gate, the mesh gate and licence rule 10. Nothing about the format was
forked or extended.

| claim | how it is checked |
| --- | --- |
| no structure is lost or degenerate | `tools/lib/mesh-tier-checks.mjs`, the brain's per-structure checks moved into one module both mesh sets call: every listed structure in both tiers at its slot, floor met, no degenerate triangle, no sliver, area within [0.75, 1.25], published error re-measured |
| the manifest is consistent | every structure cites BodyParts3D alone; id = FMA number; no element file in two structures, or shipped and excluded; built with the committed parameters |
| the mesh is registered to `BD` | the 25 level points, re-derived from the shipped vertebrae (above) |
| nothing is addressed | no structure carries an ALC-1 address |
| the licence is kept | licence rule 10 reads every structure id out of each body file and checks it against the body's `structures.json`: an excluded concept (the brain) inside a body file fails, as does a source the entry does not cite. Rules 5-7 and 6's base64 and per-structure probes cover the body files as they cover the brain's |
| the budget is kept | `lowResBodyAssetGzipBytes` (the body's share of the 2.5 MiB line) and `fullResBodyAssetGzipBytes` (the lazy tier), in `tools/perf-budget.mjs` |
| the report is current | `docs/body-mesh-report.md` must equal what the files measure |

`tools/verify-gates.mjs` stages each of these failing on the body files, and has
must-pass cases showing that the gates read the committed body files rather than
none.

## Rebuilding

```
(cd tools/mesh-build && npm ci)                          # build-only: meshoptimizer
node tools/build-body-meshes.mjs --source <BodyParts3D>  # the seven pinned files
node tools/check-mesh-assets.mjs --write-report
```

The seven inputs are checked against their pinned SHA-256s before anything is
read. BodyParts3D publishes under a moving `LATEST` URL, so a different file is
refused rather than built from.
