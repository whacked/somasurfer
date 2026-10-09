/**
 * The DOG-1 §7 journey, as an executable suite.
 *
 * DOG-1 §7 states what a v1 user must be able to do, in one sentence and in
 * order: "open the default body view, change visible structures, select a
 * region without leaving the atlas, explicitly open the linked brain atlas,
 * browse region-linked research, select a paper to reveal all its mapped brain
 * regions, compare papers through the agreed display modes, and return to the
 * body." Plan §7 assigns it to QA and plan §8 row 5 makes it task 5's
 * acceptance criterion.
 *
 * Eight steps, in that order, one per clause. Each one carries the clause it
 * encodes so a failure cites the requirement rather than a test name.
 *
 * ## Ordered, stateful, and honest about it
 *
 * This is one session, not eight independent cases: step 8 asserts the body
 * view survived a round trip to the brain atlas, which is only meaningful if
 * steps 2-4 actually happened. So steps declare `dependsOn`, and when a
 * dependency fails its dependents report `unverified` — not `pass`, and not a
 * second failure that reads like an independent defect. A suite that reports
 * eight failures for one broken step buries the one fact worth knowing.
 *
 * ## Targets are derived, not hardcoded
 *
 * The journey picks its structures and papers out of whatever fixture is
 * loaded, by the property each step needs — the region with the most papers,
 * the paper with the most regions. Hardcoding `BA44` and `P-02` would tie the
 * suite to the synthetic fixture and quietly stop testing when DOG-37's real
 * seed dataset replaces it. The chosen targets go in the report, so a result is
 * still reproducible.
 */

import {
  buildNameIndex,
  coveringIntersect,
  coveringsOverlap,
  resolve,
  type Covering,
} from '../../alc/src/index.ts';
import {
  changedFacets,
  facetKey,
  facetsEqual,
  hasMessage,
  messageCodes,
  type Capability,
  type ViewState,
  type ViewerDriver,
} from './contract.ts';
import {
  coveringOfPaper,
  nameIndexInput,
  papersForRegion,
  regionsOfPaper,
  type ResearchFixture,
} from './fixture.ts';

/** Signals a step could not be evaluated. Never a pass, never a failure. */
export class Unverifiable extends Error {}

export function unverifiable(reason: string): never {
  throw new Unverifiable(reason);
}

/**
 * Which fixture entities this run exercised.
 *
 * Computed once per run and printed in the report. "The journey passed" is not
 * reproducible; "the journey passed selecting BODY-STERNUM, researching BA44
 * and comparing P-02 with P-04" is.
 */
export interface JourneyPlan {
  readonly bodyStructureId: string;
  readonly bodyBrainStructureId: string;
  readonly researchRegionId: string;
  readonly multiRegionPaperId: string;
  readonly comparisonPaperId: string;
  readonly regionsOutsideFilter: readonly string[];
}

/**
 * Choose the journey's targets from the fixture.
 *
 * Every choice is "the entity that makes the step non-vacuous", and where no
 * such entity exists the plan cannot be built — which `resolveFixture`'s
 * requirement check has already reported, so this throwing is a bug rather than
 * a result.
 */
export function planJourney(fixture: ResearchFixture): JourneyPlan {
  const bodyStructures = fixture.structures.filter((s) => s.atlas === 'body');
  const brainStructures = fixture.structures.filter((s) => s.atlas === 'brain');
  if (bodyStructures.length === 0) throw new Error(`fixture ${fixture.id} has no body structure`);
  if (brainStructures.length === 0) throw new Error(`fixture ${fixture.id} has no brain structure`);

  // The body atlas's brain, if the fixture names one; otherwise any other body
  // structure, so the cross-atlas step still has a source to act from.
  const bodyBrain =
    bodyStructures.find((s) => /brain/i.test(s.id) || /brain/i.test(s.name)) ?? bodyStructures[0];
  const bodyStructure = bodyStructures.find((s) => s.id !== bodyBrain.id) ?? bodyStructures[0];

  // The brain region with the most papers: browse-by-anatomy on a region with
  // one paper cannot distinguish a filtered list from an unfiltered one.
  const ranked = brainStructures
    .map((s) => ({ id: s.id, papers: papersForRegion(fixture, s.id) }))
    .sort((a, b) => b.papers.length - a.papers.length || a.id.localeCompare(b.id));
  const region = ranked[0];
  if (!region || region.papers.length === 0) {
    throw new Error(`fixture ${fixture.id} has no brain region carrying research`);
  }

  // Of that region's papers, the one mapping the most regions: that is the one
  // whose mappings reach outside the filter.
  const byBreadth = region.papers
    .map((id) => ({ id, regions: regionsOfPaper(fixture, id) }))
    .sort((a, b) => b.regions.length - a.regions.length || a.id.localeCompare(b.id));
  const primary = byBreadth[0];
  const second = byBreadth.find((p) => p.id !== primary.id) ?? byBreadth[0];

  return {
    bodyStructureId: bodyStructure.id,
    bodyBrainStructureId: bodyBrain.id,
    researchRegionId: region.id,
    multiRegionPaperId: primary.id,
    comparisonPaperId: second.id,
    regionsOutsideFilter: primary.regions.filter((r) => r !== region.id),
  };
}

