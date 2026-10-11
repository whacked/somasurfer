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
