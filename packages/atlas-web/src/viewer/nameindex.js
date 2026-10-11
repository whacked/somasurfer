/**
 * The real name index arrives as TWO documents, and they are joined here.
 *
 * ## This is the one code change the catalogue could not absorb
 *
 * Stage A's handoff said binding a real template would be a catalogue entry
 * rather than a code change, and for the *templates* that held: the asset
 * pipeline's `*.body.json` and `*.brain-volume.json` satisfy the stage-A
 * template interface field for field, so they bind through `data/atlas-index.
 * json` with no new code at all.
 *
 * The naming layer does not. `buildNameIndex()` wants one object —
 * `{ version, structures: [{ id, name, source, cells }] }` — and DOG-35 ships
 * two documents with two different shapes, on purpose:
 *
 *   labels/names.json      { version, frame, structureCount, provenance,
 *                            structures: [{ id, name, source, bdLevel, tree,
 *                            elementMeshes, uberon, uberonNames }] }
 *   labels/coverings.json  { indexVersion, frame, template, digits, sampleMm,
 *                            provenance, coverings: [{ id, coverage,
 *                            inFrameFraction, cells }] }
 *
 * Note that the version field is spelled `version` in one and `indexVersion`
 * in the other, that the structure list is `structures` in one and `coverings`
 * in the other, and that neither document alone is a name index. One reader
 * cannot handle both and nothing should pretend otherwise, so the join is
 * explicit, validated, and in a module of its own.
 *
 * ## UBERON cannot become the identifier, structurally
 *
 * The naming contract is FMA: identifiers are bare FMA concept ids
 * (`FMA12519`, no colon, not a CURIE) and UBERON appears only as a
 * cross-reference. The weak way to honour that is to be careful at every
 * render site. The strong way is the one taken here — `uberon` and
 * `uberonNames` are simply not carried across the join, so no downstream
 * reader *can* mistake an xref for an id, however it is later rewritten.
 * `buildNameIndex()` then freezes each structure to `{ id, name, source }`,
 * and a UBERON string is not in the index at all.
 *
 * If a later task wants xrefs on screen they need their own channel and their
 * own label. That is a feature; silently widening `id` is not.
 *
 * ## Mismatched versions are refused, not reconciled
 *
 * Both documents declare the version of the build they came from, and the join
 * fails if they disagree. A name index is only true relative to its version,
 * and a result citing one document's provenance for another document's cells
 * is exactly the unreproducible resolution that stamping a version everywhere
 * exists to prevent. There is no sensible recovery: picking either version
 * would be a claim nobody measured.
 */

/** Thrown by the join. The shell turns it into a `names-unavailable` notice. */
export class NameIndexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NameIndexError';
  }
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * A non-empty string field, or a thrown error naming the document and field.
 *
 * The document name is part of the message because the two documents are
 * fetched together and a reader staring at "missing version" has no way to
 * tell which of the two files is at fault.
 */
function requireString(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NameIndexError(`${what} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireArray(value, what) {
  if (!Array.isArray(value)) {
    throw new NameIndexError(`${what} must be an array, got ${JSON.stringify(typeof value)}`);
  }
  return value;
}

/**
 * Join `names.json` and `coverings.json` into one `NameIndexInput`.
 *
 * Joined by `id`, never by array position. The two documents happen to be
 * emitted in the same order by the current generator, and relying on that
 * would be a silent mis-naming the moment either side is sorted, filtered or
 * regenerated differently — every structure would still resolve, just to the
 * wrong name, which is the worst available failure mode.
 */
export function joinNameIndex(namesDoc, coveringsDoc) {
  if (!isObject(namesDoc)) throw new NameIndexError('names.json is not an object');
  if (!isObject(coveringsDoc)) throw new NameIndexError('coverings.json is not an object');

  const version = requireString(namesDoc.version, 'names.json `version`');
  const coveringsVersion = requireString(
    coveringsDoc.indexVersion,
    'coverings.json `indexVersion`',
  );
  if (version !== coveringsVersion) {
    throw new NameIndexError(
      'the naming documents are from different builds and cannot be joined: '
      + `names.json declares ${JSON.stringify(version)} but coverings.json declares `
      + `${JSON.stringify(coveringsVersion)}. Resolving cells from one build under the other's `
      + 'version would produce results that cannot be reproduced from either.',
    );
  }

  const structures = requireArray(namesDoc.structures, 'names.json `structures`');
  const coverings = requireArray(coveringsDoc.coverings, 'coverings.json `coverings`');

  const cellsById = new Map();
  for (const [i, entry] of coverings.entries()) {
    if (!isObject(entry)) throw new NameIndexError(`coverings.json \`coverings[${i}]\` is not an object`);
    const id = requireString(entry.id, `coverings.json \`coverings[${i}].id\``);
    if (cellsById.has(id)) {
      throw new NameIndexError(`coverings.json lists ${JSON.stringify(id)} twice`);
    }
    cellsById.set(id, requireArray(entry.cells, `coverings.json covering ${id} \`cells\``));
  }

  const joined = [];
  const seen = new Set();
  for (const [i, entry] of structures.entries()) {
    if (!isObject(entry)) throw new NameIndexError(`names.json \`structures[${i}]\` is not an object`);
    const id = requireString(entry.id, `names.json \`structures[${i}].id\``);
    const name = requireString(entry.name, `names.json structure ${id} \`name\``);
    if (seen.has(id)) throw new NameIndexError(`names.json lists ${JSON.stringify(id)} twice`);
    seen.add(id);
    if (!cellsById.has(id)) {
      throw new NameIndexError(
        `names.json names structure ${JSON.stringify(id)} but coverings.json has no covering for `
        + 'it, so there is nothing it could resolve from. The two documents are out of step.',
      );
    }
    // Only these four fields cross the join. See the module header: this is
    // what keeps a UBERON xref from ever being readable as an identifier.
    joined.push({
      id,
      name,
      source: typeof entry.source === 'string' && entry.source !== '' ? entry.source : undefined,
      cells: cellsById.get(id),
    });
  }

  // The other direction matters too: a covering with no name would resolve to
  // an unnamed structure, and `buildNameIndex` would reject it far from here.
  for (const id of cellsById.keys()) {
    if (!seen.has(id)) {
      throw new NameIndexError(
        `coverings.json carries a covering for ${JSON.stringify(id)} but names.json does not name `
        + 'it, so a cell could resolve to a structure with no name.',
      );
    }
  }

  return { version, structures: joined };
}

/**
 * The source template a name index's cells were sampled against, or `null`.
 *
 * Reported rather than enforced, and read off `coverings.json` because that is
 * the document the sampling produced. Name resolution is frame measure —
 * dimensionless and template independent — so a covering stays *valid* under
 * any template in its frame. What changes is whose anatomy it describes: these
 * cells were chosen by testing the interior of one body's meshes.
 *
 * v1 binds the body template this was derived from, so the two always agree
 * today and nothing surfaces. It is exposed because the moment a template
 * switcher binds a second body template, resolving against it would be naming
 * one body's geometry with another body's structure boundaries, and whoever
 * adds that control needs this to be reachable rather than buried in an asset
 * file.
 */
export function nameIndexSourceTemplate(coveringsDoc) {
  return isObject(coveringsDoc) && typeof coveringsDoc.template === 'string'
    ? coveringsDoc.template
    : null;
}
