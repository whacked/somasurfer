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

/**
 * Where DOG-37's research data lives, richest first.
 *
 * `data/` holds the curated v1 seed set — 30 papers, 120 findings — and
 * `fixtures/` holds the 5-paper subset the engineers were given early to build
 * against. Both are real; the seed set is simply a better input, and searching
 * only `fixtures/` meant the journey ran against the subset and reported
 * `compare-two-papers` UNVERIFIED, because in the 5-paper subset two papers
 * share a region but never a CELL (12 of its 14 findings are region-level-only,
 * so there is nothing to intersect).
 *
 * Preference order rather than a single path, because which one is "the"
 * dataset is DOG-37's call to change and should not need a change here.
 */
export const RESEARCH_DATA_DIRS = process.env.ATLAS_QA_RESEARCH_DIR
  // One directory, and only this one, when the variable is set.
  //
  // The seam exists for a single must-pass case: that a fixture which will not
  // load exits 2 and prints UNVERIFIED rather than throwing. Proving that needs
  // a BROKEN pair of documents on disk, and the committed ones are not broken —
  // so without a way to point the loader somewhere else the case could only be
  // written as an assertion about the source text of `bin/qa-journey.mjs`,
  // which would pass against a rewrite that reintroduced the crash. It is
  // deliberately one directory rather than a prepend: a test that silently
  // falls through to the real data is a test that proves nothing.
  ? [process.env.ATLAS_QA_RESEARCH_DIR]
  : [
    join(REPO_ROOT, 'packages', 'atlas-research', 'data'),
    join(REPO_ROOT, 'packages', 'atlas-research', 'fixtures'),
  ];
/** Kept as the last entry's alias for callers that want to name the location. */
export const RESEARCH_FIXTURE_DIR = RESEARCH_DATA_DIRS[RESEARCH_DATA_DIRS.length - 1];
export const OWN_FIXTURE_PATH = join(PACKAGE_ROOT, 'fixtures', 'journey-5papers.json');

/**
 * The two halves of the real anatomical name index — the one the PAGE binds.
 *
 * Read as data, by path, and never imported: `packages/atlas-assets` is an
 * asset package under CC-BY-SA and this is a code package. Rule 3 of
 * `tools/check-licence-separation.mjs` forbids the import edge and names the
 * alternative — "fetch it as data at runtime instead" — which is what the
 * shipped page does and what these two paths are. Nothing from here reaches a
 * bundle: `atlas-qa` is a harness and has no `dist/`.
 */
export const ASSET_INDEX_PATHS = {
  names: join(REPO_ROOT, 'packages', 'atlas-assets', 'labels', 'names.json'),
  coverings: join(REPO_ROOT, 'packages', 'atlas-assets', 'labels', 'coverings.json'),
} as const;

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
  /**
   * The structure's covering. **May be empty.**
   *
   * An empty covering is `named here, painted elsewhere` — a real anatomical id
   * and the index's own term, with the geometry in another document. It is a
   * first-class state and not the same as `unknown-structure`:
   * `packages/atlas-research/data/names-seed.json` says so in its own
   * `$comment` ("a crosswalked structure resolves `empty-covering` against THIS
   * index: named, not painted") and `test/seed.test.ts` pins it.
   *
   * What it costs is that the structure cannot be a *click target*: there is no
   * address to select and no cell to draw. Steps needing one report
   * `unverified` naming the structure. See `FIXTURE_REQUIREMENTS`.
   */
  readonly cells: readonly string[];
}

/**
 * The real anatomical name index, joined from the two asset documents.
 *
 * This is the index the shipped page binds, which is why the journey's
 * ranked-name assertions resolve against it rather than against the research
 * dataset's own structure list. The research list is a different index with a
 * different job — it carries the brain parcels findings map to, and on this ref
 * most of their cells are the seed author's deliberately INVENTED placeholders
 * (`names-seed.json` declares `synthetic: true`). Measuring a name result
 * against invented cells and reporting it as a §7 pass is the false green this
 * whole package exists to prevent, so the two indexes are kept apart and the
 * report says which one answered.
 *
 * `null` when the asset package is not in the tree — then there is no real
 * index to bind, the research list is all there is, and `oracle.why` says so.
 */
