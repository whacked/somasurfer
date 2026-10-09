/**
 * `@gstack/atlas-research` — the research layer: papers, findings, region
 * mappings, both browse modes, and the solid-colour data path.
 *
 * The package knows about `@gstack/alc` and about nothing else. No DOM, no
 * meshes, no network client — the same boundary the library keeps, for the same
 * reason: the part that decides what a highlight *means* has to be testable
 * without a browser.
 *
 * Read `schema/research-1.md` first. It carries the reasoning; this file is
 * only the surface.
 */

export { loadDataset, validateDataset, ResearchDataError, type ValidationProblem } from './validate.ts';

export {
  buildResearchIndex,
  type MappingPrecision,
  type ResearchIndex,
  type ResearchIndexInput,
  type ResolvedMapping,
} from './dataset.ts';

export {
  anatomyScan,
  browseByAnatomy,
  browseByResearch,
  paperSelection,
  scanPredicate,
  selectionExtent,
  type AnatomyBrowse,
  type FindingHit,
  type PaperHit,
  type PaperListEntry,
  type PaperSelection,
  type ResearchBrowse,
  type ResearchBrowseOptions,
} from './browse.ts';

export {
  assignPaperColours,
  COLOUR_ONLY_DISTINCT,
  frameOfCell,
  hatchedExtent,
  MAX_COLOURED_PAPERS,
  nextColours,
  PAPER_PALETTE,
  pairOverlap,
  refine,
  solidColourLayers,
  type HatchAngle,
  type PaletteSlot,
  type PaperColour,
  type Refinement,
  type SolidColourLayer,
  type SolidColourLayers,
} from './layers.ts';

export { formatCitation, isSafeUrl, safeHref, sourceLink, type SourceLink } from './links.ts';

export type {
  AuthoredAgainst,
  Confidence,
  CurationRecord,
  Evidence,
  EvidenceKind,
  Finding,
  IdentifierKind,
  Paper,
  PaperIdentifier,
  Provenance,
  ProvenanceBasis,
  RegionMapping,
  ResearchDataset,
  SpatialDetail,
} from './types.ts';
