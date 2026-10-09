# The viewer against the bundle budget — measured

Owner: Web/3D Engineer · [DOG-36](/DOG/issues/DOG-36) · measured 2026-10-09

Two questions had to be answered with numbers before the viewer's first commit,
because both are expensive to reverse once the viewer is written:

1. **React Three Fiber or vanilla three.js?** The plan names either (§3).
2. **Does a 3D renderer fit `bundleGzipBytes`?** The budget in
   `ci/performance-budget.json` was published before any renderer existed.

The answers are below. Nothing here changes a budget — reshaping a published
gate is the Release Engineer's call, and this document exists so that call is
made against measurements rather than estimates.

## What was measured

Everything is gzip level 9, the same setting `tools/perf-budget.mjs` uses.
Reproduce with esbuild 0.24.0 and three 0.169.0 in a scratch directory:

```sh
# the renderer surface the stage-A viewer actually needs, tree-shaken
esbuild entry.js --bundle --minify --format=esm --outfile=out.js
gzip -9c out.js | wc -c

# the library, full public API
esbuild packages/alc/src/index.ts --bundle --minify --format=esm --outfile=alc.js
gzip -9c alc.js | wc -c
```

`entry.js` imports exactly the stage-A surface and nothing more:
`WebGLRenderer`, `Scene`, `PerspectiveCamera`, `Group`, `Mesh`,
`BufferGeometry`, `BufferAttribute`, `MeshLambertMaterial`,
`MeshBasicMaterial`, `Raycaster`, `Vector2`, `Vector3`, `Box3`, `Color`,
`AmbientLight`, `DirectionalLight`, `LineSegments`, `LineBasicMaterial`,
`EdgesGeometry`, `BoxGeometry`, and `OrbitControls` from
`three/examples/jsm`. `EdgesGeometry` + `BoxGeometry` are there to draw a cell
at its **true extent**, which is not optional (§6).

| component | raw | **gzipped** |
| --- | --- | --- |
| three.js, full published build (`three.module.min.js`) | 687,458 | **169,614** |
| three.js, tree-shaken to the stage-A surface | 506,274 | **126,469** |
| `@gstack/alc`, full public API | 49,461 | **18,012** |
| current `index.html` + `app/style.css` | 5,906 | **2,381** |
| react 18.3.1 + react-dom 18.3.1 (UMD production) | 142,586 | **47,108** |
| `@react-three/fiber` 8.17.10 core module only | 11,768 | **3,725** |

## Finding 1 — React Three Fiber is measured out of v1

R3F costs react + react-dom + the fiber reconciler closure **on top of** the
126 KiB three.js core. That is ~47 KiB gzipped before the reconciler's own
dependencies (`react-reconciler`, `scheduler`, `zustand`, `suspend-react`,
`its-fine`), against a **150 KiB** total line that three.js alone has already
spent 82% of. No tree-shaking closes a gap that size: react-dom is 42.8 KiB
gzipped and is not reducible.

**Decision: vanilla three.js for v1.** This is a cost call, not a preference;
the plan permits either, and R3F does not fit a budget that is already
published and already gated. Recorded here so it is not relitigated per-commit.

## Finding 2 — the viewer cannot fit `bundleGzipBytes`, and the felt budgets are not the reason

`tools/perf-budget.mjs` computes `bundleGzipBytes` over `dist/index.html` plus
**everything** under `dist/app/`, with no distinction between the eager shell
and a lazily-imported chunk. So a vendored or bundled three.js counts in full
against the 150 KiB line whether or not the client defers it.

Projecting the measured components, with the index at its current 870 B gz:

| my own viewer code | bundle total | against the 150 KiB line | derived first interaction |
| --- | --- | --- | --- |
| 10 KiB gz | 153.2 KiB | **102% — red** | 735 ms / 3500 ms |
| 24 KiB gz | 167.8 KiB | **112% — red** | 740 ms / 3500 ms |
| 39 KiB gz | 182.5 KiB | **122% — red** | 745 ms / 3500 ms |

The first row is the point: **the gate reds at 102% before a single line of
viewer code is written that does anything.** 10 KiB gzipped does not buy an
address bar, four distinct flag messages, a layer panel, structure search,
deep links and cross-atlas restore. The realistic figure is the middle row.

And the column that matters is the last one. Every *felt* number the budget
exists to protect stays comfortably green:

- Derived first interaction: **~740 ms against a 3,500 ms budget** — 21% used.
- three.js's transfer cost on the reference 25 Mbit/s link: **40 ms.**

So this is not the viewer being too heavy for the reference machine. It is a
**component cap whose stated rationale does not cover a renderer.** The
budget's own justification for 150 KiB is "the point at which a 25 Mbit/s link
spends more time on our own code than on a round trip" — 150 KiB / 3125 B per
ms = 49 ms against 2 RTT = 80 ms. That is an argument about how much
*application* code belongs on the critical path. It was never an argument
about a WebGL renderer, because there was no renderer in the tree when it was
written.

### What I am not doing

Widening a number until a red turns green. The felt budgets are the honest
gate and they survive; the component line is the thing whose shape is wrong.
`ci/performance-budget.json` and `tools/perf-budget.mjs` are the Release
Engineer's files, [DOG-6](/DOG/issues/DOG-6) is mid-approval with a merge card
pending with the repo owner, and a gate is not something a downstream consumer
edits to make room for itself.

### The shape that keeps the gate meaningful

Recommended to Release Engineering, in preference order:

1. **Split the renderer onto its own line.** Keep `bundleGzipBytes` for
   application code at or near its current limit — it still does its stated
   job — and add a separate `rendererGzipBytes` (≈140 KiB, which holds the
   measured 126.5 KiB with room for `OrbitControls` growth and no more). Both
   continue to feed `transferMs()`, so the derived felt numbers still gate the
   total and a regression anywhere is still caught. This preserves exactly the
   property that makes the budget worth having: a line that fails tells you
   which thing got heavier.
2. **Distinguish eager from deferred under `dist/app/`.** The viewer should
   dynamically `import()` the renderer regardless of the gate (see below), so
   the gate could measure the eager shell separately from deferred chunks and
   charge the deferred ones only to the asset-load budget. This is more
   faithful to what the user pays but a larger change to the tool.

Option 1 is enough to unblock and is the smaller edit.

### What the viewer does regardless

The renderer is loaded by dynamic `import()`, after the shell paints, for a
reason that has nothing to do with the gate: **addresses must parse and
resolve to names even when the atlas is unavailable** (§6, and the stage-A
criterion "asset load failure → the atlas reports unavailable, and addresses
still parse and still resolve to names"). If the address bar sat behind the
renderer's 126 KiB, a renderer that failed to load would take address
resolution down with it, which the edge-case table forbids. `@gstack/alc` at
18 KiB plus the shell is the critical path; three.js is not.

That makes the eager shell `index.html` + `style.css` + `@gstack/alc` =
**19.9 KiB gzipped**, plus the viewer's own code — about **44 KiB** at the
realistic 24 KiB figure above. Comfortably inside the existing line. The gate
as currently shaped charges us for the deferred renderer chunk anyway, which
is finding 2.
