/**
 * The solid-colour data path: per-paper colour, overlaps hatched.
 *
 * This module answers one question exactly — *for every piece of the model a
 * selection touches, which papers claim it?* — and hands the viewer a
 * partition it can paint without making that decision itself.
 *
 * ## Why a partition, and not a list of pairwise intersections
 *
 * The cheap version of "overlaps hatched" is: paint each paper's covering in
 * its colour, then paint `coveringIntersect(A, B)` hatched on top for every
 * pair. That is exact for two papers and quietly wrong for three. A cell inside
 * all of A, B and C appears in all three pairwise intersections, so what gets
 * drawn there depends on paint order, and the hatch says "A and B" in a place
 * where the truth is "A, B and C". The viewer cannot fix that; it does not know
 * which of the three overlays is the most specific.
 *
 * So this module computes the **common refinement**: a set of disjoint cells
 * (`atoms`) whose union is exactly the selection's extent, each labelled with
 * the full set of papers covering it. Grouping atoms by that label gives one
 * layer per distinct owner set — `{A}`, `{B}`, `{A,B}`, `{A,B,C}` — and the
 * layers are disjoint, so paint order stops mattering and the hatch pattern can
 * name every owner.
 *
 * ## Why the refinement is cheap
 *
 * Hierarchy cells are nested or disjoint, never partially overlapping. So the
 * only reason a cell needs splitting is that some *other* paper filed a
 * strictly finer cell inside it, and the split only has to descend along the
 * path to that finer cell: siblings off the path are atoms immediately. The
 * work is therefore bounded by (number of finer cells) x depth x branching,
 * not by the size of the frame. `maxAtoms` caps it anyway and throws naming
 * itself, in the manner of `coveringFromRegion`.
 *
 * ## Overlap is covering intersection, never string equality
 *
 * Membership is decided with `coveringContains` — "some cell of this covering
 * is an ancestor of, or equal to, this atom" — which is hierarchy containment,
 * the same primitive `coveringIntersect` is built on. `BV-L-1` and `BV-L-12`
 * are different strings and the same place for the finer of the two; a string
 * comparison finds no overlap there, and `test/layers.test.ts` pins exactly
 * that case against both implementations.
 */

import {
  AlcError,
  children,
  contains,
  covering,
  coveringContains,
  coveringIntersect,
  coveringUnion,
  EMPTY_COVERING,
  parse,
  type Covering,
} from '../../alc/src/index.ts';

import type { ResearchIndex, ResolvedMapping } from './dataset.ts';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export interface PaletteSlot {
  readonly slot: number;
  readonly hue: string;
  readonly light: string;
  readonly dark: string;
}

/**
 * The categorical palette, in fixed slot order.
 *
 * Assigned in order and never cycled. The order itself is the colour-vision
 * safety mechanism, so re-ordering it is a palette change and needs re-running
 * the validator, not a tidy-up.
 */
export const PAPER_PALETTE: readonly PaletteSlot[] = Object.freeze([
  { slot: 1, hue: 'blue', light: '#2a78d6', dark: '#3987e5' },
  { slot: 2, hue: 'orange', light: '#eb6834', dark: '#d95926' },
  { slot: 3, hue: 'aqua', light: '#1baf7a', dark: '#199e70' },
  { slot: 4, hue: 'yellow', light: '#eda100', dark: '#c98500' },
  { slot: 5, hue: 'magenta', light: '#e87ba4', dark: '#d55181' },
  { slot: 6, hue: 'green', light: '#008300', dark: '#008300' },
  { slot: 7, hue: 'violet', light: '#4a3aa7', dark: '#9085e9' },
  { slot: 8, hue: 'red', light: '#e34948', dark: '#e66767' },
].map((s) => Object.freeze(s)));

