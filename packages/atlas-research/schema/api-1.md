# `atlas-research-api/1`: the static research API, v1

The region ↔ paper queries as static JSON documents, emitted at build time and
served by Pages (plan D4(a), DOG-131). The same queries are also exposed
through `@gstack/atlas-research` (D4(b)). **There is no server.** A query is a
GET of a file, and a missing file (404) is the answer "none".

This file is the contract. `src/api.ts` implements it.
`validateApiDocument()` enforces it, and every document is checked against it
three times: when the region tree is generated, when the API gate runs, and
when the contract check reads the served site back.

---

## Two trees, because two licences

| tree | root, under the site base | licence | what it holds | how it reaches `dist/` |
|---|---|---|---|---|
| paper | `data/api/v1/` | Apache-2.0 | the curated dataset only | emitted by `packages/atlas-web/build.mjs` from `createPaperApi`, at every build |
| region | `assets/api/v1/` | CC BY-SA 4.0 | everything joined with structure names | committed in `packages/atlas-assets/api/v1/` by `tools/build-research-api.mjs --write`, byte-copied by the build |

A region document names structures, and those names come from two BY-SA asset
files: the brain's `structures.json` and the body's `labels/names.json`. So
every region document is derived from asset content.

Licence rule 6 (`tools/check-licence-separation.mjs`) holds `dist/data/` to
deriving nothing from asset content. So the region tree ships under
`dist/assets/`, beside the asset `LICENSE` and `ATTRIBUTION.md`, as attribution
entry `research-api-regions`. The site build never reads it; it only checks
that it was copied. Rules 6 and 7 apply to it unchanged.

That placement is the CTO's ruling on DOG-123 (2026-10-11 16:04). The rule was
not weakened to make room for the API.

**Paper → regions is region data.** Its answer names structures, so it lives
in the region tree as `paper-regions/{slug}.json`. A paper document links to
it and does not embed it. That is why a paper document stays Apache-2.0.

## Finding the roots

`<base>data/atlas-index.json` carries:

```jsonc
"researchApi": {
  "schema": "atlas-research-api/1",
  "version": "v1",
  "dataRoot": "/somasurfer/data/api/v1/",     // under the build's --base
  "assetsRoot": "/somasurfer/assets/api/v1/",
  "licences": { "data": "Apache-2.0", "assets": "CC-BY-SA-4.0" }
}
```

**Every link inside a document is relative to that document.** No document
embeds the base, so the region tree can be byte-copied, and both trees work at
`/` and at `/somasurfer/` alike.

## Paths

| query | tree | path |
|---|---|---|
| `index()` | paper | `index.json` |
| `paper(paperId)` | paper | `papers/{slug}.json` |
| `regionIndex()` | region | `index.json` |
| `region(key)` | region | `regions/{representation}/{structureId}.json` |
| `paperRegions(paperId)` | region | `paper-regions/{slug}.json` |

- **Paper paths.** `paperId` must be `paper:<slug>`, where the slug is
  `[a-z0-9][a-z0-9-]*`, and the path uses the slug.
- **Region paths.** A region `key` is `<representation>/<structureId>`. The
  representation must match `[a-z0-9][a-z0-9-]*`, and the structure id
  `[A-Za-z0-9][A-Za-z0-9._-]*`.
- **Ids are never escaped.** An id outside these forms has no path, and
  `apiPaths` throws. That keeps each id-to-path mapping injective, and it means
  no curated value can leave its root.

`region(key)` has a document only when at least one paper reaches the
structure. A shipped structure that no paper reaches answers 404, which is
`null`. `regionIndex().regions` lists exactly the keys that have documents.

## Common fields

Every document carries:

| field | value |
|---|---|
| `schema` | `"atlas-research-api/1"` |
| `kind` | `index`, `paper`, `region-index`, `region` or `paper-regions` |
| `licence` | `"Apache-2.0"` in the paper tree, `"CC-BY-SA-4.0"` in the region tree. A document whose licence does not match its tree is invalid. |
| `datasetVersion` | the curated dataset's `version`. The same in every document of both trees. |
| `crosswalkVersion` | region tree only: the crosswalk the links were resolved through |

**Unknown fields are invalid.** A field this file does not name is one no
consumer was promised.

## The documents

### `index` (paper tree)

```jsonc
{ ...common,
  "papers": [ { "id", "title", "year", "href": "papers/x.json", "regionsHref": "../../../assets/api/v1/paper-regions/x.json" } ],
  "regionIndex": { "href": "../../../assets/api/v1/index.json", "licence": "CC-BY-SA-4.0" } }
```

Papers are listed in dataset order.

### `paper` (paper tree)

```jsonc
{ ...common,
  "paper": Paper,              // research/1, verbatim
  "findings": [ Finding ],     // research/1, verbatim, with their mappings
  "regions": { "href": "../../../../assets/api/v1/paper-regions/x.json", "licence": "CC-BY-SA-4.0" } }
```

`Paper` and `Finding` are exactly the `research/1` shapes (`research-1.md`).
They are curated input: render every string as text. `sourceUrl` is a link to
render, never one to fetch.

### `region-index` (region tree)

```jsonc
{ ...common,
  "attributionHref": "../../ATTRIBUTION.md",
  "representations": [ { "id", "version" } ],
  "coverage": RegionCoverage,                 // region-index.ts, as check-crosswalk.mjs commits it
  "regions": [ { "key", "representation", "structureId", "structureName", "paperIds": [..], "href": "regions/r/id.json" } ],
  "papers":  [ { "paperId", "regionKeys": [..], "emptyBecause": [UnplacedCode], "href": "paper-regions/x.json" } ] }
```

