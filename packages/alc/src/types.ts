export type Vec3 = readonly [number, number, number];

export type Hemisphere = 'L' | 'R';

/** How well an address' anchor exists in a given template's anatomy. */
export type Homology = 'exact' | 'mapped' | 'absent';

export interface LocateFlags {
  /** The refinement digits are finer than this template can justify. */
  overPrecise?: boolean;
  /** The point fell outside the template's modelled extent and was clamped. */
  clamped?: boolean;
  /** The anchor is not present in this template as-named (e.g. L6 vertebra). */
  homology?: Homology;
  notes?: string[];
}

export interface Located {
  /** Cell centre in template millimetres. */
  pointMm: Vec3;
  /** Axis-aligned-ish cell extent in template millimetres, for honesty about precision. */
  extentMm: Vec3;
  flags: LocateFlags;
}

export interface FrameDescriptor {
  readonly id: string;
  /** Number of `-`-separated anchor segments between the frame id and the digits. */
  readonly anchorSegments: number;
  readonly digitAlphabet: string;
  readonly maxDigits: number;
  /** Human sentence describing the frame, used by the translator UI. */
  readonly summary: string;
}