export interface AnatomyIndex {
  readonly version: string;
  readonly frame: string | null;
  readonly structures: readonly FixtureStructure[];
  readonly source: { readonly names: string; readonly coverings: string; readonly sha256: string };
}

/**
 * Which index answered for what, carried into the report.
 *
 * "The journey passed against the 30-paper corpus" is not a result on its own:
 * a reader has to be able to tell whether the cells it compared were measured
 * from meshes or invented by a seed script. These counts are that.
 */
export interface FixtureOracle {
  /** The document the research structure list came from. */
  readonly researchNames: string;
  /** `names.json + coverings.json`, or null when the asset package is absent. */
  readonly anatomyIndex: string | null;
  /** Research structures whose cells were taken from the real asset index. */
  readonly paintedFromAssets: readonly string[];
  /** Research structures still carrying the synthetic index's invented cells. */
  readonly placeholderCells: readonly string[];
  /** Research structures named here and painted by no index available here. */
  readonly emptyCovering: readonly string[];
  /** Why the real asset index was not bound, when it was not. */
  readonly why: readonly string[];
}

export interface ResearchFixture {
  readonly id: string;
  readonly nameIndexVersion: string;
  readonly structures: readonly FixtureStructure[];
  readonly papers: readonly FixturePaper[];
  /** The real anatomical index, when this tree has one. See `AnatomyIndex`. */
  readonly anatomy: AnatomyIndex | null;
  /** Which index answered for what. See `FixtureOracle`. */
  readonly oracle: FixtureOracle;
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
  /**
   * The specific entities that failed it, appended to the reason.
   *
   * "the fixture cannot express: at least two body structures with a covering"
   * sends a reader to grep the whole dataset. "…: FMA13295, FMA7647 and 12
   * others are named with no covering" sends them to the row in the index. An
   * `unverified` nobody can act on is barely better than a silent pass.
   */
  readonly detail?: (f: ResearchFixture) => string;
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
    describe:
      'at least two body structures WITH A COVERING, one of them the body atlas\'s brain, so a selection '
      + 'and a cross-atlas link both have a target that can actually be clicked. A structure with an empty '
      + 'covering is admissible — named here, painted elsewhere — but it has no address to select and no '
      + 'cell to draw, so it cannot be the target of a selection step',
    satisfied: (f) => f.structures.filter((s) => s.atlas === 'body' && s.cells.length > 0).length >= 2,
    detail: (f) => {
      const empty = f.structures.filter((s) => s.atlas === 'body' && s.cells.length === 0);
      if (empty.length === 0) return `this fixture has ${f.structures.filter((s) => s.atlas === 'body').length} body structures in total`;
      return (
        `${empty.length} body structure(s) are named with an empty covering and so cannot be clicked: `
        + `${empty.slice(0, 6).map((s) => `${s.id} (${s.name})`).join(', ')}`
        + `${empty.length > 6 ? ` and ${empty.length - 6} more` : ''}`
        + `${f.oracle.anatomyIndex === null
          ? '. No real anatomical index is bound in this tree, so nothing could paint them'
          : `. ${f.oracle.anatomyIndex} is bound but does not carry them`}`
      );
    },
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

/** The declared cells of one structure in a raw fixture object. */
function structureCellsOf(raw: Record<string, unknown>, structureId: string): string[] {
  const structures = (raw.structures as Array<Record<string, unknown>>) ?? [];
  const found = structures.find((s) => s.id === structureId);
  return ((found?.cells as string[]) ?? []);
}

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

/**
 * Which index answered, in sentences, for the report.
 *
 * Not a problem list and never fatal. Every line is a limit on what a verdict
 * from this run can be read to mean, which is exactly what has to travel with
 * the verdict: "§7 passed against the 30-paper corpus" and "§7 passed against
 * the 30-paper corpus, with 66 of its 80 structures carrying cells a seed
 * script invented" are different results.
 */
export function oracleNotes(fixture: ResearchFixture): string[] {
  const o = fixture.oracle;
  const notes: string[] = [];
  notes.push(`research structures from ${o.researchNames}`);
  if (o.anatomyIndex === null) {
    notes.push(
      'NO real anatomical index is bound in this tree, so every anatomical name result was checked '
      + 'against the research dataset\'s own structure list and not against the index the page binds'
      + `${o.why.length > 0 ? `: ${o.why.slice(0, 3).join('; ')}` : ''}`,
    );
  } else {
    notes.push(`anatomical names resolved against ${o.anatomyIndex} — the index the page binds`);
    notes.push(`${o.paintedFromAssets.length} research structures painted from that index`);
  }
  if (o.placeholderCells.length > 0) {
    notes.push(
      `${o.placeholderCells.length} research structures carry cells the seed script INVENTED `
      + `(${o.placeholderCells.slice(0, 4).join(', ')}${o.placeholderCells.length > 4 ? ', …' : ''}). `
      + 'A spatial comparison involving one of them is a comparison against a placeholder, not a '
      + 'measurement. There is no real index for their frame to replace them with.',
    );
  }
  if (o.emptyCovering.length > 0) {
    notes.push(
      `${o.emptyCovering.length} research structures are named with an EMPTY covering `
      + `(${o.emptyCovering.slice(0, 4).join(', ')}${o.emptyCovering.length > 4 ? ', …' : ''}) — `
      + 'admissible, but they cannot be a click target and a mapping to one lights nothing.',
    );
  }
  return notes;
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
    // An EMPTY covering is legal; a missing `cells` is not.
    //
    // This check used to require at least one cell, and refused to load the
    // whole 30-paper corpus over the 14 structures that are deliberately
    // cell-less — a real FMA id and the real index's own term, with the
    // geometry in `packages/atlas-assets` under a different licence.
    // `names-seed.json` states the design in its own `$comment` and
    // `packages/atlas-research/test/seed.test.ts` pins it, so what the check
    // reported as a broken fixture was the curation working as specified.
    //
    // The failure mode it was actually guarding against is kept below, where it
    // belongs: EVERY structure empty means the names were loaded without the
    // coverings, and that is still fatal.
    if (!Array.isArray(s.cells)) {
      problems.push(at(`structure ${s.id} needs a cells array (empty is legal: named here, painted elsewhere)`));
    }
    for (const cell of s.cells ?? []) {
      try {
        parse(cell);
      } catch (e) {
        problems.push(at(`structure ${s.id} cell ${JSON.stringify(cell)} is not a valid address: ${(e as Error).message}`));
      }
    }
  }

