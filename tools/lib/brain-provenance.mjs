/**
 * Structure → material → source, for every structure in the pinned brain.glb.
 *
 * This is the generated manifest docs/asset-licensing.md §7.3 asks W2 for. It
 * exists because a citation in attribution.json is otherwise self-declared: an
 * entry that cites only cleared sources while its file carries a held structure
 * would be green. With this, the licence gate (rule 10) reads which structures a
 * file actually contains and checks each one's sources here.
 *
 * The rules are §7.3's, and they are applied as written:
 *
 *   - Material names are a NEGATIVE filter. A structure carrying `Brain`,
 *     `Brain-Inner` or `White matter`, or carrying `Temporal lobe` and nothing
 *     else, goes to `zanatomy-undeclared-brain-materials`. `Nerve` goes to
 *     `dundee-cranial-nerves`.
 *   - A structure is not cleared merely for avoiding those. The materials that
 *     read as Z-Anatomy's own BodyParts3D-derived systems are listed positively
 *     below; a material on neither list stops the build instead of defaulting
 *     either way.
 *   - A structure with no material is imaging-registered, and its `bx_source`
 *     names the atlas. A source string this file does not know also stops the
 *     build. A registered structure that partitions a Z-Anatomy mesh
 *     (`bx_parent`) cites Z-Anatomy and BodyParts3D as well, because its surface
 *     is theirs and only the cut is the atlas's.
 */

import { ORIGIN_TEST, originPasses } from './origin-test.mjs';
import { CONTAINMENT, outsideCortex } from './brain-cortex-containment.mjs';

/** Held: the materials of the two models Z-Anatomy lists with no licence. */
export const UNDECLARED_MATERIALS = new Set(['Brain', 'Brain-Inner', 'White matter']);

/** Held when it is a structure's only material: elsewhere it appears only on the undeclared cortex. */
export const TEMPORAL_LOBE_ONLY = 'Temporal lobe';

/** Unverified: Dundee CAHID cranial nerves. */
export const NERVE_MATERIAL = 'Nerve';

/**
 * Cleared by inference: Z-Anatomy's own systems, built on BodyParts3D. §7.3 says
 * plainly that this is an inference from names and not a record of provenance;
 * the manifest carries that sentence on every structure it applies to.
 */
export const OWN_SYSTEM_MATERIALS = new Set([
  'Artery',
  'Cartilage',
  'Nucleus',
  'Nucleus (efferent fibers)',
  'Nucleus (afferent fibers)',
  'LCR',
  'Cerebellum',
  'Bone-4',
]);

/** brainproject's `bx_source` strings → `upstreamSources` ids. */
export const REGISTERED_SOURCES = new Map([
  ['CIT168 (Pauli 2018)', 'cit168-subcortical'],
  ['CIT168 amygdala (Tyszka 2016)', 'cit168-amygdala'],
  ['Najdenovska 2018', 'najdenovska-thalamus'],
  ['Neudorfer 2020', 'neudorfer-hypothalamus'],
  ['HCP1065 (Yeh 2022, CC BY-SA 4.0)', 'hcp1065-yeh2022'],
]);

export const ZANATOMY_SOURCE_STRING = 'Z-Anatomy / BodyParts3D';

/** Every structure in a decoded glb draws on these, whatever else it cites. */
const CONTAINER = ['brainproject-brain-glb'];
const ZANATOMY = ['zanatomy', 'bodyparts3d'];

export const GROUPS = {
  cleared: 'cleared',
  undeclared: 'zanatomy-undeclared-brain-materials',
  nerves: 'dundee-cranial-nerves',
  decision: 'held-by-decision',
  outsideCortex: 'held-outside-cortex',
};

/**
 * Classify one structure. `materials` is the sorted set of material names on
 * its primitives; an empty list means none.
 */
