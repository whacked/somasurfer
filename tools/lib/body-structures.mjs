/**
 * Which BodyParts3D element meshes become which named body structures (DOG-128).
 *
 * THE UNIT IS THE CONCEPT A FILE NAMES ITSELF. Every element OBJ in the archive
 * states its own FMA concept and English name in its header. A structure is
 * one such concept, holding every element file that names it. The eight pieces
 * of the left anterior segmental artery are one structure, and the right and
 * left external obliques are two. Its id is the FMA number, which is unique by
 * construction and is the id W5's crosswalk keys on.
 *
 * A BLANK HEADER IS RESOLVED BY THE TABLES OR NOT AT ALL. 17 files state no
 * concept. Each one is resolved to the smallest IS-A concept that contains it,
 * but only if every other file in that concept names that same concept in its
 * own header. In practice that is the unnamed side of a bilateral concept whose
 * other side is named: FJ1451 joins FMA9756 "External intercostal muscle", as
 * the IS-A table states, beside FJ1451M. Anything else is excluded and listed,
 * never guessed.
 *
 * EXCLUDED ON PURPOSE, AND PUBLISHED:
 *   - the brain (PART-OF `FMA50801`): it is its own atlas (W2, DOG-127), and two
 *     brains in one scene would disagree by the registration error.
 *
 * CATEGORIES are layers for the viewer to toggle, decided by the tables' own
 * concepts in a fixed order: the first rule whose element set holds any of a
 * structure's files wins. Every rule's term is checked against the source's
 * own name table, as NAMED_STRUCTURES does, so a concept whose meaning changed
 * upstream fails the build rather than mislabelling a layer.
 *
 * Nothing here gives a structure an ALC-1 address. Limbs and the skull are
 * named and pickable; `BD` stays a 25-level spine frame (docs/alc-1-spec.md).
 */

export const BODY_EXCLUSIONS = Object.freeze([
  {
    tree: 'partof',
    fma: 'FMA50801',
    term: 'brain',
    reason: 'the brain is its own atlas (DOG-127, W2); the body does not ship a second brain',
  },
]);

/** `[category, tree, fma, expectedTerm]`, in precedence order. */
export const BODY_CATEGORIES = Object.freeze([
  ['skin', 'partof', 'FMA7163', 'skin'],
  ['skeleton', 'isa', 'FMA5018', 'bone organ'],
  ['skeleton', 'isa', 'FMA55107', 'cartilage organ'],
  ['muscle', 'isa', 'FMA5022', 'muscle organ'],
  ['muscle', 'isa', 'FMA85453', 'head of muscle organ'],
  ['muscle', 'isa', 'FMA10474', 'zone of muscle organ'],
  ['nervous', 'partof', 'FMA7157', 'nervous system'],
  ['nervous', 'isa', 'FMA65132', 'nerve'],
  ['nervous', 'isa', 'FMA5913', 'nerve trunk'],
  ['nervous', 'isa', 'FMA5884', 'ganglion'],
  ['cardiovascular', 'partof', 'FMA7161', 'cardiovascular system'],
  ['cardiovascular', 'isa', 'FMA50722', 'region of vascular tree organ'],
  ['respiratory', 'partof', 'FMA7158', 'respiratory system'],
  ['alimentary', 'partof', 'FMA7152', 'alimentary system'],
  ['urinary', 'partof', 'FMA7159', 'urinary system'],
  ['genital', 'partof', 'FMA7160', 'genital system'],
  ['endocrine', 'partof', 'FMA9668', 'endocrine system'],
]);
export const OTHER_CATEGORY = 'other';

const fmaNumber = (fma) => Number(fma.replace(/^FMA/, ''));

