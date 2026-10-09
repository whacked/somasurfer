/**
 * A reference implementation of the viewer contract.
 *
 * ## What this is, and what it very deliberately is not
 *
 * It is NOT the viewer, it is not a prototype of the viewer, and a green run
 * against it does not mean §7 works. `kind: 'reference'` is baked in so that
 * `runner.ts` reports `productVerdict: UNVERIFIED` for every run against it,
 * however many rows pass.
 *
 * It exists for exactly two reasons:
 *
 *  1. **To make the suite executable before the viewer exists.** A suite that
 *     has never run is a document, and documents drift. Every row here runs
 *     today, which means every row is syntactically live, its expectations are
 *     type-checked against the contract, and its pinned addresses are real.
 *
 *  2. **To be the control in the negative-control experiment.** `mutants.ts`
 *     breaks exactly one guarantee at a time by wrapping this. Without a build
 *     that passes, a mutant failing proves nothing — it could be failing for
 *     the same reason everything fails.
 *
 * ## It is not an oracle
 *
 * The expectations live in `matrix.ts` and `journey.ts` as authored data, not
 * in here. This file answers from `@gstack/alc` and the fixture; the matrix
 * answers from what the plan says should happen. When they disagree, that is a
 * finding, and `test/oracle.test.ts` is where the two are rubbed together. If
 * the expectations were read out of this file the suite would be asserting that
 * the stand-in agrees with itself.
 *
 * ## The UI decisions it pins
 *
 * Writing a reference implementation forces decisions the plan left open, and
 * leaving them implicit here would smuggle them into the product. Each one is
 * marked `DECISION:` below and listed in the README, so the Web/3D Engineer can
 * disagree with a specific sentence rather than with a vibe.
 */

import {
  AlcError,
  ancestors,
  buildNameIndex,
  covering,
  coveringIntersect,
  coveringsSamePlace,
  encodeBody,
  locate,
  parse,
  resolve,
  type NameIndex,
} from '../../alc/src/index.ts';
import type {
  Camera,
  Capability,
  CellRender,
  Highlight,
  LayerState,
  Message,
  MessageCode,
  RankedName,
  Vec3,
  ViewState,
  ViewerDriver,
} from './contract.ts';
import { CAPABILITIES } from './contract.ts';
import { QA_URL_PARAMS, type TemplateChoice } from './matrix.ts';
import { templateSet } from './templates.ts';
import {
  coveringOfPaper,
  nameIndexInput,
  papersForRegion,
  resolveFixture,
  type ResearchFixture,
} from './fixture.ts';

const DEFAULT_CAMERA: Record<'body' | 'brain', Camera> = {
  body: { targetMm: [0, 0, -350], distanceMm: 1200, orientation: [0, 0, 0, 1] },
  brain: { targetMm: [0, 0, 0], distanceMm: 300, orientation: [0, 0, 0, 1] },
};

const DEFAULT_LAYERS: Record<'body' | 'brain', Record<string, LayerState>> = {
  body: {
    skeleton: { visible: true, opacity: 1 },
    organs: { visible: true, opacity: 1 },
    skin: { visible: false, opacity: 0.3 },
  },
  brain: {
    cortex: { visible: true, opacity: 1 },
    subcortical: { visible: true, opacity: 1 },
  },
};

/** Deterministic, so a report is diffable between runs. */
const PAPER_COLOURS = ['paper-colour-1', 'paper-colour-2', 'paper-colour-3', 'paper-colour-4', 'paper-colour-5'];

export interface AtlasView {
  camera: Camera;
  layers: Record<string, LayerState>;
  isolatedStructureId: string | null;
  labelsVisible: boolean;
  selectionStructureId: string | null;
  selectionAddress: string | null;
  cell: CellRender | null;
  names: RankedName[] | null;
  messages: Message[];
  templateId: string | null;
}

export function freshView(atlas: 'body' | 'brain'): AtlasView {
  return {
    camera: { ...DEFAULT_CAMERA[atlas] },
    layers: structuredClone(DEFAULT_LAYERS[atlas]),
    isolatedStructureId: null,
    labelsVisible: false,
    selectionStructureId: null,
    selectionAddress: null,
    cell: null,
    names: null,
    messages: [],
    templateId: null,
  };
}

/** `BD-T07-03O-531246` truncated to 5 digits is `BD-T07-03O-53124`. */
function truncateDigits(address: string, digits: number): string {
  const a = parse(address);
  const kept = a.digits.slice(0, Math.max(0, digits));
  return kept ? `${a.frame}-${a.anchors.join('-')}-${kept}` : `${a.frame}-${a.anchors.join('-')}`;
}

