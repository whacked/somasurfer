/**
 * Frame `BR` — cortical surface, HEALPix on the registered sphere. EXPERIMENTAL.
 *
 *   BR-L-7A3F
 *   │  │  └── HEALPix NESTED index, hex, first digit 0..B (the 12 base faces)
 *   │  └───── hemisphere
 *   └──────── frame id
 *
 * Why this frame exists even though `BV` already covers the cortex: cortex is a
 * sheet. Two points 3 mm apart in the volume can be on opposite banks of a
 * sulcus and 30 mm apart along the sheet, in different areas, with different
 * connectivity. Volumetric addresses cannot express that; surface addresses can.
 *
 * Why it is cheap to specify: the standard cross-subject correspondence for
 * cortex is already a registration of each hemisphere to a sphere. A sphere is
 * exactly the domain Earth geocoding was built for, so HEALPix transfers with
 * no adaptation, and the spherical registration is what carries the age and
 * population normalisation. The address is an index on the sphere; the mesh is
 * a template detail.
 *
 * Why it ships disabled in v1: the codec below is complete, but the frame needs
 * a cortical surface template with per-vertex spherical coordinates under a
 * licence we can redistribute. Until an asset lands, `BR` parses and refines
 * but cannot be located in millimetres.
 *
 * One honest caveat: HEALPix cells are equal-area on the SPHERE, and spherical
 * inflation is not area-preserving on the folded cortex. Cortical area per cell
 * therefore varies between gyral crowns and sulcal fundi. The asset pipeline
 * must measure that distribution per template and publish it; `cellAreaMm2` is
 * a mean, not a guarantee.
 */

import { AlcError, HEX, digitsToValues } from '../codec.ts';
import { ang2pixNest, childPix, npix, parentPix, pix2angNest } from '../healpix.ts';
import type { SphericalPoint } from '../healpix.ts';
import type { FrameDescriptor, Hemisphere } from '../types.ts';

export const BR: FrameDescriptor = {
  id: 'BR',
  anchorSegments: 1,
  digitAlphabet: HEX,
  maxDigits: 7,
  // The first hex digit is the HEALPix base face, so `BR-L` is not an address.
  minDigits: 1,
  summary: 'Cortical surface, indexed on the hemisphere registration sphere. Experimental in v1.',
};

/** Mean cortical surface area of one hemisphere, mm^2. Used only for guidance. */
export const HEMISPHERE_CORTICAL_AREA_MM2 = 90_000;

/** hex digit count -> HEALPix order. 1 digit = order 0, each further digit = +2. */
export function digitsToOrder(digitCount: number): number {
  if (digitCount < 1) throw new AlcError('BR requires at least one refinement digit', 'bad_precision');
  if (digitCount > BR.maxDigits) throw new AlcError(`BR supports at most ${BR.maxDigits} digits`, 'bad_precision');
  return (digitCount - 1) * 2;
}

export function orderToDigits(order: number): number {
  if (order < 0 || order % 2 !== 0) {
    throw new AlcError(`BR orders must be even and non-negative, got ${order}`, 'bad_precision');
  }
  return order / 2 + 1;
}

/** Mean cortical area of one cell at a digit count, mm^2. */
export function cellAreaMm2(digitCount: number): number {
  return HEMISPHERE_CORTICAL_AREA_MM2 / npix(digitsToOrder(digitCount));
}

/** Decode hex digits into the HEALPix NESTED pixel index and its order. */
export function brPixel(digits: string): { pix: number; order: number } {
  const values = digitsToValues(digits, HEX, 'cortical surface');
  if (values[0] > 11) {
    throw new AlcError(
      `the first BR digit selects one of 12 base faces and must be 0-B, got ${digits[0]}`,
      'bad_base_face',
    );
  }
  let pix = values[0];
  for (let i = 1; i < values.length; i += 1) pix = pix * 16 + values[i];
  const order = digitsToOrder(values.length);
  if (pix >= npix(order)) throw new AlcError('BR index out of range for its order', 'bad_index');
  return { pix, order };
}

export function brDigits(pix: number, order: number): string {
  const digitCount = orderToDigits(order);
  let rest = pix;
  const out: string[] = [];
  for (let i = 1; i < digitCount; i += 1) {
    out.unshift(HEX[rest % 16]);
    rest = Math.floor(rest / 16);
  }
  if (rest > 11) throw new AlcError('BR index out of range for its order', 'bad_index');
  out.unshift(HEX[rest]);
  return out.join('');
}

/** Direction on the registration sphere -> digits. */
export function brEncodeSphere(point: SphericalPoint, digitCount: number): string {
  return brDigits(ang2pixNest(point.theta, point.phi, digitsToOrder(digitCount)), digitsToOrder(digitCount));
}

/** Digits -> centre direction on the registration sphere. */
export function brDecodeSphere(digits: string): SphericalPoint {
  const { pix, order } = brPixel(digits);
  return pix2angNest(pix, order);
}

/** Coarser address digits, or null if already at the base face. */
export function brParentDigits(digits: string): string | null {
  const { pix, order } = brPixel(digits);
  if (order === 0) return null;
  return brDigits(parentPix(parentPix(pix)), order - 2);
}

/** The 16 child cells one digit finer. */
export function brChildDigits(digits: string): string[] {
  const { pix, order } = brPixel(digits);
  if (orderToDigits(order) >= BR.maxDigits) return [];
  const out: string[] = [];
  for (const q of childPix(pix)) for (const r of childPix(q)) out.push(brDigits(r, order + 2));
  return out;
}

export function parseHemisphere(seg: string): Hemisphere {
  if (seg === 'L' || seg === 'R') return seg;
  throw new AlcError(`hemisphere must be L or R, got ${JSON.stringify(seg)}`, 'bad_hemisphere');
}