- `regions` is sorted by `key`. Each region's `paperIds` is sorted and never
  empty.
- `papers` is in dataset order. For each paper, either `regionKeys` is
  non-empty or `emptyBecause` lists the reason codes, never both.

### `region` (region tree): region → papers

```jsonc
{ ...common,
  "key", "representation", "structureId", "structureName",
  "papers": [ { "paperId", "href": "../../../../../data/api/v1/papers/x.json", "links": [ RegionLink ] } ] }
```

- `papers` is sorted by `paperId` and never empty.
- Each paper's `links` are every link from that paper to this structure, in
  mapping order. Each one names this paper and this structure.

### `paper-regions` (region tree): paper → regions

```jsonc
{ ...common,
  "paperId", "paperHref": "../../../../data/api/v1/papers/x.json",
  "regions": [ { "key", "structureName", "href": "../regions/r/id.json", "links": [ RegionLink ] } ],
  "emptyBecause": [ { "code": UnplacedCode, "detail", "mappingIds": [..] } ] }
```

- `regions` is sorted by `key`.
- **Exactly one of `regions` and `emptyBecause` is non-empty.** A paper that
  reaches no structure says why. That is plan §6's "non-empty or a stated
  reason", served.

### `RegionLink`

These are W5's links (`region-index.ts`), unchanged:

```jsonc
{ "mappingId", "findingId", "paperId", "representation", "structureId", "structureName",
  "side": "left" | "right" | "median" | null, "sideFromSource": boolean,
  "how": "exact-term" | "crosswalk" | "coordinate",
  "precision": { "kind": "exact" } | { "kind": "approximate", "why" } | { "kind": "mm", "mm", "basis" },
  "source": { "scheme", "term", "label" },
  "crosswalk"?:  { "completeness": "same" | "parts" | "overlaps", "heldTargets": [..] },
  "coordinate"?: { "from": "coordinates" | "cell", "address"?, "mniMm": [x, y, z], "depthMm" } }
```

The validator enforces the pairing that `how` exists for:

- `exact-term` goes with `exact`.
- `crosswalk` goes with `approximate`.
- `coordinate` goes with `mm` and carries `coordinate`.
- No other link carries `coordinate`.

`source` is the curated term and its own name. It is kept on every link, so an
HCP-MMP1 area is never shown only as the structure it was projected onto.

### `UnplacedCode`

`structure-held`, `not-in-representation`, `no-crosswalk-entry`,
`representation-absent`, `space-not-registered`, `frame-has-no-mesh`,
`no-locator`, `coordinate-outside-shipped-structures`. They are defined in
`region-index.ts`.

## The library

```ts
import { createResearchApi, createStaticApiClient } from '@gstack/atlas-research';

// Local: the dataset and the serialised region index (crosswalk/region-index-*.json).
const api = createResearchApi({ dataset, regionIndex });
api.region('zanatomy-gross-anatomy/122');   // ApiRegion | null

// Remote: the same queries, over the served trees.
const client = createStaticApiClient({ dataRoot, assetsRoot, transport: (url) => fetch(url) });
await client.region('zanatomy-gross-anatomy/122');   // ApiRegion | null
```

**Local.** `createResearchApi` refuses a region index that was built from
another dataset version or that lists other papers. `createPaperApi(dataset)`
and `createRegionApi(regionIndex)` are its two halves. The site build uses the
first, so emitting the Apache-2.0 tree never needs the asset-derived index.

**Remote.** The client's caller supplies the transport. This package makes no
request of its own (`trust.test.ts`, "no network client is reachable"). The
client only requests one of its two roots plus a path that `apiPaths` built
from a path-safe id. It validates every document it receives, and refuses a
document of the wrong kind.

## The contract, and where it is checked

| claim | checked by |
|---|---|
| every document validates against this file | `tools/build-research-api.mjs`, `test/api.test.ts`, and the client on every read |
| the region tree answers what the live region index's `papersFor` / `regionsFor` answer, link for link | `tools/build-research-api.mjs` |
| the committed region tree is exactly what its inputs produce, and its attribution entry lists exactly its files | `tools/build-research-api.mjs` |
| **every served response equals the library's answer to the same query**, computed from the seed and a region index resolved afresh from its inputs | `tools/check-research-api-contract.mjs`, over HTTP at the build's own base |
| every relative link resolves to a 200 under the base | the same |
| every file under the two roots is reached by a query | the same |

CI runs the contract check on the build at `/`. The Pages workflow runs it on
the artefact it deploys, at the Pages base. Both gates have self-tests, and
`tools/verify-gates.mjs` stages their failures on the real tree.

## Versioning

`v1` is in the path, and `atlas-research-api/1` is in every document.

- **Additive changes** stay in v1, but only through an edit to this file and
  to `validateApiDocument`, because unknown fields are invalid. Examples: a new
  optional field, or a new `UnplacedCode`.
- **Any other change** is `v2`, published beside `v1` and not in place of it:
  a removed or renamed field, a changed meaning, or a changed path.

**Deferred.** Model-scoped paths (`api/v1/models/{model}/…`) belong to D7,
which is deferred (plan §0.0). v1 has one brain, and its paths do not mention
a model.
