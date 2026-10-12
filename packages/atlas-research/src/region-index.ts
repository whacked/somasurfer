/**
 * Region links: curated mappings resolved onto named structures of every
 * registered representation, each link saying how it was made and how far to
 * trust it (DOG-130, plan §3.2).
 *
 * `dataset.ts` resolves a mapping to ALC-1 cells. This file resolves the same
 * mapping to *structures*: the meshes a viewer picks and the regions an API
 * lists. The two are independent, and neither falls back on the other.
 *
 * ## Two routes, three kinds of link
 *
 * - **Term route.** The mapping's `structureId` is a term in some scheme
 *   (`FMA`, `HCP-MMP1`, `ATLAS-LABEL`). A term in a representation's own id
 *   scheme resolves by identity. Any other term goes through the crosswalk,
 *   which is hand-authored and checked: `exact-term` when the target is the
 *   same concept (a synonym, or the complete set of its named parts),
 *   `crosswalk` when its boundaries differ. A crosswalk link is always
 *   `approximate` and keeps the source's own name. An HCP-MMP1 area projected
 *   onto a gyrus is not the gyrus.
 * - **Coordinate route.** Published coordinates, or a BV cell's centre, are
 *   carried into each mesh representation that has a transform and a locator.
 *   A structure whose closed surface contains the point gets a `coordinate`
 *   link carrying the registration's measured error, never less. Nearest is
 *   NOT containing: a point inside no shipped structure is reported with its
 *   nearest structure and distance, and does not become a link. When the true
 *   structure is held, the nearest shipped one is a confident wrong answer.
 *
 * ## Nothing is dropped silently
 *
 * Every mapping ends with at least one link or at least one stated reason, per
 * route. Every paper ends with at least one region, or the reasons none was
 * reached. `checkRegionIndex` asserts both, and asserts that the forward
 * (paper → regions) and inverted (region → papers) indexes agree, so a
 * consumer such as W6's API or W8a's acceptance run can rely on them rather
 * than re-derive them.
 */

import { bvCellBox, bvLocalToMm, parse, type TemplateSet } from '../../alc/src/index.ts';

import { REPRESENTATIONS, type Representation } from './representations.ts';
import type { Finding, RegionMapping, ResearchDataset } from './types.ts';

type Vec3 = readonly [number, number, number];

export type LinkHow = 'exact-term' | 'crosswalk' | 'coordinate';

export type LinkPrecision =
  | { readonly kind: 'exact' }
  /** Boundaries differ. `why` is the crosswalk entry's stated reason. */
  | { readonly kind: 'approximate'; readonly why: string }
  /** A placed coordinate. `mm` is never below the registration's measured error. */
  | { readonly kind: 'mm'; readonly mm: number; readonly basis: string };

// ---------------------------------------------------------------------------
// Crosswalk: hand-authored, in packages/atlas-assets/crosswalk/
// ---------------------------------------------------------------------------

export interface CrosswalkTarget {
  readonly representation: string;
  /** A structure `label` in that representation: side-free, shipped or held. */
  readonly label: string;
}

/**
 * How the targets relate to the term.
 *
 * `same` — the target is the term's concept (a synonym).
 * `parts` — the targets are the term's parts; their union stands for it.
 * `overlaps` — the term lies within or across the targets, so they are larger
 *   or differently bounded. An HCP-MMP1 area on its gyrus.
 * `none` — no registered representation names it; `why` says so.
 */
export type CrosswalkCompleteness = 'same' | 'parts' | 'overlaps' | 'none';

export interface CrosswalkEntry {
  readonly term: string;
  /** The term's own name, as the curated dataset records it. */
  readonly label: string;
  readonly how: 'exact-term' | 'crosswalk';
  readonly completeness: CrosswalkCompleteness;
  readonly targets: readonly CrosswalkTarget[];
  /** Required for `crosswalk` and for `none`: why these targets, or why none. */
  readonly why?: string;
  /** Where the placement comes from, when it is not anatomy-textbook identity. */
  readonly reference?: string;
}

export interface Crosswalk {
  readonly schema: 'atlas-crosswalk/1';
  readonly version: string;
  readonly assertedBy: string;
  readonly assertedOn: string;
  readonly entries: readonly CrosswalkEntry[];
}

