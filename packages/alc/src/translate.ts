/**
 * The human-friendly translator: address <-> readable and spoken English.
 *
 *   BD-T07-03O-531  <->  "body, T7 level, three o'clock, outer, cell 531"
 *   BV-L-471025     <->  "brain, left hemisphere, cell 471025"
 *   BR-L-7A3F       <->  "left cortical surface, cell 7A3F"
 *
 * This is the layer the whole addressing idea rests on. A code nobody can read
 * out is a database key, not an address; the claim that ALC is to anatomy what
 * Open Location Code is to the Earth only holds if a clinician can say one
 * down a phone and a colleague can write back the identical string.
 *
 * So the contract is exact, not decorative: `fromReadable(toReadable(a))` and
 * `fromReadable(toSpoken(a))` both return the canonical form of `a`, for every
 * address in every frame. `test/translate.test.ts` checks it over a generated
 * sweep rather than a handful of examples.
 *
 * Two deliberate asymmetries:
 *
 *  - **Output is one form per address; input is permissive.** `toReadable`
 *    emits exactly one string so round-tripping is single-valued, while
 *    `fromReadable` accepts `T7`/`T07`/`thoracic 7`, `3 o'clock`/`three
 *    o'clock`, `outer`/`O`, hyphenated digit runs, and the spoken form. Anyone
 *    transcribing by ear or by hand lands somewhere in that set.
 *  - **Only the refinement run is spelled out.** The level and the clock sector
 *    are already said as words, and clinicians already say "T7, three o'clock".
 *    The octal or hex run is the part that gets misheard, so that is the part
 *    `toSpoken` spells symbol by symbol.
 *
 * Input here is as untrusted as anywhere else: readable text arrives from
 * dictation, email and OCR. Length is capped, the token count is capped, and
 * every parse ends by going through `parse()`, so the grammar, anchor ranges,
 * digit alphabets and digit caps are all enforced by the same code path an
 * address string takes.
 */

import { ancestors, FRAMES, parse, type Address } from './address.ts';
import { AlcError } from './codec.ts';
import { canonicalLevel } from './frames/bodySpine.ts';
import type { FrameDescriptor } from './types.ts';

const CLOCK_WORDS = [
  'twelve', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
] as const;

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'] as const;

/** NATO letters for the hex symbols `BR` uses. `A` as "alpha" survives a phone line; `A` as "ay" does not. */
const LETTER_WORDS: Record<string, string> = {
  A: 'alpha', B: 'bravo', C: 'charlie', D: 'delta', E: 'echo', F: 'foxtrot',
};

const WORD_TO_SYMBOL = new Map<string, string>();
for (let i = 0; i < DIGIT_WORDS.length; i += 1) WORD_TO_SYMBOL.set(DIGIT_WORDS[i], String(i));
for (const [symbol, word] of Object.entries(LETTER_WORDS)) WORD_TO_SYMBOL.set(word, symbol);
// "oh" for zero and "niner" for nine are what people actually say on a radio.
WORD_TO_SYMBOL.set('oh', '0');
WORD_TO_SYMBOL.set('niner', '9');

const CLOCK_WORD_TO_NUMBER = new Map<string, number>();
for (let c = 1; c <= 12; c += 1) CLOCK_WORD_TO_NUMBER.set(CLOCK_WORDS[c], c);

const LEVEL_WORD_TO_LETTER = new Map<string, string>([
  ['c', 'C'], ['cervical', 'C'],
  ['t', 'T'], ['thoracic', 'T'],
  ['l', 'L'], ['lumbar', 'L'],
  ['s', 'S'], ['sacral', 'S'],
]);

/** Longest readable form we will look at. Well past the longest legal address. */
const MAX_READABLE_LENGTH = 512;
const MAX_PARTS = 8;

// ---------------------------------------------------------------------------
// Address -> text
// ---------------------------------------------------------------------------

/** `T07` -> `T7 level`. The leading zero is for sorting, not for saying. */
function levelPhrase(level: string): string {
  return `${level[0]}${Number(level.slice(1))} level`;
}

function clockPhrase(clockAndDepth: string): [string, string] {
  const clock = Number(clockAndDepth.slice(0, 2));
  const depth = clockAndDepth[2];
  return [`${CLOCK_WORDS[clock]} o'clock`, depth === 'I' ? 'inner' : 'outer'];
}

