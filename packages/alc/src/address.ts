/**
 * The frame-agnostic ALC-1 address surface: parse, format, truncate, refine.
 *
 * Everything here is pure string/integer work. Nothing in this module needs a
 * template, a mesh, or a subject — that separation is the whole point of the
 * design. `locate.ts` is where templates enter.
 */

import { AlcError, MAX_DIGITS, checkSymbol, splitAddress, withCheck } from './codec.ts';
import { BD, canonicalLevel, parseBodyAnchors } from './frames/bodySpine.ts';
import { BR, brChildDigits, brParentDigits, brPixel, parseHemisphere } from './frames/brainSurface.ts';
import { BV, bvCellBox, parseHemisphere as parseBvHemisphere } from './frames/brainVolume.ts';
import type { FrameDescriptor } from './types.ts';

export const FRAMES: Record<string, FrameDescriptor> = { BD, BV, BR };

/** Frames that v1 can locate in millimetres with the shipped templates. */
export const ENABLED_FRAMES = new Set(['BD', 'BV']);

export interface Address {
  frame: string;
  anchors: string[];
  digits: string;
  /** Canonical uppercase string, without the check symbol. */
  canonical: string;
  /** Canonical string with the check symbol appended. */
  withCheck: string;
  /**
   * Rungs of refinement below the frame root. Comparable only within a frame.
   * BD counts the azimuth segment as one rung, then one per digit.
   */
  level: number;
  experimental: boolean;
}

function build(frame: string, anchors: string[], digits: string, level: number): Address {
  const parts = [frame, ...anchors];
  if (digits) parts.push(digits);
  const canonical = parts.join('-');
  return {
    frame,
    anchors,
    digits,
    canonical,
    withCheck: withCheck(canonical),
    level,
    experimental: !ENABLED_FRAMES.has(frame),
  };
}

export function parse(input: string): Address {
  const { segments, check } = splitAddress(input);
  const address = fromSegments(segments);

  // Spec section 7: the symbol is a position-weighted sum over the *canonical*
  // body, so it can only be verified once the canonical body exists — after
  // `T7` has become `T07` and `3O` has become `03O`. Verifying it earlier, over
  // the uppercased input, got both directions wrong: a human who drops a
  // leading zero in a code read aloud and then transcribes the symbol
  // correctly was told the code was damaged, while a symbol computed over the
  // loose body was accepted for an address that re-emits a different one. A
  // guard that validates something other than what the parser resolves to is
  // not a guard. (QA-5 in docs/alc-1-attack-report.md.)
  if (check !== undefined) {
    const expected = checkSymbol(address.canonical);
    if (check !== expected) {
      throw new AlcError(
        `check symbol does not match address: ${address.canonical} implies `
          + `${expected}, got ${check}`,
        'check_failed',
      );
    }
  }
  return address;
}

