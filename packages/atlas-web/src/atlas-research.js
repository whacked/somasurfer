/**
 * The one place the viewer names `@gstack/atlas-research`.
 *
 * Exactly the role `alc.js` plays for the library, for exactly the same
 * reason — read that file's header first; this one only records what is
 * different.
 *
 *   Node (tests, QA harness)  this file, importing the TypeScript source
 *                             directly. Node 24 strips the types, so the
 *                             resolver the suite exercises is the resolver
 *                             `packages/atlas-research/test` is green against.
 *                             All 24 exports.
 *   Browser (dist/)           `build.mjs` emits `dist/app/atlas-research.js`
 *                             from `packages/atlas-research/dist/atlas-research.viewer.js`
 *                             in place of this file. THREE exports.
 *
 * ## The two surfaces differ, and that is the one thing to know here
 *
 * This is where `atlas-research.js` stops being the same arrangement as
 * `alc.js`. The library is served whole; the research layer is not. The
 * browser gets the bundle built from `packages/atlas-research/src/index.viewer.ts`
 * — `loadDataset`, `buildResearchIndex`, `formatCitation`, the three
 * `viewer/corpus.js` imports — because serving all 24 means serving
 * `browse.ts` and `layers.ts` too, and that was 8,702 B of gzip against a
 * `bundleGzipBytes` budget reading 98% of 150 KiB. DOG-84.
 *
 * So an import of any OTHER name resolves here under Node, typechecks, passes
 * the whole suite, and throws `SyntaxError` in the browser on first load. It
 * is the one failure mode in this package that green CI cannot see, and
 * `checkShimImportSurface()` in `../build.mjs` is the gate for it: it scans the
 * emitted `dist/app/` tree and requires every name taken from this specifier
 * to be one the emitted bundle really exports. `test/shim-surface.test.js`
 * makes the same check over `src/` in `test:counted`, which runs first.
 *
 * To use a fourth name: add it to `index.viewer.ts` and accept whatever its
 * module graph costs in `bundleGzipBytes`. Do not narrow THIS file to match —
 * the suite and the QA harness are green against the full surface, and
 * trimming it would turn a bundling decision into an API change.
 *
 * ## `@gstack/alc` must stay EXTERNAL to that bundle
 *
 * This is the one thing that differs from the `alc.js` substitution, and it is
 * not a packaging preference. `dataset.ts`, `browse.ts`, `layers.ts`,
 * `validate.ts` and `links.ts` all import `@gstack/alc`. If a bundler inlines
 * it, `dist/app/` holds two copies of the library, which means two `INTERNALS`
 * WeakMaps — and then `buildResearchIndex()` rejects the `NameIndex` the page
 * itself built through `joinNameIndex()` → `buildNameIndex()`, because the
 * object was branded by the other copy. It fails with `bad_name_index` on a
 * value that is manifestly a name index, and no stack trace says why.
 *
 * So the bundle must import alc rather than contain it, and in `dist/app/` the
 * two files are siblings, which makes the external specifier `'./alc.js'`.
 * `build.mjs` checks that rather than trusting it.
 *
 * ## Why the viewer takes this dependency at all
 *
 * Resolution could be reimplemented here against the alc primitives, and that
 * would be the wrong kind of cheap. `buildResearchIndex()` is where "nothing
 * falls back" lives — a `coordinates` mapping with no template does not quietly
 * become its structure's covering — and a second implementation of that rule in
 * the viewer is a second place for it to stop being true. Boundary 1 in the
 * plan's §3 says `@gstack/alc` knows nothing about meshes or the DOM; it does
 * not say the viewer may not know about the research layer. It must, because
 * the page is where the real name index arrives.
 *
 * Deliberately `export *`, for the reason `alc.js` is: this module adds nothing
 * and hides nothing.
 */

export * from '../../atlas-research/src/index.ts';
