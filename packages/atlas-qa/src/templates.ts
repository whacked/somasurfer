/**
 * The templates the stage-A build and this harness must agree on.
 *
 * Every pinned address, flag and extent in `matrix.ts` was measured against
 * these three. If the build under test resolves against different templates,
 * the matrix is asserting against one geometry and the screen is showing
 * another, and every millimetre expectation is meaningless — so the agreement
 * is published here as code rather than described in prose, and the build
 * imports the same function.
 *
 * All three are synthetic, from `@gstack/alc`'s own testing module. That is the
 * point of stage A: the viewer is built against the *template interface*, not
 * against one template, so it is testable while the asset pipeline (task 4)
 * runs in parallel. When real templates land, `matrix.ts`'s pinned millimetres
 * change and `test/oracle.test.ts` is what tells us which rows moved.
 *
 * `fold-fixture` deserves its own note. It is the DOG-9 finding-1
 * counterexample: a template the per-level audit clears with +7.8 mm to spare,
 * and which folds anyway. A pipeline must never produce it. It is here because
 * `folded` is a runtime fact about an address in a template, and a build that
 * has never been handed a folding template has never displayed the fold
 * message — which means nobody has seen it work.
 */

import {
  buildAnatomicalBodyTemplate,
  ADULT_P50,
  ADULT_HYPERKYPHOTIC_SHORT_WIDE,
} from '../../alc/src/testing/anatomicalTemplates.ts';
import { buildBrainTemplate, BRAIN_ADULT } from '../../alc/src/testing/syntheticTemplates.ts';
import type { TemplateSet } from '../../alc/src/index.ts';
import type { TemplateChoice } from './matrix.ts';

/** Memoised: building a template walks the whole spine, and the matrix asks often. */
const cache = new Map<string, TemplateSet>();

export function templateSet(choice: TemplateChoice): TemplateSet {
  const hit = cache.get(choice);
  if (hit) return hit;
  let set: TemplateSet;
  switch (choice) {
    case 'body':
      set = { body: buildAnatomicalBodyTemplate(ADULT_P50), brainVolume: buildBrainTemplate(BRAIN_ADULT) };
      break;
    case 'fold-fixture':
      set = {
        body: buildAnatomicalBodyTemplate(ADULT_HYPERKYPHOTIC_SHORT_WIDE),
        brainVolume: buildBrainTemplate(BRAIN_ADULT),
      };
      break;
    case 'brain':
      set = { body: buildAnatomicalBodyTemplate(ADULT_P50), brainVolume: buildBrainTemplate(BRAIN_ADULT) };
      break;
    case 'no-brain':
      // Deliberately no brainVolume: this is how `no_template` is reached.
      set = { body: buildAnatomicalBodyTemplate(ADULT_P50) };
      break;
    default:
      throw new Error(`unknown template choice ${JSON.stringify(choice)}`);
  }
  cache.set(choice, set);
  return set;
}

/** Template ids, for the report. */
export const TEMPLATE_IDS = {
  body: 'anat-adult-p50',
  fold: 'anat-hyperkyphotic-short-wide',
  brain: 'syn-brain-adult',
} as const;
