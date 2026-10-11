# Brain cortex fallback: an ICBM152 2009c surface (prototype)

**Status: prototype, not shipped.** 126 of the 128 Z-Anatomy cortical structures are not licence-cleared
(docs/asset-licensing.md §7.3). The fallback the CTO decided in advance is a first-party cerebral surface
extracted from the ICBM152 2009c template. This document says what the prototype is and what it measured.
Whether it ships is the owner's decision, taken via DOG-123. Nothing it produces is in the repository.

## Input and licence

- **Source:** `icbm152-2009c` in `packages/atlas-assets/attribution.json`. That is the ICBM 152 non-linear 2009c
  asymmetric template, `mni_icbm152_nlin_asym_09c_nifti.zip`, from
  https://www.bic.mni.mcgill.ca/~vfonov/icbm/2009/. It is already this project's `BV` template.
- **Licence:** the MNI BIC permissive licence (the archive's `COPYING`). It requires only that the copyright notice
  travel with copies. It is not share-alike and not non-commercial.
- **Archive as fetched on 2026-10-11:** 58,602,393 B, matching the server's `Content-Length`. SHA-256
  `804382e5d68a42ff8096ee845a7600b6658434da762fa67840a149eb25d48bd4`, the same value attribution.json records. The
  download took 35.7 s at 1.64 MB/s and `unzip -t` reported no errors.
- **Files read:** the GM, WM and brain-mask NIfTIs (193 x 229 x 193, 1 mm, `sform_code` 4, RAS). Their SHA-256
  values are pinned in `tools/build-icbm-cortex.mjs`, which refuses any file that does not match.

## Method

`node tools/build-icbm-cortex.mjs --icbm <dir> [--out <dir>]`. The tool's header comment gives the reasoning for
each step.

1. **Field.** The field is GM + WM probability. The int16 maps are scaled by `scl_slope`/`scl_inter`, which
   `tools/lib/nifti.mjs` does not apply, so the tool applies them. Voxels where the brain mask is below 0.5 are
   zeroed.
2. **Iso level 0.5.** This is where tissue is exactly as likely as CSF or background: a probabilistic pial
   boundary.
3. **Cerebrum only.** See the next section.
4. **Hemispheres split at MNI x = 0.** Voxels with x < 0 are left (structure 1) and voxels with x >= 0 are right
   (structure 2). Each hemisphere is closed by a flat medial cap. The two caps coincide at x = -0.5 mm.
5. **Extraction.** Marching tetrahedra (`tools/lib/marching-cubes.mjs`), using the Kuhn six-tetrahedron split.
   Classic marching cubes was not used because it can crack at ambiguous faces. Marching tetrahedra has no
   ambiguous case, so the output is a closed 2-manifold. The cost is about twice the triangles, with more slivers.
6. **Components.** Only the largest connected component per hemisphere is kept.
7. **Tiers.** These are built as in `tools/lib/brain-meshes.mjs`:
   - The full tier is the extracted surface, reordered and quantised to int16, with no decimation.
   - The low tier comes from meshoptimizer 1.3.0 `simplify()`. Its triangle budget is searched until the gzip size
     is at most 280,000 B.
   - One addition: vertices that quantise to the same position are merged before collapsed triangles are dropped.
8. **Output.** ATLM files in MNI RAS millimetres, natively, with no affine applied. A JSON report is written
   alongside them.

## The cerebrum-only rule, and what it costs

The distribution has no cerebellum or brainstem label. At 1 mm the tentorium is only partly resolved: medially,
GM + WM stays above 0.9 straight through it. As a result, no threshold, erosion or connected-component split
separates the cerebellum. The rule is geometric and has two cuts. Both are measured from this template.

- **Tentorial cut.**
  - **Sampling.** In each column with |x| from 4 to 64 and y from -100 to -30, the tool takes the deepest z between
    -40 and 5 where GM + WM < 0.6 and there is tissue (> 0.8) within 8 mm above and below. These are the places
    where the tentorium is visible.
  - **Fit.** A surface z = a + b·y + c·|x| + d·|x|·y is fitted to those samples by least squares. One refit follows,
    after dropping residuals over 6 mm. The result is clamped to [-40, -3] mm.
  - **Cut.** Everything below that surface with y <= -30 is removed.
  - **Measured fit:** 2,829 samples, 1,887 kept, RMS residual 2.21 mm.
  - **Cut height:** -7.3 mm at the midline at y = -60, -21.4 mm at |x| = 40, and -28.5 mm at |x| = 60.
- **Brainstem cut.** Every voxel with |x| <= 15, -50 <= y <= -6 and z < -12 is removed. This takes the midbrain
  and pons below the diencephalon. The medial temporal lobes lie at |x| >= 16 at those levels.
- **Removed volume.** The two cuts removed 187,944 and 44,332 tissue voxels respectively (1 mm³ each). Together
  that is 13.34% of the 1,741,162 voxels above the iso level.
- **Costs:**
  - Medially, the cut is the fit's extrapolation. It can leave a sliver of superior vermis attached or shave the
    inferior lingual gyrus.
  - The brainstem box leaves a flat cap under the diencephalon.
  - A few cerebellar voxels just in front of y = -30 at |x| of about 20 are outside both cuts.
  - **UNVERIFIED:** the cut's anatomical accuracy. There is no label to check it against. It was inspected only on
    ASCII slices.

## Measured figures (run of 2026-10-11)

| | left | right |
| --- | ---: | ---: |
| triangles extracted | 636,564 | 644,904 |
| connected components | 95 | 76 |
| triangles in dropped components (largest dropped) | 10,040 (1,160) | 11,508 (3,172) |
| non-manifold edges, extracted surface | 0 | 0 |
| enclosed volume, full tier | 752.9 cm³ | 754.0 cm³ |
| full tier triangles | 625,443 | 632,422 |
| low tier triangles | 16,405 | 16,578 |
| Hausdorff low vs full (mean) | 3.327 mm (0.123) | 2.851 mm (0.142) |
| full-to-low p95 | 0.33 mm | 0.38 mm |

| tier | triangles | bytes | gzip bytes |
| --- | ---: | ---: | ---: |
| full | 1,257,865 | 20,123,636 | 8,579,546 |
| low | 32,983 | 329,012 | 275,214 |

- **Hausdorff over the two hemispheres:** median 3.089 mm, max 3.327 mm.
- **Quantisation step:** 0.0028 mm.
- **Runtime:** 84.5 s in-process (85 s wall) on the shared runner. Most of it is the error measurement (33 s) and
  the alignment figure below (21 s).
- **Manifold defects in the tiers.**
  - Full tier: 37 non-manifold edges on the left and 16 on the right. These appear after 1,081 and 974 triangles
    collapse at the quantisation step. That they are the cause is likely but UNVERIFIED.
  - Low tier: 156 non-manifold edges on the left and 185 on the right. Nearly all are back-to-back duplicate
    triangles (99 and 127) that the simplifier makes where it flattens thin sheets.
  - None of these defects is fixed in the prototype.

**Indicative alignment only.** This is not a registration error, because the committed meshes contain no cortex.
The low tier was mapped through `mniToMesh`, whose held-out error is 8.55 mm:

- The mapped low tier's bounding box spans 150.0 x 122.2 x 214.3 mm (mesh x, y = superior, z = anterior).
- The 245 committed structures span 142.2 x 281.7 x 177.9 mm. Their superior-inferior extent includes the
  brainstem and spinal structures.
- The mean distance from a mapped vertex to the nearest committed (non-cortical) surface is 10.55 mm. The p95 is
  28.3 mm and the max is 44.51 mm.

## What it is good for

- **Natively MNI.** A cortical MNI coordinate lands on this surface with no affine. The Z-Anatomy route carries
  every coordinate through the MNI-to-mesh affine, and that affine's held-out error is 8.55 mm (see
  `packages/atlas-assets/registration/mni-to-zanatomy-2929e94.json`). That error does not apply here.