/** Everything in `parse()` that does not depend on the check symbol. */
function fromSegments(segments: readonly string[]): Address {
  const frame = segments[0];
  const descriptor = FRAMES[frame];
  if (!descriptor) {
    throw new AlcError(
      `unknown frame ${JSON.stringify(frame)}; known frames are ${Object.keys(FRAMES).join(', ')}`,
      'unknown_frame',
    );
  }
  const rest = segments.slice(1);
  if (rest.length === 0) {
    throw new AlcError(`${frame} needs at least an anchor segment`, 'missing_anchor');
  }
  if (rest.length > descriptor.anchorSegments + 1) {
    throw new AlcError(
      `${frame} takes at most ${descriptor.anchorSegments} anchor segments plus one digit segment`,
      'too_many_segments',
    );
  }

  // The digit segment is present only when every anchor segment is.
  const hasDigits = rest.length === descriptor.anchorSegments + 1;
  const anchorsIn = hasDigits ? rest.slice(0, descriptor.anchorSegments) : rest;
  const digits = hasDigits ? rest[rest.length - 1] : '';

  if (digits.length > Math.min(MAX_DIGITS, descriptor.maxDigits)) {
    throw new AlcError(
      `${frame} supports at most ${descriptor.maxDigits} refinement digits, got ${digits.length}`,
      'bad_precision',
    );
  }
  // Validate the digit alphabet here, once, for every frame. Leaving this to
  // each frame's decoder meant `BD-T07-02O-9` parsed cleanly and only failed
  // later, at locate time, in a frame-specific code path.
  for (const ch of digits) {
    if (!descriptor.digitAlphabet.includes(ch)) {
      throw new AlcError(
        `${frame} refinement digits must come from ${descriptor.digitAlphabet}, got ${JSON.stringify(ch)}`,
        'bad_digit',
      );
    }
  }

  switch (frame) {
    case 'BD': {
      const a = parseBodyAnchors(anchorsIn);
      const anchors = a.clock === undefined
        ? [a.level]
        : [a.level, `${String(a.clock).padStart(2, '0')}${a.depth}`];
      const level = (a.clock === undefined ? 0 : 1) + digits.length;
      return build('BD', anchors, digits, level);
    }
    case 'BV': {
      const hemisphere = parseBvHemisphere(anchorsIn[0]);
      bvCellBox(hemisphere, digits); // validates digit alphabet
      return build('BV', [hemisphere], digits, digits.length);
    }
    case 'BR': {
      const hemisphere = parseHemisphere(anchorsIn[0]);
      if (!digits) throw new AlcError('BR requires refinement digits', 'missing_digits');
      const { order } = brPixel(digits);
      return build('BR', [hemisphere], digits, order);
    }
    default:
      throw new AlcError(`frame ${frame} has no parser`, 'unknown_frame');
  }
}

export function isValid(input: string): boolean {
  try {
    parse(input);
    return true;
  } catch {
    return false;
  }
}

/** Format without a check symbol. Accepts loose input such as `bd-t7-2o`. */
export function format(input: string, options: { check?: boolean } = {}): string {
  const a = parse(input);
  return options.check ? a.withCheck : a.canonical;
}

/**
 * The parent's address string, for an address already parsed, without parsing
 * the result.
 *
 * `parent()` is the public form and returns a parsed `Address`. This exists
 * because `normalizeCovering` groups cells by their parent and then needs the
 * parent itself for only a few of those groups, so parsing every parent to
 * build the grouping key was most of a pass's cost. `parent()` is defined in
 * terms of this, so the string this builds and the address `parent()` returns
 * cannot drift apart.
 *
 * Grouping by this is sound whether or not the string is canonical, because
 * `parse()` of it is single-valued: distinct parents cannot collide on one key.
 * `covering.test.ts` asserts it IS canonical, which is the stronger claim, so
 * that a frame whose parent form stops round-tripping is caught here.
 */
function parentKey(a: Address): string | null {
  if (a.frame === 'BR') {
    const p = brParentDigits(a.digits);
    return p === null ? null : `BR-${a.anchors[0]}-${p}`;
  }
  if (a.digits.length > 0) {
    const d = a.digits.slice(0, -1);
    const stem = `${a.frame}-${a.anchors.join('-')}`;
    return d ? `${stem}-${d}` : stem;
  }
  if (a.frame === 'BD' && a.anchors.length === 2) return `BD-${a.anchors[0]}`;
  return null;
}

/**
 * The next coarser address, or null at the frame root.
 *
 * This is the property the whole scheme is built on: dropping refinement always
 * yields a valid address whose cell strictly contains the original.
 */
export function parent(input: string): Address | null {
  const key = parentKey(parse(input));
  return key === null ? null : parse(key);
}

/** Every ancestor from the frame root down to, but excluding, this address. */
export function ancestors(input: string): Address[] {
  const out: Address[] = [];
  let cur = parent(input);
  while (cur) {
    out.unshift(cur);
    cur = parent(cur.canonical);
  }
  return out;
}

