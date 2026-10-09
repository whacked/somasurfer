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
import { encodeBody, type TemplateSet, type Vec3 } from '../../alc/src/index.ts';

/**
 * Which template a row is resolved against.
 *
 * Declared here rather than in `matrix.ts` so that `matrix.ts` can import the
 * digit limit below at module load without an import cycle. The matrix needs
 * the limit, the limit needs the template, and the template needs to know which
 * one was asked for — so the type belongs with the templates.
 *
 * `fold-fixture` is the DOG-9 finding-1 counterexample — a template the
 * per-level audit clears and which folds anyway. A pipeline must never produce
 * it, which is exactly why the viewer has to be shown behaving correctly when
 * handed one: `folded` is a runtime fact about an address in a template, and a
 * build with no folding template available has never displayed the message.
 */
export type TemplateChoice = 'body' | 'fold-fixture' | 'brain' | 'no-brain';

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

// ---------------------------------------------------------------------------
// The precision boundary, derived rather than written down
// ---------------------------------------------------------------------------

/**
 * How many refinement digits the bound body template justifies.
 *
 * Read from the template, never hard-coded, and that is a correctness
 * requirement rather than tidiness. `flags.overPrecise` is raised relative to
 * *the bound template's* `maxUsefulDigits`; the frame does not clamp to some
 * absolute precision. So a matrix that writes the boundary down as a literal is
 * asserting a property of one template against whichever template is actually
 * loaded.
 *
 * The numbers involved make this concrete. The synthetic `anat-adult-p50`
 * justifies 5. The real `bp3d-4.0-adult-body-centroid` from the asset pipeline
 * declares 2, because it is a 99%-decimated mesh with a ~6.25 mm mean edge. A
 * row pinning "5 digits is not over-precise" inverts the moment the real
 * template is bound — and the round-trip rows invert with it, because an
 * over-precise address takes the truncating display path and stops matching the
 * address that was put in the URL.
 *
 * `maxUsefulDigits` is also a *measured* property that will legitimately rise
 * when the mesh gets finer, without invalidating a single issued address. A
 * test that hard-pins it therefore goes red on a correct improvement to the
 * asset, and a false red in a suite with thirteen deliberate failures is worse
 * than a missing case: it teaches everyone to discount the colour.
 */
export function bodyDigitLimit(choice: TemplateChoice = 'body'): number {
  const body = templateSet(choice).body as { maxUsefulDigits?: number } | undefined;
  const limit = body?.maxUsefulDigits;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `template ${choice} does not declare an integer maxUsefulDigits (got ${JSON.stringify(limit)}); `
      + 'the matrix cannot derive its precision boundary',
    );
  }
  return limit;
}

/** An octal digit pool the derived addresses are sliced from. Arbitrary, and fixed so runs are diffable. */
const DIGIT_POOL = '5312465312465';

/**
 * Digit counts the matrix uses, all three derived from the bound template.
 *
 * `ordinary` is the count the everyday rows use — a few digits, but never more
 * than the template justifies, so those rows are never accidentally testing
 * over-precision. `atLimit` is exactly the limit and must NOT be over-precise;
 * `overLimit` is one past it and must be.
 */
export function digitCounts(choice: TemplateChoice = 'body'): {
  ordinary: number;
  atLimit: number;
  overLimit: number;
} {
  const atLimit = bodyDigitLimit(choice);
  return { ordinary: Math.min(3, atLimit), atLimit, overLimit: atLimit + 1 };
}

/** `BD-T07-03O-` plus `count` digits from the pool. */
export function bodyAddressWithDigits(count: number, anchors = 'T07-03O'): string {
  if (count > DIGIT_POOL.length) {
    throw new Error(`need ${count} digits and the pool holds ${DIGIT_POOL.length}; extend DIGIT_POOL`);
  }
  const digits = DIGIT_POOL.slice(0, Math.max(0, count));
  return digits ? `BD-${anchors}-${digits}` : `BD-${anchors}`;
}

/**
 * The address a point encodes to in the bound template.
 *
 * The clamp rows need this: their address is a *function* of the template, the
 * point and the digit count, so writing it down as a literal pins a property of
 * one template. The behaviour those rows assert — which end is named, that the
 * camera reaches the cell, that a fold is not reported — stays literal, because
 * that is the requirement. The string does not, because it is derived.
 */
export function encodedBodyAddress(choice: TemplateChoice, pointMm: Vec3, digits: number): string {
  const body = templateSet(choice).body;
  if (!body) throw new Error(`template ${choice} has no body template to encode against`);
  return encodeBody(body, pointMm, digits).address;
}