- **Licence.** It is permissive and already cleared for this project as `icbm152-2009c`.

## What it lacks

- **No gyral labels.** It is one unlabelled surface per hemisphere. Names could only come from MNI coordinates
  and a crosswalk to an atlas, not from the geometry.
- **Template anatomy.** This is a population average. Sulci are shallow and blurred compared with an individual's
  pial surface. The medial walls are flat cut caps, not anatomy.
- **The cerebellum cut is unverified.** See above.

## What shipping it would need

1. An owner decision via DOG-123.
2. An attribution entry for the derived surface citing `icbm152-2009c`. Unlike the `BV` template, this one
   redistributes image-derived geometry.
3. A clearance-group file of its own under §7.3. It must not be cut into the cleared Z-Anatomy file.
4. A place under the budget. **It does not fit as prototyped.** The low-res brain share is 1.00 MiB
   (1,048,576 B). `lowResBrainAssetGzipBytes` counts everything under `assets/brain/` that is not lazy, so the
   committed low tier *and* its `structures.json`. Since the origin test added the corpus callosum and midbrain,
   that reads 829,850 B, which leaves 218,726 B. This low tier is 275,214 B, so it would overrun by about 56 KB,
   before a structures document of its own. Shipping it needs a smaller cortex tier (the recommendation), a lower
   ratio for the rest, or a re-split of the 2.5 MiB line with W3. (The prototype was sized at 280,000 B against
   an earlier reading that counted the mesh file alone; that reading was wrong.) Separately, the full tier is
   8,579,546 B gzip, against 5,320,761 B for the whole committed full tier and the 5,505,024 B line. It is
   lazy-loaded, but it would be a budget decision of its own.
