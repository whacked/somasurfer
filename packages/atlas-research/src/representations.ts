/**
 * The `Representation` registry (DOG-123 plan §3.4).
 *
 * The brain has many representations: gross anatomy, MNI coordinates,
 * Brodmann, HCP-MMP1 surfaces, connectivity, DTI. No single interface covers
 * them, so the resolver never hard-wires one. A representation declares what
 * it is, and the resolver reads only those declarations: whether it has named
 * structures, which coordinate space it lives in, how that space reaches MNI.
 * It never branches on which representation it was handed.
 *
 * That is what keeps the cortex swappable. Today the cortex is held (126 of
 * 128 Z-Anatomy cortical structures, DOG-127), so a cortical crosswalk target
 * resolves to a stated hold. If a lobe-labelled ICBM152 cortex or a cleared
 * gyral cortex arrives, it is one more entry here plus crosswalk targets that
 * name it: data, not resolver code.
 *
 * This file holds descriptors only. The structures, holds and geometry come
 * from `packages/atlas-assets` and are injected by the caller as
 * `RepresentationData`, because this package must not depend on the asset
 * package (licence rules 2 and 3).
 */

export type GeometryKind = 'surface-mesh' | 'volume' | 'tract' | 'point-set';

export interface Representation {
  /** Registry id. Stable across asset versions; the version travels in `RepresentationData`. */
  readonly id: string;
  readonly title: string;
  readonly geometry: GeometryKind;
  /** The coordinate space the geometry is expressed in. */
  readonly space: string;
  /**
   * How a point in MNI reaches this representation's space.
   *
   * `affine` — through a fitted registration, which is never exact; its
   *   measured error is injected with the data and every coordinate link
   *   carries it.
   * `identity` — the representation is natively in MNI.
   * `none` — no transform exists, so coordinates cannot be placed here.
   */
  readonly toMni: 'affine' | 'identity' | 'none';
  /** Whether the representation names structures that a link can point at. */
  readonly labels: 'named-structures' | 'none';
  /**
   * A term scheme whose ids ARE this representation's structure ids, so a term
   * in it resolves `exact-term` by identity with no crosswalk entry.
   */
  readonly idScheme?: string;
  /** For a point set: the named spaces of curated coordinates it hosts. */
  readonly hostsSpaces?: readonly string[];
  readonly licenceClass: 'asset' | 'asset-nc' | 'code';
  readonly shareAlike: boolean;
}

/**
 * The registry. v2 ships the two the plan names, *Z-Anatomy gross anatomy* and
 * *MNI coordinates*. The third is v1's BodyParts3D name index, already shipped
 * and already resolving the body papers. It is registered rather than special-
 * cased, so the body half goes through the same resolver as the brain half. The
 * fourth is the lobe-labelled cortex, approved after the plan.
 */
export const REPRESENTATIONS: readonly Representation[] = Object.freeze([
  Object.freeze({
    id: 'zanatomy-gross-anatomy',
    title: 'Z-Anatomy gross anatomy (brain meshes, DOG-127)',
    geometry: 'surface-mesh',
    space: 'brainproject mesh world (metres)',
    toMni: 'affine',
    labels: 'named-structures',
    licenceClass: 'asset',
    shareAlike: true,
  }),
  Object.freeze({
    id: 'mni-coordinates',
    title: 'MNI coordinates (ICBM152 2009c)',
    geometry: 'point-set',
    space: 'MNI',
    toMni: 'identity',
    labels: 'none',
    // The seed records `MNI152` without naming the template. It is hosted here
    // as ICBM152 2009c, and the difference between MNI templates is not added
    // to any precision figure; the link's basis says so.
    hostsSpaces: Object.freeze(['MNI152']),
    licenceClass: 'code',
    shareAlike: false,
  }),
  Object.freeze({
    id: 'bodyparts3d-bd',
    title: 'BodyParts3D 4.0 name index (v1 BD body frame)',
    geometry: 'volume',
    space: 'BD',
    toMni: 'none',
    labels: 'named-structures',
    idScheme: 'FMA',
    licenceClass: 'asset',
    shareAlike: true,
  }),
  // The cortex the owner approved on card 6a774981 (DOG-151): the ICBM152 2009c
  // surface, natively MNI, with first-party lobe labels. Registered before its
  // data lands, so crosswalk targets can name it; until then the gate reports
  // those targets UNVERIFIED rather than checked.
  Object.freeze({
    id: 'icbm152-2009c-cortex-lobes',
    title: 'ICBM152 2009c cortex, first-party lobe labels (DOG-151)',
    geometry: 'surface-mesh',
    space: 'MNI',
    toMni: 'identity',
    labels: 'named-structures',
    licenceClass: 'asset',
    shareAlike: false,
  }),
] as Representation[]);

export function representation(id: string): Representation | undefined {
  return REPRESENTATIONS.find((r) => r.id === id);
}