export function classifyStructure({ name, extras, materials }) {
  const mats = [...new Set(materials.filter((m) => m !== null))].sort();
  const reasons = [];
  let group = GROUPS.cleared;
  const sources = new Set(CONTAINER);

  if (mats.includes(NERVE_MATERIAL)) {
    group = GROUPS.nerves;
    sources.add('dundee-cranial-nerves');
    reasons.push('carries the `Nerve` material (Dundee CAHID cranial nerves, unverified)');
  }
  const undeclared = mats.filter((m) => UNDECLARED_MATERIALS.has(m));
  if (undeclared.length > 0) {
    group = group === GROUPS.cleared ? GROUPS.undeclared : group;
    sources.add('zanatomy-undeclared-brain-materials');
    reasons.push(`carries undeclared material(s) ${undeclared.map((m) => `\`${m}\``).join(', ')}`);
  }
  if (mats.length === 1 && mats[0] === TEMPORAL_LOBE_ONLY) {
    group = group === GROUPS.cleared ? GROUPS.undeclared : group;
    sources.add('zanatomy-undeclared-brain-materials');
    reasons.push('carries only `Temporal lobe`, which appears otherwise only on the undeclared cortex; held fail-closed');
  }

  const unknown = mats.filter(
    (m) => !UNDECLARED_MATERIALS.has(m) && !OWN_SYSTEM_MATERIALS.has(m) && m !== NERVE_MATERIAL && m !== TEMPORAL_LOBE_ONLY,
  );
  if (unknown.length > 0) {
    throw new Error(
      `${name}: material(s) ${unknown.join(', ')} are on neither list in tools/lib/brain-provenance.mjs.\n`
        + 'Decide which, from docs/asset-licensing.md §7.3, before building. A material nobody has read is not cleared.',
    );
  }

  let basis;
  if (mats.length === 0) {
    const atlas = REGISTERED_SOURCES.get(extras.bx_source);
    if (!atlas) {
      throw new Error(
        `${name}: no material and bx_source ${JSON.stringify(extras.bx_source)}, which is not a known registered atlas.\n`
          + 'An imaging-registered structure is cleared by its atlas; one with no recognised atlas is not cleared.',
      );
    }
    sources.add(atlas);
    if (extras.bx_parent !== undefined) {
      for (const s of ZANATOMY) sources.add(s);
      basis = `imaging-registered: a partition of Z-Anatomy's \`${extras.bx_parent}\` mesh by ${atlas}`;
    } else {
      basis = `imaging-registered: generated from ${atlas}`;
    }
  } else {
    if (extras.bx_source !== ZANATOMY_SOURCE_STRING) {
      throw new Error(`${name}: has materials but bx_source ${JSON.stringify(extras.bx_source)}; expected Z-Anatomy`);
    }
    for (const s of ZANATOMY) sources.add(s);
    basis = group === GROUPS.cleared
      ? 'Z-Anatomy own system, cleared BY INFERENCE from its material names (docs/asset-licensing.md §7.3)'
      : 'Z-Anatomy';
  }

  return {
    id: extras.bx_id,
    name,
    label: extras.bx_label,
    category: extras.bx_cat,
    side: extras.bx_side,
    // Recorded so CI can classify this structure again from the manifest alone
    // (verifyProvenance); without them the inputs of the decision are not here.
    bxSource: extras.bx_source ?? null,
    bxParent: extras.bx_parent ?? null,
    materials: mats,
    group,
    sources: [...sources].sort(),
    basis,
    ...(reasons.length > 0 ? { heldBecause: reasons } : {}),
  };
}

/**
 * Held structures whose standing a measurement changed. Read from the committed
 * result of the pre-registered origin test (docs/brain-origin-test.md), never
 * written by hand:
 *
 *   - a structure the test CLEARED ships from brain.glb as it is, and cites the
 *     source it was shown to be;
 *   - a structure the test did not clear but the CTO routed to a replacement
 *     (2026-10-11 18:32) ships the replacement's geometry instead, and cites
 *     only the replacement's source, since none of the glb's surface remains.
 */
