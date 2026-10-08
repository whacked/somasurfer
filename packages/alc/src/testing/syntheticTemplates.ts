/**
 * Parametric synthetic templates.
 *
 * These are not anatomy. They exist so the frame mathematics can be tested
 * against a controlled family of body shapes — different spine curvatures,
 * segment heights, girths, cross-sectional profiles and vertebral counts —
 * before any licensed mesh lands. The real templates built by the asset
 * pipeline must pass the same conformance suite.
 *
 * Template space convention: +x left, +y anterior, +z superior, millimetres.
 */

import type { BodyTemplate, VertebralSlab } from '../frames/bodySpine.ts';
import type { BrainVolumeTemplate } from '../frames/brainVolume.ts';
import type { Vec3 } from '../types.ts';

export interface BodyParams {
  id: string;
  /** Multiplies every vertebral body height. */
  axialScale: number;
  /** Multiplies every surface radius. */
  radialScale: number;
  /** Multiplies the sagittal curve amplitude. 0 is a straight spine. */
  curvature: number;
  /** Extra left-right girth asymmetry, as a fraction. */
  asymmetry: number;
  /** Number of lumbar vertebrae. 5 is typical; 4 and 6 both occur. */
  lumbarCount: number;
  maxUsefulDigits: number;
}

export const ADULT_MALE: BodyParams = {
  id: 'syn-adult-male',
  axialScale: 1,
  radialScale: 1,
  curvature: 1,
  asymmetry: 0,
  lumbarCount: 5,
  maxUsefulDigits: 5,
};

/** Shorter, rounder, straighter spine, narrower shoulders: a child-like shape. */
export const CHILD: BodyParams = {
  id: 'syn-child-7y',
  axialScale: 0.56,
  radialScale: 0.62,
  curvature: 0.7,
  asymmetry: 0,
  lumbarCount: 5,
  maxUsefulDigits: 4,
};

/** Taller, broader, more kyphotic, with mild asymmetry. */
export const ADULT_TALL: BodyParams = {
  id: 'syn-adult-tall',
  axialScale: 1.14,
  radialScale: 1.22,
  curvature: 1.35,
  asymmetry: 0.08,
  lumbarCount: 5,
  maxUsefulDigits: 5,
};

/** A six-lumbar-vertebra variant: roughly 1 person in 10 has a count anomaly. */
export const SIX_LUMBAR: BodyParams = { ...ADULT_MALE, id: 'syn-six-lumbar', lumbarCount: 6 };

interface LevelSpec {
  label: string;
  /** Unscaled vertebral body height, mm. */
  height: number;
  /** Unscaled mean radius from the spine axis to the skin, mm. */
  radius: number;
  /** Lateral-to-AP aspect ratio of the cross-section. */
  aspect: number;
}

function levelSpecs(lumbarCount: number): LevelSpec[] {
  const out: LevelSpec[] = [];
  for (let i = 1; i <= 7; i += 1) {
    out.push({ label: `C0${i}`, height: 15, radius: 55 + i * 2, aspect: 1.1 });
  }
  for (let i = 1; i <= 12; i += 1) {
    out.push({ label: `T${String(i).padStart(2, '0')}`, height: 19 + i * 0.4, radius: 95 + i * 3.5, aspect: 1.35 });
  }
  for (let i = 1; i <= lumbarCount; i += 1) {
    out.push({ label: `L0${i}`, height: 29, radius: 140 - i * 1.5, aspect: 1.2 });
  }
  for (let i = 1; i <= 5; i += 1) {
    out.push({ label: `S0${i}`, height: 17, radius: 130 - i * 6, aspect: 1.15 });
  }
  return out;
}

const AZIMUTH_SAMPLES = 24;

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function buildBodyTemplate(p: BodyParams): BodyTemplate {
  const specs = levelSpecs(p.lumbarCount);
  const slabs: VertebralSlab[] = [];

  // Walk the spine from C1 downward, accumulating z, with a sagittal curve.
  let z = 0;
  const yOf = (frac: number): number =>
    // Three alternating curves: cervical lordosis, thoracic kyphosis, lumbar lordosis.
    p.curvature * (14 * Math.sin(frac * Math.PI * 3) - 6 * Math.sin(frac * Math.PI));

  const total = specs.length;
  for (let i = 0; i < total; i += 1) {
    const spec = specs[i];
    const heightMm = spec.height * p.axialScale;
    const frac = (i + 0.5) / total;
    const y = yOf(frac);
    const origin: Vec3 = [0, y, z - heightMm / 2];

    // Tangent from the neighbouring curve samples, pointing caudal.
    const fPrev = Math.max(0, (i - 0.5) / total);
    const fNext = Math.min(1, (i + 1.5) / total);
    const dz = -((fNext - fPrev) * total) * heightMm;
    const dy = yOf(fNext) - yOf(fPrev);
    const axial = normalize([0, dy, dz]);
    // Anterior: perpendicular to axial inside the sagittal plane, pointing +y.
    const anterior = normalize(cross([1, 0, 0], axial));
    const left = normalize(cross(axial, anterior));

    const surfaceRadiiMm: number[] = [];
    for (let k = 0; k < AZIMUTH_SAMPLES; k += 1) {
      const t = k / AZIMUTH_SAMPLES;
      const ang = t * 2 * Math.PI;
      // Ellipse-ish: wider laterally than anterior-posterior.
      const lateral = Math.abs(Math.sin(ang));
      const base = spec.radius * (1 + (spec.aspect - 1) * lateral);
      // Posterior is flatter than anterior (the back is closer to the spine).
      const posteriorFlattening = Math.cos(ang) < 0 ? 0.72 : 1;
      // Asymmetry pushes the subject's left side out.
      const asym = 1 + p.asymmetry * Math.sin(ang);
      surfaceRadiiMm.push(base * posteriorFlattening * asym * p.radialScale);
    }

    slabs.push({ label: spec.label, origin, axial, anterior, left, heightMm, surfaceRadiiMm });
    z -= heightMm;
  }

  return { id: p.id, slabs, maxUsefulDigits: p.maxUsefulDigits };
}

export interface BrainParams {
  id: string;
  left: number;
  right: number;
  anterior: number;
  posterior: number;
  superior: number;
  inferior: number;
  maxUsefulDigits: number;
}

/** Roughly the Talairach bounding box. */
export const BRAIN_ADULT: BrainParams = {
  id: 'syn-brain-adult',
  left: 68,
  right: 68,
  anterior: 70,
  posterior: 102,
  superior: 74,
  inferior: 42,
  maxUsefulDigits: 6,
};

/** A smaller brain with different extent ratios, as in a young child. */
export const BRAIN_CHILD: BrainParams = {
  id: 'syn-brain-child',
  left: 61,
  right: 63,
  anterior: 61,
  posterior: 91,
  superior: 66,
  inferior: 38,
  maxUsefulDigits: 5,
};

export function buildBrainTemplate(p: BrainParams, acMm: Vec3 = [0, 0, 0]): BrainVolumeTemplate {
  return {
    id: p.id,
    acMm,
    left: [1, 0, 0],
    anterior: [0, 1, 0],
    superior: [0, 0, 1],
    extents: {
      left: p.left,
      right: p.right,
      anterior: p.anterior,
      posterior: p.posterior,
      superior: p.superior,
      inferior: p.inferior,
    },
    maxUsefulDigits: p.maxUsefulDigits,
  };
}

/** Deterministic LCG, so conformance runs are reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
