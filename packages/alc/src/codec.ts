/**
 * ALC-1 string codec: digit alphabets, the optional transcription check symbol,
 * and the shared parse/format machinery for every frame.
 *
 * Design rules (all deliberate, see docs/alc-1-spec.md):
 *  - ASCII, case-insensitive, canonical form is UPPERCASE.
 *  - `-` separates structural segments; `~` introduces the check symbol.
 *  - Truncating whole trailing digits (and then whole trailing segments) always
 *    yields a valid, strictly coarser address containing the original.
 *  - No millimetres, no subject identity, and no parcellation name ever appear
 *    in an address. Those live in templates and the name index.
 */

export const HEX = '0123456789ABCDEF';
export const OCTAL = '01234567';
/** Crockford base-32, minus I L O U, used only for the check symbol. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class AlcError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'AlcError';
    this.code = code;
  }
}

/** Hard cap on refinement digits. Prevents unbounded work from hostile input. */
export const MAX_DIGITS = 16;

export function digitsToValues(digits: string, alphabet: string, what: string): number[] {
  const out: number[] = [];
  for (const ch of digits) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new AlcError(`invalid ${what} digit ${JSON.stringify(ch)}`, 'bad_digit');
    out.push(v);
  }
  return out;
}

export function valuesToDigits(values: readonly number[], alphabet: string): string {
  return values.map((v) => alphabet[v]).join('');
}

/**
 * Every character that can legally appear in a canonical ALC-1 address body.
 * Deliberately 23 symbols — under 32 — so that the one-character check symbol
 * below can be injective in each position. Adding a frame that needs a new
 * character means extending this list and bumping the spec version, because it
 * changes every check symbol.
 */
// 0-9 and A-F for digits, B/D/V/R for frame ids, C/T/L/S for vertebral levels,
// L/R for hemispheres, I/O for depth halves, and the separator. 24 symbols, so
// the largest possible value difference is 23 and no substitution can be
// congruent to zero mod 32.
export const CHECK_ALPHABET = '0123456789ABCDEFILORSTV-';

/**
 * Position-weighted mod-32 check symbol.
 *
 * Weights are the odd numbers 1, 3, 5, ... Odd weights are invertible mod 32,
 * so a change of Δ in any single position changes the sum by w·Δ ≢ 0 whenever
 * Δ ≢ 0 — which gives a hard guarantee:
 *
 *   - EVERY single-character substitution within CHECK_ALPHABET is caught.
 *   - Any character outside CHECK_ALPHABET is caught by the grammar instead.
 *   - Transpositions are caught unless the two characters' values differ by
 *     exactly 16 and sit an odd distance apart: 31 of every 32 pairs.
 *
 * It is a transcription guard for codes read aloud, written down, or retyped.
 * It is not a cryptographic signature and not a storage integrity check.
 */
export function checkSymbol(canonicalBody: string): string {
  let sum = 0;
  for (let i = 0; i < canonicalBody.length; i += 1) {
    const v = CHECK_ALPHABET.indexOf(canonicalBody[i]);
    if (v < 0) {
      throw new AlcError(
        `character ${JSON.stringify(canonicalBody[i])} cannot appear in an ALC-1 address`,
        'bad_character',
      );
    }
    sum += (2 * i + 1) * (v + 1);
  }
  return CROCKFORD[sum % 32];
}

export interface RawAddress {
  frame: string;
  /** Frame-specific anchor segments, already uppercased. */
  anchors: string[];
  /** Refinement digits, possibly empty. */
  digits: string;
  /** Check symbol if the input carried one. */
  check?: string;
}

const TOKEN = /^[0-9A-Z]+$/;

/**
 * Printable ASCII, decided on the *raw* input.
 *
 * Spec section 3 says an address is ASCII and section 10 says the alphabet is
 * validated before anything else runs, so this cannot wait until after
 * canonicalisation. `trim()` strips Unicode whitespace (U+00A0, U+2007,
 * U+FEFF) and `toUpperCase()` maps non-ASCII code points onto legal ALC
 * characters — U+0131 DOTLESS I onto the depth half `I`, U+017F LONG S onto
 * the sacral prefix `S`. Validating the alphabet after either one makes the
 * effective alphabet "every code point whose uppercase form happens to be
 * legal", which let two distinct byte sequences denote one address: a consumer
 * comparing a raw URL parameter against a stored canonical form, or running
 * the section 10 prefix range scan on the unnormalised string, then disagrees
 * with this library about whether two addresses name the same place. That was
 * QA-7 in docs/alc-1-attack-report.md.
 */
const NON_ASCII = /[^\x20-\x7e]/;

/**
 * Split an address string into segments without interpreting the frame.
 *
 * Note what this deliberately does *not* do: verify the check symbol. The
 * symbol is a sum over the **canonical** body (spec section 7) and this
 * function cannot canonicalise — padding `T7` to `T07` is frame-specific. It
 * validates the symbol's shape and hands it back; `parse()` verifies it once
 * the canonical body exists. Checking it here, against the uppercased input,
 * was QA-5.
 */
export function splitAddress(input: string): { segments: string[]; check?: string } {
  if (typeof input !== 'string') throw new AlcError('address must be a string', 'bad_type');
  const offender = NON_ASCII.exec(input);
  if (offender !== null) {
    const cp = input.codePointAt(offender.index)!.toString(16).toUpperCase().padStart(4, '0');
    throw new AlcError(
      `an ALC-1 address is printable ASCII; found U+${cp} at index ${offender.index}`,
      'non_ascii',
    );
  }
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) throw new AlcError('empty address', 'empty');
  if (trimmed.length > 64) throw new AlcError('address too long', 'too_long');

  let body = trimmed;
  let check: string | undefined;
  const tilde = trimmed.indexOf('~');
  if (tilde >= 0) {
    body = trimmed.slice(0, tilde);
    check = trimmed.slice(tilde + 1);
    if (check.length !== 1 || CROCKFORD.indexOf(check) < 0) {
      throw new AlcError('check symbol must be a single Crockford base-32 character', 'bad_check');
    }
  }

  const segments = body.split('-');
  if (segments.some((s) => s.length === 0)) throw new AlcError('empty segment', 'empty_segment');
  if (segments.some((s) => !TOKEN.test(s))) {
    throw new AlcError('segments must be alphanumeric', 'bad_segment');
  }
  return { segments, check };
}

/** Append the check symbol to a canonical address body. */
export function withCheck(canonicalBody: string): string {
  return `${canonicalBody}~${checkSymbol(canonicalBody)}`;
}