export const REPLACEMENTS = Object.freeze({
  'Corpus callosum': { source: 'bodyparts3d', concept: 'FMA86464', route: 'CTO decision on DOG-127, 2026-10-11 18:32' },
});

/**
 * Re-judge the committed origin result rather than take its verdicts as given.
 * A hand-edited `clears` list, a `passes: true` on a row whose numbers fail, or
 * a control that no longer discriminates all throw: the result file is the only
 * input of a clearance, so an inconsistent one stops the build and the gate
 * alike instead of clearing anything.
 */
export function judgeOriginResult(result) {
  const controls = result.structures.map((r) => originPasses(r.control));
  const share = controls.filter(Boolean).length / controls.length;
  const discriminates = controls.length > 0 && share <= ORIGIN_TEST.maxNegativeControlPassShare;
  const clears = discriminates
    ? result.structures.filter((r) => r.role === 'held-out' && originPasses(r.matched)).map((r) => r.name)
    : [];
  const recorded = [...result.result.clears].sort();
  if (JSON.stringify(recorded) !== JSON.stringify([...clears].sort())) {
    throw new Error(
      `the origin result clears ${JSON.stringify(recorded)}, but its own figures under the pre-registered thresholds clear ${JSON.stringify(clears)}`
        + ` (negative control ${controls.filter(Boolean).length} of ${controls.length} passing, ${discriminates ? 'discriminating' : 'NOT discriminating'}).`,
    );
  }
  if (result.negativeControl?.discriminates !== discriminates) {
    throw new Error(`the origin result records discriminates: ${result.negativeControl?.discriminates}; its control rows say ${discriminates}.`);
  }
  return new Set(clears);
}

export function applyOriginResult(structure, result) {
  const name = structure.name.trim();
  const row = result.structures.find((r) => r.name === name && r.role === 'held-out');
  if (!row) return structure;
  const evidence = `packages/atlas-assets/provenance/origin-test-bodyparts3d.json: mean ${row.matched.meanSymmetricMm} mm, p95 ${row.matched.p95Mm} mm, label agreement ${row.matched.labelAgreement}`;
  if (judgeOriginResult(result).has(name)) {
    return {
      ...structure,
      group: GROUPS.cleared,
      sources: [...new Set([...structure.sources.filter((x) => x !== 'zanatomy-undeclared-brain-materials'), 'bodyparts3d'])].sort(),
      basis: `held for its material, then shown by the pre-registered origin test to be BodyParts3D's own mesh (${evidence})`,
      shipsFrom: 'brain.glb',
      formerlyHeldBecause: structure.heldBecause,
      heldBecause: undefined,
    };
  }
  const replacement = REPLACEMENTS[name];
  if (replacement) {
    return {
      ...structure,
      group: GROUPS.cleared,
      sources: [replacement.source],
      basis: `the glb's version failed the origin test (${evidence}); replaced by ${replacement.source} ${replacement.concept}, registered into the mesh frame (${replacement.route})`,
      shipsFrom: `${replacement.source} ${replacement.concept}`,
      formerlyHeldBecause: structure.heldBecause,
      heldBecause: undefined,
    };
  }
  return structure;
}

/**
 * Structures the material rules clear but a decision holds. Each is held by its
 * exact name with the decision cited, so the hold is visible in the manifest
 * and nothing about it is inferred:
 *
 *   - the four colliculi cleared only by the `Nucleus` material inference, and
 *     the origin test found they are not BodyParts3D's meshes (p95 ~9.6 mm as
 *     fit structures). An unsettled source does not ship.
 */
const COLLICULI_HOLD = Object.freeze({
  route: 'CTO decision on DOG-127, 2026-10-11 19:54: colliculi (b), hold them fail-closed',
  reason: 'cleared only by the material-name inference, which the origin test contradicted: not BodyParts3D\'s mesh (docs/brain-origin-test.md); source unsettled, held fail-closed',
});
/**
 *   - the tentorium, which the cortex containment rule cannot flag: it lies under
 *     the cortex, but ends at MNI y = -80.5 while the occipital lobes it should
 *     carry run back to -107. The falx it joins is held by the rule.
 */
