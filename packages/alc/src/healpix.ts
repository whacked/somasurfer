/**
 * HEALPix NESTED pixelisation of the unit sphere.
 *
 * Why HEALPix and not a lat/lon grid (geohash / Open Location Code style):
 *  - equal-area cells at every order, so one code length == one areal precision
 *  - 4-way hierarchical subdivision, so `pix >> 2` is the parent cell
 *    (this is what gives ALC its prefix-truncation property)
 *  - no polar singularity, unlike a lat/lon grid
 *
 * Reference: Gorski et al. 2005, "HEALPix: A Framework for High-Resolution
 * Discretization and Fast Analysis of Data Distributed on the Sphere",
 * ApJ 622:759. This is a direct implementation of ang2pix_nest / pix2ang_nest.
 */

/** jrll/jpll: ring and phi offsets of the 12 base-resolution face centres. */
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

/** Spread the low 16 bits of `v` into the even bit positions of the result. */
function spreadBits(v: number): number {
  let x = v & 0xffff;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  return x;
}

/** Inverse of spreadBits: gather the even bit positions of `v` into the low bits. */
function compactBits(v: number): number {
  let x = v & 0x55555555;
  x = (x | (x >>> 1)) & 0x33333333;
  x = (x | (x >>> 2)) & 0x0f0f0f0f;
  x = (x | (x >>> 4)) & 0x00ff00ff;
  x = (x | (x >>> 8)) & 0x0000ffff;
  return x;
}

export interface SphericalPoint {
  /** Colatitude in radians, 0 at +z (superior pole of the registration sphere). */
  theta: number;
  /** Longitude in radians. */
  phi: number;
}

/** Number of pixels at a given order. order k => 12 * 4^k. */
export function npix(order: number): number {
  return 12 * Math.pow(4, order);
}

/** Solid angle of one pixel, in steradians. Identical for every pixel. */
export function pixelSolidAngle(order: number): number {
  return (4 * Math.PI) / npix(order);
}

/**
 * Direction -> NESTED pixel index at `order`.
 * Guarantees: ang2pix(p, k) >> 2 === ang2pix(p, k - 1) for all k >= 1.
 */
export function ang2pixNest(theta: number, phi: number, order: number): number {
  const nside = 1 << order;
  const z = Math.cos(theta);
  const za = Math.abs(z);
  // tt in [0, 4): longitude measured in units of 90 degrees.
  let ph = phi % TWO_PI;
  if (ph < 0) ph += TWO_PI;
  const tt = ph / HALF_PI;

  let face: number;
  let ix: number;
  let iy: number;

  if (za <= 2 / 3) {
    // Equatorial belt: the four faces 4..7 plus the lower halves of 0..3 and
    // upper halves of 8..11. Located via the two diagonal line families.
    const temp1 = nside * (0.5 + tt);
    const temp2 = nside * z * 0.75;
    const jp = Math.floor(temp1 - temp2); // ascending edge line index
    const jm = Math.floor(temp1 + temp2); // descending edge line index
    const ifp = jp >> order; // in {0,1,2,3,4}
    const ifm = jm >> order;
    if (ifp === ifm) face = (ifp & 3) + 4;
    else if (ifp < ifm) face = ifp & 3;
    else face = (ifm & 3) + 8;
    ix = jm & (nside - 1);
    iy = nside - 1 - (jp & (nside - 1));
  } else {
    // Polar caps.
    const ntt = Math.min(3, Math.floor(tt));
    const tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(nside - 1, Math.floor(tp * tmp));
    const jm = Math.min(nside - 1, Math.floor((1 - tp) * tmp));
    if (z >= 0) {
      face = ntt;
      ix = nside - jm - 1;
      iy = nside - jp - 1;
    } else {
      face = ntt + 8;
      ix = jp;
      iy = jm;
    }
  }

  return face * nside * nside + (spreadBits(ix) | (spreadBits(iy) << 1));
}

/** NESTED pixel index -> direction of the pixel centre. */
export function pix2angNest(pix: number, order: number): SphericalPoint {
  const nside = 1 << order;
  const nside2 = nside * nside;
  const face = Math.floor(pix / nside2);
  const p = pix - face * nside2;
  const ix = compactBits(p);
  const iy = compactBits(p >>> 1);

  const nl4 = 4 * nside;
  const jr = JRLL[face] * nside - ix - iy - 1;

  let nr: number;
  let z: number;
  let kshift: number;
  if (jr < nside) {
    nr = jr;
    z = 1 - (nr * nr) / (3 * nside2);
    kshift = 0;
  } else if (jr > 3 * nside) {
    nr = nl4 - jr;
    z = (nr * nr) / (3 * nside2) - 1;
    kshift = 0;
  } else {
    nr = nside;
    z = ((2 * nside - jr) * 2) / (3 * nside);
    kshift = (jr - nside) & 1;
  }

  let jp = (JPLL[face] * nr + ix - iy + 1 + kshift) / 2;
  if (jp > nl4) jp -= nl4;
  if (jp < 1) jp += nl4;

  const phi = (jp - (kshift + 1) * 0.5) * (HALF_PI / nr);
  return { theta: Math.acos(Math.max(-1, Math.min(1, z))), phi };
}

/** Parent pixel one order coarser. */
export function parentPix(pix: number): number {
  return pix >>> 2;
}

/** The four child pixels one order finer. */
export function childPix(pix: number): [number, number, number, number] {
  const b = pix << 2;
  return [b, b + 1, b + 2, b + 3];
}

/** Unit vector for a direction. */
export function toVector(theta: number, phi: number): [number, number, number] {
  const st = Math.sin(theta);
  return [st * Math.cos(phi), st * Math.sin(phi), Math.cos(theta)];
}

/** Direction of a unit vector. */
export function fromVector(x: number, y: number, z: number): SphericalPoint {
  const r = Math.hypot(x, y, z) || 1;
  return { theta: Math.acos(Math.max(-1, Math.min(1, z / r))), phi: Math.atan2(y, x) };
}