/**
 * The coarsest ancestor that resolves, or null.
 *
 * DECISION: where nothing in the address's own frame resolves — a `BR` address
 * with the frame disabled, or any address when its template is missing — the
 * refusal still has to offer a route forward, so the message names the enabled
 * frame to use instead and says plainly that no ancestor resolves. A dead end
 * with an apology is what plan §4 is trying to avoid; the offer degenerating to
 * "nothing here resolves, try BV" is still a route.
 */
function coarsestResolvableAncestor(address: string, templates: TemplateChoice): string | null {
  let chain: string[];
  try {
    chain = [...ancestors(address)].map(String);
  } catch {
    return null;
  }
  // `ancestors` is finest-first or coarsest-first depending on the frame's
  // convention, so try all of them and keep the shortest that resolves.
  const resolvable = chain.filter((candidate) => {
    try {
      const located = locate(candidate, templateSet(templates));
      return located.pointMm.every((x) => Number.isFinite(x));
    } catch {
      return false;
    }
  });
  if (resolvable.length === 0) return null;
  return resolvable.sort((a, b) => a.length - b.length)[0];
}

export interface ReferenceViewerOptions {
  readonly fixture?: ResearchFixture;
  readonly buildId?: string;
  /** Capabilities to withhold, for testing the unverified path. */
  readonly withhold?: readonly Capability[];
}

export class ReferenceViewer implements ViewerDriver {
  readonly buildId: string;
  readonly kind = 'reference' as const;

  protected fixture: ResearchFixture;
  protected index: NameIndex;
  protected withheld: ReadonlySet<Capability>;

  protected atlas: 'body' | 'brain' = 'body';
  protected views: Record<'body' | 'brain', AtlasView> = { body: freshView('body'), brain: freshView('brain') };
  /** The body view as it was when the brain atlas was opened. */
  protected stashedBodyView: AtlasView | null = null;
  protected template: TemplateChoice = 'body';
  protected assetsOk = true;
  protected url = '/';
  /**
   * The address the view is restored to — distinct from whatever the URL says.
   * A rejected deep link leaves its address in `url` and leaves this null.
   */
  protected acceptedAddress: string | null = null;

  protected filter: string | null = null;
  protected selectedPapers: string[] = [];

  constructor(options: ReferenceViewerOptions = {}) {
    this.fixture = options.fixture ?? resolveFixture();
    this.index = buildNameIndex(nameIndexInput(this.fixture));
    this.buildId = options.buildId ?? `reference@${this.fixture.id}`;
    this.withheld = new Set(options.withhold ?? []);
  }

  capabilities(): ReadonlySet<Capability> {
    return new Set(CAPABILITIES.filter((c) => !this.withheld.has(c)));
  }

  // -- state ---------------------------------------------------------------

  protected view(): AtlasView {
    return this.views[this.atlas];
  }

  async state(): Promise<ViewState> {
    const v = this.view();
    const highlights = this.computeHighlights();
    const messages = [...v.messages];
    if (highlights.some((h) => h.regionLevelOnly)) {
      messages.push({
        code: 'region_level_only',
        severity: 'notice',
        text:
          'One or more findings report a region with no spatial detail. They are marked region-level '
          + 'only; no position has been inferred for them.',
      });
    }
    return Object.freeze({
      atlas: this.atlas,
      camera: Object.freeze({ ...v.camera }),
      layers: Object.freeze(structuredClone(v.layers)),
      isolatedStructureId: v.isolatedStructureId,
      labelsVisible: v.labelsVisible,
      selection: Object.freeze({ structureId: v.selectionStructureId, address: v.selectionAddress }),
      url: this.url,
      urlAddress: this.urlAddress(),
      cell: v.cell ? Object.freeze({ ...v.cell }) : null,
      names: v.names ? Object.freeze([...v.names]) : null,
      nameIndexVersion: v.names ? this.index.version : null,
      messages: Object.freeze(messages),
      research: Object.freeze({
        filter: this.filter,
        paperList: Object.freeze(this.paperList()),
        selectedPaperIds: Object.freeze([...this.selectedPapers]),
        highlights: Object.freeze(highlights),
      }),
      assetsAvailable: this.assetsOk,
      templateId: v.templateId,
    }) as ViewState;
  }

