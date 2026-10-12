# `@gstack/atlas-research`

The research layer of the atlas: **papers → findings → region mappings**, both
browse modes over them, and the solid-colour data path.

Start with [`schema/research-1.md`](./schema/research-1.md). It is the committed
contract and carries the reasoning; everything here is a short tour of the
surface.

## What is in here

| Path | What it is |
| --- | --- |
| `schema/research-1.md` | the schema contract, with the reasoning for each rule |
| `src/types.ts` | the same contract in types |
| `src/validate.ts` | `loadDataset` — the only sanctioned way to get a dataset |
| `src/dataset.ts` | `buildResearchIndex` — mappings resolved against a name index |
| `src/browse.ts` | `browseByAnatomy`, `browseByResearch`, `paperSelection` |
| `src/layers.ts` | the palette, the common refinement, `solidColourLayers` |
| `src/links.ts` | the one place a curator URL becomes an `href` |
| `fixtures/` | the 5-paper fixture and the synthetic name index it resolves against |
| `data/` | the curated seed set and the synthetic index it resolves against |
| `data/citation-report.json` | what Crossref and PubMed returned for all 30 sources, per paper |
| `data/citation-report.md` | the same, readable — generated, and gated against the JSON |

Imports of `@gstack/alc` are written as relative paths (`../../alc/src/...`),
matching `packages/atlas-web`: this repo has no install step, and native
TypeScript stripping resolves the files directly.

## Using it

```js
import { buildNameIndex } from '../alc/src/index.ts';
import { loadDataset, buildResearchIndex, browseByAnatomy, browseByResearch } from '../atlas-research/src/index.ts';

const names = buildNameIndex(JSON.parse(await read('fixtures/names.fixture.json')));
const dataset = loadDataset(JSON.parse(await read('fixtures/research.fixture.json')));
const research = buildResearchIndex({ dataset, names });   // add `templates` to place coordinates

// Browse by anatomy: a clicked cell, or a whole structure's covering.
const hits = browseByAnatomy(research, 'BV-L-040');

// Browse by research: the filter narrows `list`, never `selection`.
const view = browseByResearch(research, {
  selected: ['paper:glasser-2016-mmp1'],
  filter: names && covering(['BV-L-04']),
});
view.layers.layers;   // disjoint layers: fill for one owner, hatch for an overlap
```

## Four things a consumer must get right

1. **Render text as text.** Every string here is plain text and this package
   emits no markup. Put `statement`, `structureLabel` and `evidence.summary`
   through `textContent`, never `innerHTML`. The data is curator-supplied and
   the schema deliberately does not mangle legitimate `<` and `&`.
2. **Keep the `rel` with the `href`.** `link` carries
   `rel: "noopener noreferrer"` and `target: "_blank"`. A renderer that keeps
   the href and drops the rel hands the opener to a curator-chosen origin.
   When `href` is `null`, show `unlinkedReason` — it is a curation defect worth
   seeing, not a blank.
3. **Render the markers.** `regionLevelOnly` means the source gave no location
   finer than the region: show the *"region-level only"* marker. `resolution:
   "unresolved"` means there is nothing to paint and `unresolvedReason` says
   why — show it as a marker in the panel, never as geometry, and never as
   region-level.
4. **Every highlight needs a label.** Only the first
   `COLOUR_ONLY_DISTINCT` (3) palette slots separate for *every* pair on a
   shared surface; past that `requiresSecondaryEncoding` goes true and identity
   must not be colour alone. See the measurement in `src/layers.ts`.

## What the citations are, and are not, checked against

Every identifier in `data/research-seed.json` was resolved against a named
source and the result committed to `data/citation-report.json`: 28 of the 30
papers carry a DOI that Crossref confirmed points at the paper claimed, 26 of
those were *also* returned by an independent title-and-author search, and the
2 remaining papers carry no identifier because no source returned a match.
Both are monographs — Brodmann 1909 and Bogduk 2012 — and for a book that is
the correct record rather than a gap.

**This package still never fetches a URL**, and `trust.test.ts` asserts it:
the checking lives in `tools/verify-research-citations.mjs`, runs deliberately,
and commits its findings as data. `tools/check-research-dataset.mjs` then gates
the dataset against that report offline, so a later hand-edit cannot add an
identifier no source returned.

The report is a **point-in-time** record — each row names its endpoint and its
`retrievedOn` date. Re-run the verifier to refresh it; do not hand-edit either
file.

What none of this establishes: **that these papers claim what the findings
attribute to them.** Crossref confirms a paper exists. The seed asserts
`provenance.basis: "published-text"` with `confidence: "high"` across 120
findings and 170 mappings, and no API bears on whether that is true — only a
person reading the sources. A citation can resolve perfectly while the claim
attached to it is not what the paper found, and that is the failure this
package cannot detect for you.

