/**
 * Stage-A fixture data, generated at build time from `@gstack/alc` alone.
 *
 * Everything here is derived from our own Apache-2.0 code. No asset package is
 * read, imported or consulted, so nothing in `dist/data/` can carry a
 * share-alike obligation — see `tools/check-licence-separation.mjs`, rule 6.
 *
 * ## These are fixtures, and they say so
 *
 * The templates are synthetic and the structure names are invented. That is
 * fine for stage A — the viewer is built against the template interface, not
 * against one template — but it is only safe if a user can never mistake a
 * fixture for anatomy. So:
 *
 *   - every name index version string contains `fixture` and `synthetic`, and
 *     the viewer displays the version beside every name list it renders;
 *   - every template carries `provenance: 'synthetic'` and a one-line
 *     `caveat` the shell shows in the atlas panel;
 *   - the inadmissible template is labelled `admissible: false` with the reason.
 *
 * ## The template set is chosen to exercise the flags, not to look good
 *
 * `locate()` raises five distinct findings and the viewer has to surface all
 * five distinctly. Four of them need a template that actually produces them,
 * and picking templates that quietly avoid the hard cases is how a UI ships
 * with three of the five paths never once executed:
 *
 *   homology: 'absent'  `anat-adult-p50` realises the fused sacrum as ONE
 *                       addressable level, which is the recommended
 *                       convention, so `S02`-`S05` are reserved grammar with
 *                       no anatomy behind them.
 *   homology: 'variant' `T13`, `L06`, `S06` are recognised count anomalies
 *                       that no template here realises.
 *   folded              `anat-hyperkyphotic-short-wide` is the DOG-9
 *                       counterexample: a template the per-level audit clears
 *                       and which folds anyway. It is shipped deliberately,
 *                       marked inadmissible, because a viewer that has never
 *                       drawn a folded cell has never tested that message.
 *   overPrecise         every template declares `maxUsefulDigits`, so any
 *                       address past it is demoted on screen.
 *
 * `clamped` needs a point outside the modelled body rather than a template, so
 * it comes from a click or a paste, not from here.
 */

import {
  ADULT_HYPERKYPHOTIC_SHORT_WIDE,
  ADULT_P50,
  CHILD_7Y,
  buildAnatomicalBodyTemplate,
} from '../../alc/src/testing/anatomicalTemplates.ts';
import { BRAIN_ADULT, buildBrainTemplate } from '../../alc/src/testing/syntheticTemplates.ts';
import { bodyCellBox, normalizeCovering, parse, turnToClock } from '../../alc/src/index.ts';

export const NAME_INDEX_VERSION = 'fixture-names/0.2-synthetic';
export const RESEARCH_FIXTURE_VERSION = 'fixture-research/0.1-5-papers';

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** Round every float, so the emitted JSON is reproducible and compresses. */
function roundDeep(value, decimals = 4) {
  const f = 10 ** decimals;
  if (typeof value === 'number') return Math.round(value * f) / f + 0;
  if (Array.isArray(value)) return value.map((v) => roundDeep(v, decimals));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v, decimals)]));
  }
  return value;
}