/** The immediate children one rung finer. */
export function children(input: string): Address[] {
  const a = parse(input);
  const descriptor = FRAMES[a.frame];
  if (a.frame === 'BR') {
    return brChildDigits(a.digits).map((d) => parse(`BR-${a.anchors[0]}-${d}`));
  }
  if (a.frame === 'BD' && a.anchors.length === 1) {
    const out: Address[] = [];
    for (let c = 1; c <= 12; c += 1) {
      for (const depth of ['I', 'O']) {
        out.push(parse(`BD-${a.anchors[0]}-${String(c).padStart(2, '0')}${depth}`));
      }
    }
    return out;
  }
  if (a.digits.length >= descriptor.maxDigits) return [];
  return [...descriptor.digitAlphabet].map((d) =>
    parse(`${a.frame}-${a.anchors.join('-')}-${a.digits}${d}`),
  );
}

/** True when `outer` contains `inner` (or they are equal). */
export function contains(outer: string, inner: string): boolean {
  const o = parse(outer);
  const i = parse(inner);
  if (o.frame !== i.frame) return false;
  if (o.level > i.level) return false;
  for (let k = 0; k < o.anchors.length; k += 1) {
    if (o.anchors[k] !== i.anchors[k]) return false;
  }
  return i.digits.startsWith(o.digits);
}

/**
 * How many children a cell at this frame and rung has, memoised per frame and
 * rung.
 *
 * Derived from `children()` rather than tabulated, so it cannot drift from the
 * hierarchy it is supposed to describe — `BD` branches 24 ways at the azimuth
 * rung and 8 ways per octree digit, `BV` 8, `BR` 16, and this reads those
 * numbers off the real implementation. `test/covering.test.ts` asserts the
 * agreement for every frame and rung.
 *
 * Memoised because the only thing any caller wants is the COUNT, and
 * `children()` builds and PARSES every child to produce it. The rollup below
 * asked for it once per distinct parent per pass, which is 24 parses per parent
 * per pass to learn a number that depends on nothing but the frame and the rung.
 */
const BRANCHING = new Map<string, number>();

/**
 * A lower bound on how many children any cell with children has, in any frame.
 *
 * `normalizeCovering`'s rollup uses it to decide which sibling groups are even
 * worth parsing a parent for: a group of fewer than this can never be complete.
 * Derived from the frame descriptors rather than written down as 8, so adding a
 * frame cannot leave a stale constant behind — and `covering.test.ts` asserts it
 * against `children()` for every frame and rung, because the bound being WRONG
 * would not fail loudly. It would silently stop rolling up one frame's sibling
 * groups, which is a quietly larger covering rather than an error.
 *
 * `BD`'s azimuth rung branches 24 ways and `BR` 16, both comfortably above the
 * octree alphabets this minimises over; the test is what keeps that true.
 */
export const MIN_BRANCHING: number = Math.min(
  ...Object.values(FRAMES).map((f) => f.digitAlphabet.length),
);

export function branchingBelow(p: Address): number {
  const key = `${p.frame}:${p.level}`;
  const hit = BRANCHING.get(key);
  if (hit !== undefined) return hit;
  const n = children(p.canonical).length;
  BRANCHING.set(key, n);
  return n;
}

/**
 * Every address `contains()` would report as containing `a`, `a` itself
 * included, as canonical strings.
 *
 * This is the whole reason the prune below is linear. `contains(outer, inner)`
 * is true exactly when the two share a frame, `outer`'s anchor segments match
 * `inner`'s elementwise, and `outer`'s digits are a string prefix of `inner`'s.
 * Nothing in that depends on the rest of the set, so the containing addresses
 * are enumerable from `a` alone: truncate the anchor list, or truncate the
 * digits. There are `anchors + digits + 1` of them — at most fourteen in any
 * frame v1 defines — where asking the set directly costs one `contains()` per
 * member, and `contains()` parses both of its arguments.
 *
 * Enumerated from `contains()`'s predicate and not from `parent()`, so the two
 * cannot drift: whatever `parent()` does per frame — and `BR` does not simply
 * drop a digit — this enumerates what `contains()` answers. `covering.test.ts`
 * asserts the agreement against `contains()` itself.
 *
 * The strings are never parsed, so an enumerated form that is not a legal
 * address standing alone — `BR-L`, which the parser requires digits for — is
 * harmless. It cannot be a member of a set of parsed addresses, so the lookup
 * simply misses.
 */
