# Brain structure origin test: pre-registration (DOG-127)

**Status:** pre-registered. This document and `tools/lib/origin-test.mjs` were
committed **before** any reference mesh was downloaded and before any residual
was computed. `git log -- tools/lib/origin-test.mjs docs/brain-origin-test.md`
shows the order. Results go in a separate section, added in a later commit. The
thresholds are not edited in that commit or after it.

## What it decides

`docs/asset-licensing.md` §7.3 holds 146 brain.glb structures whose Z-Anatomy
materials name no licence. Two groups of them can clear by measurement.

| group | structures | reference it must match | clears to |
| --- | --- | --- | --- |
| cortex | the 126 held cortical structures | Anderson Winkler, *Brain for Blender*: FreeSurfer `fsaverage` split by the Destrieux parcellation (`brainder-brain-for-blender`) | `brainder-brain-for-blender` |
| `Temporal lobe`-only | corpus callosum, midbrain ×2 | BodyParts3D 4.0's own FMA meshes (`bodyparts3d`, cleared under D1) | `bodyparts3d` |

The origin test is necessary for the cortex, and it is **not sufficient**. The
CTO's condition (b) on DOG-127 also needs a verdict that FreeSurfer's terms let
Winkler grant CC BY-SA 3.0 on the fsaverage surfaces and the Destrieux parcels.
If that verdict is not "permits", this test clears no cortex, whatever it shows.

## The test

1. **Alignment.** There is **one similarity transform** (rotation, uniform scale
   and translation) per test set, fitted jointly on all of that set's structures
   by iterative closest point. The fit starts from the stated axis conventions
   on each side.
   - There is never one transform per structure. A per-structure fit would let
     any surface of roughly the right size and shape "match".
   - For the corpus callosum and midbrain, the transform is fitted on
     Z-Anatomy structures that are cleared and have a BodyParts3D counterpart.
     The three held structures are **not** in the fit, so their residuals are
     held-out figures.
2. **Per-structure figures**, in the reference's millimetres:
   - **mean symmetric surface distance:** the mean of the vertex-to-surface
     distances in both directions;
   - **p95:** the 95th percentile of the candidate → reference distance;
   - **label agreement:** the share of candidate vertices whose nearest reference
     vertex lies in the same-named parcel. This tests the delineation as well as
     the surface: the same cortex cut along different borders is a different
     delineation.
3. **The pass rule.** A structure passes only if it meets **all three**:
   - mean symmetric distance ≤ **1.5 mm**;
   - p95 ≤ **3.0 mm**;
   - label agreement ≥ **0.90**.

   A structure that fails is recorded as unknown-origin, and it stays NOT CLEARED.
4. **The negative control.** Every candidate is also scored against the nearest
   reference parcel with a **different** name. If more than **5%** of those
   mismatched pairs also pass, the test does not discriminate, and it clears
   **nothing**.
5. **Surface choice.** If the reference publishes several surfaces of one
   subject (pial, white and so on), the test runs on each one. The single
   surface with the most passes is reported, together with the counts for every
   surface. The choice is global, never per structure.

## Why these numbers

The question is binary: is this mesh the reference mesh, modified by
decimation, or is it a different mesh? The thresholds are set to separate those
two cases.

- **Same mesh, decimated.** Z-Anatomy's cortical structures have about 100 to
  700 vertices each, over gyral areas of a few thousand mm², so the edges are
  roughly 2 to 4 mm long. Re-triangulating a smooth surface at that edge length
  moves it by well under a millimetre on average. The worst case, at a sulcal
  fundus, is a millimetre or two. 1.5 mm mean and 3.0 mm p95 leave that room
  and no more.
- **A different brain or template.** Sulcal positions vary between individuals
  and between templates by about 5 to 10 mm, and sulcal depth is 1 to 2 cm. A
  cortex not derived from fsaverage cannot keep a 1.5 mm mean over a whole
  gyrus under one global similarity.
