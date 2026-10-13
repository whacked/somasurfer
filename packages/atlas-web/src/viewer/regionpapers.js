/** Region ↔ paper (DOG-132): W6's served region tree, read as is. No DOM, no join. docs/viewer-shell.md. */

export const API_SCHEMA = 'atlas-research-api/1';

/** A served document, refused unless it is the kind asked for. */
export function checkApiDocument(doc, kind) {
  if (doc?.schema !== API_SCHEMA || doc.kind !== kind) {
    throw new Error(`not an ${API_SCHEMA} ${kind} document (got ${JSON.stringify(doc?.schema)} ${JSON.stringify(doc?.kind)})`);
  }
  return doc;
}

/** An `href` from a document at `from`, as a URL that must stay inside the tree at `root`. */
export function treeUrl(root, from, href) {
  const url = new URL(href, from).href;
  if (!url.startsWith(root)) throw new Error(`${JSON.stringify(href)} leaves the research API tree`);
  return url;
}

/**
 * A model built from an API answer, or the answer while it has no document.
 * A document that passed the kind check can still be malformed (a stale cached
 * copy): that reads as the API failing, not as a throw on every later commit.
 */
export function apiModel(got, build) {
  if (!got.doc) return got;
  try {
    return { model: build(got.doc) };
  } catch (error) {
    return { error: `malformed document: ${error.message}` };
  }
}

/** Where a region key's document is, from the region index: `href`, or null when no paper links it. */
export function listedHref(regionIndex, kind, id) {
  const row = kind === 'region'
    ? regionIndex.regions.find((r) => r.key === id)
    : regionIndex.papers.find((p) => p.paperId === id);
  return row?.href ?? null;
}

/** One link, said for a reader: how it was made, how precise, and the term the paper used. */
export function describeLink(link) {
  const p = link.precision;
  const s = link.source;
  const notes = [];
  if (link.crosswalk?.completeness === 'parts') notes.push('the term names a whole; this structure is one of its parts');
  if (link.crosswalk?.completeness === 'overlaps') notes.push('the term and this structure only overlap');
  if (link.crosswalk?.heldTargets.length > 0) notes.push(`also maps to held structures not drawn here: ${link.crosswalk.heldTargets.join(', ')}`);
  if (link.side && !link.sideFromSource) notes.push(`the paper names no side; ${link.side} is one of the structure's sides`);
  return {
    mappingId: link.mappingId,
    how: link.how,
    approximate: p.kind !== 'exact',
    precision: p.kind === 'exact' ? 'exact'
      : p.kind === 'mm' ? `approximate, ±${p.mm} mm (${p.basis})` : `approximate: ${p.why}`,
    // The original area name, always: an HCP-MMP1 area is never shown only as the structure it was projected onto.
    source: s.scheme === 'HCP-MMP1' ? `HCP-MMP1 area ${s.label} (${s.term})` : `${s.label} (${s.term})`,
    notes,
  };
}

/** Region → papers: a `region` document, each paper's links grouped by finding, titled from the loaded corpus. */
export function regionPapers(doc, research) {
  return doc.papers.map(({ paperId, links }) => {
    const paper = research?.papers.find((p) => p.id === paperId);
    const findings = new Map();
    for (const link of links) {
      if (!findings.has(link.findingId)) {
        const label = paper?.findings.find((f) => f.id === link.findingId)?.label ?? link.findingId;
        findings.set(link.findingId, { findingId: link.findingId, label, links: [] });
      }
      findings.get(link.findingId).links.push(describeLink(link));
    }
    return { paperId, title: paper?.title ?? paperId, year: paper?.year ?? null, findings: [...findings.values()] };
  });
}

/**
 * Paper → regions: a `paper-regions` document against the drawn structures.
 * `declared` is `index.meshSets`, which says which atlas each representation is
 * drawn in; `sets` the decoded sets per atlas. A region is `exact` when any link
 * to it is, so a structure only ever reached approximately is drawn as such.
 */
export function paperRegions(doc, declared, sets) {
  const atlasOf = new Map(declared.filter((e) => e.research).map((e) => [e.research.representation, e.atlas]));
  const drawn = new Map();
  for (const s of Object.values(sets).flat().flatMap((set) => set.structures)) {
    if (s.regionKey) drawn.set(s.regionKey, [...(drawn.get(s.regionKey) ?? []), s]);
  }
  const regions = doc.regions.map((r) => {
    const links = r.links.map(describeLink);
    return {
      key: r.key,
      name: r.structureName,
      atlas: atlasOf.get(r.key.slice(0, r.key.indexOf('/'))) ?? null,
      exact: links.some((l) => !l.approximate),
      links,
      structures: drawn.get(r.key) ?? [],
    };
  });
  return { paperId: doc.paperId, regions, emptyBecause: doc.emptyBecause };
}

/** Structure key → `exact` | `approximate`, for the overlay in one atlas. */
export function overlayOf(model, atlas) {
  const out = new Map();
  for (const r of model?.regions ?? []) {
    if (r.atlas !== atlas) continue;
    for (const s of r.structures) out.set(s.key, r.exact || out.get(s.key) === 'exact' ? 'exact' : 'approximate');
  }
  return out;
}

/**
 * The revealed paper's frame in `atlas`: the structures to fit, and whether the
 * reveal is spent. It waits only while this atlas's meshes are still coming and
 * none of its structures here is drawn yet, so it frames once, never again. A
 * reveal made in `revealedIn` is spent unframed in any other atlas, by whatever
 * path the view got there (a button, a return, browser Back).
 */
export function paperFrame(model, atlas, meshStatus, revealedIn) {
  if (revealedIn !== atlas) return { drawn: [], done: true };
  const here = model.regions.filter((r) => r.atlas === atlas);
  const drawn = here.flatMap((r) => r.structures);
  return { drawn, done: drawn.length > 0 || here.length === 0 || !['pending', 'loading'].includes(meshStatus) };
}
