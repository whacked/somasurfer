/**
 * The viewer contract the §7 harness drives.
 *
 * This file exists because the harness is being written BEFORE the viewer
 * (plan task 5, DOG-36) and the research model (task 6, DOG-37). A suite
 * written against a build that already exists gets shaped by that build; this
 * one is shaped by DOG-1 §7 and plan §6 instead, and the build has to meet it.
 *
 * So the contract is the deliverable, not an implementation detail. Two things
 * follow from that, and both are deliberate:
 *
 *  1. **Everything here is observable.** No internals, no private handles, no
 *     "call this to find out what the renderer meant". A `ViewState` is what a
 *     human sitting in front of the page can see: which atlas, where the camera
 *     is, which layers are on, what is selected, what the page is telling them,
 *     what is highlighted and why. If the harness cannot see it, the harness
 *     cannot assert it, and a requirement nobody can observe is not a
 *     requirement.
 *
 *  2. **Messages are codes, not prose.** `which message appears` is an
 *     acceptance criterion on this task, and asserting it against English makes
 *     the suite fail on a copy edit and pass on a wrong message with the right
 *     words in it. So every state a user must be told about has a code from
 *     `MESSAGE_CODES`, and the prose is asserted separately and only where the
 *     prose itself is the requirement — `C08`, where naming the correction *is*
 *     the behaviour.
 *
 * ## What a build has to do to be testable
 *
 * Implement `ViewerDriver`. The product build is expected to do it through a
 * thin adapter over the real page — a `window.__atlasQa` test surface reading
 * the same state the UI renders from, not a parallel model, because a parallel
 * model is a second implementation that can agree with the suite while the
 * screen disagrees with both.
 *
 * ## Capabilities, and why they are not optional
 *
 * `capabilities()` is how a build says what it cannot yet do. A step or row
 * whose requirement is missing reports `unverified` — never `pass`. That is the
 * whole reason this type exists: the alternative is a build that quietly
 * no-ops an action, returns an unchanged state, and sails through an assertion
 * that was only ever checking that nothing blew up. A case that silently does
 * not run is a false green, and a false green here is invisible.
 *
 * See `runner.ts` for how `unverified` is allowed to propagate — short version:
 * never into a pass.
 */

export type Vec3 = readonly [number, number, number];

/**
 * Every state the UI is obliged to tell the user about.
 *
 * Closed on purpose. A build that needs a code outside this set is reporting
 * something the matrix has not been authored against, and the integrity gate
 * says so rather than letting an unrecognised code count as "a message
 * appeared".
 *
 * The pairs that must stay distinct are the point of the list:
 *
 *   clamped_cranial / clamped_caudal   which end of the column (plan §6)
 *   clamped_* / folded                 the point left the body, versus the
 *                                      coordinate system failed where the
 *                                      point is. Conflating these tells the
 *                                      user the wrong thing about their data
 *   homology_variant / homology_absent real anatomy this template lacks,
 *                                      versus reserved grammar no template
 *                                      realises. Reserved space is not anatomy
 *   rejected_* / anything else         a rejection happens before geometry and
 *                                      changes nothing else on the page
 */
export const MESSAGE_CODES = [
  // Resolution notices — the address resolved, with a caveat.
  'over_precise',
  'clamped_cranial',
  'clamped_caudal',
  'folded',
  'homology_variant',
  'homology_absent',
  // Refusals — the address did not resolve.
  'rejected_grammar',
  'rejected_level',
  'rejected_check',
  'rejected_too_long',
  'no_template',
  'frame_disabled',
  // Offers that must accompany the two refusals that have a fallback.
  'coarsest_ancestor_offered',
  // Asset and data state.
  'assets_unavailable',
  'region_level_only',
  // Name resolution provenance.
  'name_index_version',
] as const;

export type MessageCode = (typeof MESSAGE_CODES)[number];

export interface Message {
  readonly code: MessageCode;
  /** `error` blocks the action; `notice` accompanies a result. */
  readonly severity: 'error' | 'notice';
  /** User-visible text. Asserted only where the wording is the requirement. */
  readonly text: string;
}