/**
 * How many papers may be told apart **by colour alone**.
 *
 * Three, measured, not chosen. A multi-paper overlay is an all-pairs form: any
 * two papers' colours can end up adjacent anywhere on the mesh, so every pair
 * has to separate, not just neighbours in a legend. Validated with the
 * palette validator against both surfaces:
 *
 *   slots 1-3, all pairs: CVD dE 9.2 light / 9.4 dark, normal vision 24.0 / 20.9 — PASS
 *   slots 1-4, all pairs: normal vision 13.7 (yellow vs orange) — FAIL, below the 15 floor
 *   slots 1-8, all pairs: CVD dE 3.2 (green vs orange), normal vision 7.1 — FAIL
 *
 * Note which check fails first: the four-slot failure is a *normal-vision*
 * failure. Yellow beside orange is not a colour-blindness edge case, it is a
 * pair most readers cannot separate, and no amount of palette juggling fixes it
 * inside a documented eight-hue set.
 *
 * Past three papers the colours are still assigned — they are the best eight
 * available and they remain distinguishable in a legend — but
 * `requiresSecondaryEncoding` goes true, and the viewer owes every highlight a
 * direct label. It owes that anyway for provenance, which is what makes this
 * cap affordable rather than a product cut.
 */
export const COLOUR_ONLY_DISTINCT = 3;

/** Past this many selected papers there are no more slots; fold the rest into "other". */
export const MAX_COLOURED_PAPERS = PAPER_PALETTE.length;

export interface PaperColour {
  readonly paperId: string;
  /** `null` past `MAX_COLOURED_PAPERS`: fold to "other", never a generated hue. */
  readonly palette: PaletteSlot | null;
}

/**
 * Assign colours to a selection, by position in the selection.
 *
 * The selection order is the argument, not the filtered paper list, because
 * colour must follow the paper and not its rank: narrowing an anatomical filter
 * changes which papers are *listed* and must not repaint the ones still
 * selected. Callers keep the selection append-only and the assignment is stable
 * for free; `nextColours` below handles the deselect case, where a freed slot
 * must not shuffle the survivors.
 */
export function assignPaperColours(selectionOrder: readonly string[]): PaperColour[] {
  const seen = new Set<string>();
  const out: PaperColour[] = [];
  for (const paperId of selectionOrder) {
    if (seen.has(paperId)) continue;
    seen.add(paperId);
    out.push(
      Object.freeze({
        paperId,
        palette: out.length < PAPER_PALETTE.length ? PAPER_PALETTE[out.length] : null,
      }),
    );
  }
  return out;
}

/**
 * Re-assign after a selection change, keeping every surviving paper's slot.
 *
 * Deselecting the second of three papers must not recolour the third. So slots
 * held by survivors stay held, and newly selected papers take the lowest free
 * slot.
 */
export function nextColours(previous: readonly PaperColour[], selected: readonly string[]): PaperColour[] {
  const want = new Set(selected);
  const held = new Map<number, PaperColour>();
  const kept: PaperColour[] = [];
  for (const c of previous) {
    if (!want.has(c.paperId)) continue;
    if (c.palette) held.set(c.palette.slot, c);
    kept.push(c);
  }
  const keptIds = new Set(kept.map((c) => c.paperId));
  const free = PAPER_PALETTE.filter((s) => !held.has(s.slot));
  let f = 0;
  const added: PaperColour[] = [];
  for (const paperId of selected) {
    if (keptIds.has(paperId)) continue;
    keptIds.add(paperId);
    added.push(Object.freeze({ paperId, palette: f < free.length ? free[f++] : null }));
  }
  return [...kept, ...added];
}

// ---------------------------------------------------------------------------
// Common refinement
// ---------------------------------------------------------------------------

/**
 * Split `cell` so that every cut lands on a boundary.
 *
 * `cuts` are canonical addresses strictly inside `cell`. Children off every cut
 * path are returned whole, which is what keeps this linear in the cuts rather
 * than exponential in the depth.
 */
function splitCell(cell: string, cuts: readonly string[], budget: { left: number }): string[] {
  if (cuts.length === 0) return [cell];
  const kids = children(cell);
  // At the frame's digit cap there is nothing finer to split into. A cut deeper
  // than the cap cannot exist — `parse()` enforces it — so this is reachable
  // only for a cell already at the cap, where returning it whole is correct.
  if (kids.length === 0) return [cell];
  const out: string[] = [];
  for (const kid of kids) {
    if ((budget.left -= 1) < 0) {
      throw new AlcError(
        'refining a multi-paper selection exceeded its cell budget; raise maxAtoms or roll the coverings up first',
        'refinement_too_large',
      );
    }
    const inner = cuts.filter((c) => c !== kid.canonical && contains(kid.canonical, c));
    if (inner.length === 0) out.push(kid.canonical);
    else out.push(...splitCell(kid.canonical, inner, budget));
  }
  return out;
}

