/**
 * The subset of this package the viewer imports, and the entry the page's
 * bundle is built from. `index.ts` is still the package.
 *
 * Not a second API: every name below is a re-export of the binding `index.ts`
 * exports under the same name, from the same module. `scripts/build.mjs` note
 * 4 carries the reasoning, and `verifyViewerSurface()` there checks the three
 * claims this file makes — subset, same binding by identity, proper subset.
 *
 * The one thing to know before editing it: the browser's surface is now
 * smaller than the one the suite runs against, so importing a name that is not
 * here passes CI under Node and throws in the browser. The gate for that is
 * `checkShimImportSurface()` in `packages/atlas-web/build.mjs`. Adding a name
 * here means paying its module graph in `bundleGzipBytes`, which is why this
 * file exists.
 *
 * Kept short on purpose: it is inlined into the bundle it shrinks.
 */

export { loadDataset } from './validate.ts';
export { buildResearchIndex } from './dataset.ts';
export { formatCitation, sourceLink } from './links.ts';

// Type-only, so these edges are stripped before the graph is walked and cost
// the bundle nothing.
export type { MappingPrecision, ResearchIndex, ResearchIndexInput, ResolvedMapping } from './dataset.ts';
export type { Paper, ResearchDataset } from './types.ts';