function hemispherePhrase(h: string, frame: string): string {
  const side = h === 'L' ? 'left' : 'right';
  return frame === 'BR' ? `${side} cortical surface` : `${side} hemisphere`;
}

function readableParts(a: Address, spellDigits: boolean): string[] {
  const parts: string[] = [];
  switch (a.frame) {
    case 'BD': {
      parts.push('body', levelPhrase(a.anchors[0]));
      if (a.anchors.length > 1) parts.push(...clockPhrase(a.anchors[1]));
      break;
    }
    case 'BV': {
      parts.push('brain', hemispherePhrase(a.anchors[0], 'BV'));
      break;
    }
    case 'BR': {
      parts.push(hemispherePhrase(a.anchors[0], 'BR'));
      break;
    }
    default:
      throw new AlcError(`frame ${a.frame} has no readable form`, 'unknown_frame');
  }
  if (a.digits) {
    const run = spellDigits
      ? [...a.digits].map((ch) => (/[0-9]/.test(ch) ? DIGIT_WORDS[Number(ch)] : LETTER_WORDS[ch] ?? ch)).join(' ')
      : a.digits;
    parts.push(`cell ${run}`);
  }
  return parts;
}

/**
 * The readable form: comma-separated English with the refinement run left as
 * symbols. What goes on a screen, in a report, or in a URL's title.
 */
export function toReadable(address: string): string {
  return readableParts(parse(address), false).join(', ');
}

/**
 * The spoken form: the readable form with the refinement run spelled out
 * symbol by symbol. What you say down a phone.
 */
export function toSpoken(address: string): string {
  return readableParts(parse(address), true).join(', ');
}

// ---------------------------------------------------------------------------
// Text -> address
// ---------------------------------------------------------------------------

function splitParts(text: string): string[] {
  if (typeof text !== 'string') throw new AlcError('readable address must be a string', 'bad_type');
  if (text.length > MAX_READABLE_LENGTH) {
    throw new AlcError(`readable address longer than ${MAX_READABLE_LENGTH} characters`, 'too_long');
  }
  const parts = text
    .toLowerCase()
    .replace(/[.;]/g, ',')
    .split(',')
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter((p) => p !== '');
  if (parts.length === 0) throw new AlcError('empty readable address', 'empty');
  if (parts.length > MAX_PARTS) {
    throw new AlcError(`readable address has ${parts.length} clauses, more than any frame uses`, 'too_many_segments');
  }
  return parts;
}

/** A number written as digits or as an English word. */
function readNumber(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) return Number(token);
  const word = CLOCK_WORD_TO_NUMBER.get(token);
  if (word !== undefined) return word;
  const digit = WORD_TO_SYMBOL.get(token);
  return digit !== undefined && /^\d$/.test(digit) ? Number(digit) : null;
}

/**
 * Read a refinement run: `531`, `5 3 1`, `5-3-1`, `five three one`, or a mix.
 *
 * A multi-character token that is not a known word is read symbol by symbol, so
 * `7A3F` and `seven alpha three foxtrot` reach the same digits. Validation of
 * the resulting symbols against the frame's alphabet is left to `parse()`.
 */
function readDigits(phrase: string, descriptor: FrameDescriptor): string {
  const body = phrase.replace(/^cells?\s+/, '').replace(/^number\s+/, '');
  const tokens = body.split(/[\s-]+/).filter((t) => t !== '');
  const out: string[] = [];
  for (const token of tokens) {
    const word = WORD_TO_SYMBOL.get(token);
    if (word !== undefined) {
      out.push(word);
      continue;
    }
    for (const ch of token.toUpperCase()) out.push(ch);
  }
  if (out.length === 0) throw new AlcError(`could not read a refinement run from ${JSON.stringify(phrase)}`, 'bad_digit');
  if (out.length > descriptor.maxDigits) {
    throw new AlcError(
      `${descriptor.id} supports at most ${descriptor.maxDigits} refinement digits, read ${out.length}`,
      'bad_precision',
    );
  }
  return out.join('');
}

