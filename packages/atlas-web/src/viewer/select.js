/**
 * One address in, everything the viewer shows about it out.
 *
 * This is the whole "paste an address" and "click something" data flow from the
 * plan's §4, in one pure function with no DOM and no WebGL, so the §7 journey
 * and the deep-link matrix can be driven in Node against exactly the object the
 * browser renders.
 *
 * The order of operations is a requirement, not an implementation detail:
 *
 *   1. `parse()` FIRST. Addresses arrive from URLs and pasted text and are
 *      untrusted. Nothing geometric runs until the grammar, the alphabet, the
 *      anchor ranges and the digit cap have all passed. A rejected address
 *      returns a single notice naming the first problem and `changed: false`,
 *      and the caller leaves every other piece of state alone.
 *   2. Names SECOND, and independently of any template. Name resolution is a
 *      lookup in a separately versioned index, in dimensionless frame measure.
 *      It is deliberately upstream of `locate()` so that an atlas whose
 *      geometry failed to load still answers "what is this?" — the plan's §6
 *      last row, and the thing that makes a broken asset a degraded view rather
 *      than a blank one.
 *   3. Geometry LAST, and allowed to fail on its own without taking the names
 *      with it.
 *
 * ## Over-precision is resolved, then demoted — for the names too
 *
 * An over-precise address resolves. It is then drawn *and named* at the
 * template's limit, not as written. Drawing the coarse cell while naming the
 * fine one would be a subtler version of the same lie: the user would see a
 * 40 mm region on screen and a name list computed for a 5 mm one, and would
 * reasonably believe the atlas knew which 5 mm. Frame measure is exact and
 * template-independent, so the fine fractions would not be *wrong* — they would
 * just be answering a question this template cannot support asking. Both halves
 * are demoted together, and the notice says so.
 */

import {
  containingStructures,
  describe,
  locate,
  parse,
  resolve,
} from '../alc.js';
import { bodyCellMesh, brainCellMesh, cellBoxOf } from './cell.js';
import { errorNotice, locateNotices, unnamedFrameNotice } from './flags.js';

/** The frame's template in a template set, or undefined. */
const templateFor = (frame, templates) =>
  frame === 'BD' ? templates.body : frame === 'BV' ? templates.brainVolume : undefined;

/**
 * The same address with its refinement truncated to `maxDigits`.
 *
 * Rebuilt through `parse()` rather than by string surgery alone, so the result
 * is a validated canonical address and an impossible truncation — `BD` digits
 * without their azimuth segment, say — fails here instead of downstream.
 */
export function demote(address, maxDigits) {
  const a = parse(address);
  if (a.digits.length <= maxDigits) return a.canonical;
  const digits = a.digits.slice(0, Math.max(0, maxDigits));
  const stem = `${a.frame}-${a.anchors.join('-')}`;
  return parse(digits ? `${stem}-${digits}` : stem).canonical;
}

const FRAME_CACHE = new WeakMap();

/**
 * Which frames a name index actually covers, read off the index itself.
 *
 * Derived rather than declared, because a declaration drifts: an index that
 * said `frames: ['BD', 'BV']` and shipped only `BD` coverings would produce
 * exactly the misreport this exists to prevent. Each covering's cells are all
 * in one frame by construction, so the first cell of each is enough.
 *
 * Memoised on the index object, so this is ~one parse per structure, once.
 */
export function nameIndexFrames(nameIndex) {
  if (!nameIndex) return new Set();
  const cached = FRAME_CACHE.get(nameIndex);
  if (cached) return cached;
  const frames = new Set();
  for (const covering of nameIndex.coverings) {
    if (covering.cells.length > 0) frames.add(parse(covering.cells[0]).frame);
  }
  FRAME_CACHE.set(nameIndex, frames);
  return frames;
}

/**
 * Ranked names for a cell, with fractions and the index version.
 *
 * Never collapses to one name, and never returns names without the version
 * they came from: a stored resolution with no version is not reproducible, and
 * a single winner is how an atlas starts lying about a cell that straddles
 * three structures.
 *
 * ## A frame with no index is not a frame with no matches
 *
 * `resolve()` cannot tell those apart — asked about a `BV` address against a
 * `BD`-only index it reports zero matches, `unclaimedFraction: 1` and a note
 * saying no structure overlaps, which reads as a coverage gap in an index that
 * covers this frame. It does not cover it at all. `BV` ships in v1 as
 * coordinates without names because every candidate brain parcellation failed
 * licence clearance, so the honest answer is a different *kind* of answer, and
 * `covered: false` is how the caller tells them apart. Reporting the `BD`
 * index's version beside a `BV` selection would also borrow one artefact's
 * provenance for a frame it says nothing about.
 */
