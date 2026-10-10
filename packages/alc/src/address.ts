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
 * The next coarser address, or null at the frame root.
 *
 * This is the property the whole scheme is built on: dropping refinement always
 * yields a valid address whose cell strictly contains the original.
 */
export function parent(input: string): Address | null {
  const a = parse(input);
  if (a.frame === 'BR') {
    const p = brParentDigits(a.digits);
    return p === null ? null : parse(`BR-${a.anchors[0]}-${p}`);
  }
  if (a.digits.length > 0) {
    const d = a.digits.slice(0, -1);
    return parse(d ? `${a.frame}-${a.anchors.join('-')}-${d}` : `${a.frame}-${a.anchors.join('-')}`);
  }
  if (a.frame === 'BD' && a.anchors.length === 2) return parse(`BD-${a.anchors[0]}`);
  return null;
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
  let current = [...new Set(inputs.map((s) => parse(s).canonical))];

  for (;;) {
    // Roll up complete sibling groups.
    const byParent = new Map<string, { group: Set<string>; expected: number }>();
    for (const c of current) {
      const p = parent(c);
      if (!p) continue;
      const seen = byParent.get(p.canonical);
      if (seen) seen.group.add(c);
      else byParent.set(p.canonical, { group: new Set([c]), expected: branchingBelow(p) });
    }
    let rolled = false;
    const promoted = new Set<string>();
    for (const [parentKey, { group, expected }] of byParent) {
      if (expected > 0 && group.size === expected) {
        promoted.add(parentKey);
        for (const g of group) promoted.add(`!${g}`);
        rolled = true;
      }
    }
    if (rolled) {
      const removed = new Set([...promoted].filter((x) => x.startsWith('!')).map((x) => x.slice(1)));
      const added = [...promoted].filter((x) => !x.startsWith('!'));
      current = [...new Set([...current.filter((c) => !removed.has(c)), ...added])];
      continue;
    }

    // Drop anything already covered by a coarser member. Coarsest first, so a
    // cell is dropped exactly when a coarser cell that survived contains it —
    // and `kept` holds canonical strings, so "does anything coarser contain
    // this" is a handful of set lookups rather than a scan.
    const parsed = current.map((c) => parse(c));
    parsed.sort((x, y) => x.level - y.level);
    const kept = new Set<string>();
    for (const a of parsed) {
      // `containingKeys` includes `a` itself, which cannot be in `kept` yet.
      if (containingKeys(a).some((k) => kept.has(k))) continue;
      kept.add(a.canonical);
    }
    return [...kept].sort();
  }
}

export { canonicalLevel };
