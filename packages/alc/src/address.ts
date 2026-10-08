/**
 * The frame-agnostic ALC-1 address surface: parse, format, truncate, refine.
 *
 * Everything here is pure string/integer work. Nothing in this module needs a
 * template, a mesh, or a subject — that separation is the whole point of the
 * design. `locate.ts` is where templates enter.
 */

import { AlcError, MAX_DIGITS, splitAddress, withCheck } from './codec.ts';
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
  const { segments } = splitAddress(input);
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
 * Reduce a set of addresses to the smallest equivalent set: drop any address
 * contained in another, and roll a complete sibling group up to its parent.
 * This is what makes a named structure's covering small enough to ship.
 */
export function normalizeCovering(inputs: readonly string[]): string[] {
  let current = [...new Set(inputs.map((s) => parse(s).canonical))];

  for (;;) {
    // Roll up complete sibling groups.
    const byParent = new Map<string, Set<string>>();
    for (const c of current) {
      const p = parent(c);
      if (!p) continue;
      const key = p.canonical;
      if (!byParent.has(key)) byParent.set(key, new Set());
      byParent.get(key)!.add(c);
    }
    let rolled = false;
    const promoted = new Set<string>();
    for (const [parentKey, group] of byParent) {
      const expected = children(parentKey).length;
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

    // Drop anything already covered by a coarser member.
    const sorted = [...current].sort((x, y) => parse(x).level - parse(y).level);
    const kept: string[] = [];
    for (const c of sorted) {
      if (!kept.some((k) => contains(k, c))) kept.push(c);
    }
    return kept.sort();
  }
}

export { canonicalLevel };
