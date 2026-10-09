/**
 * The research fixture the journey runs against: loading it, validating it, and
 * pinning it.
 *
 * ## Why this is not just `JSON.parse`
 *
 * Three jobs, and the second is the one that matters.
 *
 * 1. **Pin it.** The digest of whatever fixture was used goes in the report. A
 *    §7 result against an unnamed fixture is not reproducible, and "QA passed"
 *    against a fixture that has since changed is worse than no result.
 *
 * 2. **Check the fixture can actually exercise the journey.** The journey needs
 *    a paper whose mappings reach outside any plausible filter, two papers that
 *    overlap, and a finding with no spatial detail. A fixture missing any of
 *    those makes the corresponding step *vacuous* — it runs, asserts over an
 *    empty set, and passes. That is the false green this whole task is about, so
 *    the requirements are checked up front and a fixture that cannot express a
 *    requirement makes the step `unverified`, never `pass`.
 *
 * 3. **Validate every cell against the real library.** A typo'd address in the
 *    fixture would otherwise surface as a research step failing, which reads as
 *    a product defect. `parse()` runs over every cell at load.
 *
 * ## Which fixture
 *
 * DOG-37 owns the real seed dataset and its 5-paper fixture, which will land at
 * `packages/atlas-research/fixtures/`. This harness prefers it the moment it
 * appears and falls back to its own synthetic one otherwise, reporting which it
 * used either way. The harness's own fixture is not deleted when the real one
 * lands: a suite whose only input is another team's in-progress deliverable
 * cannot be run while that deliverable is broken, and a harness you cannot run
 * is a harness nobody runs.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { covering, encodeBrainVolume, parse, type Covering } from '../../alc/src/index.ts';
import { templateSet } from './templates.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = dirname(HERE);
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));

/** Where DOG-37's fixture is expected. Agreed on DOG-38; if it moves, this is the one line to change. */
export const RESEARCH_FIXTURE_DIR = join(REPO_ROOT, 'packages', 'atlas-research', 'fixtures');
export const OWN_FIXTURE_PATH = join(PACKAGE_ROOT, 'fixtures', 'journey-5papers.json');

export interface FixtureFinding {
  readonly id: string;
  readonly summary: string;
  readonly regions: readonly string[];
  readonly cells: readonly string[];
  readonly evidence: string;
  readonly spatialDetail: boolean;
}

export interface FixturePaper {
  readonly id: string;
  readonly citation: string;
  readonly sourceUrl: string;
  readonly findings: readonly FixtureFinding[];
}

export interface FixtureStructure {
  readonly id: string;
  readonly name: string;
  readonly atlas: 'body' | 'brain';
  readonly cells: readonly string[];
}

export interface ResearchFixture {
  readonly id: string;
  readonly nameIndexVersion: string;
  readonly structures: readonly FixtureStructure[];
  readonly papers: readonly FixturePaper[];
  /** Provenance, for the report. */
  readonly source: { readonly path: string; readonly sha256: string; readonly kind: 'curated' | 'synthetic-qa-fixture' };
}

/**
 * What the journey needs a fixture to be able to express.
 *
 * Each entry is a step id and a predicate. A fixture failing one does not fail
 * the suite — it is not the fixture's job to satisfy QA — it makes that step
 * `unverified` with this reason attached. The distinction is the point: "the
 * build got this wrong" and "nothing here could have tested it" are different
 * results and must never print the same.
 */
