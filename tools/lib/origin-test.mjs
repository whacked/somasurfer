/**
 * The pre-registered origin test for held brain structures (DOG-127).
 *
 * These numbers were committed BEFORE any reference mesh was downloaded and
 * before any residual was computed. `git log -- tools/lib/origin-test.mjs` shows
 * that order. Nothing that reads them may change them in the same change that
 * reports a result; a threshold moved after the data is a threshold chosen by
 * the data. The reasoning is in docs/brain-origin-test.md.
 */

export const ORIGIN_TEST = Object.freeze({
  /**
   * One similarity transform (rotation, uniform scale, translation) for the
   * whole test set, fitted jointly. Never one per structure: a per-structure
   * fit would let any blob of the right size "match".
   */
  alignment: 'single-global-similarity',

  /** Pass: mean symmetric surface distance, in reference millimetres. */
  maxMeanSymmetricMm: 1.5,

  /** Pass: 95th percentile of the one-sided distance, candidate → reference, in reference mm. */
  maxP95Mm: 3.0,

  /**
   * Pass: share of the candidate's vertices whose nearest reference vertex lies
   * in the same-named reference parcel. Tests the delineation, not just the
   * surface: a gyrus cut along different borders is a different delineation
   * even on the same cortex.
   */
  minLabelAgreement: 0.9,

  /**
   * The negative control. Each candidate is also scored against a parcel it is
   * NOT (the nearest differently-named one). If more than this share of those
   * mismatched pairs also pass, the test does not discriminate, and it clears
   * NOTHING, whatever the matched pairs show.
   */
  maxNegativeControlPassShare: 0.05,
});

/** Does one structure pass? All three criteria, never a weighted mix. */
export function originPasses(r) {
  return r.meanSymmetricMm <= ORIGIN_TEST.maxMeanSymmetricMm
    && r.p95Mm <= ORIGIN_TEST.maxP95Mm
    && r.labelAgreement >= ORIGIN_TEST.minLabelAgreement;
}
