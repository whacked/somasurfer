/**
 * Resolution: curated mappings become coverings, once.
 *
 * A `ResearchDataset` is text. A `ResearchIndex` is that text resolved against
 * a specific name index (and optionally a template set) into `ResolvedMapping`s
 * — each one a covering plus the whole provenance trail behind it. Both browse
 * modes and the colour layers read only from here, which is what makes the
 * per-highlight provenance guarantee structural rather than a convention: there
 * is no way to obtain a cell to paint that is not attached to a mapping.
 *
 * Resolution happens once, at build or load, for two reasons. It is where the
 * cost is — `coveringIntersect` is quadratic in cells — and it is where the
 * *failures* are. A structure id missing from the index, curated cells that sit
 * outside the structure they claim, coordinates with no template to place them:
 * all of those are conditions a curator needs told, in one list, not surprises
 * that surface one hover at a time.
 *
 * ## What is never done here
 *
 * **Nothing falls back.** A `coordinates` mapping with no template does not
 * quietly become its structure's covering; it resolves `unresolved` and says
 * why. That rule is the whole reason the schema distinguishes `region-level`
 * from `coordinates` in the first place: "we know only the region" and "we have
 * a locus we cannot place yet" are different claims, and a fallback would print
 * the first while the data says the second.
 *
 * **Curated cells are never silently trimmed.** When a curator's cells extend
 * outside the structure they are filed under, the covering stays as authored
 * and a note records the disagreement with its measured fraction. Intersecting
 * would shrink a highlight to match an index the curator may well be right to
 * disagree with, and it would do it invisibly.
 */

import {
  AlcError,
  covering,
  coveringFromPointsMm,
  coveringIntersect,
  coveringMeasure,
  coveringUnion,
  EMPTY_COVERING,
  structureCovering,
  type Covering,
  type NameIndex,
  type TemplateSet,
} from '../../alc/src/index.ts';

import { formatCitation, sourceLink, type SourceLink } from './links.ts';
import type { Evidence, Finding, Paper, Provenance, RegionMapping, ResearchDataset } from './types.ts';

/** How precisely the source located the finding. Drives the viewer's markers. */
export type MappingPrecision = 'region-level' | 'cells' | 'coordinates';

/**
 * One curated link, resolved: what to paint, and everything a reader needs to
 * challenge it. This is the hover payload named in the schema.
 */
export interface ResolvedMapping {
  readonly mappingId: string;
  readonly findingId: string;
  readonly paperId: string;

  readonly structureId: string;
  /** Resolved from the name index when it knows the id; the curated label otherwise. */
  readonly structureLabel: string;
  /** What the dataset claimed, kept so a disagreement with the index is visible. */
  readonly structureLabelCurated: string;
  /** True when the label came from the index rather than the dataset. */
  readonly structureLabelFromIndex: boolean;

  /** What to paint. `EMPTY_COVERING` exactly when `resolution` is `unresolved`. */
  readonly covering: Covering;
  /** Frames the covering touches, so a viewer can tell body work from brain work. */
  readonly frames: readonly string[];
  readonly precision: MappingPrecision;
  /**
   * True exactly when the source gave no location finer than the region. The
   * flag the "region-level only" marker is rendered from — a viewer must not
   * infer it from the covering's size, which says nothing about precision.
   */
  readonly regionLevelOnly: boolean;
  readonly resolution: 'resolved' | 'unresolved';
  /** Machine-readable cause, `null` when resolved. */
  readonly unresolvedReason:
    | null
    | 'unknown-structure'
    | 'no-template'
    | 'empty-covering'
    | 'bad-coordinates';
  /** Human-readable conditions worth showing. Never swallowed. */
  readonly notes: readonly string[];

  readonly finding: Finding;
  readonly paper: Paper;
  readonly evidence: Evidence;
  readonly provenance: Provenance;
  readonly citation: string;
  readonly link: SourceLink;

  readonly datasetVersion: string;
  readonly nameIndexVersion: string;
}

export interface ResearchIndexInput {
  readonly dataset: ResearchDataset;
  readonly names: NameIndex;
  /**
   * Needed only to place `coordinates` mappings. Absent is a supported state,
   * not an error: in stage A there is no template yet, and the coordinate
   * mappings resolve `unresolved` with `no-template` until there is one.
   */
  readonly templates?: TemplateSet;
}

export interface ResearchIndex {
  readonly dataset: ResearchDataset;
  readonly nameIndexVersion: string;
  readonly papers: readonly Paper[];
  readonly findings: readonly Finding[];
  readonly mappings: readonly ResolvedMapping[];
  /** The subset with `resolution: 'unresolved'`. The curator's work list. */
  readonly unresolved: readonly ResolvedMapping[];