- **0.90 label agreement.** This allows border disagreement along roughly one
  vertex ring of a 100 to 700-vertex parcel. A parcel cut by a different scheme,
  for example DKT where Destrieux is expected, disagrees over far more than that.
- **The 5% negative control.** This is what stops a threshold that is simply too
  loose from looking like a result. If mismatched pairs pass, the numbers above
  are wrong for this data, and the honest outcome is "not established", not a
  clearance.

The same rule applies to the corpus callosum and midbrain, against BodyParts3D.
Z-Anatomy is built on BodyParts3D, so a structure Z-Anatomy took from it should
match to within re-meshing error under the same global transform as its cleared
neighbours.

## What a result is

Each structure is reported with its three figures, its pass or fail, and the
negative-control figure for the same structure. The aggregate report states:

- the transform and its scale;
- how many structures passed, and how many control pairs passed;
- for every structure that failed, which criterion it failed.

A structure moves out of `zanatomy-undeclared-brain-materials` only on a pass
**and**, for the cortex, a "permits" verdict on condition (b).

---

## Results (added after the run; nothing above this line was changed)

### Cortex against Brainder: not run, because it cannot clear anything

Condition (b) came back **not established** (`docs/asset-licensing.md` §7.8). The
same reading also corrected a premise in the table above. Brain for Blender is
not FreeSurfer `fsaverage`: it is one individual's brain, reconstructed with
FreeSurfer 5.2.0. The test design does not depend on which brain it is, but no
cortical structure can clear while (b) stands, so the matching was deferred
rather than run.

### Corpus callosum and midbrain against BodyParts3D 4.0, run 2026-10-11

`tools/test-bp3d-origin.mjs`. The full figures are in
`packages/atlas-assets/provenance/origin-test-bodyparts3d.json`.

- **Inputs:** brain.glb at the pinned SHA-256, and `isa_BP3D_4.0_obj_99.zip`,
  SHA-256 `40665852…409e`, which is the digest §2 of the licence memo records.
- **Fit:** 14 cleared structures with sided BodyParts3D counterparts:
  - caudate, putamen, hippocampus, lateral ventricle, superior colliculus and inferior colliculus, each left and right;
  - the third and fourth ventricles.
- **Transform:** one similarity for all of them, scale 1024.5 mm per mesh metre.
  ICP converged to a 0.31 mm mean in 26 iterations.
- **Held out:** the three structures under test. BodyParts3D's midbrain is two
  element files, one per side, and each half was matched to the element on its own side.

| held out | mean symmetric | p95 | label agreement | verdict | control (nearest other) |
| --- | ---: | ---: | ---: | --- | --- |
| Midbrain.l | 0.060 mm | 0.139 mm | 0.989 | **pass** | fails against the superior colliculus |
| Midbrain.r | 0.061 mm | 0.142 mm | 0.990 | **pass** | fails against the inferior colliculus |
| Corpus callosum | 0.227 mm | 0.378 mm | **0.769** | **fail** (label agreement) | fails against the third ventricle |

**Negative control:** 0 of 17 mismatched pairs pass, so the test discriminates.

**What this decides:**
- **Midbrain L and R clear.** They are BodyParts3D's own meshes, scaled by 1.0245,
  to within 0.14 mm at p95. They ship from brain.glb and cite `bodyparts3d`.
- **The corpus callosum does not clear by this test.** Its surface matches to
  0.23 mm on average. But 23% of its vertices lie nearer another reference
  surface, mostly the ventricles it is pressed against, than its own. The rule
  needs all three criteria, and the threshold stays where it was committed.
- **The corpus callosum ships from BodyParts3D instead,** under the CTO's route
  of 2026-10-11 18:32: BodyParts3D's FMA86464 mesh, placed into the brain-mesh
  frame by the inverse of the transform above. Its registration residual is the
  fit's 0.31 mm ICP mean. Its deviation from the Z-Anatomy surface it replaces is
  0.227 mm mean.

