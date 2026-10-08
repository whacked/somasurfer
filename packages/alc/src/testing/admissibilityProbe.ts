/**
 * Ground truth for template admissibility.
 *
 * `auditBodyTemplate` predicts whether the `BD` frame folds on a template.
 * This measures whether it actually does, by round-tripping dimensionless
 * coordinates through millimetres and back. A prediction is only worth
 * trusting if it agrees with this, which is what `test/admissibility.test.ts`
 * checks across a parameter sweep.
 *
 * The asset pipeline should run this against each real template too: the audit
 * is cheap and analytic, the probe is the thing that cannot be fooled.
 */

import { bodyLocalToMm, bodyMmToLocal, type BodyTemplate } from '../frames/bodySpine.ts';
import { rng } from './syntheticTemplates.ts';

export interface RoundTripOptions {
  samplesPerLevel?: number;
  seed?: number;
  /** Stay off the skin, where clamping rather than folding decides the result. */
  maxR?: number;
  /** Absolute tolerance on recovered u, t (turns) and r. */
  tol?: number;
}

export interface RoundTripResult {
  templateId: string;
  samples: number;
  failures: number;
  /** Levels where at least one sample failed, with counts, worst first. */
  failuresByLevel: Array<{ level: string; failures: number }>;
  /** Samples whose level assignment came back flagged as inadmissible. */
  inadmissibleNotes: number;
  /** Largest positional error among samples that round-tripped, mm. */
  worstGoodErrorMm: number;
}

export function measureRoundTrip(template: BodyTemplate, opts: RoundTripOptions = {}): RoundTripResult {
  const samplesPerLevel = opts.samplesPerLevel ?? 80;
  const maxR = opts.maxR ?? 0.995;
  const tol = opts.tol ?? 1e-6;
  const rand = rng(opts.seed ?? 20261008);

  const counts = new Map<string, number>();
  let failures = 0;
  let inadmissibleNotes = 0;
  let worstGoodErrorMm = 0;
  let samples = 0;

  for (const slab of template.slabs) {
    for (let k = 0; k < samplesPerLevel; k += 1) {
      const u = 0.02 + rand() * 0.96;
      const t = rand();
      const r = rand() * maxR;
      samples += 1;
      let bad = false;
      try {
        const mm = bodyLocalToMm(template, { level: slab.label, u, t, r });
        const back = bodyMmToLocal(template, mm);
        if (back.flags.notes?.some((n) => n.includes('inadmissible'))) inadmissibleNotes += 1;
        let dt = Math.abs(back.local.t - t);
        dt = Math.min(dt, 1 - dt); // azimuth is circular
        bad =
          back.local.level !== slab.label ||
          Math.abs(back.local.u - u) > tol ||
          dt > tol ||
          Math.abs(back.local.r - r) > tol;
        if (!bad) {
          const again = bodyLocalToMm(template, back.local);
          worstGoodErrorMm = Math.max(worstGoodErrorMm, Math.hypot(again[0] - mm[0], again[1] - mm[1], again[2] - mm[2]));
        }
      } catch {
        bad = true;
      }
      if (bad) {
        failures += 1;
        counts.set(slab.label, (counts.get(slab.label) ?? 0) + 1);
      }
    }
  }

  return {
    templateId: template.id,
    samples,
    failures,
    failuresByLevel: [...counts.entries()]
      .map(([level, n]) => ({ level, failures: n }))
      .sort((a, b) => b.failures - a.failures),
    inadmissibleNotes,
    worstGoodErrorMm,
  };
}
