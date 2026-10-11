# Atlas asset licensing — the D1 memo

**Status:** D1 implemented and settled; share-alike confirmed MANDATORY by the owner
**Date:** 2026-10-09
**Owner:** Anatomy Data Engineer
**Decides:** DOG-2 D1 (mesh licence), DOG-35 licence clearance

This is an engineering memo. It records what was measured about each upstream
licence, what the pipeline does about it, and what is *not* cleared. It is not
legal advice.

Both open questions were put to the repository owner on 2026-10-09 and both are
answered. Share-alike on the atlas geometry is **mandatory** (§3). The brain
parcellation verdict **stands as NOT CLEARED**, and the owner's direction is to
route around it with first-party labels rather than to negotiate for someone
else's parcellation (§4).

---

## 1. What D1 decided, and what it obliges

The repository owner approved **D1 on 2026-10-09**: body geometry comes from
BodyParts3D under **CC BY-SA 2.1 Japan**. Four consequences follow, and all four
are implemented rather than described:

| consequence | where it is implemented | enforced by |
| --- | --- | --- |
| DBCLS attribution ships with the assets | `packages/atlas-assets/attribution.json` → `ATTRIBUTION.md` → `dist/assets/` | `tools/check-licence-separation.mjs` rules 5 and 6 |
| the mesh package and its derivatives are share-alike | `attribution.json` entry `bp3d-bd-body-template`, `shareAlike: true`, CC BY-SA 4.0 | rule 5 requires `shareAlike` to be stated explicitly per entry |
| code packages stay Apache-2.0 | `packages/alc`, `packages/atlas-web`, `atlas.licenceClass: "code"` | rules 1–4 |
| no build-time dependency on an asset licence | no dependency edge, no import, asset package outside the workspace list, no asset bytes in the bundle | rules 2, 3, 4, 6, 7 |

**The atlas geometry therefore cannot be made proprietary.** The owner confirmed
on 2026-10-09 that this consequence is **mandatory** rather than elective, which
settles the one thing §2's upstream discrepancy could otherwise have reopened.
See §3.

### What actually ships, per file

| file | licence | share-alike | derived from |
| --- | --- | --- | --- |
| `templates/bp3d-4.0-adult-body-centroid.body.json` | CC BY-SA 4.0 | **yes** | BodyParts3D meshes |
| `labels/names.json`, `labels/coverings.json` | CC BY-SA 4.0 | **yes** | BodyParts3D meshes + terms, UBERON xrefs |
| `templates/icbm152-2009c-asym.brain-volume.json` | MNI BIC permissive | no | ICBM152 header and brain mask |
| `geometry/placeholder-body-shell.lowres.json` | Apache-2.0 | no | first-party |
| `labels/alc-1-levels.json` | Apache-2.0 | no | first-party |

Share-alike is **per entry, not per package**. First-party assets in the same
directory stay Apache-2.0, and CI checks that every payload file is covered by
exactly one entry naming a licence, a holder and a source.

No mesh vertices from BodyParts3D are redistributed. The body template is a
spine centreline, 25 per-level frames and 25 × 72 measured radii — about 60 kB
derived from 136 MB. It is nevertheless an **adaptation** of those meshes, which
is what share-alike attaches to most firmly, so it carries the obligation.

---

## 2. What was measured upstream

### BodyParts3D — two statements that disagree

The distribution says one thing and the website says another. Both were read on
2026-10-09, from the official DBCLS/NBDC archive.

**The OBJ payloads' own header comments**, in every mesh file in the current
`isa_BP3D_4.0_obj_99.zip`, verbatim:

```
# The license for this database is specified in the Creative Commons
# Attribution-Share Alike 2.1 Japan. If you use data from this database,
# please be sure attribute this database as follows: "BodyParts3D, (c)
# The Database Center for Life Science licensed under CC Attribution-Share
# Alike 2.1 Japan".
# http://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html
```

**The licence page those headers point at**, last updated 2025-02-27:

> The license for this database is specified in the Creative Commons
> Attribution 4.0 International. If you use data from this database, please be
> sure attribute this database as follows: "BodyParts3D, © The Database Center
> for Life Science licensed under CC Attribution 4.0 International".

- <https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html>
- <https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html>
- archive SHA-256 `40665852c49f218326590e204db91064a1ecfc3c6f8cbd7bbbcaac62c7cd409e`

So the bytes we downloaded say **BY-SA 2.1 Japan** and the page says **BY 4.0**.
CC BY 4.0 is *not* share-alike; CC BY-SA 2.1 Japan is. D1 as approved describes
the file headers.

**The pipeline holds the share-alike reading**, and the reason is an asymmetry
rather than a preference:

- If upstream really is BY-SA, shipping our derivative BY-SA 4.0 is compliant.
  (BY-SA 2.1 JP permits adaptations under a later version of the same licence
  with the same elements.)
- If upstream really is BY 4.0, shipping BY-SA 4.0 is **still permitted** — CC
  BY 4.0 §3(b) explicitly contemplates an Adapter's License on adapted material.
  It would only mean we were being stricter than obliged.

