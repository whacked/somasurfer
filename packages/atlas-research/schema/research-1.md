# `research/1` — the research data schema

The committed schema for the atlas's research layer: **papers → findings →
region mappings**, per DOG-1 §5, with provenance on every link. This file is the
contract; `src/types.ts` is the same contract in TypeScript and `src/validate.ts`
enforces it at load time. The fixture at `fixtures/research.fixture.json` is a
conforming instance, and `data/research-seed.json` is the curated seed set.

Three rules drive every shape below. They are the reason this schema is not just
"papers have findings have regions".

1. **Provenance on every link, not on every record.** A paper carries a
   citation; that is bibliography, not provenance. The thing a reader has to be
   able to challenge is the *assertion that this finding is about this region* —
   so the provenance sits on the `RegionMapping`, which is the link, and the
   mapping id is what a highlight in the viewer traces back to.
2. **Missing spatial data is visible, never interpolated.** A finding that
   reports "activation in the inferior frontal gyrus" and nothing finer has no
   spatial detail, and the schema makes that a distinct, explicit state rather
   than a coarse covering that looks like a measurement. See
   [Spatial detail](#spatial-detail).
3. **Curator-supplied data is untrusted input.** It arrives in the browser the
   same way a pasted address does. Source URLs are validated at load, rendered
   as links and **never fetched**; address-prefix scans go through
   `@gstack/alc`'s parameterised scan renderer; every string is text, never
   markup. See [Trust boundary](#trust-boundary).

---

## Top level

```jsonc
{
  "schema": "research/1",
  "version": "research-seed-2026.10.1",   // pinned into every query result
  "structureIdSources": ["UBERON", "FMA", "HCP-MMP1"],
  "authoredAgainst": {                    // which index the mappings were authored against
    "nameIndexVersion": "fixture-names-2026.10.1",
    "status": "fixture" | "real"
  },
  "curation": { ... },                    // see Curation record
  "papers":   [ Paper, ... ],
  "findings": [ Finding, ... ]
}
```

`version` is required and opaque. Every browse result echoes it alongside the
name-index version it resolved through, because a stored or shared highlight
without both versions is not reproducible — the same argument `resolve()` makes
for name indexes in `@gstack/alc`.

`findings` is a flat list keyed by `paperId` rather than nested inside each
paper. Findings are what the anatomy-side query returns, and a flat list is what
an index over mappings is built from; nesting would make the common query walk
the papers first.

### Curation record

```jsonc
"curation": {
  "curatedBy":  "Staff Engineer (GStack)",
  "curatedOn":  "2026-10-09",
  "method":     "manual transcription from published abstracts and parcellation documentation",
  "citationCheck": "curator-transcribed; not machine-verified",
  "notRecorded": [ "page- and figure-level evidence locators for ...", ... ]
}
```

`citationCheck` and `notRecorded` exist because the honest answer about this
dataset is that no process in this repository resolves a DOI — by design, since
external URLs are never fetched (rule 3). Claiming verified citations would be
claiming a check nothing performs. `tools/check-research-dataset.mjs` reports
the counts, so the gap is a number on the build log rather than an impression.

---

## Paper

```jsonc
{
  "id": "paper:glasser-2016-mmp1",       // stable, lower-kebab, `paper:` prefixed
  "title": "A multi-modal parcellation of human cerebral cortex",
  "authors": ["Glasser MF", "Coalson TS", "..."],
  "year": 2016,
  "venue": "Nature",
  "identifier": { "kind": "doi", "value": "10.1038/nature18933" },
  "sourceUrl": "https://doi.org/10.1038/nature18933",
  "provenance": Provenance
}
```

- `identifier.kind` is one of `doi`, `pmid`, `pmcid`, `isbn`, `url`, `none`.
  `none` is legal — Brodmann 1909 has no DOI — but it must be *stated*, and
  `value` must then be `null`. A missing identifier and an absent one are
  different facts.
- `sourceUrl` may be `null`. When present it must parse as an absolute `http:`
  or `https:` URL; the loader rejects anything else outright (not escapes it —
  rejects it), because `javascript:` in a curated link is not a rendering
  problem to be papered over downstream.

## Finding

```jsonc
{
  "id": "finding:glasser-2016-mmp1/area-55b",
  "paperId": "paper:glasser-2016-mmp1",
  "statement": "Area 55b is delineated as a distinct multi-modal parcel ...",
  "topics": ["parcellation", "language"],
  "mappings": [ RegionMapping, ... ],     // at least one
  "provenance": Provenance
}
```

- `statement` is the curator's one-sentence rendering of the claim. **Plain
  text, not a quotation.** A verbatim sentence from a paper is the publisher's
  expression; a paraphrase is ours, and it is also the thing worth displaying.
- A finding with zero mappings is rejected. A finding that maps to nothing is
  not a finding in an atlas; it is a note, and it would be invisible in both
  browse modes while still inflating the dataset's counts.

## RegionMapping

The link, and therefore the unit that carries provenance and the unit a
highlight traces back to.

```jsonc
{
  "id": "map:glasser-2016-mmp1/area-55b/HCP-MMP1:55b",
  "structureId": "HCP-MMP1:55b",         // resolved through the name/coverings index
  "structureIdSource": "HCP-MMP1",
  "structureLabel": "Area 55b",          // DISPLAY ONLY — never authoritative
  "spatial": SpatialDetail,
  "evidence": Evidence,
  "provenance": Provenance
}
```

`structureLabel` is a convenience for a list before the index has loaded, and
for diagnosing a mapping whose `structureId` is not in the index. The viewer
must display the label resolved **from the index**, not this one, whenever the
index resolves — otherwise a parcellation revision silently disagrees with the
research panel and the atlas starts showing two names for one thing.

### Spatial detail

The honesty switch. Exactly one of:

| `kind` | Means | Resolves to |
| --- | --- | --- |
| `region-level` | The source reports a named region and no finer location. | the structure's **whole** covering from the index, flagged `region-level` |
| `cells` | The curator recorded an explicit ALC covering. | that covering, normalised, intersected with the structure's own |
| `coordinates` | The source published coordinates in a named space. | the cells containing those points, **once a template for that space exists** |

```jsonc
// region-level
{ "kind": "region-level", "reason": "the paper reports the parcel, not a locus within it" }

// cells
{ "kind": "cells", "cells": ["BV-L-314", "BV-L-315"], "method": "curator traced from Fig. 2", "digits": 3 }

// coordinates
{ "kind": "coordinates", "space": "MNI152", "frame": "BV",
  "pointsMm": [[-54, 12, 18]], "digits": 4,
  "note": "peak coordinate as published" }
```

`region-level` is **not** a degraded `cells`. It resolves to a real covering —
the whole structure — so the region can be highlighted at all, and the
resolution carries `precision: "region-level"` so the viewer can render the
required *"region-level only"* marker. The distinction the acceptance criterion
is about is between "we know where in this region" and "we know only the
region", and both are renderable; only one is a measurement.

A `coordinates` mapping with no template loaded resolves to
`resolution: "unresolved"`, `reason: "no-template"`. It does **not** fall back
to the structure's covering. Falling back would turn "we have coordinates we
cannot place yet" into "we only know the region", which is a different and
false claim. Unresolved is shown as unresolved.

### Evidence

```jsonc
"evidence": {
  "summary": "Reported as a distinct parcel on the basis of myelin, thickness and task contrast.",
  "kind": "abstract" | "figure" | "table" | "section" | "page" | "supplementary",
  "locator": "Fig. 2" | null,
  "locatorStatus": "recorded" | "not-recorded"
}
```

`locator` is where in the paper *this region* is reported. It may be `null`, but
only with `locatorStatus: "not-recorded"` — the loader rejects a `null` locator
that claims to be recorded, and rejects a non-null locator marked
not-recorded. An invented figure number is worse than an absent one: it is
unfalsifiable without the paper in hand, and it makes a provenance trail that
looks complete.

For the seed set, most locators are `kind: "abstract"` with
`locatorStatus: "not-recorded"`: the claim is supported at abstract granularity
and the curator did not have the typeset article open. That is a real limit of
this dataset, stated here, counted by the gate, and displayed by the viewer.

### Provenance

The same record on a paper, a finding and a mapping. On a mapping it is the one
that matters.

```jsonc
"provenance": {
  "assertedBy": "Staff Engineer (GStack)",
  "assertedOn": "2026-10-09",
  "basis": "published-parcellation" | "published-coordinates" | "published-text"
          | "curator-inference",
  "confidence": "high" | "medium" | "low",
  "note": "..."                          // optional, required when basis is curator-inference
}
```

`curator-inference` is the basis for a mapping the paper does not state —
"this paper's 'Broca's area' is this parcel" is an inference, not a reading —
and it requires a `note` saying what was inferred. The viewer shows the basis on
hover, so an inference is never presented as a reading.

---

## The hover payload

Every highlight in the viewer resolves to a `ResolvedMapping`, which is exactly
what the acceptance criterion *"every highlight traces back to a specific
finding"* needs reachable on hover:

```
ResolvedMapping
  mappingId, findingId, paperId
  structureId, structureLabel (resolved), structureLabelCurated
  covering            — what to paint
  precision           — 'region-level' | 'cells' | 'coordinates'
  resolution          — 'resolved' | 'unresolved'
  regionLevelOnly     — true when the marker is required
  notes[]             — clamped points, unknown structure, absent template, ...
  finding.statement, evidence{summary,kind,locator,locatorStatus}
  paper.citation, link{text, href|null, rel, target}
  provenance{assertedBy, assertedOn, basis, confidence, note}
  datasetVersion, nameIndexVersion
```

There is no path that produces a highlight without one of these. `src/browse.ts`
returns layers whose every cell is attributable to at least one
`ResolvedMapping`, and `test/browse.test.ts` asserts that for every cell of
every layer.

---

## Trust boundary

| Input | Rule | Enforced by |
| --- | --- | --- |
| `sourceUrl`, any URL field | absolute `http(s)` only; rejected at load, never escaped-and-kept | `validate.ts`, `links.ts` |
| any string field | plain text; no control characters; length-capped | `validate.ts` |
| `spatial.cells` | parsed by `@gstack/alc` `covering()` before use; invalid throws, naming the mapping | `validate.ts` |
| structure ids | matched against the index by exact key; unknown ids resolve `unresolved`, never partially | `dataset.ts` |
| prefix scans | `renderScan()` from `@gstack/alc`; values bind, text never interpolates | `browse.ts` |
| external URLs | **rendered, never fetched.** No network client is imported anywhere in this package | `test/trust.test.ts` scans the source |

Two things are deliberately *not* this package's job, and are requirements on
the viewer instead, recorded here so they are reviewable:

- **Text is inserted as text.** Every string here is plain text and this package
  emits no markup. A viewer that puts `statement` or `structureLabel` through
  `innerHTML` reintroduces the injection this schema closed. Use `textContent`.
- **Links open detached.** `links.ts` supplies `rel: "noopener noreferrer"` and
  `target: "_blank"` with the href; a renderer that keeps the href and drops the
  rel hands the opener to a curator-supplied origin.

---

## Versioning

`schema` is `research/1`. A change that can invalidate an existing stored
highlight — removing a field, narrowing an enum, changing what a `spatial.kind`
resolves to — is `research/2`, not a revision of this file. Adding an optional
field, a new `basis`, or a new `identifier.kind` is additive and stays `research/1`.
The loader rejects an unknown `schema` value rather than guessing, for the same
reason `parse()` rejects an unknown frame.
