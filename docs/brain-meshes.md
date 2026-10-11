# Brain meshes (DOG-127, Atlas v2 W2)

This document covers how the real brain gets from brainproject's `brain.glb` into
the atlas: what ships, in what format, and what checks each claim. The figures
are in `docs/brain-mesh-report.md`, which CI regenerates and compares against the
committed files on every run. This document carries no figure that the report
cannot check.

## What ships, and what does not

| | structures | where |
| --- | ---: | --- |
| cleared, shipped | 245 | `packages/atlas-assets/brain/zanatomy-2929e94/` (CC BY-SA 4.0, entry `zanatomy-brain-meshes-cleared`) |
| undeclared Z-Anatomy materials, held | 146 (126 of the 128 cortical) | in neither mesh file; listed by name under `excluded` in `structures.json` |
| Dundee cranial nerves, unverified | 46 | the same |

These groups come from `docs/asset-licensing.md` §7.3. The cortex stays held after
§7.8: the upstream title behind Brainder is not established. The fallback the CTO
decided in advance is a first-party ICBM152 cortex; see
`docs/brain-cortex-fallback.md`. The corpus callosum and midbrain have their own
route; see `docs/brain-origin-test.md`.

**Provenance is generated, not written.** `tools/build-meshes.mjs` classifies all
437 structures from the materials inside the pinned glb. It writes the result to
`packages/atlas-assets/provenance/brain-zanatomy-2929e94.json`, which is not
shipped. Licence rule 10 reads each structure id out of each shipped brain file and
checks it against that manifest:
- a held structure inside a file fails;
- so does a source a structure derives from that its entry does not cite.

Before this, citations were self-declared.

## The format: ATLM

`tools/lib/meshbin.mjs` is the single definition of the format; its header gives
the layout. In short:
- one file holds many structures, sharing one int16 quantisation frame;
- normals are octahedral snorm8;
- indices are 16-bit and structure-local unless a flag says 32-bit;
- a table gives each structure's vertex and index range, keyed by brainproject's
  structure id;
- the header carries the file's own byte length, so a truncated file fails to
  parse rather than reading as fewer structures.

The perf gate, the mesh gate and licence rule 10 all read the format through that
module. The viewer (W4) should too. A second reader is a second definition, and the
perf gate would stop measuring what the page does.

**The frame is not MNI.** Positions are in brainproject's mesh frame: glTF, metres,
+x is the model's left, +y superior, +z anterior. `packages/atlas-assets/registration/`
maps MNI millimetres into it, and its held-out error is the one every
coordinate-placed finding inherits.

## Two tiers

- **Full** (`meshes.fullres.bin`, fetched lazily). This is the source, welded and
  quantised, with nothing decimated. Normals are recomputed from the welded surface.
- **Low** (`meshes.lowres.bin`, fetched eagerly). Each structure is decimated with
  meshoptimizer's topology-preserving simplifier, with open borders locked. The
  parameters are fixed in `tools/lib/brain-asset-paths.mjs`:
  - **ratio 0.15**, which puts the low tier at about 0.72 MiB gzip, inside the
    brain's 1.00 MiB share of the low-resolution line;
  - a **floor of 128 triangles**, or all of a structure's triangles if it has fewer.

  The floor is guaranteed rather than targeted: the build re-decimates until what
  lands in the file meets it, and the gate checks exactly that inequality.

Locking open borders is a measured choice. Without it, the superior semilunar
lobules lost four stray source triangles 7.85 mm off their surface. With it, the
worst structure in the file deviates by about 1.3 mm, and the file is the same size.

The budget split with W3, and the full-tier literal, are in
`docs/performance-budget.md` under "Brain meshes".

## What each gate proves

`tools/check-mesh-assets.mjs` runs in `npm run ci` and reads only the committed
files:

| claim | how it is checked |
| --- | --- |
| no structure is lost to decimation | every cleared structure in the provenance manifest is in both tiers' own tables |
| none is degenerate | no zero-area or repeated-vertex triangle; every index in range; at least the floor |
| none has collapsed into a sliver | on every axis the low tier keeps at least half the full tier's extent |
| the surface is the same surface | low/full area ratio within [0.75, 1.25]. This check caught the first build's reorder bug, which doubled the area of thin tubes |
| the published error is real | the Hausdorff and mean deviation are re-measured from the two files and compared with `structures.json` |
| the report is current | `docs/brain-mesh-report.md` must equal what the files measure |
| the registration is real | the mesh centroids, the affine and every residual are re-derived from the full tier |
| the QA sample is valid | 40 structures, every rule, every one shipped; the controls are held |

`tools/verify-gates.mjs` stages each of these failing, and has must-pass cases
showing that the gate, and licence rule 10, read every committed file rather than
none.

## Rebuilding

```
(cd tools/mesh-build && npm ci)                       # build-only: draco3dgltf, meshoptimizer
node tools/build-meshes.mjs --source <brainproject>   # brain.glb + manifest.json at the pinned commit
node tools/fit-brain-registration.mjs --cit168 <dir>  # CIT168toMNI152-2009c_prob.nii.gz
node tools/check-mesh-assets.mjs --write-report
```

The inputs are checked against pinned SHA-256s before anything is read. The QA
sample is drawn once (`tools/draw-brain-qa-sample.mjs`) and is not redrawn by a
rebuild.