Never retroactively wrong, in other words, whichever way the discrepancy
resolves. The reverse choice — treating it as BY 4.0 and relicensing the
geometry proprietary — is the one that cannot be undone, because by the time the
discrepancy is settled the geometry has already shipped under terms that may not
have been ours to grant.

That argument is what the decision in §3 was taken on, and the decision has now
removed the second branch: the owner elected the strict reading, so being
stricter than obliged is the outcome and not a provisional posture.

### ICBM152 2009c — permissive, and no image data redistributed

`COPYING`, verbatim from `mni_icbm152_nlin_asym_09c_nifti.zip` (SHA-256
`804382e5d68a42ff8096ee845a7600b6658434da762fa67840a149eb25d48bd4`):

> Copyright (C) 1993-2004 Louis Collins, McConnell Brain Imaging Centre,
> Montreal Neurological Institute, McGill University. Permission to use, copy,
> modify, and distribute this software and its documentation for any purpose and
> without fee is hereby granted, provided that the above copyright notice appear
> in all copies. The authors and McGill University make no representations about
> the suitability of this software for any purpose. It is provided "as is"
> without express or implied warranty. […]

Permissive, no share-alike, no non-commercial clause, one condition: the
copyright notice travels with copies. That notice is reproduced verbatim inside
the `BV` template's own provenance block *and* in `attribution.json` *and* in
`ATTRIBUTION.md`, so it travels with every copy of the file and into the built
site.

What ships from it is six distances, one landmark and three unit vectors,
measured from the distribution's brain mask and its NIfTI affine. **No voxel
data is redistributed.** Citation is recorded in the template
(`provenance.source.citation`): Fonov et al., *NeuroImage* 54:1 (2011) and 47:S102
(2009).

### UBERON — CC BY 3.0

`names.json` carries UBERON ids read from UBERON's own `xref: FMA:` lines in
`basic.obo`, data version recorded in `names.json`
(`provenance.uberon.dataVersion`) with the file's SHA-256. UBERON is CC BY 3.0,
which BY-SA 4.0 satisfies, so the combined file is BY-SA 4.0 overall.

---

## 3. Share-alike is MANDATORY — decided by the owner, 2026-10-09

The discrepancy in §2 was put to the repository owner, with the evidence and
with the observation that holding share-alike cannot create a violation under
either reading. **The owner chose `mandatory`:**

> **Mandatory — the atlas geometry can never be made proprietary.**

So this is settled, and settled in the strict direction. It is not a default we
fell into and not a posture pending DBCLS; it is a decision, and the rest of
this section is what it forecloses.

**What it means.** The OBJ file headers govern. Every asset in this package that
derives from the BodyParts3D meshes is share-alike permanently: the body
template, `names.json`, `coverings.json`, and anything a later release derives
from them. **No future release can relicense the atlas geometry proprietary**,
whatever DBCLS may later say about their own page.

**What it closes.** There is no D1a. Asking DBCLS to reconcile their headers
with their page is still worth doing as housekeeping, and it would still be
useful to know, but it can no longer change our outcome — a confirmation of
CC BY 4.0 upstream would merely mean we are being stricter than obliged, which
is exactly what the owner elected. An engineer finding that confirmation later
must not read it as permission to relax this.

**What it does not touch.** First-party assets in this package stay Apache-2.0
and the ICBM152-derived `BV` template stays under the permissive MNI BIC terms
(§2) — the decision is about *the geometry derived from BodyParts3D*, not about
the directory. Code packages remain Apache-2.0 with no build-time dependency on
any asset licence, which is §1's table and is checked on every push.

One consequence worth stating plainly for whoever plans a commercial release:
share-alike does not prevent commercial use. It prevents *proprietary* use. The
atlas geometry can be sold, hosted and built on; it cannot be closed.

---

## 4. Brain parcellation — **VERDICT: NOT CLEARED**

**`BV` ships coordinates without names.** This was the outcome the brief asked
to hear early if it was going to happen, and it is happening.

### What that means concretely, already implemented

- There is **no `BV` name index**. `names.json` and `coverings.json` are `BD`
  only, and `coverings.json` declares `"frame": "BD"`.
- The **brain is absent from the `BD` index entirely**. It was listed, and the
  measurement removed it: 0.2% of its interior samples fall inside the `BD`
  frame, because the brain sits almost entirely above `C01`. A covering built
  from its clamped points would assert that the brain is the first cervical
  vertebra. `tools/lib/bp3d.mjs` records the removal and why.
- `BV` addresses therefore **locate and round-trip but do not resolve to a
  name**. The frame works: `tools/verify-asset-templates.mjs` checks the AC-PC
  landmarks, the bounding box and an exact mm → local → mm inverse.
- `docs/alc-1-body-template-audit.md` §9 and §10 publish this, so a consumer
  reading the audit cannot miss it.

### Why none of the three candidates is cleared