export const FIXTURE_REQUIREMENTS: ReadonlyArray<{
  readonly id: string;
  readonly forSteps: readonly string[];
  readonly describe: string;
  readonly satisfied: (f: ResearchFixture) => boolean;
}> = [
  {
    id: 'two-papers-share-a-region',
    forSteps: ['region-research', 'compare-two-papers'],
    describe: 'at least two papers map a common region, so a filtered list has more than one entry and an overlap exists to hatch',
    satisfied: (f) => {
      const byRegion = new Map<string, Set<string>>();
      for (const p of f.papers) {
        for (const fi of p.findings) for (const r of fi.regions) {
          if (!byRegion.has(r)) byRegion.set(r, new Set());
          byRegion.get(r)!.add(p.id);
        }
      }
      return [...byRegion.values()].some((s) => s.size >= 2);
    },
  },
  {
    id: 'a-paper-reaches-outside-one-region',
    forSteps: ['paper-reveals-all-its-regions'],
    describe:
      'at least one paper found via a single region also maps regions that region\'s filter would exclude — '
      + 'without this, "reveals ALL its regions" is satisfied by a fixture where every paper maps one region',
    satisfied: (f) =>
      f.papers.some((p) => new Set(p.findings.flatMap((fi) => fi.regions)).size >= 2),
  },
  {
    id: 'a-finding-with-no-spatial-detail',
    forSteps: ['paper-reveals-all-its-regions'],
    describe: 'at least one finding has no spatial detail, so the region-level-only marker has something to mark',
    satisfied: (f) => f.papers.some((p) => p.findings.some((fi) => !fi.spatialDetail)),
  },
  {
    id: 'a-brain-region-with-research',
    forSteps: ['region-research'],
    describe: 'at least one brain structure carries findings, so browse-by-anatomy has an anchor in the brain atlas',
    satisfied: (f) => {
      const brain = new Set(f.structures.filter((s) => s.atlas === 'brain').map((s) => s.id));
      return f.papers.some((p) => p.findings.some((fi) => fi.regions.some((r) => brain.has(r))));
    },
  },
  {
    id: 'a-body-structure',
    forSteps: ['select-structure-without-leaving-atlas', 'explicit-brain-navigation'],
    describe: 'at least two body structures, one of them the body atlas\'s brain, so a selection and a cross-atlas link both have a target',
    satisfied: (f) => f.structures.filter((s) => s.atlas === 'body').length >= 2,
  },
  {
    id: 'a-cell-claimed-by-more-than-one-structure',
    forSteps: ['select-structure-without-leaving-atlas'],
    describe:
      'at least one cell is claimed by two or more structures, so "a ranked name list with containment '
      + 'fractions, never one name" has a second name to rank — in a fixture where every cell has exactly '
      + 'one owner the requirement is untestable, and a build showing only the top match passes',
    satisfied: (f) => {
      // Nested or equal cells count: a structure occupying a sub-cell of
      // another's is claimed alongside it, which is the ordinary case plan §6
      // describes ("a cell overlapping several structures").
      const cells = f.structures.flatMap((s) => s.cells.map((c) => ({ id: s.id, cell: c })));
      return cells.some((a) =>
        cells.some((b) => b.id !== a.id && (b.cell === a.cell || b.cell.startsWith(`${a.cell}`))),
      );
    },
  },
];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Places the fixture's provenance is thinner than DOG-1 §5 asks for.
 *
 * Reported, never fatal. Each one is a constraint on the UI rather than a
 * defect in the data: a paper with no source link must say that explicitly
 * instead of rendering a dead link, and a finding with no evidence summary must
 * not present an empty tooltip as provenance. Carried into the report so task 7
 * knows which gaps were present in the data it ran against — otherwise a
 * missing hover is indistinguishable from a build that drops it.
 */
export function provenanceGaps(fixture: ResearchFixture): string[] {
  const gaps: string[] = [];
  for (const p of fixture.papers) {
    if (!p.sourceUrl) {
      gaps.push(
        `paper ${p.id} has no source link, so the UI must show "no source link recorded" rather than a `
        + 'dead link or an empty field',
      );
    }
    for (const f of p.findings) {
      if (!f.evidence || f.evidence === 'no evidence summary recorded') {
        gaps.push(`finding ${f.id} has no evidence summary, so its hover has nothing to show`);
      }
    }
  }
  return gaps;
}

