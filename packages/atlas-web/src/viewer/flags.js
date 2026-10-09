/**
 * Every flag the library can raise, turned into something a person can read.
 *
 * This module exists because "the library already flags it" is not the same as
 * "the user is told". `locate()` is scrupulous — `clamped`, `folded`,
 * `homology: 'variant'`, `homology: 'absent'` and `overPrecise` are five
 * separate facts with five separate notes — and all of that is lost the moment
 * a UI renders them through one `if (flags) showWarning()`.
 *
 * Two rules shape what is here.
 *
 * **Distinct states get distinct messages.** Each notice carries a stable
 * `code`, a title and a detail, and no two codes share a title. The suite
 * asserts that pairwise, so collapsing two states into one wording fails the
 * build rather than quietly misinforming somebody.
 *
 * **`folded` and `clamped` are never conflated.** They are opposite findings:
 *
 *   clamped  the point is OUTSIDE the modelled body. The template was asked
 *            about somewhere it does not reach, and the coordinate was pulled
 *            back to the boundary. The frame is fine; the point is not in it.
 *   folded   the point is INSIDE the body and the COORDINATE SYSTEM failed
 *            there. The millimetres are deterministic but the address is
 *            ambiguous or unreachable — some other level owns this point.
 *
 * Reporting a fold as "outside the modelled body surface" for a point 200 mm
 * inside it is a real defect this project already had once, which is why the
 * two phrasings here share no vocabulary and the suite checks that they do not.
 *
 * Nothing in this module touches the DOM. It returns data; `app.js` renders it.
 */

import { ancestors, locate, parse } from '../alc.js';

/**
 * The coarsest ancestor of an address that the supplied templates can place,
 * or `null` when none can be.
 *
 * Walks from the frame root downwards and returns the first that resolves,
 * which is the *coarsest* — deliberately. The point of the offer is to give
 * back the most that can still be said honestly, and the coarsest ancestor is
 * the one most likely to be placeable at all.
 *
 * `null` is a real answer and not a failure to look. A `BR` address has no
 * resolvable ancestor because every ancestor is also in `BR`, and `BR` ships
 * disabled; a `BD` address has none when no body template loaded. In both cases
 * the honest message is that there is nothing to offer, and the caller says so
 * rather than silently omitting the offer.
 */
export function coarsestResolvable(address, templates) {
  const chain = [...ancestors(address), parse(address)];
  for (const candidate of chain) {
    try {
      const located = locate(candidate.canonical, templates);
      if (Number.isFinite(located.pointMm[0])) return candidate.canonical;
    } catch {
      // Keep walking: a coarser rung failing does not mean a finer one will.
    }
  }
  return null;
}

const notice = (code, severity, title, detail, extra = {}) => ({
  code,
  severity,
  title,
  detail,
  ...extra,
});

/**
 * Notices for a successful `locate()`.
 *
 * `located` is the library's result and `displayAddress` is what the viewer
 * actually drew — the two differ exactly when the address was over-precise,
 * and the notice names both so the user can see the demotion rather than infer
 * it.
 */