  // Some structures painted nowhere is the ordinary case. NONE of them painted
  // anywhere is half an index.
  //
  // This is the failure the per-structure cell count used to catch, stated as
  // the thing that is actually wrong. `names.json` carries ids and terms and no
  // cells at all, so a loader handed only that half builds every structure with
  // an empty covering and every mapping resolves `empty-covering` — which reads
  // as "the curation is wrong" when the truth is that the geometry was never
  // loaded. `tools/check-research-dataset.mjs` refuses the same half-index for
  // the same reason. A fixture in that state can pose no spatial question at
  // all, so it is not a test result.
  const anyPainted = (o.structures as FixtureStructure[]).some(
    (s) => Array.isArray(s?.cells) && s.cells.length > 0,
  );
  if (!anyPainted) {
    problems.push(at(
      `not one of ${(o.structures as unknown[]).length} structures has a single cell, so nothing here can `
      + 'be resolved, selected, drawn or intersected. One structure named with an empty covering is the '
      + 'ordinary "named here, painted elsewhere" case; ALL of them means the names were loaded without '
      + 'the coverings, and every row would report `empty-covering` as though the curation were at fault.',
    ));
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
      // A finding without spatial detail MAY still carry cells: a region-level
      // finding localises to a parcel and lights that parcel. What it must not
      // do is carry cells FINER than the regions it names, which would be
      // inventing a locus the paper never reported. That is the interpolation
      // the plan forbids, and it is checked rather than the cell count.
      if (!fi.spatialDetail && (fi.cells ?? []).length > 0) {
        const allowed = new Set((fi.regions ?? []).flatMap((r) => structureCellsOf(o, r)));
        const finer = (fi.cells ?? []).filter((c) => !allowed.has(c));
        if (finer.length > 0) {
          problems.push(at(
            `finding ${fi.id} reports no locus within its region but lights `
            + `${JSON.stringify(finer.slice(0, 3))}, which is not among its regions' own cells. `
            + 'Lighting the region is reporting it; lighting something finer is interpolating.',
          ));
        }
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
  const structures = raw.structures as FixtureStructure[];
  return {
    id: raw.id as string,
    nameIndexVersion: raw.nameIndexVersion as string,
    structures,
    papers: raw.papers as FixturePaper[],
    // A single-document fixture IS its own index: it carries its own cells and
    // the harness's own fixture is the control the self-tests run against, so
    // binding the real asset index here would make those tests depend on
    // another package's deliverable. See `resolveFixture`'s `preferOwn`.
    anatomy: null,
    oracle: {
      researchNames: rel(path),
      anatomyIndex: null,
      paintedFromAssets: [],
      placeholderCells: structures.filter((s) => s.cells.length > 0).map((s) => s.id),
      emptyCovering: structures.filter((s) => s.cells.length === 0).map((s) => s.id),
      why: ['this fixture carries its own cells and is not resolved against an external index'],
    },
    source: {
      path,
      sha256: sha256(text),
      kind: raw.kind === 'synthetic-qa-fixture' ? 'synthetic-qa-fixture' : 'curated',
    },
  };
}

// ---------------------------------------------------------------------------
// The real anatomical index: the join of the two asset documents
// ---------------------------------------------------------------------------

/**
 * Build the real name index from `labels/names.json` + `labels/coverings.json`.
 *
 * **Never throws.** "The asset package is not in this tree" and "the asset
 * index is broken" are different reports, and only the second is a defect;
 * both are returned as `why` so the caller can print them and carry on. A
 * harness that cannot find its oracle must say so, not abort.
 *
 * The join, rather than either half, and the reasoning is
 * `tools/check-research-dataset.mjs`'s verbatim because it is the same trap:
 *
 *   - `coverings.json` alone has no terms, so nothing can be named.
 *   - `names.json` alone has no cells, so every structure resolves
 *     `empty-covering` and the data looks wrong when the loader was wrong.
 *
 * `paths` is injectable so the tests can prove each refusal against documents
 * they construct, rather than against whatever happens to be in the tree.
 */
export function loadAnatomyIndex(
  paths: { names: string; coverings: string } = ASSET_INDEX_PATHS,
): { index: AnatomyIndex; why: readonly string[] } | { index: null; why: readonly string[] } {
  const read = (path: string): { raw: Record<string, unknown>; text: string } | string => {
    if (!existsSync(path)) return `${rel(path)} is not in this tree`;
    try {
      const text = readFileSync(path, 'utf8');
      return { raw: JSON.parse(text) as Record<string, unknown>, text };
    } catch (e) {
      return `${rel(path)}: not readable as JSON (${(e as Error).message})`;
    }
  };

  const names = read(paths.names);
  const coverings = read(paths.coverings);
  const why: string[] = [];
  if (typeof names === 'string') why.push(names);
  if (typeof coverings === 'string') why.push(coverings);
  if (typeof names === 'string' || typeof coverings === 'string') return { index: null, why };

  const version = names.raw.version;
  const indexVersion = coverings.raw.indexVersion;
  if (typeof version !== 'string' || version === '') {
    return { index: null, why: [`${rel(paths.names)}: no \`version\`, so a resolution from it is not reproducible`] };
  }
  if (indexVersion !== version) {
    return {
      index: null,
      why: [
        `${rel(paths.names)} is version ${JSON.stringify(version)} but ${rel(paths.coverings)} declares `
        + `indexVersion ${JSON.stringify(indexVersion)}. Joining them would attach one index's cells to `
        + "another index's terms.",
      ],
    };
  }

  const cellsById = new Map<string, readonly string[]>();
  for (const c of (coverings.raw.coverings as Array<Record<string, unknown>>) ?? []) {
    if (typeof c?.id !== 'string') { why.push(`${rel(paths.coverings)}: a covering entry has no id`); continue; }
    if (cellsById.has(c.id)) why.push(`${rel(paths.coverings)}: duplicate covering for ${c.id}`);
    cellsById.set(c.id, Array.isArray(c.cells) ? (c.cells as string[]) : []);
  }

  const structures: FixtureStructure[] = [];
  const unnamed = new Set(cellsById.keys());
  for (const s of (names.raw.structures as Array<Record<string, unknown>>) ?? []) {
    if (typeof s?.id !== 'string') { why.push(`${rel(paths.names)}: a structure entry has no id`); continue; }
    unnamed.delete(s.id);
    const cells = cellsById.get(s.id);
    if (cells === undefined) {
      why.push(`${rel(paths.names)}: ${s.id} has no covering in ${rel(paths.coverings)}`);
      continue;
    }
    structures.push({ id: s.id, name: s.name as string, atlas: atlasOfCells(cells), cells });
  }
  for (const id of unnamed) {
    why.push(`${rel(paths.coverings)}: covering ${id} has no entry in ${rel(paths.names)}, so nothing can name it`);
  }
  if (why.length > 0) return { index: null, why };
  if (structures.length === 0) {
    return { index: null, why: [`${rel(paths.names)}: joined to no structures at all`] };
  }

  return {
    index: {
      version,
      frame: (coverings.raw.frame as string) ?? null,
      structures,
      source: {
        names: rel(paths.names),
        coverings: rel(paths.coverings),
        // Both documents, so the pin covers the index that actually answered.
        sha256: sha256(`${names.text} ${coverings.text}`),
      },
    },
    why: [],
  };
}

/**
 * Which atlas a covering is in, read off the frame its cells are addressed in.
 *
 * `BD` is the body; `BV` and `BR` are the brain. No cells means the frame
 * cannot be read off the geometry, and the caller decides — see
 * `atlasOfCrosswalk`.
 */
function atlasOfCells(cells: readonly string[]): 'body' | 'brain' {
  return cells.some((c) => c.startsWith('BD-')) ? 'body' : 'brain';
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

/**
 * Which atlas a structure named with no covering belongs to.
 *
 * Only reached when no index available here paints it. `names-seed.json`'s own
 * `$comment` says what these entries are: "CROSSWALKED body structures: a real
 * FMA concept id, the real index's own term, and NO CELLS AT ALL … the cells
 * are derived from the BodyParts3D meshes under CC-BY-SA and stay in
 * packages/atlas-assets". So an `FMA` entry with no cells is a *body* structure
 * whose geometry is in the asset package; everything else synthetic here is a
 * brain parcel.
 *
 * Deriving it from the cells alone — which is all this adapter used to do —
 * filed all fourteen of them under the BRAIN atlas, because `[].some(...)` is
 * false. That is a quieter bug than the crash above it: the journey would have
 * looked for a body target among structures that are the body atlas's.
 */
function atlasOfCrosswalk(source: unknown): 'body' | 'brain' {
  return source === 'FMA' ? 'body' : 'brain';
}

function adaptCurated(research: Record<string, unknown>, names: Record<string, unknown>, paths: {
  research: string;
  names: string;
}, anatomy: AnatomyIndex | null): Omit<ResearchFixture, 'source' | 'anatomy' | 'oracle'> & {
  readonly oracle: Omit<FixtureOracle, 'why'>;
} {
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

  // ---- the join -----------------------------------------------------------
  //
  // The research dataset's index names the structures findings map to; the
  // asset index carries the cells the page paints them with. For the fourteen
  // body structures that appear in both, the asset index is authoritative —
  // those entries exist in the research index precisely BECAUSE their geometry
  // lives in the asset package, and `names-seed.json` ends with the
  // instruction: "Join packages/atlas-assets/labels/{names,coverings}.json to
  // paint them."
  //
  // A structure the asset index does not carry keeps whatever the research
  // index gave it. On this ref that is 66 brain parcels with INVENTED cells and
  // there is no real `BV` index anywhere to replace them with
  // (`docs/asset-licensing.md`: "There is no BV name index"), so this is not a
  // choice between a real and a synthetic oracle for them — it is the only
  // oracle there is, and `oracle.placeholderCells` is how the report says so.
  const painted = new Map<string, FixtureStructure>(
    (anatomy?.structures ?? []).map((s) => [s.id, s]),
  );
  const adaptedStructures: FixtureStructure[] = structures.map((s) => {
    const id = s.id as string;
    const real = painted.get(id);
    const own = (s.cells as string[]) ?? [];
    const cells = real ? real.cells : own;
    return {
      id,
      // The research index's own term is kept even when the asset index paints
      // the structure: it is the term the curator mapped against, and a
      // silently substituted name would make a provenance claim nobody made.
      name: s.name as string,
      atlas: cells.length > 0 ? atlasOfCells(cells) : atlasOfCrosswalk(s.source),
      cells,
    };
  });

  const paintedFromAssets = adaptedStructures.filter((s) => painted.has(s.id)).map((s) => s.id);
  const paintedSet = new Set(paintedFromAssets);
  const oracle = {
    researchNames: rel(paths.names),
    anatomyIndex: anatomy ? `${anatomy.source.names} + ${anatomy.source.coverings}@${anatomy.version}` : null,
    paintedFromAssets,
    // Only a document that declares itself synthetic has placeholder cells. A
    // real research index with real cells is not maligned by this count.
    placeholderCells:
      names.synthetic === true
        ? adaptedStructures.filter((s) => !paintedSet.has(s.id) && s.cells.length > 0).map((s) => s.id)
        : [],
    emptyCovering: adaptedStructures.filter((s) => s.cells.length === 0).map((s) => s.id),
  };

  const structureCells = new Map<string, readonly string[]>(
    adaptedStructures.map((s) => [s.id, s.cells]),
  );

  const cellsOfMapping = (
    spatial: CuratedSpatial,
    structureId: string,
    where: string,
  ): { cells: string[]; detail: boolean } => {
    if (spatial.kind === 'region-level') {
      // A region-level mapping is NOT "no spatial information". DOG-37's own
      // reason field says it exactly: "the parcellation defines the parcel as a
      // whole; no locus within it is reported". So the finding localises to the
      // parcel, and what gets lit is the parcel's own covering — at that
      // precision and no finer.
      //
      // Mapping it to no cells, which this adapter did first, had a
      // consequence worth recording: across the 30-paper seed set it left only
      // 6 papers with any cells and ZERO paper pairs sharing one, so
      // `compare-two-papers` reported UNVERIFIED and the hatching requirement
      // looked untestable against the real data. It was an artefact of the
      // adapter throwing the region away, not a gap in the curation.
      //
      // `detail: false` still, because there is no locus WITHIN the parcel —
      // that is what the marker says, and lighting the parcel is reporting the
      // region, not interpolating a position inside it.
      //
      // Where the parcel's covering is EMPTY — "named here, painted elsewhere",
      // and nothing in this tree paints it — the mapping lights nothing. That
      // is not a downgrade and not an error: the finding still names its
      // region, and `oracle.emptyCovering` names the structures it happened to.
      return { cells: [...(structureCells.get(structureId) ?? [])], detail: false };
    }
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
    structures: adaptedStructures,
    oracle,
    papers: papers.map((p) => {
      const id = p.id as string;
      return {
        id,
        citation: citationOf(p),
        sourceUrl: (p.sourceUrl as string) ?? '',
        findings: (byPaper.get(id) ?? []).map((f) => {
          const mappings = (f.mappings as Array<Record<string, unknown>>) ?? [];
          const where = `${paths.research}: finding ${f.id as string}`;
          const parts = mappings.map((m) =>
            cellsOfMapping(m.spatial as CuratedSpatial, m.structureId as string, where));
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
 *
 * Throws when a fixture is present and unusable. Callers that must produce a
 * verdict rather than a stack trace use `tryResolveFixture`.
 */
export function resolveFixture(options: { preferOwn?: boolean } = {}): ResearchFixture {
  if (!options.preferOwn) {
    const curated = loadCuratedFixture();
    if (curated) return curated;
  }
  return loadFixtureFile(OWN_FIXTURE_PATH);
}

/**
 * `resolveFixture`, as a result rather than an exception.
 *
 * A fixture that will not load is **`UNVERIFIED`, not a failure.** The
 * distinction is the whole point of the third exit code: exit 1 says "something
 * about the product or the harness is wrong", and a fixture this harness cannot
 * read says nothing at all about the product. The uncaught throw this replaces
 * exited 1 from module scope — no report, no rows, and a stack trace where a
 * verdict belongs, which is the one outcome `runner.ts` is built to never
 * produce.
 */
export function tryResolveFixture(
  options: { preferOwn?: boolean } = {},
): { fixture: ResearchFixture; why: readonly string[] } | { fixture: null; why: readonly string[] } {
  try {
    return { fixture: resolveFixture(options), why: [] };
  } catch (e) {
    const error = e as Error;
    return {
      fixture: null,
      why: [
        `the fixture could not be loaded, so nothing was measured: ${error.message}`,
      ],
    };
  }
}

/** DOG-37's data, richest directory first, or null when none of it is there yet. */
export function loadCuratedFixture(): ResearchFixture | null {
  for (const dir of RESEARCH_DATA_DIRS) {
    const loaded = loadCuratedFrom(dir);
    if (loaded) return loaded;
  }
  return null;
}

export function loadCuratedFrom(RESEARCH_FIXTURE_DIR: string): ResearchFixture | null {
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
  // The real anatomical index, when this tree has one. Looked up BEFORE the
  // shape check, because whether a structure has a covering is a fact about the
  // join and not about either document on its own.
  const anatomy = loadAnatomyIndex();
  const adapted = adaptCurated(
    JSON.parse(researchText) as Record<string, unknown>,
    JSON.parse(namesText) as Record<string, unknown>,
    { research: researchPath, names: namesPath },
    anatomy.index,
  );
  const problems = fixtureShapeProblems(adapted, researchPath);
  if (problems.length > 0) {
    throw new Error(`curated fixture is not usable after adaptation:\n  ${problems.join('\n  ')}`);
  }
  return {
    ...adapted,
    anatomy: anatomy.index,
    oracle: { ...adapted.oracle, why: anatomy.why },
    source: {
      path: `${rel(researchPath)} + ${rel(namesPath)}`
        + (anatomy.index ? ` + ${anatomy.index.source.names} + ${anatomy.index.source.coverings}` : ''),
      // Every document that answered, so the pin covers the oracle rather than
      // half of it. A digest over the research pair alone would read the same
      // whether or not the real index painted anything, and two runs with
      // materially different inputs would then claim the same pin.
      sha256: sha256(
        `${researchText} ${namesText} ${anatomy.index?.source.sha256 ?? 'no-anatomy-index'}`,
      ),
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
    const detail = req.detail ? ` — ${req.detail(fixture)}` : '';
    for (const step of req.forSteps) {
      if (!out.has(step)) out.set(step, []);
      out.get(step)!.push(`fixture ${fixture.id} cannot express: ${req.describe}${detail}`);
    }
  }
  return out;
}

/**
 * Structures named here and painted by no index available here.
 *
 * Admissible, and reported: a reader of a §7 result has to be able to tell
 * which structures were in the fixture-but-not-paintable state, because a row
 * that touched one measured a name and not a place.
 */
export function emptyCoveringStructures(fixture: ResearchFixture): readonly FixtureStructure[] {
  return fixture.structures.filter((s) => s.cells.length === 0);
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
 * The index an ANATOMICAL name result must be checked against.
 *
 * The real asset index when the tree has one, because that is the index the
 * page binds and the only one whose cells were measured from geometry; the
 * research dataset's own list otherwise.
 *
 * The two are not interchangeable and using the research list for this was the
 * second half of the loader defect. On the integrated ref the research list is
 * `synthetic: true` with invented cells for every brain parcel, so a ranked
 * name list checked against it would have been compared with a number nobody
 * measured — and it would have *disagreed* with the page, which resolves names
 * against the 57 real structures and knows nothing of the placeholders. Either
 * way the row would have reported on the harness's own index rather than on the
 * build.
 */
export function anatomyIndexInput(fixture: ResearchFixture): {
  version: string;
  structures: Array<{ id: string; name: string; cells: readonly string[] }>;
} {
  if (!fixture.anatomy) return nameIndexInput(fixture);
  return {
    version: fixture.anatomy.version,
    structures: fixture.anatomy.structures.map((s) => ({ id: s.id, name: s.name, cells: s.cells })),
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
