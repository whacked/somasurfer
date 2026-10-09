/**
 * The `research/1` schema, in types. `schema/research-1.md` is the prose
 * contract and the reasoning; this file must not drift from it.
 *
 * Every type here describes *curator-supplied input*, which is to say
 * untrusted input. Nothing in this file is a runtime guarantee — `validate.ts`
 * is what turns a parsed JSON blob into a value of these types, and it is the
 * only sanctioned way to produce one.
 */

/** Who asserted a link, when, on what basis, and how strongly. */
export interface Provenance {
  readonly assertedBy: string;
  /** ISO date, `YYYY-MM-DD`. */
  readonly assertedOn: string;
  readonly basis: ProvenanceBasis;
  readonly confidence: Confidence;
  /** Required when `basis` is `curator-inference`: say what was inferred. */
  readonly note?: string;
}

export type ProvenanceBasis =
  /** The paper states the parcellation or atlas region itself. */
  | 'published-parcellation'
  /** The paper publishes coordinates in a named space. */
  | 'published-coordinates'
  /** The paper's text names the region. */
  | 'published-text'
  /** The curator mapped a vague or historical name onto a modern structure. */
  | 'curator-inference';

export type Confidence = 'high' | 'medium' | 'low';

export type IdentifierKind = 'doi' | 'pmid' | 'pmcid' | 'isbn' | 'url' | 'none';

export interface PaperIdentifier {
  readonly kind: IdentifierKind;
  /** `null` exactly when `kind` is `none`. An absent identifier is a stated fact. */
  readonly value: string | null;
}

export interface Paper {
  readonly id: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly year: number;
  readonly venue: string;
  readonly identifier: PaperIdentifier;
  /** Absolute `http(s)` URL, or `null`. Rendered, never fetched. */
  readonly sourceUrl: string | null;
  readonly provenance: Provenance;
}

export type EvidenceKind = 'abstract' | 'figure' | 'table' | 'section' | 'page' | 'supplementary';

export interface Evidence {
  /** The curator's paraphrase of what the source shows. Not a quotation. */
  readonly summary: string;
  readonly kind: EvidenceKind;
  /** Where in the paper this region is reported. `null` only with `not-recorded`. */
  readonly locator: string | null;
  readonly locatorStatus: 'recorded' | 'not-recorded';
}

/**
 * Where a finding is, to the precision the source actually supports.
 *
 * `region-level` is not a degraded `cells`: it resolves to the structure's
 * whole covering and is flagged, so the viewer can show the required
 * "region-level only" marker. See the schema's Spatial detail section.
 */
export type SpatialDetail =
  | {
      readonly kind: 'region-level';
      /** Why there is no finer location. Shown on hover. */
      readonly reason: string;
    }
  | {
      readonly kind: 'cells';
      readonly cells: readonly string[];
      /** How the curator arrived at these cells. */
      readonly method: string;
      /** Refinement digits the curator stands behind. */
      readonly digits: number;
    }
  | {
      readonly kind: 'coordinates';
      /** Named coordinate space, e.g. `MNI152`. Not a template id. */
      readonly space: string;
      readonly frame: 'BD' | 'BV';
      readonly pointsMm: readonly (readonly [number, number, number])[];
      readonly digits: number;
      readonly note?: string;
    };

export interface RegionMapping {
  readonly id: string;
  readonly structureId: string;
  readonly structureIdSource: string;
  /** Display only, and only until the index resolves. Never authoritative. */
  readonly structureLabel: string;
  readonly spatial: SpatialDetail;
  readonly evidence: Evidence;
  readonly provenance: Provenance;
}

export interface Finding {
  readonly id: string;
  readonly paperId: string;
  /** The curator's one-sentence rendering of the claim. Plain text. */
  readonly statement: string;
  readonly topics: readonly string[];
  /** At least one. A finding that maps to nothing is rejected. */
  readonly mappings: readonly RegionMapping[];
  readonly provenance: Provenance;
}

export interface CurationRecord {
  readonly curatedBy: string;
  readonly curatedOn: string;
  readonly method: string;
  /** What was and was not checked. See the schema's Curation record section. */
  readonly citationCheck: string;
  readonly notRecorded: readonly string[];
}

export interface AuthoredAgainst {
  readonly nameIndexVersion: string;
  /**
   * `fixture` while the mappings are authored against a synthetic index;
   * `real` once they are authored against the pipeline's `coverings.json`.
   * Stated so a dataset cannot be mistaken for verified against real geometry.
   */
  readonly status: 'fixture' | 'real';
}

export interface ResearchDataset {
  readonly schema: 'research/1';
  readonly version: string;
  readonly structureIdSources: readonly string[];
  readonly authoredAgainst: AuthoredAgainst;
  readonly curation: CurationRecord;
  readonly papers: readonly Paper[];
  readonly findings: readonly Finding[];
}