## Region links: mappings onto named structures (DOG-130)

`buildRegionIndex` resolves every mapping onto the named structures of each
registered representation (`src/representations.ts`): the Z-Anatomy brain
meshes, MNI coordinates, and v1's BodyParts3D name index. It provides
`resolve(finding)`, `regionsFor(paper)` and `papersFor(structureKey)`. Every
link records **how** it was made and its **precision**:

| how | when | precision |
| --- | --- | --- |
| `exact-term` | the term is the structure's own id, or the crosswalk says it is the same concept (or its complete set of parts) | `exact` |
| `crosswalk` | the crosswalk places the term on structures whose boundaries differ, e.g. every HCP-MMP1 area | `approximate`, with the entry's reason, and the term's own name kept |
| `coordinate` | a published point, or a BV cell's centre, lies inside a structure's closed surface after the registration | millimetres, never below the registration's measured held-out error, with its basis |

Two rules are worth knowing before you consume it:

- **Containing, never nearest.** A point inside no shipped structure is
  reported with its nearest structure and distance, and is **not** linked to
  it. While the cortex is held, the nearest shipped structure to a cortical
  point is the confident wrong answer. On the real seed, the fusiform face
  coordinate lands 0.54 mm from a cerebellar lobule.
- **Nothing vanishes.** A mapping with no link carries a stated reason
  (`structure-held`, `not-in-representation`, `coordinate-outside-shipped-structures`, …).
  A paper with no region carries the reasons of its mappings.

The assets stay in `packages/atlas-assets` and are passed in as data. The
crosswalk (`packages/atlas-assets/crosswalk/crosswalk.json`) is hand-authored.
The committed index beside it is generated, and `tools/check-crosswalk.mjs`
gates both: the crosswalk's targets, the acceptance invariants
(`checkRegionIndex`), the locator on known points, and drift. Swapping the
cortex, whether to a cleared gyral cortex or a lobe-labelled one, means
changing data: a registry entry and crosswalk targets. The resolver code
stays the same.

The lobe-labelled ICBM152 cortex (DOG-151) is registered as
`icbm152-2009c-cortex-lobes`, and every HCP-MMP1 entry targets its lobe as well as
its gyrus. The gate reads DOG-151's label file
(`packages/atlas-assets/brain/icbm152-2009c/lobes.json`) and checks every lobe
target against it: the label exists, with one structure per side and the id
DOG-151 publishes (DOG-157). The lobes are supplied as named structures only,
with no locator, so a coordinate never lands on them. On the low tier a
nearest-label rule puts the A1 peak in the parietal lobe and the PHA1 and FFC
peaks on unlabelled faces, so the gate prints `NOT PLACED:` for the lobe cortex
rather than placing points there. `PHA1` targets the temporal lobe only, because
DOG-151's limbic lobe stops at the cingulate sulcus.

**Two criteria are vacuous on the real data today, and the gate says so.** There
are 0 coordinate links (every curated coordinate falls inside no shipped
structure) and 0 HCP-MMP1 → gyrus links (every target gyrus is held). So "no
coordinate link is `exact-term`", the precision floor, and "HCP-MMP1 links are
crosswalk, approximate, and keep the area name" are checked only by
`region-index.test.ts` and the gate's self-test. `check-crosswalk` prints
`VACUOUS:` for each, rather than counting them as passes. Coverage
(≥ 109 of 170 mappings, ≥ 29 of 30 papers) and coordinate precision (≥ ±7 mm,
from ≥ 2 held-out landmarks) are committed literals in the gate, not readings.

## Tests

```
node --test --experimental-strip-types 'test/*.test.ts'
```

| Suite | Covers |
| --- | --- |
| `schema.test.ts` | every validator rule, each with the case it refuses |
| `browse.test.ts` | both modes, and the filter-leak guarantee with a must-pass leak detector |
| `layers.test.ts` | the refinement's partition invariants, agreement with `coveringIntersect`, palette stability |
| `trust.test.ts` | the URL allow-list, the no-network-client source scan, parameterised scans |
| `seed.test.ts` | the curated seed set, and the stage-B resolution gate |
| `citations.test.ts` | every identifier traces to a named source, with a must-pass case |
| `region-index.test.ts` | region links: how and precision, containing not nearest, held targets, the cortex swap as data, the round trip |

## Stage A and stage B

Stage A is everything that can be built against a fixture: the schema, both
browse modes, the colour path, and the curation itself. It is done and does not
depend on the asset pipeline.

Stage B is the swap to the real `coverings.json` from plan task 4. Because
mappings are authored **by structure id** rather than by hard-coded cells, that
swap is a change to one file and a re-run of `tools/check-research-dataset.mjs`.
Until it lands, the gate reports the resolution rate as **UNVERIFIED against
real geometry** rather than passing silently — see the note at the top of that
tool.