**One finding outside the question asked.** The four colliculi were in the fit
as "cleared by inference" (material `Nucleus`). They do **not** match
BodyParts3D: p95 about 9.6 mm, label agreement about 0.64. So they are not
BodyParts3D's own colliculi. They may still be Z-Anatomy's own modelling, which
Z-Anatomy's licence covers, so this does not by itself un-clear them. It does
show that the material-name inference can be wrong about *which* cleared source
a structure came from. That is reported to the CTO on DOG-123, not resolved here.

**Decided since (CTO, DOG-127, 2026-10-11 19:54): the colliculi are held.** Their
clearance rested on the material inference alone, this test is the first direct
evidence about that inference, and it was wrong about their source. An
unsettled source does not ship. `DECISION_HOLDS` in
`tools/lib/brain-provenance.mjs` holds all four by name, citing the decision, in
the group `held-by-decision`. W2 ships 244 structures.

**What was and was not pre-registered.** The thresholds and the alignment rule
were committed first, in `0c98385`, and have not changed since. The matching
machinery was not committed first: `tools/lib/origin-match.mjs`,
`tools/test-bp3d-origin.mjs`, the reference parcel set and the 14-structure fit
set all landed in the results commit, `60be6f9`, so they were chosen with the
reference in hand. The results give no sign of tuning toward a pass: the midbrain
passes by about 10x, and the corpus callosum failed. The fit set also contains
the four colliculi, which mismatch at p95 ≈ 9.6 mm. They contribute to the one
similarity transform, and the fit converged to 0.31 mm regardless.

### Structures cleared by material inference alone

Under the CTO's follow-up, these are the cleared structures whose standing
rests on the §7.3 material-name inference and nothing else. They are every
cleared record in `packages/atlas-assets/provenance/brain-zanatomy-2929e94.json`
whose `basis` reads "cleared BY INFERENCE". There are **145 of 244**. The
other 99 rest on something more:
- 96 are imaging-registered, cleared by their atlas;
- 2 (the midbrain) passed this test;
- 1 (the corpus callosum) ships from BodyParts3D directly.

A dagger (†) marks the 10 that this test did measure, as fit structures. Each one
matched BodyParts3D within all three thresholds, with p95 ≤ 0.30 mm and label
agreement ≥ 0.93. That evidence is weaker than a held-out pass, because the
transform was fitted on them. The other 135 have no direct evidence of their
source.