/** Problems with the fixture's own shape. These DO fail, loudly: a broken fixture is not a test result. */
export function fixtureShapeProblems(raw: unknown, path: string): string[] {
  const problems: string[] = [];
  const at = (what: string) => `${path}: ${what}`;
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object') return [at('not an object')];
  if (typeof o.id !== 'string' || o.id === '') problems.push(at('needs a non-empty id'));
  if (typeof o.nameIndexVersion !== 'string' || o.nameIndexVersion === '') {
    problems.push(at('needs a nameIndexVersion — an unversioned name index produces unreproducible resolutions'));
  }
  if (!Array.isArray(o.structures) || o.structures.length === 0) problems.push(at('needs a structures array'));
  if (!Array.isArray(o.papers) || o.papers.length === 0) problems.push(at('needs a papers array'));
  if (problems.length > 0) return problems;

  const structureIds = new Set<string>();
  for (const s of o.structures as FixtureStructure[]) {
    if (typeof s?.id !== 'string' || s.id === '') { problems.push(at('a structure has no id')); continue; }
    if (structureIds.has(s.id)) problems.push(at(`duplicate structure id ${s.id}`));
    structureIds.add(s.id);
    if (typeof s.name !== 'string' || s.name === '') problems.push(at(`structure ${s.id} has no name`));
    if (s.atlas !== 'body' && s.atlas !== 'brain') problems.push(at(`structure ${s.id} must declare atlas body|brain`));
    if (!Array.isArray(s.cells) || s.cells.length === 0) problems.push(at(`structure ${s.id} has no cells`));
    for (const cell of s.cells ?? []) {
      try {
        parse(cell);
      } catch (e) {
        problems.push(at(`structure ${s.id} cell ${JSON.stringify(cell)} is not a valid address: ${(e as Error).message}`));
      }
    }
  }

  const findingIds = new Set<string>();
  const paperIds = new Set<string>();
  for (const p of o.papers as FixturePaper[]) {
    if (typeof p?.id !== 'string' || p.id === '') { problems.push(at('a paper has no id')); continue; }
    if (paperIds.has(p.id)) problems.push(at(`duplicate paper id ${p.id}`));
    paperIds.add(p.id);
    // Provenance on every link is DOG-1 §5 and plan §6, not a nicety: a
    // highlight the user cannot trace is a claim with no source.
    if (typeof p.citation !== 'string' || p.citation === '') problems.push(at(`paper ${p.id} has no citation`));
    // `sourceUrl` is deliberately NOT required.
    //
    // DOG-37's curated fixture carries a 1909 monograph and a 1999 paper with
    // `identifier: { kind: 'none' }` and no URL, which is a correct curation
    // decision rather than missing data — there is no DOI for Brodmann 1909.
    // This check used to be fatal and refused to load their whole fixture over
    // it, which would have made a legitimate editorial call look like a broken
    // deliverable. The absence is reported by `provenanceGaps()` instead, and
    // what it actually constrains is the UI: a paper with no source link has to
    // say so, rather than rendering a dead one.
    if (!Array.isArray(p.findings) || p.findings.length === 0) problems.push(at(`paper ${p.id} has no findings`));
    for (const fi of p.findings ?? []) {
      if (typeof fi?.id !== 'string' || fi.id === '') { problems.push(at(`paper ${p.id} has a finding with no id`)); continue; }
      if (findingIds.has(fi.id)) problems.push(at(`duplicate finding id ${fi.id}`));
      findingIds.add(fi.id);
      if (typeof fi.evidence !== 'string' || fi.evidence === '') problems.push(at(`finding ${fi.id} has no evidence`));
      if (typeof fi.spatialDetail !== 'boolean') problems.push(at(`finding ${fi.id} must declare spatialDetail explicitly`));
      if (!Array.isArray(fi.regions) || fi.regions.length === 0) problems.push(at(`finding ${fi.id} maps no region`));
      for (const r of fi.regions ?? []) {
        if (!structureIds.has(r)) problems.push(at(`finding ${fi.id} maps unknown region ${JSON.stringify(r)}`));
      }
      if (!Array.isArray(fi.cells)) problems.push(at(`finding ${fi.id} needs a cells array (empty is legal)`));
      for (const cell of fi.cells ?? []) {
        try {
          parse(cell);
        } catch (e) {
          problems.push(at(`finding ${fi.id} cell ${JSON.stringify(cell)} is invalid: ${(e as Error).message}`));
        }
      }
      // `spatialDetail: true` with no cells is the interpolation trap: it looks
      // like spatial data and has none, so nothing would mark it.
      if (fi.spatialDetail && (fi.cells ?? []).length === 0) {
        problems.push(at(`finding ${fi.id} claims spatial detail but lists no cells`));
      }
      if (!fi.spatialDetail && (fi.cells ?? []).length > 0) {
        problems.push(at(`finding ${fi.id} denies spatial detail but lists cells`));
      }
    }
  }
  return problems;
}