export interface JourneyContext {
  readonly driver: ViewerDriver;
  readonly fixture: ResearchFixture;
  readonly plan: JourneyPlan;
  /** Snapshots earlier steps left for later ones. */
  readonly snapshots: Map<string, ViewState>;
}

export interface JourneyStep {
  readonly id: string;
  /** The DOG-1 §7 clause this step encodes, quoted. */
  readonly clause: string;
  readonly mustPass: boolean;
  readonly requires: readonly Capability[];
  readonly dependsOn: readonly string[];
  /** One sentence in observable terms, as the matrix rows carry. */
  readonly observable: string;
  /** Returns the problems found. Empty means pass. Throws `Unverifiable` to abstain. */
  run(ctx: JourneyContext): Promise<string[]>;
}

/** Collects assertion failures instead of throwing on the first one. */
class Checks {
  readonly problems: string[] = [];

  must(condition: boolean, message: string): void {
    if (!condition) this.problems.push(message);
  }

  /** `expected` and `actual` are rendered, because "layers differ" is not a bug report. */
  equal(actual: unknown, expected: unknown, what: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) this.problems.push(`${what}: expected ${e}, got ${a}`);
  }

  setEqual(actual: readonly string[], expected: readonly string[], what: string): void {
    const a = [...new Set(actual)].sort();
    const e = [...new Set(expected)].sort();
    if (JSON.stringify(a) !== JSON.stringify(e)) {
      const missing = e.filter((x) => !a.includes(x));
      const extra = a.filter((x) => !e.includes(x));
      this.problems.push(
        `${what}: ${missing.length ? `missing ${JSON.stringify(missing)}` : ''}`
        + `${missing.length && extra.length ? '; ' : ''}`
        + `${extra.length ? `unexpected ${JSON.stringify(extra)}` : ''}`
        + ` (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`,
      );
    }
  }
}

/** Every highlight must name a paper and a finding that exist in the fixture. */
function checkProvenance(c: Checks, state: ViewState, fixture: ResearchFixture, what: string): void {
  const findings = new Map(
    fixture.papers.flatMap((p) => p.findings.map((f) => [f.id, p.id] as const)),
  );
  for (const h of state.research.highlights) {
    c.must(h.paperId !== '' && h.findingId !== '', `${what}: a highlight carries no provenance`);
    const owner = findings.get(h.findingId);
    c.must(
      owner !== undefined,
      `${what}: highlight cites finding ${JSON.stringify(h.findingId)}, which is not in the fixture`,
    );
    if (owner !== undefined) {
      c.must(
        owner === h.paperId,
        `${what}: highlight says finding ${h.findingId} belongs to ${h.paperId}, fixture says ${owner}`,
      );
    }
  }
}

/** Cells a paper's highlights actually lit. */
function litCells(state: ViewState, paperId: string): string[] {
  return state.research.highlights.filter((h) => h.paperId === paperId).flatMap((h) => [...h.cells]);
}