function containingKeys(a: Address): string[] {
  const out: string[] = [];
  for (let k = 1; k < a.anchors.length; k += 1) {
    out.push(`${a.frame}-${a.anchors.slice(0, k).join('-')}`);
  }
  const full = `${a.frame}-${a.anchors.join('-')}`;
  out.push(full);
  for (let d = 1; d <= a.digits.length; d += 1) out.push(`${full}-${a.digits.slice(0, d)}`);
  return out;
}

/**
 * Reduce a set of addresses to the smallest equivalent set: drop any address
 * contained in another, and roll a complete sibling group up to its parent.
 * This is what makes a named structure's covering small enough to ship.
 *
 * Linear in the number of cells, times the fixed depth of a frame. It was
 * quadratic until DOG-80: the prune asked `kept.some(contains)` per cell, so
 * normalising the 412-cell covering of FMA7574 made 84,666 `contains()` calls
 * and 169,332 `parse()` calls, and the page paid ~2.6 s building the 57
 * structures of the real name index on the critical path at load. The cells are
 * a hierarchy, so containment never needed a search: see `containingKeys`.
 */
export function normalizeCovering(inputs: readonly string[]): string[] {
  // Parse each distinct input once and carry the `Address` through every pass.
  // Re-parsing a canonical string this function had just produced was the rest
  // of its cost once the prune stopped being quadratic: three passes each
  // re-derived from strings what the pass before it already knew.
  const distinct = new Map<string, Address>();
  for (const s of inputs) {
    const a = parse(s);
    if (!distinct.has(a.canonical)) distinct.set(a.canonical, a);
  }
  let current = [...distinct.values()];

  for (;;) {
    // Roll up complete sibling groups. Grouped by `parentKey`, which builds the
    // key without parsing it; a group can only be complete if it holds at least
    // `MIN_BRANCHING` cells, so a parent is parsed only for a group that could
    // possibly be complete. Nothing the asset pipeline ships rolls up at all,
    // and on that input this pass now parses nothing.
    const byParent = new Map<string, Address[]>();
    for (const a of current) {
      const key = parentKey(a);
      if (key === null) continue;
      const group = byParent.get(key);
      if (group) group.push(a);
      else byParent.set(key, [a]);
    }
    let rolled = false;
    const removed = new Set<string>();
    const added: Address[] = [];
    for (const [key, group] of byParent) {
      if (group.length < MIN_BRANCHING) continue;
      const p = parse(key);
      const expected = branchingBelow(p);
      if (expected <= 0 || group.length !== expected) continue;
      added.push(p);
      for (const g of group) removed.add(g.canonical);
      rolled = true;
    }
    if (rolled) {
      const next = new Map<string, Address>();
      for (const a of current) if (!removed.has(a.canonical)) next.set(a.canonical, a);
      for (const a of added) next.set(a.canonical, a);
      current = [...next.values()];
      continue;
    }

    // Drop anything already covered by a coarser member. Coarsest first, so a
    // cell is dropped exactly when a coarser cell that survived contains it —
    // and `kept` holds canonical strings, so "does anything coarser contain
    // this" is a handful of set lookups rather than a scan.
    current.sort((x, y) => x.level - y.level);
    const kept = new Set<string>();
    for (const a of current) {
      // `containingKeys` includes `a` itself, which cannot be in `kept` yet.
      if (containingKeys(a).some((k) => kept.has(k))) continue;
      kept.add(a.canonical);
    }
    return [...kept].sort();
  }
}

export { canonicalLevel };