const LEVEL_PHRASE_RE = /^(c|t|l|s|cervical|thoracic|lumbar|sacral)\s*-?\s*([a-z0-9]+?)(?:\s+level)?$/;
const CLOCK_PHRASE_RE = /^([a-z0-9]+)\s*(?:o\s*'?\s*clock|oclock)$/;
const HEMISPHERE_RE = /^(left|right|l|r)(?:\s+hemisphere)?$/;
const SURFACE_RE = /^(left|right|l|r)\s+(?:cortical\s+surface|cortex|surface)$/;
const CELL_RE = /^(?:cell|cells|number)\s+(.+)$/;

/**
 * Parse a readable or spoken form back to an address.
 *
 * Returns the parsed `Address`, so the caller gets the canonical string, the
 * check symbol and the hierarchy level in one step. Throws `AlcError` on
 * anything it cannot read — there is no best-effort guess, because a
 * mistranscribed address that resolves to the wrong place is worse than one
 * that fails.
 */
export function fromReadable(text: string): Address {
  const parts = splitParts(text);
  const head = parts[0];

  const surface = SURFACE_RE.exec(head);
  if (surface) {
    const hemisphere = surface[1][0].toUpperCase();
    const rest = parts.slice(1);
    if (rest.length !== 1) {
      throw new AlcError('a cortical surface address needs exactly one cell clause', 'missing_digits');
    }
    return parse(`BR-${hemisphere}-${readDigits(rest[0], FRAMES.BR)}`);
  }

  if (head === 'brain' || head === 'brain volume') {
    const rest = parts.slice(1);
    if (rest.length === 0) throw new AlcError('a brain address needs a hemisphere', 'missing_anchor');
    const hemisphere = HEMISPHERE_RE.exec(rest[0]);
    if (!hemisphere) {
      throw new AlcError(`expected a hemisphere, got ${JSON.stringify(rest[0])}`, 'bad_hemisphere');
    }
    const letter = hemisphere[1][0].toUpperCase();
    if (rest.length === 1) return parse(`BV-${letter}`);
    if (rest.length > 2) throw new AlcError('too many clauses after the hemisphere', 'too_many_segments');
    return parse(`BV-${letter}-${readDigits(rest[1], FRAMES.BV)}`);
  }

  if (head === 'body') {
    const rest = parts.slice(1);
    if (rest.length === 0) throw new AlcError('a body address needs a vertebral level', 'missing_anchor');
    const levelMatch = LEVEL_PHRASE_RE.exec(rest[0]);
    if (!levelMatch) {
      throw new AlcError(`expected a vertebral level, got ${JSON.stringify(rest[0])}`, 'bad_level');
    }
    const letter = LEVEL_WORD_TO_LETTER.get(levelMatch[1]);
    const number = readNumber(levelMatch[2]);
    if (!letter || number === null) {
      throw new AlcError(`expected a vertebral level, got ${JSON.stringify(rest[0])}`, 'bad_level');
    }
    // canonicalLevel enforces the anchor range; it is the same check `parse` runs.
    const level = canonicalLevel(`${letter}${number}`);
    if (rest.length === 1) return parse(`BD-${level}`);

    const clockMatch = CLOCK_PHRASE_RE.exec(rest[1]);
    if (!clockMatch) {
      throw new AlcError(`expected a clock sector, got ${JSON.stringify(rest[1])}`, 'bad_azimuth');
    }
    const clock = readNumber(clockMatch[1]);
    if (clock === null) {
      throw new AlcError(`expected a clock sector, got ${JSON.stringify(rest[1])}`, 'bad_azimuth');
    }
    if (rest.length < 3) {
      throw new AlcError('a clock sector must be followed by inner or outer', 'missing_anchor');
    }
    const depthWord = rest[2];
    const depth = depthWord === 'inner' || depthWord === 'i' ? 'I'
      : depthWord === 'outer' || depthWord === 'o' ? 'O'
      : null;
    if (!depth) {
      throw new AlcError(`expected inner or outer, got ${JSON.stringify(depthWord)}`, 'bad_azimuth');
    }
    const azimuth = `${String(clock).padStart(2, '0')}${depth}`;
    if (rest.length === 3) return parse(`BD-${level}-${azimuth}`);
    if (rest.length > 4) throw new AlcError('too many clauses after the depth half', 'too_many_segments');
    return parse(`BD-${level}-${azimuth}-${readDigits(rest[3], FRAMES.BD)}`);
  }

  throw new AlcError(
    `unrecognised frame in ${JSON.stringify(head)}; expected "body", "brain", or "<side> cortical surface"`,
    'unknown_frame',
  );
}

/** True when `text` is a readable form this module can parse. */
export function isReadable(text: string): boolean {
  try {
    fromReadable(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Structured description, for a UI that wants to label each segment
// ---------------------------------------------------------------------------

export interface AddressPart {
  /** The segment as it appears in the canonical address. */
  readonly segment: string;
  /** Which rung of the hierarchy this is. */
  readonly kind: 'frame' | 'level' | 'azimuth' | 'hemisphere' | 'refinement';
  /** Short label for a UI. */
  readonly label: string;
  /** One sentence saying what this segment pins down. */
  readonly detail: string;
}

export interface AddressDescription {
  readonly address: string;
  readonly withCheck: string;
  readonly frame: string;
  /** The frame's `summary` string: one sentence on what this coordinate system is. */
  readonly frameSummary: string;
  readonly experimental: boolean;
  readonly readable: string;
  readonly spoken: string;
  readonly parts: readonly AddressPart[];
  /** Coarser addresses, frame root first, each containing the next. */
  readonly ancestors: readonly string[];
}

/** One sentence describing a frame. Throws on an unknown frame id. */
export function frameSummary(frameId: string): string {
  const descriptor = FRAMES[String(frameId).toUpperCase()];
  if (!descriptor) {
    throw new AlcError(`unknown frame ${JSON.stringify(frameId)}`, 'unknown_frame');
  }
  return descriptor.summary;
}

/** Every frame's summary, for a frame picker. */
export function frameSummaries(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, descriptor] of Object.entries(FRAMES)) out[id] = descriptor.summary;
  return out;
}

/**
 * Everything a UI needs to render one address: both text forms, the frame's
 * summary, a labelled breakdown of each segment, and the ancestor chain for a
 * breadcrumb. No template and no name index, so this is safe to call before
 * either has loaded.
 */
export function describe(address: string): AddressDescription {
  const a = parse(address);
  const descriptor = FRAMES[a.frame];
  const parts: AddressPart[] = [
    {
      segment: a.frame,
      kind: 'frame',
      label: a.frame === 'BD' ? 'body' : a.frame === 'BV' ? 'brain volume' : 'cortical surface',
      detail: descriptor.summary,
    },
  ];

  if (a.frame === 'BD') {
    parts.push({
      segment: a.anchors[0],
      kind: 'level',
      label: levelPhrase(a.anchors[0]),
      detail: 'Vertebral level. The address is defined in its template\'s level sequence, so a subject with a different vertebral count needs an explicit level mapping.',
    });
    if (a.anchors.length > 1) {
      const [clock, depth] = clockPhrase(a.anchors[1]);
      parts.push({
        segment: a.anchors[1],
        kind: 'azimuth',
        label: `${clock}, ${depth}`,
        detail: `Clock sector about the spine axis, with sector 12 centred on the anterior midline, and the ${depth} half of the distance from the axis to the skin.`,
      });
    }
  } else {
    parts.push({
      segment: a.anchors[0],
      kind: 'hemisphere',
      label: hemispherePhrase(a.anchors[0], a.frame),
      detail: a.frame === 'BV'
        ? 'Hemisphere half-box. The midsagittal plane itself belongs to L, so midline structures have coverings spanning both halves.'
        : 'Hemisphere registration sphere.',
    });
  }

  if (a.digits) {
    parts.push({
      segment: a.digits,
      kind: 'refinement',
      label: `cell ${a.digits}`,
      detail: a.frame === 'BR'
        ? 'HEALPix NESTED index on the registration sphere; one hex digit per two orders, so each digit refines 16-fold.'
        : 'Octree refinement. Each digit halves all three local coordinates, so dropping one digit gives the containing cell.',
    });
  }

  return Object.freeze({
    address: a.canonical,
    withCheck: a.withCheck,
    frame: a.frame,
    frameSummary: descriptor.summary,
    experimental: a.experimental,
    readable: readableParts(a, false).join(', '),
    spoken: readableParts(a, true).join(', '),
    parts: Object.freeze(parts),
    ancestors: Object.freeze(ancestors(a.canonical).map((x) => x.canonical)),
  });
}