| category | material | n | structures |
| --- | --- | ---: | --- |
| arteries | `Artery` | 48 | Anterior cerebral artery.l, Anterior cerebral artery.r, Anterior communicating artery, Anterior inferior cerebellar artery.l, Anterior inferior cerebellar artery.r, Anterior spinal artery.l, Anterior spinal artery.r, Basilar artery, Callosomarginal artery.l, Callosomarginal artery.r, Distal lateral striate branches.l, Distal lateral striate branches.r, Frontal branches of callosomarginal artery.l, Frontal branches of callosomarginal artery.r, Insular branches of middle cerebral artery (M2).r, Insular branches of middle cerebral artery (M2-segment).l, Internal carotid artery.l, Internal carotid artery.r, Lateral pontine branches of basilar artery.l, Lateral pontine branches of basilar artery.r, Medial pontine branches of basilar artery.l, Medial pontine branches of basilar artery.r, Middle cerebral artery (M1-segment).l, Middle cerebral artery (M1-segment).r, Middle cerebral artery (M3 segment).l, Middle cerebral artery (M3-segment).r, Ophthalmic artery.l, Ophthalmic artery.r, Orbitofrontal branches of anterior cerebral artery.l, Orbitofrontal branches of anterior cerebral artery.r, Parietal branches of middle cerebral artery.l, Parietal branches of middle cerebral artery.r, Pericallosal artery.l, Pericallosal artery.r, Posterior cerebral artery.l, Posterior cerebral artery.r, Posterior communicating artery.l, Posterior communicating artery.r, Posterior inferior cerebellar artery.l, Posterior inferior cerebellar artery.r, Proximal lateral striate branches.l, Proximal lateral striate branches.r, Superior cerebellar artery.l, Superior cerebellar artery.r, Temporal branches of middle cerebral artery.l, Temporal branches of middle cerebral artery.r, Vertebral artery.l, Vertebral artery.r |
| brainstem | `LCR` | 1 | Aqueduct of midbrain |
| brainstem | `Nucleus` | 6 | Olive.l, Olive.r, Pyramid of medulla oblongata.l, Pyramid of medulla oblongata.r, Red nucleus.l, Red nucleus.r |
| brainstem | `Nucleus (afferent fibers)` | 2 | Vestibular nuclei.l, Vestibular nuclei.r |
| brainstem | `Nucleus (efferent fibers)` | 10 | Accessory nucleus of oculomotor nerve.l, Accessory nucleus of oculomotor nerve.r, Motor nucleus of facial nerve.l, Motor nucleus of facial nerve.r, Nucleus of abducens nerve.l, Nucleus of abducens nerve.r, Nucleus of oculomotor nerve.l, Nucleus of oculomotor nerve.r, Superior salivatory nucleus.l, Superior salivatory nucleus.r |
| cerebellum | `Cerebellum` | 31 | Anterior quadrangular lobule.l, Anterior quadrangular lobule.r, Biventral lobule.l, Biventral lobule.r, Central lobule, Culmen, Declive, Flocculus.l, Flocculus.r, Folium of vermis, Gracile lobule.l, Gracile lobule.r, Inferior semilunar lobule.l, Inferior semilunar lobule.r, Lingula of cerebellum, Nodule of vermis, Peduncle of flocculus.l, Peduncle of flocculus.r, Posterior quadrangular lobule.l, Posterior quadrangular lobule.r, Pyramis of vermis, Superior cerebellar peduncle.l, Superior cerebellar peduncle.r, Superior semilunar lobule.l, Superior semilunar lobule.r, Tonsil of cerebellum.l, Tonsil of cerebellum.r, Tuber of vermis, Uvula of vermis, Wing of central lobule.l, Wing of central lobule.r |
| cortex | `Nucleus` | 2 | Hippocampus.l †, Hippocampus.r † |
| cranial_nerves | `Bone-4` | 2 | Hypoglossal nerve (XII).l, Hypoglossal nerve (XII).r |
| cranial_nerves | `Nucleus (afferent fibers)` | 2 | Sensory root of trigeminal nerve.l, Sensory root of trigeminal nerve.r |
| deep_grey | `Nucleus` | 5 | Caudate nucleus.l †, Caudate nucleus.r †, Putamen.l †, Putamen.r †, Septal nuclei |
| diencephalon | `Nucleus` | 10 | Adenohypophysis, Habenula, Lateral geniculate body.l, Lateral geniculate body.r, Mamillary body.l, Mamillary body.r, Medial geniculate body.l, Medial geniculate body.r, Neurohypophysis, Pineal gland |
| meninges_dura | `Cartilage` | 3 | Falx cerebri, Tentorium cerebelli.l, Tentorium cerebelli.r |
| veins_sinuses | `Artery` | 17 | Anterior intercavernous sinus, Basilar venous plexus, Cavernous sinus.l, Cavernous sinus.r, Inferior petrosal sinus.l, Inferior petrosal sinus.r, Inferior sagittal sinus, Occipital sinus, Posterior intercavernous sinus, Sigmoid sinus.l, Sigmoid sinus.r, Straight sinus, Superior petrosal sinus.l, Superior petrosal sinus.r, Superior sagittal sinus, Transverse sinus.l, Transverse sinus.r |
| ventricles | `Artery` | 2 | Choroid plexus.l, Choroid plexus.r |
| ventricles | `LCR` | 4 | Fourth ventricle †, Lateral ventricle.l †, Lateral ventricle.r †, Third ventricle † |

The manifest is the authority for this list, and CI re-derives the manifest on
every run. If the two disagree, the manifest is right.