/** `right`, `left` or null, from the structure's own name; nothing is inferred from position. */
export function sideOf(name) {
  const m = /\b(right|left)\b/i.exec(name);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Group an opened source's element files into structures.
 *
 * `files` is `[{ file, header: { conceptId, englishName } }]`, one per element
 * file in the archive. Returns the structures, sorted by id, and every file or
 * concept that did not become one, with the reason.
 */
export function groupBodyStructures(source, files) {
  for (const [, tree, fma, term] of [...BODY_CATEGORIES, ...BODY_EXCLUSIONS.map((e) => [null, e.tree, e.fma, e.term])]) {
    const actual = source.nameOf(fma, tree);
    if (actual !== term) {
      throw new Error(`${fma} is ${JSON.stringify(actual)} in the ${tree} tree, not ${JSON.stringify(term)}: the concept changed upstream. Re-check the rule before building.`);
    }
  }
  const excludedFiles = new Map();
  for (const e of BODY_EXCLUSIONS) {
    for (const f of source.elementsOf(e.fma, e.tree)) excludedFiles.set(f, e);
  }

  const headerConcept = new Map(files.map((f) => [f.file, f.header.conceptId]));
  const excluded = [];
  const groups = new Map();
  const add = (concept, f, resolvedBy) => {
    if (!groups.has(concept)) groups.set(concept, { concept, files: [], names: new Set(), resolvedBy: [] });
    const g = groups.get(concept);
    g.files.push(f.file);
    if (f.header.englishName) g.names.add(f.header.englishName);
    if (resolvedBy) g.resolvedBy.push({ file: f.file, by: resolvedBy });
  };

  for (const f of files) {
    const ex = excludedFiles.get(f.file);
    if (ex) {
      excluded.push({ file: f.file, fma: f.header.conceptId, name: f.header.englishName, reason: `in ${ex.term} (${ex.tree} ${ex.fma}): ${ex.reason}` });
      continue;
    }
    if (f.header.conceptId) {
      add(f.header.conceptId, f, null);
      continue;
    }
    const resolved = resolveBlank(source, f.file, headerConcept);
    if (resolved) add(resolved, f, `IS-A ${resolved}, whose other element files all name it`);
    else excluded.push({ file: f.file, fma: null, name: null, reason: 'its header names no concept, and no IS-A concept holding it is named by its other files' });
  }

  const categoryOf = categoriser(source);
  const structures = [...groups.values()].map((g) => {
    const names = [...g.names];
    if (names.length > 1) throw new Error(`${g.concept}: its element files name it ${names.map((n) => JSON.stringify(n)).join(' and ')}`);
    const name = names[0] ?? source.nameOf(g.concept, 'isa');
    if (!name) throw new Error(`${g.concept}: no English name in any header or table`);
    return {
      id: fmaNumber(g.concept),
      fma: g.concept,
      name,
      category: categoryOf(g.files),
      side: sideOf(name),
      files: g.files.sort(),
      ...(g.resolvedBy.length > 0 ? { resolvedBy: g.resolvedBy } : {}),
    };
  }).sort((a, b) => a.id - b.id);

  const ids = new Set(structures.map((s) => s.id));
  if (ids.size !== structures.length) throw new Error('two structures share an FMA number');
  return { structures, excluded: excluded.sort((a, b) => a.file.localeCompare(b.file)) };
}

/**
 * The smallest IS-A concept holding `file` whose other files all name that
 * concept or are blank themselves, with at least one of them naming it. Two
 * blank files can share a concept (FJ1664 and FJ1665 in FMA77439, beside their
 * named mirrors), and several concepts can hold the same files (FJ1450's set is
 * held by three); a file naming a different concept rules a candidate out.
 */
function resolveBlank(source, file, headerConcept) {
  const candidates = [];
  for (const [concept, members] of source.trees.isa.elements) {
    if (members.includes(file) && members.length >= 2) candidates.push({ concept, members });
  }
  candidates.sort((a, b) => a.members.length - b.members.length || a.concept.localeCompare(b.concept));
  for (const { concept, members } of candidates) {
    const others = members.filter((m) => m !== file);
    const consistent = others.every((m) => headerConcept.get(m) === concept || !headerConcept.get(m));
    if (consistent && others.some((m) => headerConcept.get(m) === concept)) return concept;
  }
  return null;
}

function categoriser(source) {
  const rules = BODY_CATEGORIES.map(([category, tree, fma]) => ({ category, files: new Set(source.elementsOf(fma, tree)) }));
  return (files) => rules.find((r) => files.some((f) => r.files.has(f)))?.category ?? OTHER_CATEGORY;
}