  protected urlAddress(): string | null {
    return this.acceptedAddress;
  }

  // -- navigation ----------------------------------------------------------

  async open(url: string): Promise<ViewState> {
    const parsed = new URL(url, 'https://qa.invalid');
    const params = parsed.searchParams;

    this.views = { body: freshView('body'), brain: freshView('brain') };
    this.stashedBodyView = null;
    this.atlas = 'body';
    this.acceptedAddress = null;
    this.filter = null;
    this.selectedPapers = [];
    this.template = (params.get(QA_URL_PARAMS.template) as TemplateChoice | null) ?? 'body';
    this.assetsOk = params.get(QA_URL_PARAMS.assets) !== 'fail';
    this.url = url;

    if (!this.assetsOk) {
      this.view().messages.push({
        code: 'assets_unavailable',
        severity: 'notice',
        text:
          'The atlas geometry failed to load, so nothing is drawn. Addresses still parse and still '
          + 'resolve to names — neither needs a mesh.',
      });
    }

    const address = params.get('a');
    if (address !== null && address !== '') {
      this.applyAddress(address, { fromUrl: true });
    }
    return this.state();
  }

  /**
   * Resolve an address into the current view.
   *
   * DECISION: a BV address deep-linked from the URL enters the brain atlas
   * directly. That is not the automatic navigation DOG-1 §2 forbids — the user
   * named the brain cell in the address, so arriving in the brain atlas is what
   * they asked for. Selection inside an atlas still never navigates.
   */
  protected applyAddress(input: string, options: { fromUrl?: boolean } = {}): void {
    let parsed;
    try {
      parsed = parse(input);
    } catch (error) {
      this.reject(error as AlcError, input);
      return;
    }

    // Resolve BEFORE switching atlas. Switching first and then discovering the
    // address does not resolve leaves the user in the brain atlas looking at an
    // error about an address that was never shown — and it made the
    // `no_template` row report that the camera and layers had changed, which
    // they had, for no reason the user asked for.
    const templates = templateSet(this.template);
    const targetAtlas: 'body' | 'brain' =
      parsed.frame === 'BV' && options.fromUrl ? 'brain' : this.atlas;

    let located;
    try {
      located = locate(parsed.canonical, templates);
    } catch (error) {
      this.reject(error as AlcError, parsed.canonical);
      return;
    }
    this.atlas = targetAtlas;
    const v = this.view();

    v.templateId = located.templateId;
    const flags = located.flags;
    const notes = (flags.notes ?? []).join(' ');

    if (flags.homology === 'variant' || flags.homology === 'absent') {
      // No millimetres, so nothing is drawn and the camera does not move. The
      // address still belongs in the URL: it is a legal address that this
      // template cannot place, and the user must be able to send it to someone
      // whose template can.
      v.messages.push({
        code: flags.homology === 'variant' ? 'homology_variant' : 'homology_absent',
        severity: 'notice',
        text: notes,
      });
      v.selectionAddress = parsed.canonical;
      v.selectionStructureId = null;
      v.cell = null;
      v.names = null;
      this.setUrlAddress(parsed.canonical);
      return;
    }

    // Over-precision: resolve, but draw at the template's limit.
    const limit = this.usefulDigits(parsed.frame);
    const overPrecise = flags.overPrecise === true;
    const displayAddress = overPrecise ? truncateDigits(parsed.canonical, limit) : parsed.canonical;
    const displayed = overPrecise ? locate(displayAddress, templates) : located;

    if (overPrecise) {
      v.messages.push({
        code: 'over_precise',
        severity: 'notice',
        text: notes,
      });
    }
    if (flags.folded) {
      v.messages.push({ code: 'folded', severity: 'notice', text: notes });
    }

    // DECISION: with no geometry loaded there is nothing to draw and nothing to
    // fly to, so neither happens. The address still resolves and the names are
    // still shown — plan §6's last row — but presenting an empty viewport as a
    // located result would claim more than the build can deliver.
    if (this.assetsOk) {
      v.camera = {
        targetMm: [...displayed.pointMm] as unknown as Vec3,
        distanceMm: Math.max(50, Math.hypot(...displayed.extentMm) * 8),
        orientation: [0, 0, 0, 1],
      };
      v.cell = {
        kind: 'extent',
        extentMm: [...displayed.extentMm] as unknown as Vec3,
        addressDigits: parsed.digits.length,
        displayedDigits: displayAddress ? parse(displayAddress).digits.length : 0,
      };
    }
    v.selectionAddress = parsed.canonical;
    v.names = this.rankedNames(parsed.canonical);
    v.messages.push({
      code: 'name_index_version',
      severity: 'notice',
      text: `Names from index ${this.index.version}.`,
    });
    this.setUrlAddress(parsed.canonical);
  }