export function namesFor(address, nameIndex) {
  if (!nameIndex) return null;
  const frame = parse(address).frame;
  if (!nameIndexFrames(nameIndex).has(frame)) {
    return {
      covered: false,
      frame,
      // Deliberately no indexVersion: no index spoke, so none is cited.
      indexVersion: null,
      measure: 'frame',
      matches: [],
      unclaimedFraction: 0,
      containing: [],
      notes: [`no name index in this build covers frame ${frame}`],
    };
  }
  const resolution = resolve(address, nameIndex);
  return {
    covered: true,
    indexVersion: resolution.indexVersion,
    measure: resolution.measure,
    matches: resolution.matches.map((m) => ({
      id: m.structure.id,
      name: m.structure.name,
      source: m.structure.source ?? null,
      fraction: m.fraction,
    })),
    unclaimedFraction: resolution.unclaimedFraction,
    containing: containingStructures(address, nameIndex).map((s) => ({
      id: s.id,
      name: s.name,
      source: s.source ?? null,
    })),
    notes: [...resolution.notes],
  };
}

/**
 * Build the drawable cell for an address, or `null` with a reason.
 *
 * `null` is returned for a level the template does not realise. There is no
 * shape to draw for anatomy the template does not have, and drawing a
 * plausible-looking one is the guess that `homology: 'variant'` exists to
 * prevent.
 */
function cellMeshFor(address, templates) {
  const decoded = cellBoxOf(address);
  if (decoded.frame === 'BD') {
    const template = templates.body;
    if (!template) return null;
    return bodyCellMesh(template, { level: decoded.level, ...decoded.box });
  }
  if (decoded.frame === 'BV') {
    const template = templates.brainVolume;
    if (!template) return null;
    return brainCellMesh(template, decoded.hemisphere, decoded.box);
  }
  return null;
}

/**
 * The full selection model for an address.
 *
 * `ok: false` means nothing else in the viewer should move. That is the
 * contract the "a rejected address changes nothing else" requirement rests on:
 * this function cannot reach into viewer state, so the only way a rejection can
 * have a side effect is if a caller ignores the flag.
 */
export function selectAddress(input, options = {}) {
  const templates = options.templates ?? {};
  const nameIndex = options.nameIndex ?? null;

  // --- 1. parse, before anything geometric ---------------------------------
  let parsed;
  try {
    parsed = parse(input);
  } catch (error) {
    return {
      ok: false,
      input: String(input),
      notices: [errorNotice(error, String(input), templates)],
    };
  }

  const address = parsed.canonical;
  const template = templateFor(parsed.frame, templates);

  // --- 2. names, independent of any template ------------------------------
  // Resolved against the address as written for now; re-resolved below at the
  // display address if the template demotes it.
  let names = null;
  let nameError = null;
  try {
    names = namesFor(address, nameIndex);
  } catch (error) {
    nameError = error;
  }

  // --- 3. geometry, allowed to fail alone ---------------------------------
  let located = null;
  let notices = [];
  let displayAddress = address;
  // Recorded where the demotion happens rather than recovered afterwards by
  // comparing the two address strings. That comparison would be benign here —
  // one frame, one template — but "did these two addresses come out the same?"
  // is the question the standing equality guard exists to keep out of reach,
  // and the fact is already known at the only place that can cause it.
  let demoted = false;
  let cell = null;

  try {
    located = locate(address, templates);
  } catch (error) {
    notices = [errorNotice(error, address, templates)];
  }

  if (located) {
    // Captured before the demotion below replaces `located`, because that
    // replacement is exactly what clears the flag that has to be reported.
    const overPrecise = Boolean(located.flags.overPrecise);
    if (overPrecise && template) {
      displayAddress = demote(address, template.maxUsefulDigits);
      demoted = true;
      // Re-locate at what is actually drawn, so `extentMm` and `pointMm` below
      // describe the cell on screen rather than the one the address asked for.
      located = locate(displayAddress, templates);
      try {
        names = namesFor(displayAddress, nameIndex);
      } catch (error) {
        nameError = error;
      }
    }
    notices = locateNotices(located, {
      address,
      displayAddress,
      overPrecise,
      templateLimitDigits: template?.maxUsefulDigits,
    });
    if (Number.isFinite(located.pointMm[0])) {
      cell = cellMeshFor(displayAddress, templates);
    }
  }

  // Said once, next to the geometry notices, so a brain selection explains
  // itself rather than appearing to be a resolution that silently found
  // nothing. Appended after the locate notices because it is not a fault.
  if (names && names.covered === false) {
    notices = [...notices, unnamedFrameNotice(names.frame)];
  }

  if (nameError) {
    notices = [
      ...notices,
      {
        code: 'names-unavailable',
        severity: 'warning',
        title: 'Names could not be resolved',
        detail: nameError.message ?? String(nameError),
      },
    ];
  }

  return {
    ok: true,
    input: String(input),
    address,
    withCheck: parsed.withCheck,
    frame: parsed.frame,
    experimental: parsed.experimental,
    /** What is drawn and named. Differs from `address` only when demoted. */
    displayAddress,
    demoted,
    description: describe(address),
    located,
    templateId: located?.templateId ?? null,
    pointMm: located?.pointMm ?? null,
    extentMm: located?.extentMm ?? null,
    cell,
    names,
    notices,
  };
}