/**
 * How the cell is drawn.
 *
 * `kind` is the honesty requirement from plan §4, as a value. An over-precise
 * address must look coarse on screen: it resolves, and it is drawn at the
 * extent the template can justify. A build that draws a point has thrown away
 * the only visual cue that the precision is borrowed, which is why
 * `point` is representable here at all — so the suite can fail it.
 */
export interface CellRender {
  readonly kind: 'extent' | 'point';
  /** Extent actually drawn, in template millimetres. */
  readonly extentMm: Vec3;
  /** Digits the address carried. */
  readonly addressDigits: number;
  /** Digits the template justifies, which is what `extentMm` must correspond to. */
  readonly displayedDigits: number;
}

export interface Camera {
  readonly targetMm: Vec3;
  readonly distanceMm: number;
  /** Any stable encoding of orientation; compared for equality, never interpreted. */
  readonly orientation: readonly number[];
}

export interface LayerState {
  readonly visible: boolean;
  /** 0..1. */
  readonly opacity: number;
}

export interface RankedName {
  readonly structureId: string;
  readonly name: string;
  /** Containment fraction of the selected cell. */
  readonly fraction: number;
}

/**
 * One research highlight.
 *
 * `paperId` and `findingId` are both required, and that is DOG-1 §3: every
 * highlight traces back to a specific finding, with its paper reachable. A
 * highlight that can only say which paper it came from cannot answer "why is
 * this region lit up", so the type refuses to express one.
 */
export interface Highlight {
  readonly paperId: string;
  readonly findingId: string;
  /** Cells lit, as ALC addresses. Compared as coverings, never as strings. */
  readonly cells: readonly string[];
  /** True where this finding has no spatial detail and is shown region-level only. */
  readonly regionLevelOnly: boolean;
  /** Per-paper colour token. Distinctness is asserted, the value is not. */
  readonly colour: string;
  /**
   * The subset of `cells` another selected paper also covers, hatched on screen.
   *
   * A subset and not a boolean, which running the suite is what established: a
   * finding covering two cells where only one is shared would otherwise have to
   * declare itself wholly overlapping or not at all, and a build hatching the
   * whole finding is overstating the overlap. Overlap is computed per cell by
   * covering intersection, so it is expressible per cell, so the type says so.
   */
  readonly hatchedCells: readonly string[];
}

export interface SelectionState {
  /** Structure the user selected, if any. */
  readonly structureId: string | null;
  /** Canonical ALC address of the selected cell. */
  readonly address: string | null;
}

export interface ResearchState {
  /** The anatomical filter narrowing the paper LIST. Never a selected paper's own mappings. */
  readonly filter: string | null;
  /** Paper ids the list is showing, in order. */
  readonly paperList: readonly string[];
  readonly selectedPaperIds: readonly string[];
  readonly highlights: readonly Highlight[];
}

/**
 * The whole observable state of the page.
 *
 * Deliberately a plain, deep-frozen, JSON-serialisable value: the harness
 * snapshots it, diffs two snapshots to assert what did *not* change, and writes
 * it into the report so a failure is readable six weeks later without a
 * browser. Anything that cannot survive `structuredClone` does not belong here.
 */
export interface ViewState {
  readonly atlas: 'body' | 'brain';
  readonly camera: Camera;
  readonly layers: Readonly<Record<string, LayerState>>;
  readonly isolatedStructureId: string | null;
  readonly labelsVisible: boolean;
  readonly selection: SelectionState;
  /** The full URL, as the address bar shows it. */
  readonly url: string;
  /**
   * The canonical address the view is currently RESTORED TO, or null.
   *
   * Not simply the `a` parameter. Null when the parameter is absent, empty, or
   * was rejected — because a deep link carrying a bad address leaves that
   * address in the URL bar (the user needs to see and fix it) while restoring
   * nothing. Reading this straight off the query string would make every
   * rejection row report that the address "restored" fine, which is the
   * opposite of the behaviour under test. `url` is still the raw string, for
   * the hygiene rows.
   */
  readonly urlAddress: string | null;
  readonly cell: CellRender | null;
  /** Ranked names with fractions. Never a single name — see `journey.ts`. */
  readonly names: readonly RankedName[] | null;
  readonly nameIndexVersion: string | null;
  readonly messages: readonly Message[];
  readonly research: ResearchState;
  /** False when the geometry failed to load. Addresses must still parse and resolve. */
  readonly assetsAvailable: boolean;
  /** Which template answered, for the cross-template comparison rows. */
  readonly templateId: string | null;
}