/** Load one fixture file. Throws on a shape problem — a broken fixture is not a test result. */
export function loadFixtureFile(path: string): ResearchFixture {
  const text = readFileSync(path, 'utf8');
  const raw = JSON.parse(text) as Record<string, unknown>;
  const problems = fixtureShapeProblems(raw, path);
  if (problems.length > 0) {
    throw new Error(`fixture is not usable:\n  ${problems.join('\n  ')}`);
  }
  return {
    id: raw.id as string,
    nameIndexVersion: raw.nameIndexVersion as string,
    structures: raw.structures as FixtureStructure[],
    papers: raw.papers as FixturePaper[],
    source: {
      path,
      sha256: sha256(text),
      kind: raw.kind === 'synthetic-qa-fixture' ? 'synthetic-qa-fixture' : 'curated',
    },
  };
}

// ---------------------------------------------------------------------------
// Reading DOG-37's curated fixture
// ---------------------------------------------------------------------------

/**
 * DOG-37's research model, adapted to the shape the journey asserts over.
 *
 * Their schema is richer than this harness needs and differently organised:
 * papers carry structured citations rather than a citation string, findings are
 * a top-level array keyed by `paperId` rather than nested, mappings sit between
 * a finding and a structure, and the name index is a separate file. All of that
 * is the right shape for the product — a mapping is exactly where provenance
 * belongs — and none of it is a reason for QA to hold a second copy of the
 * data.
 *
 * So this adapts rather than duplicates, and it is deliberately strict: a shape
 * it does not recognise throws, naming what it found. The alternative is an
 * adapter that quietly produces an empty paper list, which the journey would
 * then report as the build revealing no regions — a product defect raised
 * against a fixture-reading bug.
 *
 * Three spatial kinds, and the third is why this is not a field rename:
 *
 *   region-level  no spatial detail. `spatialDetail: false`, no cells. This is
 *                 the common case in their fixture (17 of 19 mappings) and is
 *                 the one that must render as an explicit marker.
 *   cells         explicit ALC cells, used as given.
 *   coordinates   millimetres in a named frame, which have to be ENCODED to
 *                 cells before anything can be compared. Encoding is where a
 *                 silent downgrade would hide, so a failure here throws.
 */
interface CuratedSpatial {
  kind: string;
  cells?: string[];
  frame?: string;
  pointsMm?: number[][];
  digits?: number;
}

