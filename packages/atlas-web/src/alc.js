/**
 * The one place the viewer names `@gstack/alc`.
 *
 * Every viewer module imports the library through this file, and nothing else
 * in `src/` reaches into the library's path. That is what lets the same viewer
 * source run in two environments without a bundler:
 *
 *   Node (tests, QA harness)  this file, importing the TypeScript source
 *                             directly. Node 24 strips the types; the code the
 *                             tests exercise is the code the conformance suite
 *                             is green against, with no build step in between.
 *   Browser (dist/)           `build.mjs` emits `dist/app/alc.js` from
 *                             `packages/alc/dist/alc.js` — the library's own
 *                             single-file browser bundle — in place of this
 *                             file. `dist/app/viewer/*.js` resolve `../alc.js`
 *                             to it, because dist/app mirrors src/.
 *
 * The substitution is only safe if both sides export the same names, so it is
 * checked rather than assumed, in two places: `packages/alc/scripts/build.mjs`
 * verifies the bundle's export names and behaviour against the TypeScript
 * source, and `build.mjs` here re-checks the parity before it emits, and fails
 * the build if the bundle is missing or has drifted.
 *
 * Deliberately `export *`: this module adds nothing and hides nothing. A viewer
 * concern that wants to wrap a library call belongs in a viewer module, not
 * here — see boundary 1 in the plan's §3.
 */

export * from '../../alc/src/index.ts';