  protected usefulDigits(frame: string): number {
    const templates = templateSet(this.template);
    if (frame === 'BV') return (templates.brainVolume as { maxUsefulDigits?: number } | undefined)?.maxUsefulDigits ?? 6;
    return (templates.body as { maxUsefulDigits?: number } | undefined)?.maxUsefulDigits ?? 5;
  }

  protected reject(error: AlcError, input: string): void {
    const v = this.view();
    const code = (error as AlcError).code ?? 'bad_address';
    const map: Record<string, MessageCode> = {
      bad_level: 'rejected_level',
      too_long: 'rejected_too_long',
      check_failed: 'rejected_check',
      no_template: 'no_template',
      frame_disabled: 'frame_disabled',
    };
    const messageCode: MessageCode = map[code] ?? 'rejected_grammar';
    v.messages.push({ code: messageCode, severity: 'error', text: error.message });

    if (messageCode === 'no_template' || messageCode === 'frame_disabled') {
      const ancestor = coarsestResolvableAncestor(input, this.template);
      v.messages.push({
        code: 'coarsest_ancestor_offered',
        severity: 'notice',
        text: ancestor
          ? `The coarsest address that does resolve here is ${ancestor}; open that instead.`
          : 'No ancestor of this address resolves in this build either. The enabled brain frame in v1 is '
            + 'BV, the AC-PC proportional volume frame; address the location there.',
      });
    }
    // A rejection changes nothing else: no camera move, no selection, no URL.
  }

  /** Accepting an address is what puts it in the URL, and the two are recorded together. */
  protected setUrlAddress(address: string): void {
    const u = new URL(this.url, 'https://qa.invalid');
    u.searchParams.set('a', address);
    this.url = `${u.pathname}${u.search}`;
    this.acceptedAddress = address;
  }

  protected rankedNames(address: string): RankedName[] {
    const resolution = resolve(address, this.index);
    return resolution.matches.map((m) => ({
      structureId: m.structure.id,
      name: m.structure.name,
      fraction: m.fraction,
    }));
  }

  // -- viewer controls -----------------------------------------------------

  async setLayer(layerId: string, patch: Partial<LayerState>): Promise<ViewState> {
    const v = this.view();
    const current = v.layers[layerId];
    if (!current) throw new Error(`no layer ${layerId} in the ${this.atlas} atlas`);
    v.layers[layerId] = { ...current, ...patch };
    return this.state();
  }

  async isolate(structureId: string | null): Promise<ViewState> {
    this.view().isolatedStructureId = structureId;
    return this.state();
  }

  async setLabels(visible: boolean): Promise<ViewState> {
    this.view().labelsVisible = visible;
    return this.state();
  }

  async orbit(deltaDeg: number): Promise<ViewState> {
    const v = this.view();
    const rad = (deltaDeg * Math.PI) / 360;
    v.camera = { ...v.camera, orientation: [0, Math.sin(rad), 0, Math.cos(rad)] };
    return this.state();
  }

  async zoom(factor: number): Promise<ViewState> {
    const v = this.view();
    v.camera = { ...v.camera, distanceMm: v.camera.distanceMm / factor };
    return this.state();
  }

  async resetCamera(): Promise<ViewState> {
    this.view().camera = { ...DEFAULT_CAMERA[this.atlas] };
    return this.state();
  }

  async searchStructures(query: string): Promise<readonly RankedName[]> {
    const q = query.toLowerCase();
    return this.fixture.structures
      .filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
      .map((s) => ({ structureId: s.id, name: s.name, fraction: 1 }));
  }

  // -- selection -----------------------------------------------------------

  async clickStructure(structureId: string): Promise<ViewState> {
    const structure = this.fixture.structures.find((s) => s.id === structureId);
    if (!structure) throw new Error(`no structure ${structureId} in fixture ${this.fixture.id}`);
    const v = this.view();
    v.messages = [];
    // Selection never navigates. The structure is addressed in whichever atlas
    // we are already in, and a structure belonging to the other atlas is simply
    // not clickable from here.
    this.applyAddress(structure.cells[0]);
    this.view().selectionStructureId = structureId;
    return this.state();
  }