| parcellation | why it is not cleared |
| --- | --- |
| **Harvard-Oxford** | Distributed with FSL. FSL's own licence is free for non-commercial use and requires a commercial licence otherwise; the atlas is also derived from subject data with its own consent terms. Redistribution inside a commercial product is not something we can assume. |
| **AAL** | Requires registration and a licence agreement, and the published terms restrict redistribution. AAL3's terms are stricter than AAL1's. |
| **Julich-Brain** | Published on EBRAINS under CC BY-NC-SA 4.0 — **non-commercial and share-alike at once**. The NC term is the blocker: unlike share-alike, there is no direction in which accepting it is safe, because it forecloses commercial use outright rather than constraining how derivatives are licensed. |

**An honesty note on this table.** Unlike §2, these rows are *not* verified
against primary sources fetched in this run. The EBRAINS and FSL licence pages
are client-rendered and returned no licence text to a plain fetch; the AAL host
did not respond. That absence of verification is not a gap in the verdict — it
*is* the verdict. An uncleared licence stays uncleared until somebody clears it
in writing, and "we could not read the terms" is a reason to ship without names,
never a reason to ship with them.

### The owner's direction, 2026-10-09 — the verdict stands and the route is first-party labels

The verdict was put to the owner. They did not ask for any of the three to be
chased, and they drew a distinction that is the useful part of the answer:

> We want to get the usable models for display. Then we want to get to the
> labels that are usable, corresponding to literature. **The labels themselves
> that are in literature should not be copyrighted kinds. But, if they come with
> the model and are attached as copyrighted materials such that we do not have
> license to use them, we will not use them.** […] Either you find a different
> model to use in the Atlas, and we apply labels ourselves based on later
> reconstruction, or you use the available models without violating any
> copyrights, and we can tack on the labels later ourselves.

**The distinction, stated precisely, because it is what makes the route legal.**
Two different things get called "a label":

| | what it is | protectable? |
| --- | --- | --- |
| the **term** | "hippocampus", "Brodmann area 44" — an anatomical name used in the literature | No. A name is not a creative work, and anatomical nomenclature is the common vocabulary of the field. This is what the owner means by "should not be copyrighted kinds". |
| the **parcellation** | the voxel-by-voxel delineation that assigns each millimetre of a template to one of those terms | **Yes, in substance.** It is the product of expert labour and the thing an atlas publisher actually licenses. This is what Harvard-Oxford, AAL and Julich-Brain are. |

So "use the names, not the parcellation" is not a loophole — it is the only
reading under which the two halves of the owner's answer are consistent. We may
use the vocabulary freely; we may not take someone else's delineation.

**Consequences, which are now decisions and not options:**

1. **`NOT CLEARED` is final for these three, not pending.** The owner's "we will
   not use them" closes it. Nobody should reopen Harvard-Oxford, AAL or
   Julich-Brain by obtaining a grant unless the owner asks for that specifically;
   the instruction was to route around them, not to negotiate with them.
2. **The ICBM152 `BV` template already satisfies the owner's second path.** It is
   a usable model for display, under permissive MNI BIC terms (§2), carrying no
   labels and therefore no label licence. "Use the available models without
   violating any copyrights" is what shipped. No change is required to it.
3. **`BV` keeps shipping coordinates without names until a first-party label
   layer exists**, and that layer is new scope rather than a gap in this task.
   What it needs, so the next owner of it is not starting cold:
   - a `BV` name index with the same shape as the `BD` one — a covering per
     structure, an explicit index version, and the same
     `tools/verify-asset-templates.mjs` checks;
   - per structure, a delineation **we** produced, with its provenance recorded
     the way every other number in this package is. Reconstructing one from the
     literature is a research task, not a pipeline task, and it is the step the
     owner called "later reconstruction";
   - the terms themselves can come from UBERON and FMA, which this package
     already reads and which are CC BY 3.0 and already attributed.
4. **Deferring it costs nothing already issued.** A name is only true relative to
   an index, every `resolve()` result is stamped with one, and
   `tools/verify-asset-templates.mjs` proves an address keeps its millimetres and
   its canonical form across an index revision. **Adding `BV` names later
   invalidates no address already issued** — which is precisely why "tack on the
   labels later" is a safe instruction to accept.

One thing I did **not** do, deliberately: I did not go looking for a
permissively licensed parcellation to substitute. That would be the third path
and the owner named only two, both of which end at labels we make ourselves. If
a permissive parcellation is wanted as a shortcut, it needs to be asked for —
adopting someone else's delineation is the thing both of the owner's paths avoid.

---

## 5. `BR` stays disabled

`locate('BR-…')` refuses with `frame_disabled`, and
`tools/verify-asset-templates.mjs` fails if it ever stops refusing. `BR` needs a
redistributable fsaverage-class surface template with per-vertex spherical
coordinates, and no such asset is cleared. The codec is complete and still
parses, so shipping it disabled costs nothing and enabling it later is additive.

Not a v1 blocker, and it must not be enabled to make a test pass.

---

## 6. Summary for the acceptance criteria