export function locateNotices(located, context = {}) {
  const out = [];
  const flags = located?.flags ?? {};
  const { address, displayAddress, templateLimitDigits } = context;

  // `overPrecise` has to be told, not read back off `located`.
  //
  // The caller demotes an over-precise address and re-locates at the template's
  // limit, so the result passed in here is a cell that is — correctly — no
  // longer over-precise. Reading the flag off it would mean the one case the
  // honesty requirement is about is the one case that silently says nothing:
  // the cell would quietly draw coarser with no explanation of why. So the
  // as-written finding is passed through `context` and wins.
  const overPrecise = context.overPrecise ?? flags.overPrecise;

  if (overPrecise) {
    out.push(notice(
      'over-precise',
      'warning',
      'Shown at the template’s limit, not as written',
      `${address} carries more refinement than template ${located.templateId} can justify`
      + `${typeof templateLimitDigits === 'number' ? ` (${templateLimitDigits} digits)` : ''}. `
      + `The address is valid and resolves, but it is drawn AND named as ${displayAddress ?? address} `
      + '— the finest cell this template actually supports. The extra digits are not discarded from '
      + 'the address; they are simply not evidence of anything on this template, so neither the '
      + 'region on screen nor the name list below pretends to know which part of it you meant.',
      { shownAs: displayAddress ?? null },
    ));
  }

  // Deliberately before `clamped`, and deliberately a separate push: a cell can
  // be both folded and clamped, and the user needs both sentences.
  if (flags.folded) {
    out.push(notice(
      'folded',
      'error',
      'The coordinate system fails here',
      'This point is inside the modelled body, but the BD frame is not one-to-one at it: another '
      + 'vertebral level has an address for the same place, or no level reaches it. The millimetres '
      + 'are deterministic, so the cell draws, but the address is ambiguous and a second address '
      + 'may denote the same region. This is a property of the template, not of your input.',
      { notes: flags.notes ?? [] },
    ));
  }

  if (flags.clamped) {
    out.push(notice(
      'clamped',
      'warning',
      'Pulled back to the template boundary',
      'The requested location lies beyond the extent this template models, so it was moved onto '
      + 'the nearest boundary. The template was asked about somewhere it does not reach. Nothing '
      + 'was projected silently — the cell you see is the boundary cell, not the place you asked '
      + 'about.',
      { notes: flags.notes ?? [] },
    ));
  }

  if (flags.homology === 'variant') {
    out.push(notice(
      'homology-variant',
      'error',
      'A recognised anatomical variant this template does not have',
      'This level is a real vertebral count anomaly, not a typo — roughly one person in ten has '
      + 'one. Template ' + (located.templateId ?? 'this template') + ' does not realise it, and it '
      + 'has deliberately NOT been guessed at: there are no millimetres for it and no cell is '
      + 'drawn. Placing it needs an explicit, registration-supplied level mapping.',
      { notes: flags.notes ?? [] },
    ));
  }

  if (flags.homology === 'absent') {
    out.push(notice(
      'homology-absent',
      'warning',
      'Reserved in the grammar, realised by no template',
      'This level is legal to write and is reserved by ALC-1, but no template realises it — the '
      + 'fused sacrum is one addressable level, so S02–S05 name reserved space rather than '
      + 'anatomy. That is a different thing from an anatomical variant: there is nothing here for '
      + 'a level mapping to map to.',
      { notes: flags.notes ?? [] },
    ));
  }

  return out;
}

/**
 * The notice for an address that `parse()` or `locate()` rejected.
 *
 * One notice, naming the FIRST problem, because that is the one the user can
 * act on; a list of every downstream consequence buries it. `AlcError` already
 * carries a specific code and a sentence written for a human, so both are
 * passed through rather than replaced with a generic "invalid address".
 */
export function errorNotice(error, address, templates = {}) {
  const code = error?.code ?? 'rejected';

  if (code === 'no_template') {
    return notice(
      'no-template',
      'error',
      'No template is loaded for this frame',
      'The address is valid and its names still resolve, but nothing can be placed in millimetres '
      + 'or drawn until a template for its frame has loaded.',
      { offer: coarsestResolvable(address, templates), alcCode: code },
    );
  }

  if (code === 'frame_disabled') {
    return notice(
      'frame-disabled',
      'error',
      'This frame ships disabled in v1',
      'The cortical surface frame BR is specified and parses, but v1 ships no template that can '
      + 'place it in millimetres, so it cannot be drawn. Its names still resolve.',
      { offer: coarsestResolvable(address, templates), alcCode: code },
    );
  }

  return notice(
    'rejected',
    'error',
    'Not a valid address',
    error?.message ?? String(error),
    { alcCode: code },
  );
}

/** The notice shown when a template or index failed to load at all. */
export function atlasUnavailableNotice(detail) {
  return notice(
    'atlas-unavailable',
    'error',
    'This atlas is unavailable',
    `${detail} Addresses still parse and still resolve to names; only the geometry is missing.`,
  );
}

/**
 * Every notice code this module can produce.
 *
 * Exported so the suite can assert that each one is reachable and that no two
 * share a title — a list that drifts from the code is how a state stops being
 * surfaced without anybody noticing.
 */
export const NOTICE_CODES = Object.freeze([
  'over-precise',
  'folded',
  'clamped',
  'homology-variant',
  'homology-absent',
  'no-template',
  'frame-disabled',
  'rejected',
  'atlas-unavailable',
]);
