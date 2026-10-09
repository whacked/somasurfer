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

import { buildNameIndex } from '../src/alc.js';
import {
  buildNameIndexInput,
  buildResearchFixture,
  buildTemplates,
} from '../fixtures/fixtures.mjs';
import { validateBodyTemplate, validateBrainVolumeTemplate } from '../src/viewer/template.js';

const asJson = (value) => JSON.parse(JSON.stringify(value));

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

export { DEFINITIONS };
