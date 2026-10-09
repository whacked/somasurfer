# Atlas asset licensing — the D1 memo

**Status:** D1 implemented; one material decision routed to the repository owner
**Date:** 2026-10-09
**Owner:** Anatomy Data Engineer
**Decides:** DOG-2 D1 (mesh licence), DOG-35 licence clearance

This is an engineering memo. It records what was measured about each upstream
licence, what the pipeline does about it, and what is *not* cleared. It is not
legal advice, and the one place where a commercial release turns on a reading
rather than on a measurement is called out in §3 and routed to the owner.

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

**The atlas geometry therefore cannot be made proprietary.** That is a
consequence of D1, and §3 is about whether it is a *mandatory* consequence or an
elective one.

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
  It only makes the "geometry cannot be proprietary" consequence mandatory where
  it could have been elective.

Conservative now, reversible later, never retroactively wrong. The reverse
choice — treating it as BY 4.0 and relicensing the geometry proprietary — is not
reversible, because by the time the discrepancy is resolved the geometry has
already shipped under terms that may not have been ours to grant.

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

## 3. The one material decision for the owner

**The share-alike consequence of D1 may be elective rather than mandatory, and
that is a product call.**

D1 was approved on the understanding that BodyParts3D is CC BY-SA 2.1 Japan,
which is what its file headers say. The archive's web licence page now says CC
BY 4.0. If the page is the operative statement, then nothing obliges the atlas
geometry to stay share-alike — we would be choosing it.

The engineering posture does not change either way: §2 explains why holding
share-alike cannot create a violation under either reading, so the pipeline is
safe to run and the assets are safe to ship **today** regardless of how this
resolves. What the owner may want to decide is whether to *keep* the share-alike
commitment, because it is the difference between:

- **mandatory** — the atlas geometry can never be made proprietary, full stop; or
- **elective** — we currently ship it share-alike by choice, and a future
  release could be relicensed.

Recommended action, in order:

1. **Ask DBCLS to confirm which statement governs the current archive**, and to
   update the OBJ headers or the page so they agree. One email; they are
   responsive and the discrepancy is plainly an oversight on one side or the
   other.
2. Until they answer, **keep shipping BY-SA 4.0**. No change required.
3. If DBCLS confirms BY 4.0 **and** the owner wants proprietary geometry later,
   that is a new decision (call it D1a) and it needs a lawyer's read on the
   adaptation question, not an engineer's.

Nothing in v1 is blocked on this. It is recorded here so the choice is made
deliberately rather than discovered after release.

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

### What clearing it would take

1. A written redistribution grant, per parcellation, covering the intended use
   (including commercial, if that is wanted) — obtained by whoever owns
   commercial terms, not by this pipeline.
2. Then a `BV` name index built the same way as the `BD` one: a covering per
   parcel from the parcellation volume, an explicit index version, and the same
   `tools/verify-asset-templates.mjs` checks.
3. The index version is what makes step 2 safe to do later: a name is only true
   relative to an index, every `resolve()` result is stamped with one, and
   `tools/verify-asset-templates.mjs` proves an address keeps its millimetres
   and its canonical form across an index revision. **Adding `BV` names later
   invalidates no address already issued.**

A cheaper route, if commercial terms stay unresolved: a permissively licensed
parcellation. That is a separate evaluation and is not on the v1 path.

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
| verdict on the brain parcellation licence | **NOT CLEARED.** `BV` ships coordinates without names; see §4 |
| `BR` stays disabled | **done** — gated, see §5 |
| D1 discrepancy | **routed to the owner**, §3. Does not block v1. |