const TENTORIUM_HOLD = Object.freeze({
  route: 'CTO decision on DOG-238, 2026-10-18: hold the dura until it is registered to the ICBM brain',
  reason: 'not registered to the ICBM cortex: under it, but 26 mm short of the occipital pole it should carry (back edge MNI y -80.5 against -107)',
});
/**
 *   - the orbitofrontal branches of the ACA, which the rule cannot flag either:
 *     displaced downward, they hang under the frontal lobe, in the orbit, not
 *     on its orbital surface. Found in review (DOG-240).
 */
const ORBITOFRONTAL_HOLD = Object.freeze({
  route: 'CTO decision on DOG-238, 2026-10-18, from DOG-240 review finding 1',
  reason: 'not registered to the ICBM cortex: under it, but 8-13 mm below the orbital surface of the frontal lobe it runs on (median 8 mm, max 13 mm; excused by the containment rule as under the cortex)',
});
export const DECISION_HOLDS = Object.freeze({
  'Inferior colliculus.l': COLLICULI_HOLD,
  'Inferior colliculus.r': COLLICULI_HOLD,
  'Superior colliculus.l': COLLICULI_HOLD,
  'Superior colliculus.r': COLLICULI_HOLD,
  'Tentorium cerebelli.l': TENTORIUM_HOLD,
  'Tentorium cerebelli.r': TENTORIUM_HOLD,
  'Orbitofrontal branches of anterior cerebral artery.l': ORBITOFRONTAL_HOLD,
  'Orbitofrontal branches of anterior cerebral artery.r': ORBITOFRONTAL_HOLD,
});

export function applyDecisionHold(structure) {
  const hold = DECISION_HOLDS[structure.name.trim()];
  if (!hold || structure.group !== GROUPS.cleared) return structure;
  return {
    ...structure,
    group: GROUPS.decision,
    heldBecause: [`${hold.reason} (${hold.route})`],
  };
}

/**
 * Held for lying outside the ICBM cortex it is drawn with (DOG-238), read from
 * the committed containment result (tools/lib/brain-cortex-containment.mjs).
 * The verdict is re-judged from the row's figure here, never read from a flag,
 * and a structure that would ship with no row is an error: unmeasured is not
 * contained.
 */
export function applyContainmentHold(structure, containment) {
  if (structure.group !== GROUPS.cleared) return structure;
  const row = containment.structures.find((r) => r.id === structure.id);
  if (!row) throw new Error(`${structure.name.trim()} (id ${structure.id}) would ship, but the cortex containment result has no row for it.`);
  if (!outsideCortex(row)) return structure;
  return {
    ...structure,
    group: GROUPS.outsideCortex,
    heldBecause: [`not registered to the ICBM cortex: lies outside it, ${row.beyondMaxMm} mm at most, past the ${CONTAINMENT.toleranceMm} mm tolerance (docs/brain-mesh-report.md)`],
  };
}

/**
 * One structure, start to finish: the material rules, then the measurement,
 * then any decision, then the cortex containment. `containment` null is the
 * build's first pass, which decides what to measure.
 */
function decide(classified, originResult, containment) {
  let s = { shipsFrom: 'brain.glb', ...classified };
  if (originResult) s = applyOriginResult(s, originResult);
  s = applyDecisionHold(s);
  if (containment) s = applyContainmentHold(s, containment);
  return JSON.parse(JSON.stringify(s));
}