export const JOURNEY: readonly JourneyStep[] = [
  // -------------------------------------------------------------------------
  {
    id: 'default-body-view',
    clause: 'a user can open the default body view',
    mustPass: true,
    requires: ['body-atlas'],
    dependsOn: [],
    observable:
      'The app opens in the BODY atlas with at least one visible layer, nothing selected, no address in '
      + 'the URL and no error message. The brain atlas is not entered on load.',
    async run(ctx) {
      const c = new Checks();
      const s = await ctx.driver.open('/');
      c.equal(s.atlas, 'body', 'opening atlas');
      c.must(Object.keys(s.layers).length > 0, 'the default view has no layers at all');
      c.must(
        Object.values(s.layers).some((l) => l.visible),
        'the default view has no visible layer, so there is nothing to look at',
      );
      c.equal(s.selection.address, null, 'default selection address');
      c.equal(s.selection.structureId, null, 'default selected structure');
      c.equal(s.urlAddress, null, 'default URL address');
      c.must(
        !s.messages.some((m) => m.severity === 'error'),
        `the default view shows an error: ${JSON.stringify(messageCodes(s))}`,
      );
      c.must(s.assetsAvailable, 'the default view reports its assets unavailable');
      ctx.snapshots.set('default', s);
      return c.problems;
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'change-layers',
    clause: 'a user can change visible structures',
    mustPass: true,
    requires: ['layers', 'opacity'],
    dependsOn: ['default-body-view'],
    observable:
      'Hiding a layer and halving another\'s opacity changes exactly those layers. The camera does not '
      + 'move, the atlas does not change, and nothing becomes selected — changing what is visible is not '
      + 'a navigation and not a selection.',
    async run(ctx) {
      const c = new Checks();
      const before = await ctx.driver.state();
      const ids = Object.keys(before.layers).sort();
      if (ids.length < 2) {
        unverifiable(
          `the build exposes ${ids.length} layer(s); hiding one and dimming another needs two. `
          + 'This is a gap in the build or in the fixture, not a pass.',
        );
      }
      const [hide, dim] = ids;

      const hidden = await ctx.driver.setLayer(hide, { visible: false });
      c.equal(hidden.layers[hide]?.visible, false, `layer ${hide} after hiding`);
      c.must(
        facetsEqual(before, hidden, ['camera', 'selection', 'atlas']),
        `hiding a layer also changed ${JSON.stringify(changedFacets(before, hidden))}; `
        + 'it must change the layers and nothing else',
      );

      const dimmed = await ctx.driver.setLayer(dim, { opacity: 0.5 });
      c.must(
        Math.abs((dimmed.layers[dim]?.opacity ?? -1) - 0.5) < 1e-9,
        `layer ${dim} opacity: expected 0.5, got ${dimmed.layers[dim]?.opacity}`,
      );
      c.equal(dimmed.layers[hide]?.visible, false, `layer ${hide} must still be hidden after dimming another`);
      c.must(
        facetsEqual(hidden, dimmed, ['camera', 'selection', 'atlas']),
        `changing opacity also changed ${JSON.stringify(changedFacets(hidden, dimmed))}`,
      );
      ctx.snapshots.set('layers-changed', dimmed);
      return c.problems;
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'select-structure-without-leaving-atlas',
    clause: 'a user can select a region without leaving the atlas',
    mustPass: true,
    requires: ['click-select', 'ranked-names'],
    dependsOn: ['default-body-view'],
    observable:
      'Clicking a body structure selects it, shows its ALC address and a RANKED NAME LIST WITH '
      + 'CONTAINMENT FRACTIONS together with the name-index version, draws the cell at its true extent, '
      + 'and puts the address in the URL. The atlas is still the body atlas, and the layer state set by '
      + 'the previous step is untouched.',
    async run(ctx) {
      const c = new Checks();
      const before = await ctx.driver.state();
      const s = await ctx.driver.clickStructure(ctx.plan.bodyStructureId);

      // The clause this step exists for.
      c.equal(s.atlas, 'body', 'atlas after selecting a body structure — selection must never navigate');
      c.equal(s.selection.structureId, ctx.plan.bodyStructureId, 'selected structure');
      c.must(s.selection.address !== null, 'selecting a structure produced no address');
      c.equal(s.urlAddress, s.selection.address, 'the URL must carry the selected address, so the view is linkable');

      // A ranked list with fractions, never one name.
      const names = s.names;
      if (names === null) {
        c.must(false, 'no name list at all after a selection');
      } else {
        c.must(names.length > 0, 'the name list is empty for a selected structure');
        c.must(
          names.every((n) => n.fraction > 0 && n.fraction <= 1),
          `a containment fraction is outside (0, 1]: ${JSON.stringify(names.map((n) => n.fraction))}`,
        );
        const sorted = [...names].sort((a, b) => b.fraction - a.fraction);
        c.equal(
          names.map((n) => n.structureId),
          sorted.map((n) => n.structureId),
          'the name list must be ranked by containment fraction, descending',
        );
        c.must(
          names.every((n) => typeof n.name === 'string' && n.name !== ''),
          'a ranked name has no name',
        );
        // Cross-checked against the library's own index rather than against a
        // second copy of the expectation: the UI's ranking is only right if it
        // agrees with what the name index actually says.
        if (s.selection.address) {
          const index = buildNameIndex(nameIndexInput(ctx.fixture));
          const expected = resolve(s.selection.address, index);
          c.setEqual(
            names.map((n) => n.structureId),
            expected.matches.map((m) => m.structure.id),
            `ranked names for ${s.selection.address} disagree with the name index`,
          );
          c.equal(s.nameIndexVersion, expected.indexVersion, 'displayed name-index version');
          // "Never one name" needs a cell with more than one claimant to mean
          // anything, and the fixture requirement guarantees one exists. Before
          // that requirement was added, every cell in the fixture had exactly
          // one owner and the mutant returning only the top match passed this
          // step — the assertion was live and the input was vacuous.
          if (expected.matches.length >= 2) {
            c.must(
              names.length >= 2,
              `the name index claims ${expected.matches.length} structures overlap `
              + `${s.selection.address} and the panel showed ${names.length}. Names are always a ranked `
              + 'list with fractions, never one name — a cell overlapping several structures that reports '
              + 'one of them has made a choice the data does not support.',
            );
            // The fractions themselves, against the index, per structure.
            //
            // NOT a distinctness check. An earlier version asserted that two
            // displayed fractions could not both be 1.0, on the reasoning that
            // nested structures must differ — and DOG-37's curated fixture has
            // two structures occupying the IDENTICAL cell, where 1.0 and 1.0 is
            // the right answer. Comparing against the index is both stricter
            // and correct: it catches a wrong fraction without inventing a rule
            // about which fractions are possible.
            const expectedFraction = new Map(
              expected.matches.map((m) => [m.structure.id, m.fraction] as const),
            );
            for (const n of names) {
              const want = expectedFraction.get(n.structureId);
              if (want === undefined) continue;
              c.must(
                Math.abs(n.fraction - want) < 1e-9,
                `containment fraction for ${n.structureId}: index says ${want}, panel showed ${n.fraction}`,
              );
            }
          }
        }
      }
      c.must(
        hasMessage(s, 'name_index_version'),
        'the name-index version is not surfaced; a name result that cannot say which index it came from '
        + 'is not reproducible across a parcellation revision',
      );

      // The cell is drawn, at its extent.
      c.must(s.cell !== null, 'no cell was drawn for the selection');
      if (s.cell) {
        c.equal(s.cell.kind, 'extent', 'the cell must be drawn at its true extent, never as a point');
        c.must(
          s.cell.extentMm.every((x) => Number.isFinite(x) && x > 0),
          `the drawn extent is not a positive finite box: ${JSON.stringify(s.cell.extentMm)}`,
        );
      }

      // And the previous step's work survives.
      c.must(
        facetsEqual(before, s, ['layers']),
        `selecting a structure changed the layer state: ${JSON.stringify(changedFacets(before, s))}`,
      );
      ctx.snapshots.set('body-view-before-brain', s);
      return c.problems;
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'explicit-brain-navigation',
    clause: 'a user can explicitly open the linked brain atlas',
    mustPass: true,
    requires: ['cross-atlas-navigation', 'brain-atlas'],
    dependsOn: ['select-structure-without-leaving-atlas'],
    observable:
      'Selecting the body atlas\'s brain does NOT switch atlas — it selects, like any other structure. '
      + 'Only the explicit Open brain atlas action switches, and then the atlas is the brain atlas. The '
      + 'two halves are asserted in that order, because a build that switches on selection would pass '
      + 'the second half alone.',
    async run(ctx) {
      const c = new Checks();
      const selected = await ctx.driver.clickStructure(ctx.plan.bodyBrainStructureId);
      c.equal(
        selected.atlas,
        'body',
        'selecting the brain in the body atlas switched atlas. DOG-1 §2: selection must not automatically '
        + 'navigate to a different atlas',
      );
      c.equal(selected.selection.structureId, ctx.plan.bodyBrainStructureId, 'selected structure');

      const bodyView = await ctx.driver.state();
      ctx.snapshots.set('body-view-before-brain', bodyView);

      const brain = await ctx.driver.openBrainAtlas();
      c.equal(brain.atlas, 'brain', 'atlas after the explicit Open brain atlas action');

      // Then move the camera and change a layer HERE, in the brain atlas.
      //
      // Without this the return trip is a vacuous test: nothing has touched
      // the body view while we were away, so a build that simply navigates
      // back — restoring nothing — passes. The negative control caught exactly
      // that; the mutant that drops the saved view went green. A build holding
      // one camera and one layer set for both atlases is a real and likely
      // implementation, and these two lines are what make the difference
      // between the two designs observable on the way back.
      await ctx.driver.orbit(90);
      const brainLayers = Object.keys(brain.layers);
      if (brainLayers.length > 0) {
        await ctx.driver.setLayer(brainLayers[0], { visible: false, opacity: 0.25 });
      }
      const moved = await ctx.driver.state();
      c.must(
        facetKey(moved.camera) !== facetKey(brain.camera),
        'orbiting in the brain atlas did not move the camera, so the return trip cannot be tested',
      );
      ctx.snapshots.set('brain-view-after-changes', moved);
      return c.problems;
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'region-research',
    clause: 'a user can browse region-linked research',
    mustPass: true,
    requires: ['browse-by-anatomy'],
    dependsOn: ['explicit-brain-navigation'],
    observable:
      'Filtering by a brain region lists exactly the papers the fixture links to that region, in a list '
      + 'that is narrower than the unfiltered one, and nothing is highlighted yet — browsing a list is '
      + 'not selecting a paper.',
    async run(ctx) {
      const c = new Checks();
      const region = ctx.plan.researchRegionId;
      const unfiltered = await ctx.driver.setAnatomyFilter(null);
      const all = [...unfiltered.research.paperList];

      const s = await ctx.driver.setAnatomyFilter(region);
      const expected = papersForRegion(ctx.fixture, region);
      c.setEqual(s.research.paperList, expected, `the paper list for region ${region}`);
      c.equal(s.research.filter, region, 'the active filter');
      c.must(
        expected.length < all.length,
        `filtering by ${region} did not narrow the list (${all.length} papers before, `
        + `${expected.length} expected after). A filter that selects everything cannot show a leak.`,
      );
      c.equal(s.research.selectedPaperIds, [], 'filtering must not select a paper');
      c.equal(s.research.highlights, [], 'filtering must not highlight anything on its own');
      return c.problems;
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'paper-reveals-all-its-regions',
    clause: 'a user can select a paper to reveal all its mapped brain regions',
    mustPass: true,
    requires: ['browse-by-research'],
    dependsOn: ['region-research'],
    observable:
      'Selecting a paper found through one region highlights EVERY region that paper maps, including the '
      + 'ones the active filter excludes. The filter itself does not change — it narrows the paper list, '
      + 'never a selected paper\'s own mappings. Every highlight names its paper and its finding, and a '
      + 'finding with no spatial detail is marked region-level only rather than being given a position.',
    async run(ctx) {
      const c = new Checks();
      const { researchRegionId: region, multiRegionPaperId: paper, regionsOutsideFilter } = ctx.plan;
      if (regionsOutsideFilter.length === 0) {
        unverifiable(
          `the fixture's paper ${paper} maps only ${region}, so "reveals ALL its regions" has nothing to `
          + 'reveal. The requirement is untestable against this fixture, which is not the same as met.',
        );
      }

      const before = await ctx.driver.state();
      const s = await ctx.driver.selectPaper(paper);

      c.equal(s.research.selectedPaperIds, [paper], 'selected papers');
      c.equal(
        s.research.filter,
        before.research.filter,
        'selecting a paper changed the anatomical filter; the filter narrows the LIST, not the mappings',
      );

      // The clause: all of the paper's regions, not only the filtered one.
      const expectedRegions = regionsOfPaper(ctx.fixture, paper);
      const highlightedRegions = new Set<string>();
      const regionCells = new Map<string, string[]>();
      for (const st of ctx.fixture.structures) regionCells.set(st.id, [...st.cells]);
      for (const h of s.research.highlights) {
        const finding = ctx.fixture.papers
          .flatMap((p) => p.findings)
          .find((f) => f.id === h.findingId);
        for (const r of finding?.regions ?? []) highlightedRegions.add(r);
      }
      c.setEqual(
        [...highlightedRegions],
        expectedRegions,
        `the regions revealed by selecting ${paper} (filter was ${JSON.stringify(before.research.filter)})`,
      );
      for (const outside of regionsOutsideFilter) {
        c.must(
          highlightedRegions.has(outside),
          `region ${outside} is mapped by ${paper} but was not revealed — the filter on ${region} leaked `
          + 'into the selected paper\'s own mappings. This is DOG-1 §3, explicitly.',
        );
      }

      checkProvenance(c, s, ctx.fixture, 'selecting a paper');

      // Missing spatial data must be visible, never interpolated.
      const spatialless = ctx.fixture.papers
        .find((p) => p.id === paper)
        ?.findings.filter((f) => !f.spatialDetail) ?? [];
      for (const f of spatialless) {
        const h = s.research.highlights.find((x) => x.findingId === f.id);
        c.must(h !== undefined, `finding ${f.id} has no spatial detail and was dropped rather than marked`);
        if (h) {
          c.equal(h.regionLevelOnly, true, `finding ${f.id} must be marked region-level only`);
          c.equal(h.cells, [], `finding ${f.id} has no spatial detail but was given cells — that is interpolation`);
        }
      }
      if (spatialless.length > 0) {
        c.must(
          hasMessage(s, 'region_level_only'),
          'a finding with no spatial detail is present but the region-level-only marker is not shown',
        );
      }
      ctx.snapshots.set('one-paper-selected', s);
      return c.problems;
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'compare-two-papers',
    clause: 'a user can compare papers through the agreed display modes',
    mustPass: true,
    requires: ['multi-paper-selection'],
    dependsOn: ['paper-reveals-all-its-regions'],
    observable:
      'Adding a second paper keeps the first selected, gives each paper its own colour, and hatches '
      + 'exactly the cells both cover. The overlap is the COVERING INTERSECTION of the two papers — not '
      + 'the set of address strings they have in common — and every highlight still names its finding.',
    async run(ctx) {
      const c = new Checks();
      const { multiRegionPaperId: first, comparisonPaperId: second } = ctx.plan;
      if (first === second) {
        unverifiable(
          'the fixture offers only one paper for the chosen region, so there is no second paper to '
          + 'compare against.',
        );
      }
      const s = await ctx.driver.selectPaper(second, { add: true });

      c.setEqual(s.research.selectedPaperIds, [first, second], 'both papers must stay selected');

      const colours = new Map<string, Set<string>>();
      for (const h of s.research.highlights) {
        if (!colours.has(h.paperId)) colours.set(h.paperId, new Set());
        colours.get(h.paperId)!.add(h.colour);
      }
      for (const [paper, set] of colours) {
        c.must(set.size === 1, `paper ${paper} drew ${set.size} different colours; one colour per paper`);
      }
      const used = [...colours.values()].map((v) => [...v][0]);
      c.must(
        new Set(used).size === used.length,
        `two papers share a colour (${JSON.stringify(used)}); they must be distinguishable`,
      );

      // The overlap, computed the only sanctioned way.
      const ca: Covering = coveringOfPaper(ctx.fixture, first);
      const cb: Covering = coveringOfPaper(ctx.fixture, second);
      const expectedOverlap = coveringIntersect(ca, cb);
      const hatched = [
        ...new Set(s.research.highlights.flatMap((h) => [...h.hatchedCells])),
      ].sort();

      if (expectedOverlap.cells.length === 0) {
        unverifiable(
          `papers ${first} and ${second} do not overlap in this fixture, so hatching has nothing to mark. `
          + 'Pick a fixture whose papers share a region.',
        );
      }
      c.must(
        coveringsOverlap(ca, cb),
        `the fixture says ${first} and ${second} overlap but the covering algebra disagrees`,
      );
      c.setEqual(hatched, [...expectedOverlap.cells], 'the hatched cells must be the covering intersection');

      // Both papers' full mappings are still shown: adding a paper must not
      // narrow the first one's regions.
      c.must(
        litCells(s, first).length > 0,
        `paper ${first} stopped being highlighted when ${second} was added`,
      );
      c.must(litCells(s, second).length > 0, `paper ${second} was selected but highlighted nothing`);
      checkProvenance(c, s, ctx.fixture, 'comparing two papers');

      // And the UI-level equality guard, on the comparison that actually drives
      // the screen. Two addresses in different templates can be the same place
      // with different strings; a build comparing strings gets this wrong.
      const answer = await ctx.driver.samePlaceAcrossSubjects(
        [...expectedOverlap.cells],
        [...expectedOverlap.cells],
        6,
      );
      c.must(
        answer.basis !== 'string-equality',
        `the build answered "same place?" on the basis ${JSON.stringify(answer.basis)}. Addresses are `
        + 'never compared by string equality — spec §6: at a 5 mm residual the strings agree 4% of the '
        + 'time while the cells are 5.9 mm apart.',
      );
      return c.problems;
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'return-to-body-with-previous-view-intact',
    clause: 'a user can return to the body',
    mustPass: true,
    requires: ['cross-atlas-navigation', 'view-restore'],
    dependsOn: ['explicit-brain-navigation'],
    observable:
      'Returning to the body atlas restores the camera, the layer visibility and opacity, the isolate and '
      + 'label state and the selection exactly as they were before the brain atlas was opened. "Preserve '
      + 'the previous view" is a claim about every one of those, not only about the camera.',
    async run(ctx) {
      const c = new Checks();
      const before = ctx.snapshots.get('body-view-before-brain');
      if (!before) {
        unverifiable('no body-atlas snapshot was taken, so there is nothing to compare the restored view to');
      }
      const s = await ctx.driver.returnToBody();
      c.equal(s.atlas, 'body', 'atlas after returning');

      for (const facet of ['camera', 'layers', 'isolated', 'labels', 'selection'] as const) {
        c.must(
          facetsEqual(before, s, [facet]),
          `${facet} was not restored on returning to the body atlas. `
          + `Changed facets: ${JSON.stringify(changedFacets(before, s))}`,
        );
      }
      // The round trip must also leave the view linkable: the URL has to carry
      // the restored address, or the restored view cannot be shared.
      c.equal(s.urlAddress, before.urlAddress, 'the URL address after the round trip');
      return c.problems;
    },
  },
];

export const JOURNEY_STEP_IDS: readonly string[] = JOURNEY.map((s) => s.id);

/**
 * Problems with the journey as authored.
 *
 * The same idea as `matrixIntegrityProblems`: the enumeration is the artefact,
 * so losing a clause has to break a gate rather than shrink the suite.
 */
export function journeyIntegrityProblems(steps: readonly JourneyStep[] = JOURNEY): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) problems.push(`duplicate step id ${s.id}`);
    ids.add(s.id);
    if ((s.observable?.trim().length ?? 0) < 40) {
      problems.push(`step ${s.id}: observable behaviour is not stated`);
    }
    if ((s.clause?.trim().length ?? 0) < 10) problems.push(`step ${s.id}: does not cite its DOG-1 §7 clause`);
    for (const dep of s.dependsOn) {
      if (!ids.has(dep)) {
        problems.push(`step ${s.id} depends on ${dep}, which is not an EARLIER step — the journey is ordered`);
      }
    }
  }

  // The eight clauses of DOG-1 §7, by the step that must encode each. A step
  // deleted here is a clause stopped being tested.
  const required = [
    'default-body-view',
    'change-layers',
    'select-structure-without-leaving-atlas',
    'explicit-brain-navigation',
    'region-research',
    'paper-reveals-all-its-regions',
    'compare-two-papers',
    'return-to-body-with-previous-view-intact',
  ];
  for (const id of required) {
    if (!ids.has(id)) problems.push(`DOG-1 §7 clause has no step: ${id}`);
  }
  for (const s of steps) {
    if (required.includes(s.id) && !s.mustPass) {
      problems.push(`step ${s.id} encodes a DOG-1 §7 clause and must be must-pass`);
    }
  }
  return problems;
}