  async clickPointMm(pointMm: Vec3, digits: number): Promise<ViewState> {
    const v = this.view();
    v.messages = [];
    const templates = templateSet(this.template);
    if (!templates.body) throw new Error('no body template to click in');
    const { address, flags } = encodeBody(templates.body, pointMm, digits);
    if (flags.clamped) {
      const note = (flags.notes ?? []).join(' ');
      v.messages.push({
        code: note.includes('above') ? 'clamped_cranial' : 'clamped_caudal',
        severity: 'notice',
        text: note,
      });
    }
    this.applyAddress(address);
    return this.state();
  }

  async pasteAddress(text: string): Promise<ViewState> {
    const v = this.view();
    v.messages = [];
    this.applyAddress(text.trim());
    return this.state();
  }

  // -- cross-atlas ---------------------------------------------------------

  async openBrainAtlas(): Promise<ViewState> {
    this.stashedBodyView = structuredClone(this.views.body);
    this.atlas = 'brain';
    return this.state();
  }

  async returnToBody(): Promise<ViewState> {
    if (this.stashedBodyView) this.views.body = structuredClone(this.stashedBodyView);
    this.atlas = 'body';
    return this.state();
  }

  // -- research ------------------------------------------------------------

  protected paperList(): string[] {
    if (!this.filter) return this.fixture.papers.map((p) => p.id);
    return papersForRegion(this.fixture, this.filter);
  }

  async setAnatomyFilter(structureId: string | null): Promise<ViewState> {
    this.filter = structureId;
    return this.state();
  }

  async selectPaper(paperId: string, options: { add?: boolean } = {}): Promise<ViewState> {
    if (!this.fixture.papers.some((p) => p.id === paperId)) {
      throw new Error(`no paper ${paperId} in fixture ${this.fixture.id}`);
    }
    this.selectedPapers = options.add
      ? [...new Set([...this.selectedPapers, paperId])]
      : [paperId];
    return this.state();
  }

  async clearPaperSelection(): Promise<ViewState> {
    this.selectedPapers = [];
    return this.state();
  }

  /**
   * Every mapped region of every selected paper.
   *
   * The filter is not consulted here, and that is the whole of DOG-1 §3: it
   * narrows `paperList()` above and nothing else. A single `if (this.filter)`
   * in this method is the defect `mutants.ts` reproduces.
   */
  protected computeHighlights(): Highlight[] {
    const out: Highlight[] = [];
    const coverings = new Map(this.selectedPapers.map((id) => [id, coveringOfPaper(this.fixture, id)]));

    for (const paperId of this.selectedPapers) {
      const paper = this.fixture.papers.find((p) => p.id === paperId)!;
      const colour = PAPER_COLOURS[this.fixture.papers.findIndex((p) => p.id === paperId) % PAPER_COLOURS.length];
      for (const finding of paper.findings) {
        // Per cell, not per finding: a finding covering two cells where only
        // one is shared hatches that one. Covering intersection throughout,
        // never string equality.
        const hatchedCells = finding.cells.filter((cell) =>
          this.selectedPapers.some((other) => {
            if (other === paperId) return false;
            return coveringIntersect(covering([cell]), coverings.get(other)!).cells.length > 0;
          }),
        );
        out.push({
          paperId,
          findingId: finding.id,
          cells: [...finding.cells],
          regionLevelOnly: !finding.spatialDetail,
          colour,
          hatchedCells,
        });
      }
    }
    return out;
  }

  /**
   * The only sanctioned way to ask "same place?" across subjects.
   *
   * Delegates to the library's `coveringsSamePlace`, which requires an explicit
   * regime and an explicit residual. The `basis` returned is what the UI-level
   * equality guard inspects: a build answering `string-equality` fails the row
   * even when the verdict happens to be right.
   */
  async samePlaceAcrossSubjects(
    cellsA: readonly string[],
    cellsB: readonly string[],
    toleranceMm: number,
  ): Promise<{ same: boolean; basis: string }> {
    const templates = templateSet(this.template);
    const result = coveringsSamePlace(covering([...cellsA]), covering([...cellsB]), {
      across: 'subjects',
      toleranceMm,
      templatesA: templates,
      templatesB: templates,
    } as never);
    return { same: result.same, basis: result.basis };
  }
}

/** The stand-in build, ready to run. */
export function referenceViewer(options: ReferenceViewerOptions = {}): ReferenceViewer {
  return new ReferenceViewer(options);
}
