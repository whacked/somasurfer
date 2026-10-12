/**
 * Gates the crosswalk and the region index built from it (DOG-130).
 *
 *   node tools/check-crosswalk.mjs            check (CI)
 *   node tools/check-crosswalk.mjs --write    regenerate the committed index
 *
 * The research seed's mappings are resolved onto every registered
 * representation by `buildRegionIndex` (packages/atlas-research), with the
 * brain meshes, the registration and the BD name index read from
 * packages/atlas-assets here, because a code package may not read them itself.
 *
 * Asserted, and able to go red:
 *
 *   1. The crosswalk is well formed, every target is a structure of its
 *      representation (shipped or held), HCP-MMP1 entries are crosswalk, and
 *      every term the seed uses has an entry or a representation keyed by its
 *      scheme.
 *   2. The index meets the acceptance criteria as `checkRegionIndex` states
 *      them: how and precision on every link, no coordinate link labelled
 *      exact-term or claiming less than the registration error, every paper
 *      non-empty or with a stated reason, forward and inverted indexes agree.
 *   3. The locator finds the fitted landmarks inside their own structures.
 *      Every coordinate link rests on it, so it is checked on points whose
 *      answer is known.
 *   4. The committed index is what these inputs produce. A hand edit, or an
 *      input that moved without a regeneration, is drift.
 *   5. The gate can fail: `selfTest()` feeds checks 1 and 2 indexes and
 *      crosswalks broken on purpose, and fails if any passes.
 *   6. Committed floors, not readings: coverage (COVERAGE_FLOOR) and the
 *      coordinate precision (PRECISION_FLOOR_MM, MIN_HELD_OUT).
 *
 * Reported, never counted as a pass: coverage against the v1 baseline, measured
 * the way the baseline was; VACUOUS criteria, which the real data gives nothing
 * to check (0 coordinate links, 0 HCP-MMP1 -> gyrus links today); and
 * UNVERIFIED crosswalk targets, whose representation's data is not on the tree.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { fail, pass, rel } from './lib/repo.mjs';
import { BRAIN, REGION_INDEX_PATH, REGION_INPUT_PATHS as PATHS, loadRegionInputs, readRepoFile } from './lib/region-inputs.mjs';
import { buildNameIndex } from '../packages/alc/src/index.ts';
import {
  buildRegionIndex,
  buildResearchIndex,
  checkRegionIndex,
  serialiseRegionIndex,
  validateCrosswalk,
} from '../packages/atlas-research/src/index.ts';

const INDEX_PATH = REGION_INDEX_PATH;

const bytes = readRepoFile;
const json = (p) => JSON.parse(bytes(p).toString('utf8'));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Committed literals, not readings (CTO review of 4f58f93). A floor taken from
 * the data at gate time compares the data with itself: a refit reporting ±1 mm
 * from two points, or a crosswalk edit that drops every link, would pass.
 *
 * - PRECISION_FLOOR_MM: no coordinate link may claim better than this, whatever
 *   the registration file says. 7 mm is the plan's figure and brainproject's own
 *   held-out error; ours measured 8.55. A refit below it is a finding to review,
 *   not a precision to publish, so the gate stops it.
 * - MIN_HELD_OUT: the held-out landmarks behind that figure. Two today (the red
 *   nucleus, both sides).
 * - COVERAGE_FLOOR: what W5 delivered at review (44 of 170 mappings, 15 of 30
 *   papers by named structure). Raise it when coverage grows; lowering it is a
 *   decision, made in a diff a reviewer reads.
 */
const PRECISION_FLOOR_MM = 7;
const MIN_HELD_OUT = 2;
const COVERAGE_FLOOR = Object.freeze({ mappings: 44, papers: 15 });