  paper(id: string): Paper | undefined;
  finding(id: string): Finding | undefined;
  mapping(id: string): ResolvedMapping | undefined;
  findingsOf(paperId: string): readonly Finding[];
  mappingsOf(paperId: string): readonly ResolvedMapping[];
  mappingsOfFinding(findingId: string): readonly ResolvedMapping[];
  /** Union of every resolved mapping of a paper. The paper's full extent. */
  paperCovering(paperId: string): Covering;

  /**
   * Every resolved mapping's cells, sorted, with the owning mapping index
   * parallel to it. The same shape `@gstack/alc`'s name index uses, so the
   * anatomy-side query is the same prefix range scan — see `browse.ts`.
   */
  readonly cellKeys: readonly string[];
  readonly cellOwners: readonly number[];
}

function resolveOne(
  input: ResearchIndexInput,
  finding: Finding,
  paper: Paper,
  m: RegionMapping,
  citation: string,
  link: SourceLink,
): ResolvedMapping {
  const { names, templates } = input;
  const notes: string[] = [];

  let structureCov: Covering | null = null;
  let structureLabel = m.structureLabel;
  let structureLabelFromIndex = false;
  try {
    structureCov = structureCovering(m.structureId, names);
    const ref = names.structures.find((s) => s.id === m.structureId);
    if (ref) {
      structureLabel = ref.name;
      structureLabelFromIndex = true;
      if (ref.name !== m.structureLabel) {
        // Not an error: the index is authoritative and parcellations get
        // renamed. Worth saying, because a curated label that has drifted is
        // the first sign a mapping was authored against an older index.
        notes.push(
          `the name index calls ${m.structureId} "${ref.name}"; the dataset recorded "${m.structureLabel}"`,
        );
      }
    }
  } catch (e) {
    if ((e as AlcError).code !== 'unknown_structure') throw e;
    notes.push(`structure ${m.structureId} is not in name index ${names.version}`);
  }

  const base = {
    mappingId: m.id,
    findingId: finding.id,
    paperId: paper.id,
    structureId: m.structureId,
    structureLabel,
    structureLabelCurated: m.structureLabel,
    structureLabelFromIndex,
    finding,
    paper,
    evidence: m.evidence,
    provenance: m.provenance,
    citation,
    link,
    datasetVersion: input.dataset.version,
    nameIndexVersion: names.version,
  };

  const unresolved = (
    reason: NonNullable<ResolvedMapping['unresolvedReason']>,
    precision: MappingPrecision,
    extra: string,
  ): ResolvedMapping =>
    Object.freeze({
      ...base,
      covering: EMPTY_COVERING,
      frames: Object.freeze([] as string[]),
      precision,
      regionLevelOnly: precision === 'region-level',
      resolution: 'unresolved' as const,
      unresolvedReason: reason,
      notes: Object.freeze([...notes, extra]),
    });

  const resolved = (cov: Covering, precision: MappingPrecision): ResolvedMapping =>
    Object.freeze({
      ...base,
      covering: cov,
      frames: cov.frames,
      precision,
      regionLevelOnly: precision === 'region-level',
      resolution: 'resolved' as const,
      unresolvedReason: null,
      notes: Object.freeze([...notes]),
    });

  switch (m.spatial.kind) {
    case 'region-level': {
      // The structure's whole covering, flagged. Region-level is a real,
      // paintable extent — it is the *precision* that is coarse, not the
      // claim that is missing.
      if (structureCov === null) {
        return unresolved(
          'unknown-structure',
          'region-level',
          'a region-level mapping has no geometry of its own, so an unknown structure leaves nothing to show',
        );
      }
      if (structureCov.cells.length === 0) {
        return unresolved(
          'empty-covering',
          'region-level',
          `structure ${m.structureId} is in the index with an empty covering`,
        );
      }
      return resolved(structureCov, 'region-level');
    }

    case 'cells': {
      const cov = covering(m.spatial.cells);
      if (cov.cells.length === 0) {
        return unresolved('empty-covering', 'cells', 'the curated cells normalised to an empty covering');
      }
      if (structureCov !== null && structureCov.cells.length > 0) {
        const inside = coveringIntersect(cov, structureCov);
        const whole = coveringMeasure(cov);
        const share = whole > 0 ? coveringMeasure(inside) / whole : 0;
        if (share < 1) {
          // Kept as authored. See the module header.
          notes.push(
            share === 0
              ? `the curated cells lie entirely outside ${m.structureId}'s covering in index ${names.version}`
              : `${(share * 100).toFixed(1)}% of the curated cells lie inside ${m.structureId}'s covering in index ${names.version}`,
          );
        }
      }
      return resolved(cov, 'cells');
    }

    case 'coordinates': {
      const haveTemplate = m.spatial.frame === 'BD' ? templates?.body : templates?.brainVolume;
      if (!templates || !haveTemplate) {
        return unresolved(
          'no-template',
          'coordinates',
          `published coordinates in ${m.spatial.space} cannot be placed: no ${m.spatial.frame} template is loaded. Not shown as region-level, because a locus we cannot place is not the same claim as a region`,
        );
      }
      let result;
      try {
        result = coveringFromPointsMm(templates, m.spatial.frame, m.spatial.pointsMm, m.spatial.digits);
      } catch (e) {
        return unresolved('bad-coordinates', 'coordinates', `coordinates could not be encoded: ${(e as Error).message}`);
      }
      if (result.clampedPoints > 0) {
        // The library's own honesty flag, forwarded rather than absorbed: a
        // published coordinate outside the modelled surface is a real
        // registration condition, not a rendering detail.
        notes.push(
          `${result.clampedPoints} of ${m.spatial.pointsMm.length} published coordinate(s) clamped to the modelled surface`,
        );
      }
      for (const n of result.notes) notes.push(n);
      if (result.covering.cells.length === 0) {
        return unresolved('empty-covering', 'coordinates', 'the published coordinates encoded to no cells');
      }
      return resolved(result.covering, 'coordinates');
    }
  }
}

