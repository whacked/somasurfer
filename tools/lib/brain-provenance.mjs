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
    materials: mats,
    group,
    sources: [...sources].sort(),
    basis,
    ...(reasons.length > 0 ? { heldBecause: reasons } : {}),
  };
}

/** The whole manifest, from decoded nodes, plus counts per group. */
export function buildProvenance(nodes) {
  const structures = nodes
    .map((n) => classifyStructure({ name: n.name, extras: n.extras, materials: n.parts.map((p) => p.material) }))
    .sort((a, b) => a.id - b.id);
  const counts = {};
  for (const s of structures) counts[s.group] = (counts[s.group] ?? 0) + 1;
  const cortical = structures.filter((s) => s.category === 'cortex');
  return {
    structures,
    counts,
    corticalHeld: cortical.filter((s) => s.group !== GROUPS.cleared).length,
    cortical: cortical.length,
  };
}