/** The v1 figure, measured the way the 31/170 baseline was measured. */
function baseline(inputs) {
  const cov = json(PATHS.coverings);
  const cells = new Map(cov.coverings.map((c) => [c.id, c.cells]));
  const index = buildNameIndex({
    version: inputs.names.version,
    structures: inputs.names.structures.map((s) => ({ ...s, cells: cells.get(s.id) ?? [] })),
  });
  const ri = buildResearchIndex({ dataset: inputs.dataset, names: index, templates: inputs.templates });
  const resolved = ri.mappings.filter((m) => m.resolution === 'resolved');
  const named = resolved.filter((m) => m.structureLabelFromIndex);
  const papers = (xs) => new Set(xs.map((m) => m.paperId)).size;
  return {
    method: 'v1 buildResearchIndex against the BD name index and both templates: a mapping counts when it resolves to cells',
    mappingsResolved: resolved.length,
    papersCovered: papers(resolved),
    mappingsResolvedToANamedStructure: named.length,
    papersWithANamedStructure: papers(named),
  };
}

// ---------------------------------------------------------------------------
// 5. Self-test: the checks go red on broken input
// ---------------------------------------------------------------------------

function selfTest(inputs, index) {
  const failures = [];
  const expectRed = (what, problems, pattern) => {
    if (!problems.some((p) => pattern.test(p))) failures.push(`${what}: not caught (${problems.length} other problem(s)).`);
  };
  // A synthetic index the checks can be pointed at: the real one, with one
  // thing changed per case, so each case proves its own check.
  const withMappings = (mutate) => {
    const mappings = structuredClone(index.mappings.map((o) => ({ ...o, links: [...o.links], unplaced: [...o.unplaced] })));
    mutate(mappings);
    return { ...index, mappings };
  };
  const someLink = index.mappings.flatMap((o) => o.links)[0];
  const registrationMm = inputs.representations.find((r) => r.representation.id === 'zanatomy-gross-anatomy').coordinatePrecision.mm;
  if (!someLink) {
    failures.push('the committed inputs produce no link at all, so the link checks have nothing to break.');
    return failures;
  }
  const placed = {
    ...someLink,
    how: 'exact-term',
    precision: { kind: 'exact' },
    coordinate: { from: 'coordinates', mniMm: [0, 0, 0], depthMm: 1 },
    representation: 'zanatomy-gross-anatomy',
  };
  expectRed(
    'a coordinate link labelled exact-term',
    checkRegionIndex(withMappings((ms) => ms[0].links.push(placed)), inputs.representations),
    /placed coordinate is labelled exact-term/,
  );
  expectRed(
    'a coordinate link tighter than the registration',
    checkRegionIndex(
      // Half the supplied registration's own figure, so the case stays tighter
      // than it whatever the file claims; a fixed 1 mm went inert at ±1 mm.
      withMappings((ms) =>
        ms[0].links.push({ ...placed, how: 'coordinate', precision: { kind: 'mm', mm: registrationMm / 2, basis: 'x' } }),
      ),
      inputs.representations,
    ),
    /tighter than the registration's measured/,
  );
  expectRed(
    'an HCP-MMP1 link labelled exact-term',
    checkRegionIndex(
      // `how` and precision are set here, not inherited: `someLink` is whatever
      // link comes first, and a crosswalk link there made this case inert.
      withMappings((ms) =>
        ms[0].links.push({
          ...someLink,
          how: 'exact-term',
          precision: { kind: 'exact' },
          source: { scheme: 'HCP-MMP1', term: 'HCP-MMP1:V1', label: 'V1' },
        }),
      ),
      inputs.representations,
    ),
    /HCP-MMP1 link labelled exact-term; it must be crosswalk/,
  );
  expectRed(
    'an HCP-MMP1 link that lost the area name',
    checkRegionIndex(
      withMappings((ms) =>
        ms[0].links.push({
          ...someLink,
          how: 'crosswalk',
          precision: { kind: 'approximate', why: 'x' },
          source: { scheme: 'HCP-MMP1', term: 'HCP-MMP1:V1', label: '' },
        }),
      ),
      inputs.representations,
    ),
    /lost the area's own name/,
  );
  expectRed(
    'a mapping with no link and no reason',
    checkRegionIndex(withMappings((ms) => Object.assign(ms[0], { links: [], unplaced: [] })), inputs.representations),
    /no link and no stated reason/,
  );
  const emptyPaper = index.papers.find((p) => p.regions.length === 0) ?? index.papers[0];
  expectRed(
    'a paper with no region and no reason',
    checkRegionIndex(
      { ...index, papers: index.papers.map((p) => (p === emptyPaper ? { ...p, regions: [], emptyBecause: [] } : p)) },
      inputs.representations,
    ),
    /no region and no stated reason/,
  );
  const nonEmpty = index.structures[0];
  expectRed(
    'an inverted index that lost a paper',
    checkRegionIndex(
      { ...index, structures: index.structures.map((s) => (s === nonEmpty ? { ...s, paperIds: s.paperIds.slice(1) } : s)) },
      inputs.representations,
    ),
    /round trip: paper → regions has .* region → papers does not/,
  );

  const cw = (mutate) => {
    const c = structuredClone(inputs.crosswalk);
    mutate(c);
    return validateCrosswalk(c, inputs.representations, inputs.dataset);
  };
  expectRed('an HCP-MMP1 entry claiming exact-term', cw((c) => (c.entries.find((e) => e.term.startsWith('HCP-MMP1:')).how = 'exact-term')), /claims exact-term/);
  expectRed('a misspelt target', cw((c) => (c.entries[0].targets[0].label += ' (sic)')), /is not a structure of zanatomy-gross-anatomy/);
  expectRed('a seed term with no entry', cw((c) => c.entries.shift()), /has no crosswalk entry/);
  expectRed('a crosswalk entry with no reason', cw((c) => delete c.entries.find((e) => e.how === 'crosswalk').why), /says neither why/);
  return failures;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const write = process.argv.includes('--write');
const problems = [];
const report = [];

const inputs = loadRegionInputs();

// 1. Crosswalk.
problems.push(...validateCrosswalk(inputs.crosswalk, inputs.representations, inputs.dataset));

// Targets in a registered representation whose data is not on this tree cannot
// be checked: a misspelt lobe label would pass. Reported UNVERIFIED, by
// representation, never counted as checked and never failed for being absent.
const supplied = new Set(inputs.representations.map((r) => r.representation.id));
const unverified = new Map();
for (const e of inputs.crosswalk.entries) {
  for (const t of e.targets) {
    if (supplied.has(t.representation)) continue;
    const u = unverified.get(t.representation) ?? unverified.set(t.representation, { targets: 0, labels: new Set() }).get(t.representation);
    u.targets += 1;
    u.labels.add(t.label);
  }
}

// The registration's claim, against the committed literals rather than itself.
{
  const claimed = inputs.registration.summary.heldOut.maxMm;
  const n = inputs.registration.heldOut.length;
  if (!(claimed >= PRECISION_FLOOR_MM)) {
    problems.push(
      `precision floor: the registration claims a held-out error of ±${claimed} mm, below the committed floor of ±${PRECISION_FLOOR_MM} mm.`,
      `  Coordinate links would inherit it. Review the refit; lowering PRECISION_FLOOR_MM is a decision, not a regeneration.`,
    );
  }
  if (n < MIN_HELD_OUT) {
    problems.push(`precision floor: the registration's held-out figure rests on ${n} landmark(s); at least ${MIN_HELD_OUT} are required.`);
  }
}

// 3. Locator, on points whose answer is known: each single-structure landmark's
//    MNI centroid. Only the convex ones are required. The caudate's centroid
//    lies in the concavity of its C, outside the nucleus, so "outside" is the
//    right answer there and requiring "inside" would test the anatomy.
const REQUIRED_INSIDE = ['putamen.l', 'putamen.r', 'mammillary-body.l', 'mammillary-body.r'];
const OUTSIDE_THE_HEAD = [0, 0, 200];
if (inputs.locate(OUTSIDE_THE_HEAD).inside.length > 0) {
  problems.push(`locator: MNI (${OUTSIDE_THE_HEAD.join(', ')}), far above the head, is reported inside a structure.`);
}
const byName = new Map(inputs.structures.structures.map((s) => [s.name, String(s.id)]));
const landmarkLines = [];
for (const lm of [...inputs.registration.landmarks, ...inputs.registration.heldOut]) {
  if (lm.meshStructures.length !== 1) continue;
  const own = byName.get(lm.meshStructures[0]);
  const hit = inputs.locate(lm.mniMm);
  const inside = hit.inside.some((h) => h.id === own);
  landmarkLines.push(`${lm.id}${inside ? ' inside' : ' outside'}`);
  if (!inside && REQUIRED_INSIDE.includes(lm.id)) {
    problems.push(`locator: the MNI centroid of landmark ${lm.id} is not inside ${lm.meshStructures[0]}. Every coordinate link rests on this.`);
  }
}

// 2. Index.
const index = buildRegionIndex(inputs);
problems.push(...checkRegionIndex(index, inputs.representations));

const allLinks = index.mappings.flatMap((o) => o.links);
for (const l of allLinks) {
  if (l.how === 'coordinate' && !(l.precision.kind === 'mm' && l.precision.mm >= PRECISION_FLOOR_MM)) {
    problems.push(`precision floor: mapping ${l.mappingId} → ${l.structureName} claims ${JSON.stringify(l.precision)}, below the committed ±${PRECISION_FLOOR_MM} mm.`);
  }
}
if (index.coverage.mappings.linked < COVERAGE_FLOOR.mappings || index.coverage.papers.nonEmpty < COVERAGE_FLOOR.papers) {
  problems.push(
    `coverage floor: ${index.coverage.mappings.linked} of ${index.coverage.mappings.total} mappings and ${index.coverage.papers.nonEmpty} of ${index.coverage.papers.total} papers reach a named structure,`,
    `  below the committed floor of ${COVERAGE_FLOOR.mappings} mappings and ${COVERAGE_FLOOR.papers} papers. A regeneration does not lower it; an edit to COVERAGE_FLOOR does.`,
  );
}

// Criteria the real data cannot exercise. A check over zero links passes by
// construction, so it is reported as vacuous rather than counted as a pass.
const coordinateLinks = allLinks.filter((l) => l.how === 'coordinate').length;
const hcpGyrusLinks = allLinks.filter((l) => l.source.scheme === 'HCP-MMP1' && l.representation === 'zanatomy-gross-anatomy').length;
const vacuous = [
  ...(coordinateLinks === 0
    ? ['0 coordinate links: "no coordinate link is exact-term" and the precision floor have nothing to check on this data']
    : []),
  ...(hcpGyrusLinks === 0
    ? ['0 HCP-MMP1 → gyrus links (every target gyrus is held): "crosswalk, approximate, area name kept" has nothing to check on this data']
    : []),
];

// 5. Self-test, before any result is trusted.
const selfFailures = selfTest(inputs, index);
if (selfFailures.length > 0) {
  fail('crosswalk', ['self-test: the gate cannot go red on:', ...selfFailures.map((f) => `  ${f}`)]);
}

const base = baseline(inputs);
const doc = {
  schema: 'atlas-region-index/1',
  id: `region-index-${BRAIN.id}`,
  comment: [
    'Generated by tools/check-crosswalk.mjs --write. Do not edit; regenerate.',
    'Every curated mapping of the research seed, resolved onto every registered representation',
    '(packages/atlas-research/src/representations.ts) through crosswalk.json, the brain meshes and the',
    'registration. A link records how it was made (exact-term | crosswalk | coordinate) and its precision.',
    'A mapping with no link, and a paper with no region, carry the stated reason. `papers` is paper ->',
    'regions, `structures` is region -> papers; tools/check-crosswalk.mjs asserts they agree.',
  ],
  // The CTO's ruling on DOG-123 (16:04): the region index is joined with BY-SA
  // structure names, so it is derived from asset content and is BY-SA itself.
  licence:
    'CC-BY-SA-4.0: carries brain structure names from structures.json and body names from labels/names.json, both share-alike. ' +
    'Not in payloadDirs, so it does not ship; whoever ships it (W6, under dist/assets/) adds an attribution.json entry citing ' +
    'the sources of those two files, and licence rule 5 refuses it until they do.',
  inputs: Object.fromEntries(Object.entries(PATHS).map(([k, p]) => [k, { file: p, sha256: sha256(bytes(p)) }])),
  baseline: base,
  ...serialiseRegionIndex(index),
};
const text = `${JSON.stringify(doc, null, 1)}\n`;

if (write) {
  writeFileSync(INDEX_PATH, text);
  report.push(`wrote ${rel(INDEX_PATH)} (${text.length} bytes).`);
} else {
  let committed = null;
  try {
    committed = readFileSync(INDEX_PATH, 'utf8');
  } catch {
    problems.push(`${rel(INDEX_PATH)} is missing. Run node tools/check-crosswalk.mjs --write.`);
  }
  if (committed !== null && committed !== text) {
    problems.push(
      `${rel(INDEX_PATH)} does not match what its inputs produce.`,
      `  Edited by hand, or an input moved without a regeneration. Run node tools/check-crosswalk.mjs --write and review the diff.`,
    );
  }
}

if (problems.length > 0) fail('crosswalk', problems);

const c = index.coverage;
const held = index.mappings.filter((o) => o.links.length === 0 && o.unplaced.some((u) => u.code === 'structure-held')).length;
const empty = index.papers.filter((p) => p.regions.length === 0);
pass('crosswalk', [
  `self-test: red on a coordinate link labelled exact-term or tighter than the registration, an HCP-MMP1 link labelled`,
  `  exact-term or without its area name, a mapping or paper with nothing and no reason, a lost inverted entry,`,
  `  and on crosswalks with an exact HCP-MMP1 entry, a misspelt target, a missing term and an unexplained entry.`,
  `locator: ${landmarkLines.join(', ')}; ${REQUIRED_INSIDE.join(', ')} required.`,
  `coverage: ${c.mappings.linked} of ${c.mappings.total} mappings reach a named structure, covering ${c.papers.nonEmpty} of ${c.papers.total} papers.`,
  `  by how: exact-term ${c.mappings.byHow['exact-term']}, crosswalk ${c.mappings.byHow.crosswalk}, coordinate ${c.mappings.byHow.coordinate} (a mapping may count under more than one).`,
  `  baseline (v1, cells): ${base.mappingsResolved} of 170 mappings, ${base.papersCovered} of 30 papers; of those, ${base.mappingsResolvedToANamedStructure} mappings and ${base.papersWithANamedStructure} papers reach a named structure.`,
  `  ${held} mapping(s) reach only held structures. ${empty.length} paper(s) have no region, each with a stated reason: ${empty.map((p) => `${p.paperId} (${[...new Set(p.emptyBecause.map((e) => e.code))].join(', ')})`).join('; ') || 'none'}.`,
  `index: ${rel(INDEX_PATH)} matches its inputs.`,
  `floors (committed): coverage ≥ ${COVERAGE_FLOOR.mappings} of 170 mappings and ≥ ${COVERAGE_FLOOR.papers} of 30 papers, met; coordinate precision ≥ ±${PRECISION_FLOOR_MM} mm from ≥ ${MIN_HELD_OUT} held-out landmarks, met.`,
  ...vacuous.map((v) => `VACUOUS: ${v}. Covered only by region-index.test.ts and this gate's self-test.`),
  ...[...unverified].map(
    ([id, u]) =>
      `UNVERIFIED: ${u.targets} crosswalk target(s) in ${id} (${[...u.labels].sort().join(', ')}): its data is not on this tree, so their labels are unchecked and they resolve to nothing.`,
  ),
]);
