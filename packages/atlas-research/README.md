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
