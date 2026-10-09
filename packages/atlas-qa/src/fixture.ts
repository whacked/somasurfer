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
import { covering, parse, type Covering } from '../../alc/src/index.ts';

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
];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
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
    if (typeof p.sourceUrl !== 'string' || p.sourceUrl === '') problems.push(at(`paper ${p.id} has no sourceUrl`));
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

/**
 * The fixture to run against: DOG-37's if it exists, ours otherwise.
 *
 * `preferOwn` exists for the harness's own tests, which must keep asserting
 * against a known input even after the real fixture lands — otherwise the
 * harness's self-tests start failing for reasons that belong to someone else's
 * deliverable.
 */
export function resolveFixture(options: { preferOwn?: boolean } = {}): ResearchFixture {
  if (!options.preferOwn && existsSync(RESEARCH_FIXTURE_DIR)) {
    const candidates = readdirSync(RESEARCH_FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
    if (candidates.length > 0) return loadFixtureFile(join(RESEARCH_FIXTURE_DIR, candidates[0]));
  }
  return loadFixtureFile(OWN_FIXTURE_PATH);
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
