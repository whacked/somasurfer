export type Vec3 = readonly [number, number, number];

export type Hemisphere = 'L' | 'R';

/**
 * How well an address' anchor exists in a given template's anatomy.
 *
 * The four values answer four different questions, and keeping them apart is
 * the point — `absent` used to mean all of "this template lacks it", "this
 * subject's anatomy differs" and "you mistyped it", which left a consumer
 * unable to tell a patient needing a level mapping from a typo.
 *
 *   exact    the template realises this anchor as named
 *   mapped   a registration supplied an explicit correspondence
 *   variant  the anchor is a recognised anatomical VARIANT (a vertebral count
 *            anomaly: T13, L06, S06) that this template does not realise. Real
 *            anatomy; a registration-supplied level mapping can resolve it
 *   absent   the anchor is canonical but this template does not realise it
 *            (e.g. S03 against the required single fused sacral level)
 *
 * A label that is neither canonical nor a recognised variant is not a homology
 * question at all: it is rejected by `parse()` with `bad_level`.
 */
export type Homology = 'exact' | 'mapped' | 'variant' | 'absent';

export interface LocateFlags {
  /** The refinement digits are finer than this template can justify. */
  overPrecise?: boolean;
  /** The point fell outside the template's modelled extent and was clamped. */
  clamped?: boolean;
  /**
   * The frame is not injective at this point in this template: more than one
   * anchor has an address for it, or none does. The answer is deterministic but
   * the address is ambiguous, and the notes name the competing anchors.
   *
   * "Has an address for it", not "claims it". A fold both duplicates and
   * displaces — spec §4's wedge on the convex side of a bend and gap on the
   * concave side — and a detector that counts how many anchors claim the point
   * sees only the first. In the displacement case exactly one anchor claims the
   * point, it is the wrong one, and the right one's address has quietly become
   * unreachable. That was QA-13, and it is why this flag is raised from the
   * round-trip question rather than from a claim count.
   *
   * Distinct from `clamped` on purpose. `clamped` says the point left the
   * modelled body; `folded` says the point is inside the body and the
   * *coordinate system* failed there. Reporting a fold as a clamp tells the
   * user the wrong thing about their data.
   */
  folded?: boolean;
  /** The anchor is not present in this template as-named (e.g. L6 vertebra). */
  homology?: Homology;
  notes?: string[];
}

export interface Located {
  /** Cell centre in template millimetres. */
  pointMm: Vec3;
  /** Axis-aligned-ish cell extent in template millimetres, for honesty about precision. */
  extentMm: Vec3;
  /**
   * Unit directions of the three `extentMm` axes at the cell centre, in
   * template millimetres, in the same order.
   *
   * Required, not optional, and that is the point: without it the only thing a
   * comparison can do with `extentMm` is take its diagonal, which is the cell's
   * reach along its *longest* axis. Charging that against a separation measured
   * along one direction is how `samePlace` came to call two disjoint cells the
   * same place (QA-12). A frame that cannot say which way its axes point cannot
   * be compared geometrically, so the type says so.
   *
   * For a curvilinear frame these are the axes at the centre only — `BD`'s
   * azimuthal axis turns across the cell — so a projection onto them is exact
   * for `BV` and a close approximation for `BD`. Where exactness matters,
   * `samePlace` uses the frame's own nested-or-disjoint guarantee instead.
   */
  axesMm: readonly [Vec3, Vec3, Vec3];
  /**
   * Which template answered. Two addresses resolved in the same template share
   * a coordinate system, which is what lets a comparison use the frame's exact
   * hierarchy answer; resolved in two templates they do not, and only the
   * millimetres can speak.
   */
  templateId: string;
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