function adaptCurated(research: Record<string, unknown>, names: Record<string, unknown>, paths: {
  research: string;
  names: string;
}): Omit<ResearchFixture, 'source'> {
  const papers = research.papers as Array<Record<string, unknown>> | undefined;
  const findings = research.findings as Array<Record<string, unknown>> | undefined;
  const structures = names.structures as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(papers) || !Array.isArray(findings)) {
    throw new Error(
      `${paths.research}: expected a curated fixture with \`papers\` and a top-level \`findings\` array, `
      + `found keys ${JSON.stringify(Object.keys(research))}. The adapter in packages/atlas-qa/src/fixture.ts `
      + 'needs updating for the new shape rather than guessing at it.',
    );
  }
  if (!Array.isArray(structures)) {
    throw new Error(`${paths.names}: expected \`structures\`, found ${JSON.stringify(Object.keys(names))}`);
  }

  const byPaper = new Map<string, Array<Record<string, unknown>>>();
  for (const f of findings) {
    const paperId = f.paperId as string;
    if (!byPaper.has(paperId)) byPaper.set(paperId, []);
    byPaper.get(paperId)!.push(f);
  }

  const citationOf = (p: Record<string, unknown>): string => {
    const authors = Array.isArray(p.authors) ? (p.authors as string[]) : [];
    const lead = authors.length > 2 ? `${authors[0]} et al.` : authors.join(' and ');
    const id = p.identifier as { kind?: string; value?: string } | undefined;
    return [lead, p.year ? `(${p.year})` : '', p.title, p.venue, id?.value ? `${id.kind}:${id.value}` : '']
      .filter(Boolean)
      .join('. ');
  };

  const cellsOfMapping = (spatial: CuratedSpatial, where: string): { cells: string[]; detail: boolean } => {
    if (spatial.kind === 'region-level') return { cells: [], detail: false };
    if (spatial.kind === 'cells') {
      const cells = spatial.cells ?? [];
      if (cells.length === 0) throw new Error(`${where}: spatial kind "cells" with no cells`);
      return { cells, detail: true };
    }
    if (spatial.kind === 'coordinates') {
      const frame = spatial.frame;
      const points = spatial.pointsMm ?? [];
      const digits = spatial.digits ?? 4;
      if (frame !== 'BV') {
        throw new Error(
          `${where}: coordinates in frame ${JSON.stringify(frame)}. Only BV can be encoded here; `
          + 'extend the adapter rather than dropping the mapping.',
        );
      }
      const brain = templateSet('brain').brainVolume;
      if (!brain) throw new Error(`${where}: no brain template to encode coordinates against`);
      const cells = points.map((p) => encodeBrainVolume(brain, p as [number, number, number], digits).address);
      if (cells.length === 0) throw new Error(`${where}: spatial kind "coordinates" with no points`);
      return { cells, detail: true };
    }
    throw new Error(
      `${where}: unrecognised spatial kind ${JSON.stringify(spatial.kind)}. The harness must not guess `
      + 'whether an unknown kind carries spatial detail — that is the one thing it is here to report.',
    );
  };

  return {
    id: `${(research.version as string) ?? 'curated'}`,
    nameIndexVersion: (names.version as string) ?? 'unversioned',
    structures: structures.map((s) => ({
      id: s.id as string,
      name: s.name as string,
      // Their index does not label an atlas, so it is derived from the frame
      // the cells are addressed in: BD is the body, BV and BR are the brain.
      atlas: ((s.cells as string[]) ?? []).some((c) => c.startsWith('BD-')) ? 'body' : 'brain',
      cells: (s.cells as string[]) ?? [],
    })),
    papers: papers.map((p) => {
      const id = p.id as string;
      return {
        id,
        citation: citationOf(p),
        sourceUrl: (p.sourceUrl as string) ?? '',
        findings: (byPaper.get(id) ?? []).map((f) => {
          const mappings = (f.mappings as Array<Record<string, unknown>>) ?? [];
          const where = `${paths.research}: finding ${f.id as string}`;
          const parts = mappings.map((m) => cellsOfMapping(m.spatial as CuratedSpatial, where));
          return {
            id: f.id as string,
            summary: (f.statement as string) ?? '',
            regions: mappings.map((m) => m.structureId as string),
            cells: [...new Set(parts.flatMap((x) => x.cells))],
            evidence:
              mappings
                .map((m) => (m.evidence as { summary?: string } | undefined)?.summary)
                .filter(Boolean)
                .join(' ') || 'no evidence summary recorded',
            // A finding has spatial detail only if SOME mapping does. A finding
            // whose every mapping is region-level is the marker case.
            spatialDetail: parts.some((x) => x.detail),
          };
        }),
      };
    }),
  };
}

/**
 * The fixture to run against: DOG-37's if it is there, ours otherwise.
 *
 * `preferOwn` exists for the harness's own tests, which must keep asserting
 * against a known input even after the real fixture lands — otherwise the
 * harness's self-tests start failing for reasons that belong to someone else's
 * deliverable, and a red suite stops meaning anything.
 */
export function resolveFixture(options: { preferOwn?: boolean } = {}): ResearchFixture {
  if (!options.preferOwn) {
    const curated = loadCuratedFixture();
    if (curated) return curated;
  }
  return loadFixtureFile(OWN_FIXTURE_PATH);
}

/** DOG-37's fixture pair, or null when it is not there yet. */
export function loadCuratedFixture(): ResearchFixture | null {
  if (!existsSync(RESEARCH_FIXTURE_DIR)) return null;
  const files = readdirSync(RESEARCH_FIXTURE_DIR).filter((f) => f.endsWith('.json'));
  // Selected by content, not by filename order: the directory holds a names
  // index alongside the research data, and picking the alphabetically first
  // file loaded the name index as though it were the papers.
  const researchPath = files
    .map((f) => join(RESEARCH_FIXTURE_DIR, f))
    .find((p) => {
      try {
        return Array.isArray((JSON.parse(readFileSync(p, 'utf8')) as { papers?: unknown }).papers);
      } catch {
        return false;
      }
    });
  const namesPath = files
    .map((f) => join(RESEARCH_FIXTURE_DIR, f))
    .find((p) => {
      try {
        const j = JSON.parse(readFileSync(p, 'utf8')) as { structures?: unknown; papers?: unknown };
        return Array.isArray(j.structures) && !Array.isArray(j.papers);
      } catch {
        return false;
      }
    });
  if (!researchPath || !namesPath) return null;

  const researchText = readFileSync(researchPath, 'utf8');
  const namesText = readFileSync(namesPath, 'utf8');
  const adapted = adaptCurated(
    JSON.parse(researchText) as Record<string, unknown>,
    JSON.parse(namesText) as Record<string, unknown>,
    { research: researchPath, names: namesPath },
  );
  const problems = fixtureShapeProblems(adapted, researchPath);
  if (problems.length > 0) {
    throw new Error(`curated fixture is not usable after adaptation:\n  ${problems.join('\n  ')}`);
  }
  return {
    ...adapted,
    source: {
      path: `${rel(researchPath)} + ${rel(namesPath)}`,
      // Both files, so the pin covers the pair rather than half of it.
      sha256: sha256(`${researchText} ${namesText}`),
      kind: 'curated',
    },
  };
}