| criterion | status |
| --- | --- |
| DBCLS attribution ships with the assets | **done** — `attribution.json` → `ATTRIBUTION.md` → `dist/assets/`, enforced |
| mesh package and derivatives under a compatible share-alike licence | **done** — CC BY-SA 4.0, per-entry `shareAlike: true` |
| code packages still Apache-2.0, no build-time dependency on an asset licence | **done** — 7 structural rules, checked twice per CI run |
| verdict on the brain parcellation licence | **NOT CLEARED**, and now final rather than pending. `BV` ships coordinates without names; the owner's route is first-party labels; see §4 |
| `BR` stays disabled | **done** — gated, see §5 |
| D1 discrepancy | **decided by the owner 2026-10-09: share-alike is mandatory.** §3. There is no D1a. |

---

## 7. Atlas v2 upstreams — the W1 memo (DOG-126, 2026-10-11)

**Scope:** DOG-123 D1 (the brain mesh), D2 (the full human) and D3 (Allen as `asset-nc`).
**Method:** every licence was read at its **primary** source on 2026-10-11, where
"primary" means the licensor's own record: the deposit's licence field, the
licence file inside the distribution, or the licensor's own page. brainproject's
statements about its inputs are claims, and they are checked here rather than
relied on. Where a deposit's metadata and its own files disagree, both are
recorded, and the stricter reading is held.

The machine-readable form of this section is `upstreamSources` in
`packages/atlas-assets/attribution.json`. That is where W2 and W3 cite these
sources from, and the licence gate (rules 8 and 9) enforces it.

### 7.1 Verdicts