/** The whole manifest, from decoded nodes, plus counts per group. */
export function buildProvenance(nodes, originResult = null, containment = null) {
  const names = new Set(nodes.map((n) => n.name.trim()));
  const unmatched = Object.keys(DECISION_HOLDS).filter((n) => !names.has(n));
  if (unmatched.length > 0) throw new Error(`DECISION_HOLDS names ${unmatched.join(', ')}, which the glb does not contain; a hold that matches nothing holds nothing.`);
  const structures = nodes
    .map((n) => decide(classifyStructure({ name: n.name, extras: n.extras, materials: n.parts.map((p) => p.material) }), originResult, containment))
    .sort((a, b) => a.id - b.id);
  return { structures, ...countGroups(structures) };
}

function countGroups(structures) {
  const counts = {};
  for (const s of structures) counts[s.group] = (counts[s.group] ?? 0) + 1;
  const cortical = structures.filter((s) => s.category === 'cortex');
  return { counts, corticalHeld: cortical.filter((s) => s.group !== GROUPS.cleared).length, cortical: cortical.length };
}

/**
 * Check a committed manifest without the glb: classify every record again from
 * the inputs it records (name, ids, materials, bx_source/bx_parent), apply the
 * committed origin result, the decision holds and the committed cortex
 * containment result, and require the manifest to be exactly that. A record hand-edited to `cleared`, a source dropped, a count
 * nudged: each is a difference here.
 *
 * What this cannot check is the recorded inputs themselves: that a structure's
 * materials really are what the manifest says, and that its geometry is the
 * glb's. Both need the glb, which is not in the repository.
 *
 * Returns a list of problems; empty means the manifest is what the rules give.
 */
export function verifyProvenance(manifest, originResult, containment) {
  const problems = [];
  if (!containment) return ['there is no cortex containment result to re-derive the manifest with.'];
  let rebuilt;
  try {
    rebuilt = manifest.structures.map((rec) => decide(classifyStructure({
      name: rec.name,
      extras: {
        bx_id: rec.id,
        bx_label: rec.label,
        bx_cat: rec.category,
        bx_side: rec.side,
        bx_source: rec.bxSource ?? undefined,
        ...(rec.bxParent != null ? { bx_parent: rec.bxParent } : {}),
      },
      materials: rec.materials ?? [],
    }), originResult, containment));
  } catch (err) {
    return [`the provenance manifest does not re-derive: ${err.message}`];
  }
  const names = new Set(manifest.structures.map((s) => s.name.trim()));
  // Every row is a structure the decisions left to ship: one measured for
  // nothing is a stale result, and it would hide a hold that moved.
  const candidates = new Set(rebuilt.filter((s) => s.group === GROUPS.cleared || s.group === GROUPS.outsideCortex).map((s) => s.id));
  for (const r of containment.structures) {
    if (!candidates.has(r.id)) problems.push(`the cortex containment result measures ${r.name} (id ${r.id}), which is not a structure the earlier rules leave to ship.`);
  }
  for (const n of Object.keys(DECISION_HOLDS)) {
    if (!names.has(n)) problems.push(`DECISION_HOLDS names ${n}, which the provenance manifest does not list.`);
  }
  manifest.structures.forEach((rec, i) => {
    const want = rebuilt[i];
    const fields = [...new Set([...Object.keys(rec), ...Object.keys(want)])]
      .filter((k) => JSON.stringify(rec[k]) !== JSON.stringify(want[k]));
    if (fields.length > 0) {
      problems.push(`${rec.name.trim()} (id ${rec.id}): the manifest records ${fields.map((k) => `${k} ${JSON.stringify(rec[k])}`).join(', ')};`
        + ` re-deriving it under §7.3, the origin result, the decision holds and the cortex containment gives ${fields.map((k) => JSON.stringify(want[k])).join(', ')}.`);
    }
  });
  const { counts, cortical, corticalHeld } = countGroups(rebuilt);
  const wantCounts = { ...counts, cortical, corticalHeld };
  if (JSON.stringify(manifest.counts) !== JSON.stringify(wantCounts)) {
    problems.push(`the provenance manifest counts ${JSON.stringify(manifest.counts)}; its records give ${JSON.stringify(wantCounts)}.`);
  }
  return problems;
}