export function buildTemplates() {
  const body = (params, extra) => {
    const template = buildAnatomicalBodyTemplate(params);
    return {
      id: template.id,
      kind: 'body',
      provenance: 'synthetic',
      admissible: true,
      ...extra,
      template: roundDeep({
        id: template.id,
        slabs: template.slabs,
        maxUsefulDigits: template.maxUsefulDigits,
      }),
    };
  };

  const brain = buildBrainTemplate(BRAIN_ADULT);

  return [
    body(ADULT_P50, {
      label: 'Adult, 50th percentile',
      caveat:
        'Synthetic parametric template, not a scan and not a mesh. The fused sacrum is one '
        + 'addressable level, so S02–S05 are reserved grammar with no anatomy behind them.',
      isDefault: true,
    }),
    body(CHILD_7Y, {
      label: 'Child, 7 years',
      caveat:
        'Synthetic parametric template. Shipped so that the viewer is exercised against more '
        + 'than one body: the same address resolves to different millimetres here.',
    }),
    body(ADULT_HYPERKYPHOTIC_SHORT_WIDE, {
      label: 'Hyperkyphotic, short and wide — INADMISSIBLE',
      admissible: false,
      caveat:
        'Deliberately inadmissible. The BD frame folds in this template: upper-thoracic bisector '
        + 'planes fan out anteriorly and claim skin several levels below, which the per-level audit '
        + 'does not catch. Shipped so the folded message is reachable and testable, never as '
        + 'anatomy to read.',
    }),
    {
      id: brain.id,
      kind: 'brainVolume',
      provenance: 'synthetic',
      admissible: true,
      label: 'Adult brain, proportional half-box',
      caveat:
        'Synthetic bounding box on the Talairach proportions, not a parcellated brain. Cells are '
        + 'boxes about the AC, so a BV cell is a true box in millimetres.',
      isDefault: true,
      template: roundDeep({
        id: brain.id,
        acMm: brain.acMm,
        left: brain.left,
        anterior: brain.anterior,
        superior: brain.superior,
        extents: brain.extents,
        maxUsefulDigits: brain.maxUsefulDigits,
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Name index
// ---------------------------------------------------------------------------

/**
 * Levels the fine-grained part of the index names. A subset, deliberately.
 *
 * The index has two layers, and the reason is a measured property of the frame
 * rather than a shortcut.
 *
 * **A slab-shaped structure cannot have a small covering.** The octree digit
 * interleaves all three local axes — one digit splits `u`, `t` and `r` at once
 * — so a complete sibling group is a 2x2x2 block, and any structure shaped like
 * a radial shell cuts through every one of those blocks. `normalizeCovering`
 * therefore has nothing to roll up, and both it and `buildNameIndex` (which
 * re-normalises on construction) are quadratic in the cell count. Sampling
 * every level at two digits produced 15,792 cells and a build that did not
 * finish.
 *
 * So the fine layer is confined to the levels a stage-A demonstration actually
 * needs, at one digit, and a **coarse layer covers every level** with one
 * address each. That is not a gap papered over: a whole-level structure is
 * exactly as true as a fine one, it is what makes every address anywhere
 * resolve to a real hierarchy, and it costs one address instead of a thousand.
 */
const FINE_LEVELS = ['T05', 'T06', 'T07', 'T08', 'T09', 'L01', 'L02'];

/**
 * Granularity the fine predicate is sampled at.
 *
 * One digit, which puts the radial band boundaries exactly on quarters of the
 * spine-to-skin distance: the cell centres a depth half plus one digit can
 * produce are `r = 0.125, 0.375, 0.625, 0.875`, one in each quarter. The bands
 * in `structureAt` are stated on those same quarters, so every band is hit by
 * exactly one sampled shell and no band is silently empty.
 */
const SAMPLE_DIGITS = 1;

const UBERON = 'UBERON-like (fixture)';

/** Every level the body templates realise, for the coarse layer. */
const ALL_LEVELS = [
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07',
  'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12',
  'L01', 'L02', 'L03', 'L04', 'L05',
  'S01',
];

const REGION_OF = { C: 'cervical', T: 'thoracic', L: 'lumbar', S: 'sacral' };
const REGION_NAME = {
  cervical: 'Cervical region',
  thoracic: 'Thoracic region',
  lumbar: 'Lumbar region',
  sacral: 'Sacral region',
};

/**
 * Which structure owns a cell, from its region, its radial band and its clock.
 *
 * A deliberately crude radial model — canal, paraspinal, viscera, wall, skin —
 * sampled at the cell's own centre. It is not anatomy; it is a believable
 * *shape* of anatomy, which is what the viewer needs to be exercised against:
 * several structures overlapping one coarse cell, one structure containing many
 * fine cells, and fractions that do not sum to 1 where nothing is named.
 */
function structureAt(level, clock, r) {
  const region = REGION_OF[level[0]];
  // Clock 12 is the anterior midline and the sector number runs toward the
  // subject's left, so 5-8 is the posterior arc behind the spine.
  const posterior = clock >= 5 && clock <= 8;
  const n = Number(level.slice(1));

  // Band 1, r < 0.25: the column itself.
  if (r < 0.25) {
    return region === 'sacral'
      ? { id: 'FX-sacrum', name: 'Sacrum', source: UBERON }
      : { id: `FX-vertebra-${level}`, name: `${level} vertebra`, source: UBERON };
  }

  // Band 2, 0.25 <= r < 0.5: the tissue immediately around it.
  if (r < 0.5) {
    if (posterior) return { id: 'FX-paraspinal', name: 'Paraspinal musculature', source: UBERON };
    if (region === 'thoracic') return { id: 'FX-mediastinum', name: 'Mediastinum', source: UBERON };
    if (region === 'lumbar') return { id: 'FX-retroperitoneum', name: 'Retroperitoneal space', source: UBERON };
    return { id: 'FX-prevertebral', name: 'Prevertebral space', source: UBERON };
  }

  // Band 3, 0.5 <= r < 0.75: viscera.
  if (r < 0.75) {
    if (posterior) return { id: 'FX-paraspinal', name: 'Paraspinal musculature', source: UBERON };
    if (region === 'thoracic') {
      if (n >= 5 && n <= 8 && (clock === 12 || clock <= 2 || clock === 11)) {
        return { id: 'FX-heart', name: 'Heart', source: UBERON };
      }
      return clock >= 1 && clock <= 4
        ? { id: 'FX-lung-left-lower', name: 'Lower lobe of left lung', source: UBERON }
        : { id: 'FX-lung-right-lower', name: 'Lower lobe of right lung', source: UBERON };
    }
    if (region === 'lumbar') {
      if (n <= 2) {
        return clock >= 1 && clock <= 4
          ? { id: 'FX-kidney-left', name: 'Left kidney', source: UBERON }
          : { id: 'FX-kidney-right', name: 'Right kidney', source: UBERON };
      }
      return { id: 'FX-bowel', name: 'Small intestine', source: UBERON };
    }
    return { id: 'FX-pelvic-viscera', name: 'Pelvic viscera', source: UBERON };
  }

  // Band 4, r >= 0.75: the body wall out to the skin. One band rather than a
  // separate skin shell, because at one digit there is no finer shell to put it
  // in and a band nothing ever lands in would be a lie about coverage.
  if (region === 'thoracic') {
    return posterior
      ? { id: `FX-rib-${n}`, name: `Rib ${n}`, source: UBERON }
      : { id: 'FX-chest-wall', name: 'Chest wall and skin', source: UBERON };
  }
  return { id: 'FX-abdominal-wall', name: 'Abdominal wall and skin', source: UBERON };
}

/**
 * Build the name index input: one entry per structure, with a normalised
 * covering.
 *
 * ## Why the normalisation is per azimuth segment
 *
 * `normalizeCovering` is what makes this shippable at all — it rolls complete
 * sibling groups up to their parent, so a structure filling a whole azimuth
 * segment ships as one address instead of sixty-four. But it is quadratic in
 * its input: the "drop anything already covered by a coarser member" pass is
 * `kept.some(contains)` over every cell, and `contains` parses both operands.
 * Handed one structure's ~4,000 cells it does on the order of 10^7 parses and
 * the build stops being a build.
 *
 * The fix comes from the frame rather than from a faster loop. Two cells in
 * different `(level, clock, depth)` segments differ in an anchor, so neither
 * can contain the other and no roll-up can ever span them — the normaliser's
 * whole job is confined within a segment. So the cells are grouped by segment
 * first and normalised a segment at a time: 64 cells per call instead of 4,000,
 * with the same result.
 *
 * The one thing given up is a roll-up from "all 24 segments of a level" to the
 * bare level address. That needs every segment at once, and it is worth
 * nothing here: no fixture structure fills an entire vertebral level, because
 * the radial bands cut every segment into at least three structures.
 */
export function buildNameIndexInput({ digits = SAMPLE_DIGITS, levels = FINE_LEVELS } = {}) {
  /** structure id -> segment key -> cells in that segment. */
  const bySegment = new Map();
  const metaById = new Map();
  const alphabet = '01234567';

  const walk = (prefix, depth, emit) => {
    if (depth === 0) {
      emit(prefix);
      return;
    }
    for (const d of alphabet) walk(prefix + d, depth - 1, emit);
  };

  for (const level of levels) {
    for (let clock = 1; clock <= 12; clock += 1) {
      for (const half of ['I', 'O']) {
        const anchors = { level, clock, depth: half };
        const segment = `BD-${level}-${String(clock).padStart(2, '0')}${half}`;
        walk('', digits, (suffix) => {
          const box = bodyCellBox(anchors, suffix);
          const r = (box.r[0] + box.r[1]) / 2;
          const t = (box.t[0] + box.t[1]) / 2;
          const structure = structureAt(level, turnToClock(t), r);
          if (!bySegment.has(structure.id)) {
            bySegment.set(structure.id, new Map());
            metaById.set(structure.id, structure);
          }
          const segments = bySegment.get(structure.id);
          if (!segments.has(segment)) segments.set(segment, []);
          // `parse()` validates and canonicalises every generated address, so a
          // bug in the generator is a build failure rather than a bad index.
          segments.get(segment).push(parse(`${segment}-${suffix}`).canonical);
        });
      }
    }
  }

  const fine = [...bySegment.entries()].map(([id, segments]) => ({
    id,
    name: metaById.get(id).name,
    source: metaById.get(id).source,
    cells: [...segments.values()].flatMap((cells) => normalizeCovering(cells)).sort(),
  }));

  // The coarse layer: one structure per level, one per region. Each is a whole
  // vertebral level, so each costs a single address, and together they mean
  // every valid BD address anywhere in the column resolves to a real
  // containment hierarchy instead of an empty list.
  const coarse = [];
  for (const level of ALL_LEVELS) {
    coarse.push({
      id: `FX-level-${level}`,
      name: `${level} vertebral level`,
      source: UBERON,
      cells: [parse(`BD-${level}`).canonical],
    });
  }
  for (const region of ['cervical', 'thoracic', 'lumbar', 'sacral']) {
    coarse.push({
      id: `FX-region-${region}`,
      name: REGION_NAME[region],
      source: UBERON,
      cells: ALL_LEVELS.filter((l) => REGION_OF[l[0]] === region).map(
        (l) => parse(`BD-${l}`).canonical,
      ),
    });
  }

  const structures = [...coarse, ...fine].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { version: NAME_INDEX_VERSION, structures };
}

// ---------------------------------------------------------------------------
// Research fixture: 5 papers
// ---------------------------------------------------------------------------

/**
 * Five papers with mapped findings, for exercising the viewer's highlight seam.
 *
 * This is NOT the research model — that is task 6, and the browse modes,
 * filtering and provenance UI belong to it. What this fixture exists for is the
 * one thing the viewer owns: that a set of coverings can be handed to the
 * renderer as highlight groups and drawn, with per-group colour and per-finding
 * provenance, and that nothing in the viewer's path *filters* a group.
 *
 * One finding deliberately carries no covering. "Region-level only" has to be
 * visible as its own state rather than interpolated into a location, and a
 * fixture with no such row cannot test that.
 */
export function buildResearchFixture() {
  const papers = [
    {
      id: 'FXP-1',
      title: 'Segmental distribution of thoracic paraspinal findings',
      year: 2024,
      venue: 'Fixture Journal of Anatomy',
      url: 'https://example.invalid/fxp-1',
      findings: [
        { id: 'FXP-1-a', label: 'Paraspinal signal change, mid-thoracic', cells: ['BD-T06-06O', 'BD-T07-06O', 'BD-T08-06O'] },
        { id: 'FXP-1-b', label: 'Rib involvement at T07', cells: ['BD-T07-05O', 'BD-T07-07O'] },
      ],
    },
    {
      id: 'FXP-2',
      title: 'Left lower lobe consolidation patterns',
      year: 2023,
      venue: 'Fixture Respiratory Reports',
      url: 'https://example.invalid/fxp-2',
      findings: [
        { id: 'FXP-2-a', label: 'Consolidation, left lower lobe', cells: ['BD-T07-02O', 'BD-T07-03O', 'BD-T08-02O', 'BD-T08-03O'] },
      ],
    },
    {
      id: 'FXP-3',
      title: 'Renal position across lumbar levels',
      year: 2025,
      venue: 'Fixture Urology',
      url: 'https://example.invalid/fxp-3',
      findings: [
        { id: 'FXP-3-a', label: 'Left renal hilum', cells: ['BD-L01-03I', 'BD-L01-03O'] },
        { id: 'FXP-3-b', label: 'Right renal hilum', cells: ['BD-L01-09I', 'BD-L01-09O'] },
      ],
    },
    {
      id: 'FXP-4',
      title: 'A cross-atlas report: thalamic and thoracic co-findings',
      year: 2026,
      venue: 'Fixture Neurology',
      url: 'https://example.invalid/fxp-4',
      findings: [
        { id: 'FXP-4-a', label: 'Left thalamic lesion', cells: ['BV-L-47', 'BV-L-46'] },
        // Same paper, other atlas. The viewer must show both and must not
        // switch atlas to do it.
        { id: 'FXP-4-b', label: 'Thoracic referral pattern', cells: ['BD-T04-12O'] },
      ],
    },
    {
      id: 'FXP-5',
      title: 'Region-level reporting without spatial detail',
      year: 2022,
      venue: 'Fixture Methods',
      url: 'https://example.invalid/fxp-5',
      findings: [
        {
          id: 'FXP-5-a',
          label: 'Thoracic spine, unspecified level',
          cells: [],
          regionOnly: 'Reported as "thoracic spine" with no level or side. Not placed.',
        },
      ],
    },
  ];

  // Validate every cell through parse() at build time, so a typo in a fixture
  // is a build failure rather than a runtime surprise in the viewer.
  for (const paper of papers) {
    for (const finding of paper.findings) {
      finding.cells = finding.cells.map((c) => parse(c).canonical);
    }
  }

  return { version: RESEARCH_FIXTURE_VERSION, papers };
}