| source (`upstreamSources` id) | verdict | licence, as the primary source states it | primary source |
| --- | --- | --- | --- |
| brainproject `brain.glb` + `manifest.json` (`brainproject-brain-glb`) | **cleared, per structure only** | CC BY-SA 4.0 for the model; Apache-2.0 for the code | `LICENSE` and `README.md` at the pinned commit, <https://github.com/itayinbarr/brainproject> |
| Z-Anatomy (`zanatomy`) | **cleared for its own work and the BodyParts3D meshes only** | CC BY-SA 4.0, with five third-party models listed separately | `License.txt` at the pinned commit, <https://github.com/Z-Anatomy/Models-of-human-anatomy> |
| BodyParts3D / DBCLS (`bodyparts3d`) | cleared, share-alike mandatory (§3) | CC BY-SA **2.1 Japan** in the OBJ headers; CC BY 4.0 on the web page | <https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html> (re-read; still "Last updated 2025/02/27") |
| Brainder, Brain for Blender (`brainder-brain-for-blender`) | cleared, but **not yet shown to be Z-Anatomy's "Brainder"** | CC BY-SA 3.0 Unported, Anderson Winkler | <https://brainder.org/research/brain-for-blender/> |
| Z-Anatomy "Brainder" and "White matter (University of Washington)" materials (`zanatomy-undeclared-brain-materials`) | **NOT CLEARED** | none declared | Z-Anatomy `License.txt`; upstream question open as [Z-Anatomy#10](https://github.com/Z-Anatomy/Models-of-human-anatomy/issues/10) |
| Dundee CAHID, Cranial Nerves and Foramina (`dundee-cranial-nerves`) | **UNVERIFIED** | Z-Anatomy says CC BY 4.0; the primary page states no licence and calls itself BodyParts3D-derived (BY-SA 2.1 JP) | <https://sketchfab.com/3d-models/cranial-nerves-and-foramina-a9358ee7a6dd4ea18a3622114405a4c7> |
| Dundee, Anatomy of the Inner Ear (`dundee-inner-ear`) | **non-commercial**, asset-nc only | CC BY-NC-SA 4.0, as stated by Z-Anatomy | Z-Anatomy `License.txt` |
| Cowley, Kidney (`cowley-kidney`) | **non-commercial**, asset-nc only | CC BY-NC 4.0, as stated by Z-Anatomy | Z-Anatomy `License.txt` |
| CIT168 subcortical v1.1.0 (`cit168-subcortical`) | cleared | CC BY 4.0 | OSF node licence, <https://osf.io/jkzwp/> |
| CIT168 amygdala v1.0.3 (`cit168-amygdala`) | cleared | CC BY-SA 4.0 (the distribution's own `LICENSE.txt`) | <https://osf.io/hksa6/>, file `LICENSE.txt` |
| Najdenovska thalamus (`najdenovska-thalamus`) | cleared, with a note | CC BY-SA 4.0 | Zenodo record licence, <https://doi.org/10.5281/zenodo.1405484> |
| Neudorfer hypothalamus (`neudorfer-hypothalamus`) | cleared | CC BY 4.0 | Zenodo record licence, <https://doi.org/10.5281/zenodo.3942115> |
| HCP1065 tracts, Yeh 2022 (`hcp1065-yeh2022`) | cleared, plus the HCP acknowledgement | CC BY-SA 4.0 for `hcp1065_avg_tracts_nifti.zip` | release notes, <https://github.com/data-others/atlas/releases/tag/hcp1065> (formerly `frankyeh/data-atlas`) |
| Allen Institute / brain-map.org (`allen-brain-map`) | **non-commercial**, asset-nc only (D3) | Terms of Use, "Updated: May 5, 2022"; citation policy | <https://alleninstitute.org/legal/terms-of-use>, <https://alleninstitute.org/legal/citation-policy> |

Every BY and BY-SA input above is compatible with shipping the v2 geometry as
**CC BY-SA 4.0**:
- BY 4.0 permits an adapter's licence.
- BY-SA 3.0 and BY-SA 2.1 Japan both permit a later version with the same elements.

The rows that are not cleared, or are non-commercial, are the ones that decide
what W2 and W3 can ship.

### 7.2 Pins

**brainproject**, commit `2929e94f521a8ddceab26bc100a98dc06b0da060` (2026-06-19):

| artefact | SHA-256 |
| --- | --- |
| archive `codeload.github.com/itayinbarr/brainproject/tar.gz/2929e94…` | `f42f198812aab352bf5127b95a2821d3b5ecb42d4a6dfcd5464930987a1a3ed9` |
| `brain-atlas/models/brain.glb` (4,650,816 B) | `76a49ea4526a4880613aec7a02756bd7301b0b9d0680d7cae33e197b672c5453` |
| `brain-atlas/models/manifest.json` (232,455 B) | `66c32355e02c3ba5fadf3b3bdb61b18c619162d6c5ee2083262e59bed4274d93` |

GitHub generates the archive digest and does not promise its bytes are stable,
so W2 must verify against the **per-file** digests and use the archive digest
only as a cross-check.

**Z-Anatomy**, commit `9de5d6912a1b0df9cab739d57f00e036b0496ddc` (2026-10-10):
- `License.txt` has SHA-256 `196b66b56551a862e59872f7cdb70e6d9a6ad84e9105962fca8ec28c14e97520`.
- `Z-Anatomy.zip` (86,734,957 B) has git blob `f43cabc6f366b2a6058dd2ed4a2b3c7b9b2492cb`.
- Its SHA-256 is recorded as `null` and not guessed: the download from this runner stopped at 22 MB after 8 minutes. The blob id content-addresses the same bytes, and W3 records the SHA-256 when it fetches the archive.

brainproject does not say which Z-Anatomy commit its `.blend` came from. That is
one more reason to read provenance from the glb itself (§7.3) and not from
anyone's description of it.

### 7.3 The finding that changes W2: 146 of 437 brain structures are not cleared

Z-Anatomy's licence names five third-party models it "used as reference/included
and adapted". Two of them ("Brainder" and "White matter" from the University of
Washington) carry **no licence**. Someone else redistributing Z-Anatomy asked
upstream about exactly this on 2026-10-06 ([Z-Anatomy#10](https://github.com/Z-Anatomy/Models-of-human-anatomy/issues/10),
open, no reply). They currently exclude every object that uses the Z-Anatomy
materials `Brain`, `Brain-Inner` or `White matter`.

brain.glb keeps those material names, so the question can be measured rather
than guessed. These counts come from walking each `bx_id` node to its
primitives' materials in the glTF JSON chunk:

| Blender material(s) | structures | brainproject `category` | provenance |
| --- | ---: | --- | --- |
| `Brain-Inner` + `Temporal lobe` | 124 | cortex | **undeclared** (Brainder candidate) |
| `Brain` (± `Temporal lobe`) | 9 | 2 cortex, 5 brainstem (pons, medulla, interpeduncular fossa), 2 cerebellum (base of peduncle) | **undeclared** |
| `White matter` | 10 | 6 white matter, 3 diencephalon, 1 ventricles (commissures, fornix, septum pellucidum, stria medullaris) | **undeclared**, no candidate source |
| `Nerve` | 46 | 44 cranial nerves + 2 | Dundee CAHID per Z-Anatomy: **unverified** |
| `Temporal lobe` alone | 3 | corpus callosum (white matter), midbrain ×2 (brainstem) | **undeclared**, held fail-closed |
| `Artery`, `Cerebellum`, `Nucleus*`, `LCR`, `Cartilage`, `Bone-4` | 149 | arteries, cerebellum, nuclei, ventricles, … | Z-Anatomy / BodyParts3D: cleared, **by inference** |
| none (imaging-registered) | 96 | 54 tracts (HCP1065), 14 thalamic (Najdenovska), 10 hypothalamic (Neudorfer), 10 CIT168, 8 amygdala | cleared |

**Material names are a negative filter, not a positive one.** A structure
carrying an undeclared material is held. A structure is *not* cleared merely for
carrying none of them. That is why the three `Temporal lobe`-only structures are
held. That material appears otherwise only on the undeclared cortex. Nothing
ties it to Z-Anatomy's own work or to BodyParts3D, and the corpus callosum is
exactly what a "White matter" model would supply. Even the 149 "cleared"
structures clear by an inference from material names (`Artery`, `Nucleus`,
`Cerebellum` and so on read as Z-Anatomy's own BodyParts3D-derived systems), not
by a record of provenance. W2's manifest (below) is what turns that inference
into a checked fact.

**126 of the 128 cortical structures are in the undeclared group.** These are
the gyri and sulci that §1 of the v2 plan relies on to give `BV` names. So the
plan's premise holds only if this group clears.

**What clears it, in order of cost:**

1. **Measure it (W2).** Brainder's Brain for Blender is FreeSurfer cortex split by
   the Destrieux and DKT atlases, under CC BY-SA 3.0. Z-Anatomy's cortex has
   Destrieux names. Match the decoded brain.glb cortex against the Brainder
   meshes, up to a similarity transform, and publish the per-structure residual.
   A structure that matches moves to `brainder-brain-for-blender`, which is
   cleared. This is the same discipline as the body template gate: a structure
   clears on a published number, never on a resemblance.
2. **Ask upstream.** Add to Z-Anatomy#10 rather than open a duplicate. An answer
   naming a compatible licence clears whatever it names.
3. **Ship without it.** W2 ships the 245 cleared structures (437 less these 146
   and the 46 unverified nerves) and lists the excluded ones by name.

Even if (1) succeeds, the 10 `White matter` structures have **no candidate
source**, and nothing short of (2) clears them.

**How the gate holds this, and what it cannot yet see.**
- An entry that cites `zanatomy-undeclared-brain-materials` or
  `dundee-cranial-nerves` fails rule 9.
- An entry that is not first-party and cites **nothing** also fails rule 9.
  Citing is mandatory, so an entry cannot avoid the refusal by leaving the
  failing source out (staged as `licence-third-party-entry-cites-nothing`).
- W2 should emit one file per clearance group, not one `meshes.bin`. A later
  clearance then adds a file instead of re-cutting a shipped one, and the
  uncleared group can never ride along inside a cleared file.

**The residual:** the citation is still self-declared. An entry that cites only
cleared sources while its file contains held structures is green today. Closing
that is **a W2 acceptance criterion**, not this issue's. W2 commits a
structure → material → source manifest generated from the pinned glb, and the
gate cross-checks every entry's `sources` against the structures its file
actually contains.

**The cranial nerves** are unverified for a different reason:
- Z-Anatomy says the Dundee model is CC BY 4.0.
- Dundee's own page states no licence: the Sketchfab API returns an empty licence object.
- That page describes the model as based on BodyParts3D under BY-SA 2.1 Japan, which would make it share-alike at least.

The record holds the share-alike reading. It clears on a statement from Dundee
CAHID, or if W2 shows the nerves are BodyParts3D's own.

### 7.4 What the brief and brainproject said, against the primary sources

| claim | primary source says | consequence |
| --- | --- | --- |
| "Z-Anatomy and BodyParts3D/DBCLS: CC BY-SA 4.0" | Z-Anatomy is BY-SA 4.0. BodyParts3D is **BY-SA 2.1 Japan** (file headers) or BY 4.0 (page); never BY-SA 4.0 | None for us: §3 already holds the share-alike reading, and Z-Anatomy and Dundee both cite 2.1 Japan. Attribution uses DBCLS's own wording. |
| Z-Anatomy credits are complete | brainproject's attribution chain omits Brainder and the two NC models | Ours carries Brainder whenever a structure cites it. NC models never enter a BY-SA file (rule 8). |
| CIT168 amygdala: CC BY-SA 4.0 | The distribution's `LICENSE.txt` says BY-SA 4.0 (changed in 1.0.1, 2016-08-01). The OSF node's licence field says **CC BY 4.0** | Hold BY-SA: the in-distribution file governs, and it is the stricter reading. |
| Najdenovska: CC BY-SA 4.0 | The Zenodo record is BY-SA 4.0. Its `README.txt` says "Copyright (c) - All rights reserved. University of Lausanne. 2018." | Rely on the explicit licence grant on the record; reproduce the copyright line in the attribution. |
| HCP1065 (Yeh 2022): CC BY-SA 4.0 | Correct for the averaged tracts. The same release's fiber templates are under HCP data use terms instead | Cleared for `hcp1065_avg_tracts_nifti.zip` only. |
| imaging-registered structures "remain CC BY-SA 4.0" | CIT168 subcortical and Neudorfer are BY 4.0 | Permitted: BY content may ship inside a BY-SA work. Attribution still names each source. |

**HCP acknowledgement.** CIT168 (both atlases), Najdenovska, Neudorfer and
HCP1065 are all built from Human Connectome Project data. The HCP1065 release
explicitly requires the WU-Minn acknowledgement. The others name HCP as their
source. Every entry citing any of them carries the acknowledgement in its
attribution (`hcp1065-yeh2022.attributionStatement` has the wording).

### 7.5 Allen and the `asset-nc` class

The Allen Terms of Use permit use, copying, distribution and derivative works
"for research or other noncommercial purposes". Commercial redistribution needs
written permission. The citation policy applies to any public display. There is
also a non-assert clause on Improvements, and the trademarks need permission.

None of that is compatible with CC BY-SA, which promises downstream users
commercial use. D3's three conditions are now structural:

| D3 condition | implemented as | enforced by |
| --- | --- | --- |
| a new licence class | per-entry `licenceClass: "asset" \| "asset-nc"` in `attribution.json`, mandatory, never inferred | rule 8 |
| its own files, never merged into BY-SA geometry | an asset-nc entry may not claim a file a share-alike entry claims, and its bytes may not appear inside one | rule 8, by path and by content |
| excluded from the build by default | asset-nc files live only under `atlas.ncPayloadDirs` (`nc/`); the build copies `payloadDirs` and nothing else; `dist/` must contain neither `assets/nc/` nor any NC payload's bytes | rule 8, static and on `dist/` |
| (and its inputs travel) | an entry citing a non-commercial source must be asset-nc; one citing a share-alike source must be share-alike; one citing an uncleared source fails | rule 9 |

`tools/verify-gates.mjs` stages each failure: `licence-nc-in-default-build`,
`licence-nc-merged-into-share-alike`, `licence-nc-in-dist`,
`licence-uncleared-source` and `licence-third-party-entry-cites-nothing`. A `mustPass` baseline,
`licence-nc-segregated-is-not-a-failure`, proves that a correctly segregated NC
layer is let through. The committed tree has no asset-nc entry, so a green run
on the tree alone would say nothing about rule 8.

**v2 lands no Allen bytes**, and there is deliberately no build switch yet.
Whichever representation first ships NC content adds the switch, and with it an
NC licence file beside `dist/assets/nc/`. A default build, which is the only
one CI makes and deploys, still fails rule 8 if that directory appears.

### 7.6 What W2 and W3 must cite

| work item | ships | cites |
| --- | --- | --- |
| W2, brain, cleared group | the 245 structures outside §7.3's undeclared and unverified groups, as BY-SA 4.0 | `brainproject-brain-glb`, `zanatomy`, `bodyparts3d`, and per structure `cit168-subcortical`, `cit168-amygdala`, `najdenovska-thalamus`, `neudorfer-hypothalamus`, `hcp1065-yeh2022` |
| W2, brain, cortex group | the 133 `Brain`/`Brain-Inner` structures, **only after** they move to `brainder-brain-for-blender` by measurement or upstream answer | as above, plus `brainder-brain-for-blender` |
| W2, brain, held | the 10 `White matter` structures, the 3 `Temporal lobe`-only structures and the 46 `Nerve` structures | cannot ship: rule 9 refuses `zanatomy-undeclared-brain-materials` and `dundee-cranial-nerves` |
| W3, body | Z-Anatomy/BodyParts3D whole-body meshes as BY-SA 4.0, **excluding** the inner ear (`dundee-inner-ear`), the kidney (`cowley-kidney`, so take BodyParts3D's own kidney), and every object with the `Brain`, `Brain-Inner`, `White matter` or `Nerve` materials until §7.3 clears them | `zanatomy`, `bodyparts3d` |

"Excluded" must be measured, not asserted. W3 should publish the object names it
dropped and the material that dropped each one. Z-Anatomy materials are a proxy
for provenance, not a record of it; Z-Anatomy#10 asks that very question about
`Pons`, `Medulla oblongata` and the spinal-cord horns.

### 7.7 Summary

| criterion (DOG-126) | status |
| --- | --- |
| every upstream licence verified at its primary source | **done**: §7.1. Three items are not cleared or unverified and are recorded as such, not rounded up |
| brainproject commit pinned, archive SHA-256 recorded | **done**: §7.2, plus per-file digests, which are the durable pin |
| `attribution.json` records for everything W2/W3 will ship | **done**: 16 `upstreamSources` with verdict, evidence and attribution wording. Every third-party entry must cite them by id (rule 9); the three existing ones now do |
| `asset-nc` class and gate rule | **done**: rules 8 and 9 of `tools/check-licence-separation.mjs`, red on five staged breakages and green on the tree and on a segregated NC layer |
| the v2 plan's §1 premise that the gyral mesh gives `BV` names | **at risk**: 146 of 437 structures held, including 126 of 128 cortical are in the undeclared group. Measurement route in §7.3; escalated to the CTO on DOG-123 |

### 7.8 Cortex, condition (b): the upstream title behind Brainder — **NOT ESTABLISHED** (DOG-127, 2026-10-11)

The CTO's decision on DOG-127 clears the held cortex only if **both** of these
hold:
- **(a)** the geometry measurably *is* Brainder's;
- **(b)** Brainder's upstream terms let Anderson Winkler grant CC BY-SA 3.0 on it.

"Could not read the terms" means not cleared (§4). **(b) is not established, so
(a) cannot clear any structure**, whatever it measures. `brainder-brain-for-blender`
is now `not-established` in `upstreamSources`, so rule 9 refuses any entry that
cites it.

**The premise was wrong in a way that matters.** Brain for Blender is not
FreeSurfer `fsaverage`. Winkler's page says the meshes are "a true human brain,
which were constructed from 12 volumes acquired using magnetic resonance
imaging", from the Research Imaging Institute (UTHSCSA), and that "the
generation of the cortical meshes and subcortical segmentations used FreeSurfer
5.2.0".
- The geometry is therefore one individual's brain.
- What FreeSurfer contributes is the reconstruction, plus the parcel borders,
  which come from its classifier atlases: Desikan-Killiany, Destrieux and DKT.
- The page states no upstream permission.

| upstream | primary source (read 2026-10-11) | what it says | verdict |
| --- | --- | --- | --- |
| FreeSurfer Software License, Version 1.0 (February 2011) | `LICENSE.txt` in <https://github.com/freesurfer/freesurfer> (`dev`); the same text on the fswiki FreeSurferSoftwareLicense page (Wayback, 2026-08-25) | It covers "software and/or data from FreeSurfer". It permits derivative works and distribution, and commercial use is "at the sole risk" of the user. But **B.1(b)**: "in connection with any copy of or sublicense of all or any portion of the Software, all of the terms and conditions in this Software License shall appear in and shall apply to such copy and such sublicense". **B.2(iii)** allows "additional or different" terms on modifications "provided that … [it] otherwise complies with the conditions stated in this Software License". The terms that must travel include an indemnity (B.5), a ban on using names (B.6) and automatic revocation (B.7) | A bare CC BY-SA grant does not carry these terms, and CC BY-SA forbids adding them downstream. Whether a classifier's *output* on another person's brain is a "portion" of the Software is **not settled by any text read** |
| Destrieux atlas (`aparc.a2009s`) | fswiki CorticalParcellation and DestrieuxAtlasChanges (Wayback) | No terms of its own; only the licence above applies | **not established** |
| DKT atlas (`DKTatlas40`) | `README-DKT40.txt`, attached to fswiki CorticalParcellation (Wayback, 2026-08-24) | "Copyright 2012, Mindboggle team … Creative Commons License (http://creativecommons.org/licenses/by-nc-sa/3.0/deed.en_US)". Mindboggle's own page now says CC BY 4.0 ("v3 on 2019-04-03"), but it does not say whether that covers the 2012 DKT40 data | **not established**, and the only licensor-hosted notice is **non-commercial** |
| `fsaverage` | fswiki FsAverage (Wayback) | No terms; it points to a README inside the 320 MB subject archive, which **was not read** | **not established** (moot for Brain for Blender, which contains no fsaverage geometry) |

**Fetch failures, stated rather than smoothed over:**
- `surfer.nmr.mgh.harvard.edu` timed out directly, so every fswiki page above was read from the Wayback Machine.
- `fswiki/License` has no snapshot and was not read.
- The fsaverage subject README was not read.
- That FreeSurfer 5.2.0 shipped this same Version 1.0 licence is assumed and **unverified**.

**What this changes:**
- **The cortex stays held.** 126 of 128 cortical structures remain in `zanatomy-undeclared-brain-materials`. W2 ships the 245 cleared structures without them.
- **The cortex fallback is now the live route.** The fallback the CTO decided in advance is a first-party cortical surface extracted from ICBM152 2009c, which is permissive, already our `BV` template and natively MNI. W2 builds it; whether to ship it is the owner's decision, which the CTO takes via DOG-123.
- **The origin test stays useful, but it cannot clear anything.** The test in `docs/brain-origin-test.md` can still settle whether Z-Anatomy's cortex is Brainder's. That would only matter if a licensor later answered (b).
- **What would clear (b):** a statement from Anderson Winkler or MGH that FreeSurfer outputs are not "portions" of the Software, or an MGH grant.

### 7.9 What W2's measurements moved (DOG-127, 2026-10-11)

The pre-registered origin test (`docs/brain-origin-test.md`) ran against
BodyParts3D 4.0. Its negative control discriminated: 0 of 17 mismatched pairs
passed. It moved three structures out of `zanatomy-undeclared-brain-materials`:

| structure | test result | ships from | cites |
| --- | --- | --- | --- |
| Midbrain.l, Midbrain.r | **pass**: BodyParts3D's own mesh, p95 0.14 mm | brain.glb | `brainproject-brain-glb`, `zanatomy`, `bodyparts3d` |
| Corpus callosum | **fail** on label agreement (0.77, threshold 0.90) | BodyParts3D FMA86464 directly, placed by the test's transform | `bodyparts3d` |

**W2 therefore ships 248 structures.** 143 remain held, including 126 of the 128
cortical ones, and the 46 Dundee nerves remain unverified. The provenance
manifest records the move per structure (`shipsFrom`, `formerlyHeldBecause`), and
rule 10 checks it.

The same run found that the four colliculi do **not** match BodyParts3D's
colliculi. They are cleared by inference from the `Nucleus` material. That
inference is about *which* cleared source they come from, and it is now known to
be wrong as to BodyParts3D, though they may still be Z-Anatomy's own work. They
are reported on DOG-123, not re-classified here.