/**
 * Resolve a dataset against a name index.
 *
 * Deterministic: mappings come out in dataset order, so a build is reproducible
 * and a diff of resolved output is readable.
 */
export function buildResearchIndex(input: ResearchIndexInput): ResearchIndex {
  const { dataset, names } = input;
  if (typeof names?.version !== 'string' || !Array.isArray(names.structures)) {
    throw new AlcError('buildResearchIndex needs a NameIndex built by buildNameIndex()', 'bad_name_index');
  }

  const papersById = new Map(dataset.papers.map((p) => [p.id, p]));
  const citations = new Map<string, string>();
  const links = new Map<string, SourceLink>();
  for (const p of dataset.papers) {
    const citation = formatCitation(p);
    citations.set(p.id, citation);
    links.set(p.id, sourceLink(citation, p.sourceUrl));
  }

  const mappings: ResolvedMapping[] = [];
  const byFinding = new Map<string, ResolvedMapping[]>();
  const byPaper = new Map<string, ResolvedMapping[]>();
  const findingsByPaper = new Map<string, Finding[]>();
  const byMappingId = new Map<string, ResolvedMapping>();
  const findingsById = new Map<string, Finding>();

  for (const f of dataset.findings) {
    findingsById.set(f.id, f);
    const paper = papersById.get(f.paperId);
    // `validate.ts` rejects a dangling paperId, so this cannot happen for a
    // loaded dataset. It is checked anyway because this function also accepts
    // a dataset constructed in a test.
    if (!paper) throw new AlcError(`finding ${f.id} refers to unknown paper ${f.paperId}`, 'unknown_paper');
    (findingsByPaper.get(paper.id) ?? findingsByPaper.set(paper.id, []).get(paper.id)!).push(f);

    for (const m of f.mappings) {
      const r = resolveOne(input, f, paper, m, citations.get(paper.id)!, links.get(paper.id)!);
      mappings.push(r);
      byMappingId.set(r.mappingId, r);
      (byFinding.get(f.id) ?? byFinding.set(f.id, []).get(f.id)!).push(r);
      (byPaper.get(paper.id) ?? byPaper.set(paper.id, []).get(paper.id)!).push(r);
    }
  }

  // Sorted cell keys with parallel owners: the scan substrate. Several mappings
  // legitimately share a cell, so keys repeat and the owner array is what
  // disambiguates — exactly how the name index handles one cell in two
  // structures.
  const pairs: { key: string; owner: number }[] = [];
  mappings.forEach((m, i) => {
    for (const cell of m.covering.cells) pairs.push({ key: cell, owner: i });
  });
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.owner - b.owner));

  const paperCoverings = new Map<string, Covering>();

  const index: ResearchIndex = Object.freeze({
    dataset,
    nameIndexVersion: names.version,
    papers: dataset.papers,
    findings: dataset.findings,
    mappings: Object.freeze(mappings),
    unresolved: Object.freeze(mappings.filter((m) => m.resolution === 'unresolved')),
    cellKeys: Object.freeze(pairs.map((p) => p.key)),
    cellOwners: Object.freeze(pairs.map((p) => p.owner)),

    paper: (id) => papersById.get(id),
    finding: (id) => findingsById.get(id),
    mapping: (id) => byMappingId.get(id),
    findingsOf: (paperId) => findingsByPaper.get(paperId) ?? [],
    mappingsOf: (paperId) => byPaper.get(paperId) ?? [],
    mappingsOfFinding: (findingId) => byFinding.get(findingId) ?? [],
    paperCovering: (paperId) => {
      const hit = paperCoverings.get(paperId);
      if (hit) return hit;
      const parts = (byPaper.get(paperId) ?? []).filter((m) => m.resolution === 'resolved').map((m) => m.covering);
      const cov = parts.length === 0 ? EMPTY_COVERING : coveringUnion(...parts);
      paperCoverings.set(paperId, cov);
      return cov;
    },
  });
  return index;
}