export interface Refinement {
  /** Disjoint cells whose union is the union of the inputs. */
  readonly atoms: readonly string[];
  /** Indices into the input coverings that cover each atom, parallel to `atoms`. */
  readonly owners: readonly (readonly number[])[];
}

/**
 * The common refinement of several coverings.
 *
 * Postconditions, all asserted in `test/layers.test.ts`:
 *  - atoms are pairwise disjoint (no atom contains another);
 *  - their union equals the union of the inputs — nothing gained, nothing lost;
 *  - an atom's owner set is exactly the inputs whose covering contains it.
 */
export function refine(coverings: readonly Covering[], maxAtoms = 200_000): Refinement {
  const all = new Set<string>();
  for (const c of coverings) for (const cell of c.cells) all.add(cell);
  if (all.size === 0) return Object.freeze({ atoms: Object.freeze([]), owners: Object.freeze([]) });

  const everyCell = [...all];
  const budget = { left: maxAtoms };
  const atoms = new Set<string>();
  for (const cell of everyCell) {
    // Every strictly finer cell anyone filed inside this one is a cut. Cutting
    // by all of them at once is what makes the result a global partition rather
    // than a pairwise one.
    const cuts = everyCell.filter((other) => other !== cell && contains(cell, other));
    for (const atom of splitCell(cell, cuts, budget)) atoms.add(atom);
  }

  const atomList = [...atoms].sort();
  const owners = atomList.map((atom) =>
    Object.freeze(coverings.map((c, i) => (coveringContains(c, atom) ? i : -1)).filter((i) => i >= 0)),
  );
  return Object.freeze({ atoms: Object.freeze(atomList), owners: Object.freeze(owners) });
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** 45 degrees for a two-paper overlap, 135 for three or more. One texture, two angles. */
export type HatchAngle = 45 | 135;

export interface SolidColourLayer {
  /** Papers claiming every cell of this layer. Length 1 for a solid fill. */
  readonly paperIds: readonly string[];
  readonly covering: Covering;
  /** The fill for a single-owner layer; `null` for an overlap, which is hatched. */
  readonly fill: PaletteSlot | null;
  /** Colours to hatch with, in slot order. Empty for a single-owner layer. */
  readonly hatch: readonly PaletteSlot[];
  readonly hatchAngle: HatchAngle | null;
  /** Mandatory legend and hover text: the owners, named. Never colour alone. */
  readonly label: string;
}

export interface SolidColourLayers {
  /** Disjoint layers. Paint in any order; nothing overdraws anything. */
  readonly layers: readonly SolidColourLayer[];
  /** Each paper's whole extent, for a legend swatch and an "isolate" action. */
  readonly perPaper: readonly { paperId: string; palette: PaletteSlot | null; covering: Covering }[];
  readonly colours: readonly PaperColour[];
  /** True when more papers are selected than colour alone can separate. */
  readonly requiresSecondaryEncoding: boolean;
  /** Selected papers past the palette's eight slots. Fold to "other" or facet. */
  readonly uncoloured: readonly string[];
  /** Mappings that could not be placed. Shown as markers, never as geometry. */
  readonly unresolved: readonly ResolvedMapping[];
  readonly notes: readonly string[];
}

/**
 * Compute the solid-colour layers for a multi-paper selection.
 *
 * `selectionOrder` is the user's selection, in the order it was made. The
 * current anatomical filter is **not** an argument, and that is the point: this
 * is the computation behind "selecting a paper reveals all of its mapped
 * regions". There is no parameter here that could narrow it.
 */
export function solidColourLayers(
  index: ResearchIndex,
  selectionOrder: readonly string[],
  options: { colours?: readonly PaperColour[]; maxAtoms?: number } = {},
): SolidColourLayers {
  const colours = options.colours
    ? nextColours(options.colours, selectionOrder)
    : assignPaperColours(selectionOrder);
  const colourOf = new Map(colours.map((c) => [c.paperId, c.palette]));
  const ordered = colours.map((c) => c.paperId);

  const perPaper = ordered.map((paperId) => ({
    paperId,
    palette: colourOf.get(paperId) ?? null,
    covering: index.paperCovering(paperId),
  }));

  const unresolved = ordered.flatMap((paperId) =>
    index.mappingsOf(paperId).filter((m) => m.resolution === 'unresolved'),
  );

  const notes: string[] = [];
  const nonEmpty = perPaper.filter((p) => p.covering.cells.length > 0);
  for (const p of perPaper) {
    if (p.covering.cells.length === 0) {
      notes.push(`${p.paperId} has no resolved mapping, so it contributes no geometry to the overlay`);
    }
  }

  const { atoms, owners } = refine(
    nonEmpty.map((p) => p.covering),
    options.maxAtoms,
  );

  const groups = new Map<string, { ownerIdx: readonly number[]; cells: string[] }>();
  atoms.forEach((atom, i) => {
    const o = owners[i];
    if (o.length === 0) return; // unreachable: an atom comes from some covering
    const key = o.join(',');
    const hit = groups.get(key);
    if (hit) hit.cells.push(atom);
    else groups.set(key, { ownerIdx: o, cells: [atom] });
  });

  const layers: SolidColourLayer[] = [...groups.values()]
    .map(({ ownerIdx, cells }) => {
      const paperIds = ownerIdx.map((i) => nonEmpty[i].paperId);
      const slots = paperIds.map((id) => colourOf.get(id) ?? null).filter((s): s is PaletteSlot => s !== null);
      const single = paperIds.length === 1;
      return Object.freeze({
        paperIds: Object.freeze(paperIds),
        covering: covering(cells),
        fill: single ? (colourOf.get(paperIds[0]) ?? null) : null,
        hatch: Object.freeze(single ? [] : slots),
        hatchAngle: single ? null : paperIds.length === 2 ? (45 as const) : (135 as const),
        label: single
          ? titleOf(index, paperIds[0])
          : `${paperIds.length} papers overlap: ${paperIds.map((id) => titleOf(index, id)).join('; ')}`,
      });
    })
    // Single-owner layers first, then by owner count, so a renderer that does
    // honour order gets the most specific layer last anyway.
    .sort((a, b) => a.paperIds.length - b.paperIds.length || (a.label < b.label ? -1 : 1));

  const uncoloured = colours.filter((c) => c.palette === null).map((c) => c.paperId);
  if (uncoloured.length > 0) {
    notes.push(
      `${uncoloured.length} selected paper(s) past the palette's ${MAX_COLOURED_PAPERS} slots have no colour; fold them into "other" or facet the comparison`,
    );
  }
  if (ordered.length > COLOUR_ONLY_DISTINCT) {
    notes.push(
      `${ordered.length} papers selected; only the first ${COLOUR_ONLY_DISTINCT} palette slots separate for every pair, so every highlight needs a direct label`,
    );
  }

  return Object.freeze({
    layers: Object.freeze(layers),
    perPaper: Object.freeze(perPaper),
    colours: Object.freeze(colours),
    requiresSecondaryEncoding: ordered.length > COLOUR_ONLY_DISTINCT,
    uncoloured: Object.freeze(uncoloured),
    unresolved: Object.freeze(unresolved),
    notes: Object.freeze(notes),
  });
}

function titleOf(index: ResearchIndex, paperId: string): string {
  return index.paper(paperId)?.title ?? paperId;
}

/**
 * The pairwise overlap of two papers, straight from `coveringIntersect`.
 *
 * Kept as a separate, obviously-correct function so the layer computation can
 * be checked against it: for two papers, the union of the multi-owner layers
 * must equal this exactly. `test/layers.test.ts` asserts that for random
 * selections, which is what makes the refinement above trustworthy.
 */
export function pairOverlap(index: ResearchIndex, aPaperId: string, bPaperId: string): Covering {
  return coveringIntersect(index.paperCovering(aPaperId), index.paperCovering(bPaperId));
}

/** Union of every layer with two or more owners: everything that is hatched. */
export function hatchedExtent(result: SolidColourLayers): Covering {
  const parts = result.layers.filter((l) => l.paperIds.length > 1).map((l) => l.covering);
  return parts.length === 0 ? EMPTY_COVERING : coveringUnion(...parts);
}

/** Frame of a cell, used by viewers to route a layer to the right atlas. */
export function frameOfCell(cell: string): string {
  return parse(cell).frame;
}