// ---------------------------------------------------------------------------
// Representation data: injected by the caller, because assets are not ours
// ---------------------------------------------------------------------------

export type Side = 'left' | 'right' | 'median';

export interface RepresentedStructure {
  /** The representation's own id for it, as a string. */
  readonly id: string;
  /** Full name, side-suffixed where the source does that (`Putamen.l`). */
  readonly name: string;
  /** Side-free label the crosswalk names (`Putamen`). */
  readonly label: string;
  readonly side: Side | null;
}

export interface HeldStructure {
  readonly name: string;
  readonly label: string;
  readonly side: Side | null;
  /** The owner's stated reason it does not ship. Quoted into the hold. */
  readonly because: string;
}

export interface LocateResult {
  /** Structures whose closed surface contains the point, with its depth inside. */
  readonly inside: readonly { readonly id: string; readonly depthMm: number }[];
  /** The nearest shipped surface, reported but never linked. */
  readonly nearest: { readonly id: string; readonly distanceMm: number } | null;
}

export interface RepresentationData {
  readonly representation: Representation;
  /** The asset version this data was read from, e.g. `zanatomy-2929e94`. */
  readonly version: string;
  readonly structures: readonly RepresentedStructure[];
  readonly held: readonly HeldStructure[];
  /** Places an MNI point, in millimetres. Present only with `coordinatePrecision`. */
  readonly locate?: (mniMm: Vec3) => LocateResult;
  /** The registration's measured error and what it was measured on. Read from the asset, never typed in. */
  readonly coordinatePrecision?: { readonly mm: number; readonly basis: string };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface RegionLink {
  readonly mappingId: string;
  readonly findingId: string;
  readonly paperId: string;
  readonly representation: string;
  readonly structureId: string;
  readonly structureName: string;
  readonly side: Side | null;
  /** True only when the side came from the source (a coordinate). A term link to both sides says nothing about laterality. */
  readonly sideFromSource: boolean;
  readonly how: LinkHow;
  readonly precision: LinkPrecision;
  /** The curated term and its own name. Kept on every link, so an HCP-MMP1 area is never shown only as its gyrus. */
  readonly source: { readonly scheme: string; readonly term: string; readonly label: string };
  /** Term links through the crosswalk: the relation, and any target that is held. */
  readonly crosswalk?: { readonly completeness: CrosswalkCompleteness; readonly heldTargets: readonly string[] };
  /** Coordinate links: where the point came from and how deep inside the surface it sits. */
  readonly coordinate?: {
    readonly from: 'coordinates' | 'cell';
    readonly address?: string;
    readonly mniMm: Vec3;
    readonly depthMm: number;
  };
}

export type UnplacedCode =
  /** Every target the term reaches is held by the asset owner. */
  | 'structure-held'
  /** No registered representation names it; the crosswalk says why. */
  | 'not-in-representation'
  /** A term in a scheme with no crosswalk entry. A curation gap, and the gate fails on it. */
  | 'no-crosswalk-entry'
  /** A crosswalk target names a representation the caller did not supply. */
  | 'representation-absent'
  /** The coordinates' named space is hosted by no point-set representation. */
  | 'space-not-registered'
  /** The cells' frame has no transform into any mesh representation. */
  | 'frame-has-no-mesh'
  /** No mesh representation was supplied with a locator. */
  | 'no-locator'
  /** The point lies inside no shipped structure. Nearest is reported, not linked. */
  | 'coordinate-outside-shipped-structures';

export interface Unplaced {
  readonly mappingId: string;
  readonly findingId: string;
  readonly paperId: string;
  readonly route: 'term' | 'coordinate';
  readonly code: UnplacedCode;
  readonly detail: string;
}

export interface MappingOutcome {
  readonly mappingId: string;
  readonly findingId: string;
  readonly paperId: string;
  readonly links: readonly RegionLink[];
  readonly unplaced: readonly Unplaced[];
}

export interface PaperRegions {
  readonly paperId: string;
  /** Structure keys (`representation/structureId`), sorted. */
  readonly regions: readonly string[];
  /** Present exactly when `regions` is empty: the stated reasons, by code. */
  readonly emptyBecause: readonly { readonly code: UnplacedCode; readonly detail: string; readonly mappingIds: readonly string[] }[];
}

export interface StructurePapers {
  readonly key: string;
  readonly representation: string;
  readonly structureId: string;
  readonly structureName: string;
  readonly paperIds: readonly string[];
}

export interface RegionCoverage {
  readonly mappings: {
    readonly total: number;
    /** Mappings with at least one link. */
    readonly linked: number;
    /** Mappings with at least one link of each kind. A mapping may count under several. */
    readonly byHow: Readonly<Record<LinkHow, number>>;
  };
  readonly papers: {
    readonly total: number;
    readonly nonEmpty: number;
    readonly emptyWithStatedReason: number;
  };
}

export interface RegionIndex {
  readonly datasetVersion: string;
  readonly crosswalkVersion: string;
  readonly representations: readonly { readonly id: string; readonly version: string }[];
  readonly mappings: readonly MappingOutcome[];
  readonly papers: readonly PaperRegions[];
  readonly structures: readonly StructurePapers[];
  readonly coverage: RegionCoverage;