/**
 * What a build can do.
 *
 * Named rather than inferred. A build that cannot yet hatch overlaps declares
 * it and the overlap rows go `unverified`; a build that silently draws them
 * unhatched fails. Those are different facts and the harness must not have to
 * guess which it is looking at.
 */
export const CAPABILITIES = [
  'body-atlas',
  'brain-atlas',
  'layers',
  'opacity',
  'isolate',
  'labels',
  'structure-search',
  'camera-controls',
  'click-select',
  'paste-address',
  'deep-link',
  'ranked-names',
  'cross-atlas-navigation',
  'view-restore',
  'browse-by-anatomy',
  'browse-by-research',
  'multi-paper-selection',
  'overlap-hatching',
  'asset-failure-reporting',
  'qa-template-override',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The surface the harness drives.
 *
 * Every mutator returns the state *after* the action, so a step reads as
 * action-then-assertion with no polling. Implementations must not return until
 * the UI has settled; a driver that returns early turns a real failure into a
 * flake, and a flake in a must-pass row is indistinguishable from the false
 * green this whole suite exists to prevent.
 */
export interface ViewerDriver {
  /** Identifies the build under test in the report. */
  readonly buildId: string;
  /**
   * `product` is the real build — the only kind whose pass means §7 is
   * verified. `reference` is the QA stand-in that makes this suite executable
   * before the viewer exists. `mutant` is a deliberately broken build used as a
   * negative control. The report prints this, loudly, next to every verdict.
   */
  readonly kind: 'product' | 'reference' | 'mutant';

  capabilities(): ReadonlySet<Capability>;

  /** Load a URL — the deep-link entry point. */
  open(url: string): Promise<ViewState>;
  state(): Promise<ViewState>;

  /** Viewer controls. */
  setLayer(layerId: string, patch: Partial<LayerState>): Promise<ViewState>;
  isolate(structureId: string | null): Promise<ViewState>;
  setLabels(visible: boolean): Promise<ViewState>;
  orbit(deltaDeg: number): Promise<ViewState>;
  zoom(factor: number): Promise<ViewState>;
  resetCamera(): Promise<ViewState>;
  searchStructures(query: string): Promise<readonly RankedName[]>;

  /** Selection and addressing. */
  clickStructure(structureId: string): Promise<ViewState>;
  /**
   * A click that lands at a point in template millimetres — plan §4's raycast
   * result, before any structure is known.
   *
   * Separate from `clickStructure` because `clamped` is raised turning
   * millimetres INTO an address and is therefore unreachable by pasting one. A
   * contract with only structure clicks cannot express "the user clicked 400 mm
   * above the top of the column", which is the only way the clamp rows happen.
   */
  clickPointMm(pointMm: Vec3, digits: number): Promise<ViewState>;
  pasteAddress(text: string): Promise<ViewState>;

  /** Cross-atlas navigation. Both explicit; neither ever happens on selection. */
  openBrainAtlas(): Promise<ViewState>;
  returnToBody(): Promise<ViewState>;

  /** Research. */
  setAnatomyFilter(structureId: string | null): Promise<ViewState>;
  selectPaper(paperId: string, options?: { add?: boolean }): Promise<ViewState>;
  clearPaperSelection(): Promise<ViewState>;

  /**
   * Ask the build the same "same place?" question the UI asks when it decides
   * whether two papers overlap.
   *
   * Exposed on the contract so the address-string-equality guard can be asserted
   * at the UI level and not only by scanning source. A build that answers this
   * by comparing canonical strings gets the cross-subject cases wrong, and the
   * `equality-guard` rows are what notice.
   */
  samePlaceAcrossSubjects(
    cellsA: readonly string[],
    cellsB: readonly string[],
    toleranceMm: number,
  ): Promise<{ same: boolean; basis: string }>;

  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Observation helpers
// ---------------------------------------------------------------------------

export function messageCodes(state: ViewState): MessageCode[] {
  return state.messages.map((m) => m.code);
}

export function hasMessage(state: ViewState, code: MessageCode): boolean {
  return state.messages.some((m) => m.code === code);
}

export function messageText(state: ViewState, code: MessageCode): string {
  return state.messages.filter((m) => m.code === code).map((m) => m.text).join(' ');
}

/** Facets a row can require to be unchanged. Each maps to a stable projection. */
export const FACETS = {
  atlas: (s: ViewState) => s.atlas,
  camera: (s: ViewState) => s.camera,
  layers: (s: ViewState) => s.layers,
  isolated: (s: ViewState) => s.isolatedStructureId,
  labels: (s: ViewState) => s.labelsVisible,
  selection: (s: ViewState) => s.selection,
  url: (s: ViewState) => s.url,
  cell: (s: ViewState) => s.cell,
  names: (s: ViewState) => s.names,
  filter: (s: ViewState) => s.research.filter,
  paperList: (s: ViewState) => s.research.paperList,
  selectedPapers: (s: ViewState) => s.research.selectedPaperIds,
  highlights: (s: ViewState) => s.research.highlights,
  templateId: (s: ViewState) => s.templateId,
} as const;

export type Facet = keyof typeof FACETS;

/**
 * Stable JSON for comparing a facet across two snapshots.
 *
 * Object keys are sorted so that a build which rebuilds its layer record in a
 * different insertion order is not reported as having changed the layers. The
 * one thing this must never do is normalise an address, because then an address
 * changing from one form to another would compare equal.
 */
export function facetKey(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return typeof v === 'number' && Number.isNaN(v) ? '__NaN__' : v;
    if (seen.has(v as object)) return '__cycle__';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/** Facets that differ between two snapshots. */
export function changedFacets(before: ViewState, after: ViewState): Facet[] {
  return (Object.keys(FACETS) as Facet[]).filter(
    (f) => facetKey(FACETS[f](before)) !== facetKey(FACETS[f](after)),
  );
}

export function facetsEqual(a: ViewState, b: ViewState, facets: readonly Facet[]): boolean {
  return facets.every((f) => facetKey(FACETS[f](a)) === facetKey(FACETS[f](b)));
}

/**
 * Structural check that a driver implements the contract.
 *
 * Cheap, and it earns its keep: a driver missing `returnToBody` would otherwise
 * surface as a `TypeError` inside one step, which the runner would record as
 * that step failing — a localised bug report for a global problem.
 */
export const DRIVER_METHODS: readonly string[] = [
  'capabilities', 'open', 'state', 'setLayer', 'isolate', 'setLabels', 'orbit', 'zoom',
  'resetCamera', 'searchStructures', 'clickStructure', 'clickPointMm', 'pasteAddress',
  'openBrainAtlas', 'returnToBody', 'setAnatomyFilter', 'selectPaper', 'clearPaperSelection',
  'samePlaceAcrossSubjects',
];

export function driverShapeProblems(driver: unknown): string[] {
  const problems: string[] = [];
  const d = driver as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return ['driver is not an object'];
  if (typeof d.buildId !== 'string' || d.buildId === '') problems.push('buildId must be a non-empty string');
  if (d.kind !== 'product' && d.kind !== 'reference' && d.kind !== 'mutant') {
    problems.push(`kind must be product | reference | mutant, got ${JSON.stringify(d.kind)}`);
  }
  for (const m of DRIVER_METHODS) {
    if (typeof d[m] !== 'function') problems.push(`missing method ${m}()`);
  }
  return problems;
}

/** Unknown capability strings are a contract violation, not a silent skip. */
export function unknownCapabilities(driver: ViewerDriver): string[] {
  const known = new Set<string>(CAPABILITIES);
  return [...driver.capabilities()].filter((c) => !known.has(c));
}
