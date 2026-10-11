/**
 * Shared fixtures for the viewer suite.
 *
 * Templates go through `JSON.parse(JSON.stringify(...))` and then through the
 * validators before any test sees them. That is not ceremony: in the browser a
 * template arrives as fetched JSON, so a test holding the live object the
 * generator returned would be testing a path the product never takes — and
 * would miss, for instance, a validator that rejects a field the generator
 * happens to emit as a typed array.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNameIndex } from '../src/alc.js';
import {
  buildNameIndexInput,
  buildResearchFixture,
  buildTemplates,
} from '../fixtures/fixtures.mjs';
import { validateBodyTemplate, validateBrainVolumeTemplate } from '../src/viewer/template.js';

const asJson = (value) => JSON.parse(JSON.stringify(value));

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFINITIONS = buildTemplates();

/** One template definition by id, as it would arrive over the network. */
export function definition(id) {
  const found = DEFINITIONS.find((d) => d.id === id);
  if (!found) throw new Error(`no fixture template ${id}`);
  return asJson(found);
}

export const bodyTemplate = (id = 'anat-adult-p50') =>
  validateBodyTemplate(definition(id).template);

export const brainTemplate = (id = 'syn-brain-adult') =>
  validateBrainVolumeTemplate(definition(id).template);

/** The default template set: the admissible adult body plus the adult brain. */
export const templates = () => ({
  body: bodyTemplate(),
  brainVolume: brainTemplate(),
});

/** A template set whose body folds, for exercising `flags.folded`. */
export const foldingTemplates = () => ({
  body: bodyTemplate('anat-hyperkyphotic-short-wide'),
  brainVolume: brainTemplate(),
});

let cachedIndex = null;
export function nameIndex() {
  if (!cachedIndex) cachedIndex = buildNameIndex(asJson(buildNameIndexInput()));
  return cachedIndex;
}

export const research = () => asJson(buildResearchFixture());

/**
 * The curated 30-paper dataset, as `dist/data/research.json` serves it.
 *
 * Read off disk and given the `role` the build adds, so a test sees the same
 * bytes the browser fetches rather than an object assembled in process. The
 * dataset is `research/1` TEXT: structure ids and provenance, no geometry. The
 * geometry is decided by `curatedModel()` against the real name index, which is
 * the thing worth testing.
 */
export const curatedSeed = () => ({
  ...JSON.parse(
    readFileSync(join(PACKAGE_ROOT, '..', 'atlas-research', 'data', 'research-seed.json'), 'utf8'),
  ),
  role: 'curated',
});

export { DEFINITIONS };

/**
 * Every `.js` file under a directory of this package, recursively.
 *
 * For suites that assert a property of the source itself rather than of its
 * behaviour — "no module under `src/` names an asset path" is one, and the
 * address-equality guard is another. Walking the tree rather than listing
 * files is the point: a rule that only covers the files someone remembered to
 * list stops covering the next one added.
 */
export function sourceFilesOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) out.push(p);
    }
  };
  walk(join(PACKAGE_ROOT, dir));
  return out;
}