  /** Every link a finding resolves to, across all its mappings. */
  resolve(finding: Finding | string): readonly RegionLink[];
  /** Paper → regions: each structure with the links that reach it. */
  regionsFor(paperId: string): readonly { readonly key: string; readonly links: readonly RegionLink[] }[];
  /** Region → papers: each paper with the links that reach the structure. */
  papersFor(structureKey: string): readonly { readonly paperId: string; readonly links: readonly RegionLink[] }[];
}

export const structureKey = (representation: string, structureId: string): string => `${representation}/${structureId}`;
const keyOf = (l: RegionLink): string => structureKey(l.representation, l.structureId);

// ---------------------------------------------------------------------------
// Crosswalk validation
// ---------------------------------------------------------------------------

const HOWS = ['exact-term', 'crosswalk'];
const COMPLETENESS: readonly CrosswalkCompleteness[] = ['same', 'parts', 'overlaps', 'none'];

/**
 * Schemes whose terms name an area that is never the same thing as a gross-
 * anatomy structure. An entry for one may not claim `exact-term`.
 */
export const CROSSWALK_ONLY_SCHEMES: readonly string[] = Object.freeze(['HCP-MMP1']);

const schemeOf = (term: string): string => {
  const i = term.indexOf(':');
  return i > 0 ? term.slice(0, i) : '';
};

/**
 * Everything wrong with a crosswalk, as lines. Empty means usable.
 *
 * With `dataset`, also every term the dataset uses that nothing can resolve:
 * a term with no entry and no representation keyed by its scheme. That is a
 * gap in curation, and a gap is reported where it is made rather than
 * discovered as an empty panel.
 */
export function validateCrosswalk(
  crosswalk: Crosswalk,
  representations: readonly RepresentationData[],
  dataset?: ResearchDataset,
): string[] {
  const problems: string[] = [];
  if (crosswalk?.schema !== 'atlas-crosswalk/1') {
    return [`crosswalk: schema is ${JSON.stringify(crosswalk?.schema)}, expected "atlas-crosswalk/1".`];
  }
  const seen = new Set<string>();
  const supplied = new Map(representations.map((r) => [r.representation.id, r]));
  for (const e of crosswalk.entries) {
    const at = `crosswalk ${e.term}`;
    if (seen.has(e.term)) problems.push(`${at}: listed twice.`);
    seen.add(e.term);
    if (!e.label) problems.push(`${at}: has no label; the source's own name must be kept.`);
    if (!HOWS.includes(e.how)) problems.push(`${at}: how is ${JSON.stringify(e.how)}; must be "exact-term" or "crosswalk".`);
    if (!COMPLETENESS.includes(e.completeness)) problems.push(`${at}: completeness is ${JSON.stringify(e.completeness)}.`);
    if (CROSSWALK_ONLY_SCHEMES.includes(schemeOf(e.term)) && e.how !== 'crosswalk') {
      problems.push(
        `${at}: claims ${e.how}. ${schemeOf(e.term)} areas are never the structures they are projected onto,`,
        `  so its links must be "crosswalk" and approximate.`,
      );
    }
    if (e.how === 'exact-term' && e.completeness === 'overlaps') {
      problems.push(`${at}: exact-term with completeness "overlaps". Differing boundaries are a crosswalk.`);
    }
    if ((e.completeness === 'none') !== (e.targets.length === 0)) {
      problems.push(`${at}: completeness "none" goes with no targets, and only with none.`);
    }
    if ((e.how === 'crosswalk' || e.completeness === 'none') && !e.why) {
      problems.push(`${at}: says neither why these targets nor why none. A crosswalk link shows its reason.`);
    }
    for (const t of e.targets) {
      const known = REPRESENTATIONS.find((r) => r.id === t.representation);
      if (!known) {
        problems.push(`${at}: target representation ${t.representation} is not in the registry.`);
        continue;
      }
      if (known.labels !== 'named-structures') {
        problems.push(`${at}: target representation ${t.representation} names no structures.`);
        continue;
      }
      const data = supplied.get(t.representation);
      if (!data) continue;
      const exists = data.structures.some((s) => s.label === t.label) || data.held.some((s) => s.label === t.label);
      if (!exists) {
        problems.push(
          `${at}: target "${t.label}" is not a structure of ${t.representation} ${data.version}, shipped or held.`,
          `  A misspelt target would resolve to nothing and read as a hold.`,
        );
      }
    }
  }
  if (dataset) {
    const keyed = new Set(REPRESENTATIONS.flatMap((r) => (r.idScheme ? [r.idScheme] : [])));
    for (const f of dataset.findings) {
      for (const m of f.mappings) {
        if (!seen.has(m.structureId) && !keyed.has(m.structureIdSource)) {
          problems.push(`mapping ${m.id}: term ${m.structureId} has no crosswalk entry, and no representation is keyed by ${m.structureIdSource}.`);
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface RegionIndexInput {
  readonly dataset: ResearchDataset;
  readonly crosswalk: Crosswalk;
  readonly representations: readonly RepresentationData[];
  /** Needed to place BV cells. Absent, they are reported `frame-has-no-mesh`. */
  readonly templates?: TemplateSet;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

function sideOrder(s: Side | null): number {
  return s === 'left' ? 0 : s === 'right' ? 1 : 2;
}

/** A point to place, with any extent it carries on top of the registration error. */
interface PointToPlace {
  readonly from: 'coordinates' | 'cell';
  readonly address?: string;
  readonly mniMm: Vec3;
  readonly extraMm: number;
}

function termRoute(
  input: RegionIndexInput,
  entries: ReadonlyMap<string, CrosswalkEntry>,
  m: RegionMapping,
  base: Pick<RegionLink, 'mappingId' | 'findingId' | 'paperId'>,
  links: RegionLink[],
  unplaced: Unplaced[],
): void {
  const source = { scheme: m.structureIdSource, term: m.structureId, label: m.structureLabel };
  const miss = (code: UnplacedCode, detail: string) => unplaced.push({ ...base, route: 'term', code, detail });

  // Identity first: a term in a representation's own id scheme.
  for (const data of input.representations) {
    if (data.representation.idScheme !== m.structureIdSource) continue;
    const hit = data.structures.find((s) => s.id === m.structureId);
    if (hit) {
      links.push({
        ...base,
        representation: data.representation.id,
        structureId: hit.id,
        structureName: hit.name,
        side: hit.side,
        sideFromSource: false,
        how: 'exact-term',
        precision: { kind: 'exact' },
        source,
      });
      return;
    }
  }

  const entry = entries.get(m.structureId);
  if (!entry) {
    const keyed = input.representations.filter((d) => d.representation.idScheme === m.structureIdSource);
    if (keyed.length > 0) {
      miss(
        'not-in-representation',
        `${m.structureId} is not in ${keyed.map((d) => `${d.representation.id} ${d.version}`).join(', ')}, and the crosswalk has no entry for it.`,
      );
    } else {
      miss('no-crosswalk-entry', `the crosswalk has no entry for ${m.structureId}.`);
    }
    return;
  }
  if (entry.completeness === 'none') {
    miss('not-in-representation', entry.why ?? '');
    return;
  }

  const precision: LinkPrecision =
    entry.how === 'exact-term' ? { kind: 'exact' } : { kind: 'approximate', why: entry.why ?? '' };
  const found: { representation: string; shipped: RepresentedStructure[] }[] = [];
  const held: HeldStructure[] = [];
  const absent: string[] = [];
  for (const t of entry.targets) {
    const data = input.representations.find((d) => d.representation.id === t.representation);
    if (!data) {
      absent.push(t.representation);
      continue;
    }
    const shipped = data.structures.filter((s) => s.label === t.label);
    if (shipped.length > 0) found.push({ representation: data.representation.id, shipped });
    for (const h of data.held) if (h.label === t.label) held.push(h);
  }
  const heldTargets = [...new Set(held.map((h) => h.label))].sort();
  const absentReps = [...new Set(absent)];
  if (found.length === 0) {
    if (held.length > 0) {
      const because = [...new Set(held.map((h) => h.because))].sort();
      // "Every target is held" would be false while some targets sit in a
      // representation nobody supplied, so the absent ones are named too.
      miss(
        'structure-held',
        `every supplied target of ${m.structureId} ("${m.structureLabel}") is held by the asset owner: ${heldTargets.join('; ')}. Held because: ${because.join(' | ')}` +
          (absentReps.length > 0 ? `. Its targets in ${absentReps.join(', ')} were not supplied.` : ''),
      );
    } else if (absent.length > 0) {
      miss('representation-absent', `the crosswalk places ${m.structureId} in ${absentReps.join(', ')}, which was not supplied.`);
    }
    return;
  }
  for (const group of found) {
    for (const s of [...group.shipped].sort((a, b) => sideOrder(a.side) - sideOrder(b.side))) {
      links.push({
        ...base,
        representation: group.representation,
        structureId: s.id,
        structureName: s.name,
        side: s.side,
        sideFromSource: false,
        how: entry.how,
        precision,
        source,
        crosswalk: { completeness: entry.completeness, heldTargets },
      });
    }
  }
}

function pointsOf(input: RegionIndexInput, m: RegionMapping): { points: PointToPlace[]; reasons: { code: UnplacedCode; detail: string }[] } {
  const points: PointToPlace[] = [];
  const reasons: { code: UnplacedCode; detail: string }[] = [];
  const sp = m.spatial;
  if (sp.kind === 'coordinates') {
    const host = REPRESENTATIONS.find((r) => r.geometry === 'point-set' && r.hostsSpaces?.includes(sp.space));
    if (!host) {
      reasons.push({ code: 'space-not-registered', detail: `no registered representation hosts coordinates in ${sp.space}.` });
      return { points, reasons };
    }
    for (const p of sp.pointsMm) points.push({ from: 'coordinates', mniMm: [p[0], p[1], p[2]], extraMm: 0 });
  } else if (sp.kind === 'cells') {
    for (const cell of sp.cells) {
      const a = parse(cell);
      const tpl = input.templates?.brainVolume;
      if (a.frame !== 'BV' || !tpl) {
        reasons.push({
          code: 'frame-has-no-mesh',
          detail:
            a.frame === 'BV'
              ? `${cell}: no BV template was supplied to carry the cell into MNI.`
              : `${cell}: frame ${a.frame} has no transform into any mesh representation, so the cell is not placed. The term route still applies.`,
        });
        continue;
      }
      // The cell's box in MNI: its centre is the point, half its diagonal the
      // extent added to the registration error. A cell is a region, not a point.
      const box = bvCellBox(a.anchors[0] as 'L' | 'R', a.digits);
      const lo = bvLocalToMm(tpl, box.hemisphere, { a: box.a[0], b: box.b[0], c: box.c[0] });
      const hi = bvLocalToMm(tpl, box.hemisphere, { a: box.a[1], b: box.b[1], c: box.c[1] });
      const centre: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      const half = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
      points.push({ from: 'cell', address: a.canonical, mniMm: centre, extraMm: half });
    }
  }
  return { points, reasons };
}

function coordinateRoute(
  input: RegionIndexInput,
  m: RegionMapping,
  base: Pick<RegionLink, 'mappingId' | 'findingId' | 'paperId'>,
  links: RegionLink[],
  unplaced: Unplaced[],
): void {
  if (m.spatial.kind === 'region-level') return;
  const miss = (code: UnplacedCode, detail: string) => unplaced.push({ ...base, route: 'coordinate', code, detail });
  const { points, reasons } = pointsOf(input, m);
  for (const r of reasons) miss(r.code, r.detail);
  if (points.length === 0) return;

  const placers = input.representations.filter(
    (d) => d.representation.toMni !== 'none' && d.representation.labels === 'named-structures' && d.locate && d.coordinatePrecision,
  );
  if (placers.length === 0) {
    miss('no-locator', 'no mesh representation was supplied with a locator and a measured registration error.');
    return;
  }
  const source = { scheme: m.structureIdSource, term: m.structureId, label: m.structureLabel };
  for (const data of placers) {
    const byId = new Map(data.structures.map((s) => [s.id, s]));
    const reg = data.coordinatePrecision!;
    for (const p of points) {
      const at = p.address ?? `(${p.mniMm.map((x) => round2(x)).join(', ')}) mm`;
      const hit = data.locate!(p.mniMm);
      if (hit.inside.length === 0) {
        const near = hit.nearest ? byId.get(hit.nearest.id) : undefined;
        miss(
          'coordinate-outside-shipped-structures',
          `${at} lies inside no shipped structure of ${data.representation.id} ${data.version}` +
            (near && hit.nearest
              ? `; the nearest is ${near.name}, ${round2(hit.nearest.distanceMm)} mm away in the mesh frame. Not linked: nearest is not containing, and the structure that does contain it may be held.`
              : '.'),
        );
        continue;
      }
      for (const h of hit.inside) {
        const s = byId.get(h.id);
        if (!s) continue;
        links.push({
          ...base,
          representation: data.representation.id,
          structureId: s.id,
          structureName: s.name,
          side: s.side,
          sideFromSource: true,
          how: 'coordinate',
          precision: {
            kind: 'mm',
            mm: round2(reg.mm + p.extraMm),
            basis:
              p.extraMm > 0
                ? `${reg.basis}; plus ${round2(p.extraMm)} mm, half the diagonal of cell ${p.address}`
                : reg.basis,
          },
          source,
          coordinate: { from: p.from, ...(p.address ? { address: p.address } : {}), mniMm: p.mniMm, depthMm: round2(h.depthMm) },
        });
      }
    }
  }
}

/**
 * Resolve every mapping of a dataset onto every supplied representation.
 *
 * Deterministic: mappings in dataset order, links in route then target then
 * side order, indexes sorted. A rebuild that changes nothing diffs empty.
 */
export function buildRegionIndex(input: RegionIndexInput): RegionIndex {
  const entries = new Map(input.crosswalk.entries.map((e) => [e.term, e]));
  const mappings: MappingOutcome[] = [];
  const byFinding = new Map<string, RegionLink[]>();
  const forward = new Map<string, Map<string, RegionLink[]>>();
  const inverted = new Map<string, Map<string, RegionLink[]>>();
  const names = new Map<string, { representation: string; structureId: string; structureName: string }>();
  const unplacedByPaper = new Map<string, Unplaced[]>();

  for (const f of input.dataset.findings) {
    const fl = byFinding.get(f.id) ?? byFinding.set(f.id, []).get(f.id)!;
    for (const m of f.mappings) {
      const base = { mappingId: m.id, findingId: f.id, paperId: f.paperId };
      const links: RegionLink[] = [];
      const unplaced: Unplaced[] = [];
      termRoute(input, entries, m, base, links, unplaced);
      coordinateRoute(input, m, base, links, unplaced);
      mappings.push(Object.freeze({ ...base, links: Object.freeze(links), unplaced: Object.freeze(unplaced) }));
      fl.push(...links);
      (unplacedByPaper.get(f.paperId) ?? unplacedByPaper.set(f.paperId, []).get(f.paperId)!).push(...unplaced);
      for (const l of links) {
        const k = keyOf(l);
        names.set(k, { representation: l.representation, structureId: l.structureId, structureName: l.structureName });
        const fp = forward.get(l.paperId) ?? forward.set(l.paperId, new Map()).get(l.paperId)!;
        (fp.get(k) ?? fp.set(k, []).get(k)!).push(l);
        const ip = inverted.get(k) ?? inverted.set(k, new Map()).get(k)!;
        (ip.get(l.paperId) ?? ip.set(l.paperId, []).get(l.paperId)!).push(l);
      }
    }
  }

  const papers: PaperRegions[] = input.dataset.papers.map((p) => {
    const regions = [...(forward.get(p.id)?.keys() ?? [])].sort();
    const grouped = new Map<string, { code: UnplacedCode; detail: string; mappingIds: string[] }>();
    if (regions.length === 0) {
      for (const u of unplacedByPaper.get(p.id) ?? []) {
        const k = `${u.code}\u0000${u.detail}`;
        const g = grouped.get(k) ?? grouped.set(k, { code: u.code, detail: u.detail, mappingIds: [] }).get(k)!;
        if (!g.mappingIds.includes(u.mappingId)) g.mappingIds.push(u.mappingId);
      }
    }
    return Object.freeze({ paperId: p.id, regions: Object.freeze(regions), emptyBecause: Object.freeze([...grouped.values()]) });
  });

  const structures: StructurePapers[] = [...inverted.keys()].sort().map((k) => {
    const n = names.get(k)!;
    return Object.freeze({ key: k, ...n, paperIds: Object.freeze([...inverted.get(k)!.keys()].sort()) });
  });

  const count = (pred: (o: MappingOutcome) => boolean) => mappings.filter(pred).length;
  const coverage: RegionCoverage = Object.freeze({
    mappings: {
      total: mappings.length,
      linked: count((o) => o.links.length > 0),
      byHow: {
        'exact-term': count((o) => o.links.some((l) => l.how === 'exact-term')),
        crosswalk: count((o) => o.links.some((l) => l.how === 'crosswalk')),
        coordinate: count((o) => o.links.some((l) => l.how === 'coordinate')),
      },
    },
    papers: {
      total: papers.length,
      nonEmpty: papers.filter((p) => p.regions.length > 0).length,
      emptyWithStatedReason: papers.filter((p) => p.regions.length === 0 && p.emptyBecause.length > 0).length,
    },
  });

  return Object.freeze({
    datasetVersion: input.dataset.version,
    crosswalkVersion: input.crosswalk.version,
    representations: Object.freeze(input.representations.map((d) => ({ id: d.representation.id, version: d.version }))),
    mappings: Object.freeze(mappings),
    papers: Object.freeze(papers),
    structures: Object.freeze(structures),
    coverage,
    resolve: (finding: Finding | string) => byFinding.get(typeof finding === 'string' ? finding : finding.id) ?? [],
    regionsFor: (paperId: string) =>
      [...(forward.get(paperId)?.entries() ?? [])].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, links]) => ({ key, links })),
    papersFor: (k: string) =>
      [...(inverted.get(k)?.entries() ?? [])].sort(([a], [b]) => (a < b ? -1 : 1)).map(([paperId, links]) => ({ paperId, links })),
  });
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * Everything wrong with a region index, as lines. Empty means sound.
 *
 * These are the acceptance criteria as executable checks, so the same function
 * gates the committed index in CI and the synthetic ones in the unit tests:
 *
 * 1. Every link says how it was made, with a precision that matches. A
 *    coordinate link is never `exact-term`, and never claims an error below
 *    the registration's measured one.
 * 2. An HCP-MMP1 link is `crosswalk`, `approximate`, and keeps the area name.
 * 3. Every mapping has a link or a stated reason; every paper has a region or
 *    a stated reason.
 * 4. Paper → regions and region → papers agree, both ways.
 */
export function checkRegionIndex(index: RegionIndex, representations: readonly RepresentationData[]): string[] {
  const problems: string[] = [];
  const floors = new Map(representations.map((d) => [d.representation.id, d.coordinatePrecision?.mm]));

  for (const o of index.mappings) {
    if (o.links.length === 0 && o.unplaced.length === 0) {
      problems.push(`mapping ${o.mappingId}: no link and no stated reason. A mapping cannot vanish.`);
    }
    for (const l of o.links) {
      const at = `mapping ${l.mappingId} → ${l.structureName} (${l.representation})`;
      if (!['exact-term', 'crosswalk', 'coordinate'].includes(l.how)) problems.push(`${at}: how is ${JSON.stringify(l.how)}.`);
      const isPlaced = l.coordinate !== undefined;
      if (isPlaced && l.how !== 'coordinate') {
        problems.push(`${at}: a placed coordinate is labelled ${l.how}. A coordinate link is never exact; it carries the registration error.`);
      }
      if (l.how === 'coordinate') {
        if (!isPlaced) problems.push(`${at}: labelled coordinate but records no point.`);
        if (l.precision.kind !== 'mm') {
          problems.push(`${at}: a coordinate link with precision ${l.precision.kind}; it must carry millimetres.`);
        } else {
          const floor = floors.get(l.representation);
          if (floor === undefined) problems.push(`${at}: a coordinate link into a representation with no measured registration error.`);
          else if (l.precision.mm < floor) {
            problems.push(`${at}: claims ±${l.precision.mm} mm, tighter than the registration's measured ${floor} mm.`);
          }
          if (!l.precision.basis) problems.push(`${at}: a millimetre precision with no stated basis.`);
        }
      }
      if (l.how === 'exact-term' && l.precision.kind !== 'exact') problems.push(`${at}: exact-term with precision ${l.precision.kind}.`);
      if (l.how === 'crosswalk' && (l.precision.kind !== 'approximate' || !l.precision.why)) {
        problems.push(`${at}: a crosswalk link must be approximate and say why.`);
      }
      if (CROSSWALK_ONLY_SCHEMES.includes(l.source.scheme) && l.how !== 'coordinate') {
        if (l.how !== 'crosswalk') problems.push(`${at}: an ${l.source.scheme} link labelled ${l.how}; it must be crosswalk.`);
        if (!l.source.label) problems.push(`${at}: an ${l.source.scheme} link that lost the area's own name.`);
      }
    }
  }

  for (const p of index.papers) {
    if (p.regions.length === 0 && p.emptyBecause.length === 0) {
      problems.push(`paper ${p.paperId}: no region and no stated reason.`);
    }
    if (p.regions.length > 0 && p.emptyBecause.length > 0) {
      problems.push(`paper ${p.paperId}: has regions and also an emptyBecause.`);
    }
  }

  // Round trip. Forward from the per-paper lists, inverted from the per-
  // structure lists, each checked against the other and against the links.
  const fwd = new Set<string>();
  for (const p of index.papers) for (const k of p.regions) fwd.add(`${p.paperId}\u0000${k}`);
  const inv = new Set<string>();
  for (const s of index.structures) for (const pid of s.paperIds) inv.add(`${pid}\u0000${s.key}`);
  const viaLinks = new Set<string>();
  for (const o of index.mappings) for (const l of o.links) viaLinks.add(`${l.paperId}\u0000${keyOf(l)}`);
  for (const [name, a, bName, b] of [
    ['paper → regions', fwd, 'region → papers', inv],
    ['region → papers', inv, 'paper → regions', fwd],
    ['the links', viaLinks, 'paper → regions', fwd],
    ['paper → regions', fwd, 'the links', viaLinks],
  ] as const) {
    for (const pair of a) {
      if (!b.has(pair)) {
        const [pid, k] = pair.split('\u0000');
        problems.push(`round trip: ${name} has ${pid} ↔ ${k}, ${bName} does not.`);
      }
    }
  }
  for (const p of index.papers) {
    for (const r of index.regionsFor(p.paperId)) {
      const back = index.papersFor(r.key).find((x) => x.paperId === p.paperId);
      if (!back || back.links.length !== r.links.length) {
        problems.push(`round trip: ${p.paperId} → ${r.key} carries ${r.links.length} link(s), the way back ${back?.links.length ?? 0}.`);
      }
    }
  }
  return problems;
}

/**
 * The index as plain JSON: what is committed, what W6 publishes, and what W8a
 * checks. Functions are dropped; everything they answer is in the data.
 */
export function serialiseRegionIndex(index: RegionIndex): {
  readonly datasetVersion: string;
  readonly crosswalkVersion: string;
  readonly representations: RegionIndex['representations'];
  readonly coverage: RegionCoverage;
  readonly papers: readonly PaperRegions[];
  readonly structures: readonly StructurePapers[];
  readonly mappings: readonly MappingOutcome[];
} {
  return {
    datasetVersion: index.datasetVersion,
    crosswalkVersion: index.crosswalkVersion,
    representations: index.representations,
    coverage: index.coverage,
    papers: index.papers,
    structures: index.structures,
    mappings: index.mappings,
  };
}