function rel(p: string): string {
  return p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
}

/** Requirements this fixture cannot express, as `{ stepId -> reasons }`. */
export function unmetRequirements(fixture: ResearchFixture): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const req of FIXTURE_REQUIREMENTS) {
    if (req.satisfied(fixture)) continue;
    for (const step of req.forSteps) {
      if (!out.has(step)) out.set(step, []);
      out.get(step)!.push(`fixture ${fixture.id} cannot express: ${req.describe}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derived views the journey and the reference viewer both need
// ---------------------------------------------------------------------------

export function paperById(fixture: ResearchFixture, id: string): FixturePaper {
  const p = fixture.papers.find((x) => x.id === id);
  if (!p) throw new Error(`no paper ${id} in fixture ${fixture.id}`);
  return p;
}

export function structureById(fixture: ResearchFixture, id: string): FixtureStructure {
  const s = fixture.structures.find((x) => x.id === id);
  if (!s) throw new Error(`no structure ${id} in fixture ${fixture.id}`);
  return s;
}

/** Every region any finding of this paper maps. The set "reveals all its regions" means. */
export function regionsOfPaper(fixture: ResearchFixture, paperId: string): string[] {
  return [...new Set(paperById(fixture, paperId).findings.flatMap((f) => f.regions))].sort();
}

/** Papers with a finding mapping this region. The browse-by-anatomy list. */
export function papersForRegion(fixture: ResearchFixture, regionId: string): string[] {
  return fixture.papers
    .filter((p) => p.findings.some((f) => f.regions.includes(regionId)))
    .map((p) => p.id);
}

/**
 * A paper's covering: the union over its findings' cells.
 *
 * Built through `covering()` so it is normalised, disjoint and rolled up. The
 * overlap between two papers is the intersection of these, and never a
 * comparison of address strings.
 */
export function coveringOfPaper(fixture: ResearchFixture, paperId: string): Covering {
  return covering(paperById(fixture, paperId).findings.flatMap((f) => f.cells));
}

/** The structure's own covering. */
export function coveringOfStructure(fixture: ResearchFixture, structureId: string): Covering {
  return covering(structureById(fixture, structureId).cells);
}

/**
 * The fixture, as the library's name index.
 *
 * Shared by the reference viewer and by the journey's assertions so that a
 * ranked name list can be checked against what the index actually says rather
 * than against a second hand-maintained copy of it.
 */
export function nameIndexInput(fixture: ResearchFixture): {
  version: string;
  structures: Array<{ id: string; name: string; cells: readonly string[] }>;
} {
  return {
    version: fixture.nameIndexVersion,
    structures: fixture.structures.map((s) => ({ id: s.id, name: s.name, cells: s.cells })),
  };
}

/**
 * A region that is in the fixture and is NOT mapped by the given paper.
 *
 * Used to build the filter-leak case: filter by a region the paper does map,
 * select the paper, and assert the regions it maps outside that filter are
 * still shown. Returning null means the fixture cannot pose the question, which
 * `unmetRequirements` reports as `unverified` rather than as a pass.
 */
export function regionOutsideFilter(fixture: ResearchFixture, paperId: string, filterRegion: string): string | null {
  const mapped = regionsOfPaper(fixture, paperId);
  return mapped.find((r) => r !== filterRegion) ?? null;
}
