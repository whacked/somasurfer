/**
 * The ALC-1 address fuzz corpus.
 *
 * Addresses arrive from URLs, pasted text and imported datasets, so every
 * string in this file is a hostile input (spec section 10, trust boundary).
 *
 * The corpus has three layers, and all three are deterministic:
 *
 *   1. CURATED      — hand-written vectors, one per attack idea. Fixed, ordered,
 *                     and the place to add a regression when a defect is filed.
 *   2. MUTATED      — the seed addresses put through 1..3 random edits drawn from
 *                     ASCII_ALPHABET and CONFUSABLES.
 *   3. WELL_FORMED  — random addresses that are *legal by construction*, to
 *                     exercise the deep end of the grammar rather than the
 *                     rejection path.
 *
 * REPRODUCIBILITY. Layers 2 and 3 are driven by `rng(FUZZ_SEED)`, the same
 * LCG the conformance suite uses. A failing case therefore reproduces exactly
 * from (FUZZ_SEED, iterations, index). The suite prints the seed on failure.
 * To widen a run without editing code:
 *
 *     ALC_FUZZ_ITERATIONS=400000 ALC_FUZZ_SEED=12345 node --test test/fuzz.test.ts
 *
 * WHY THESE CHARACTERS. `parse()` lowercases nothing and uppercases everything
 * (`codec.ts: splitAddress`) before it validates the alphabet, so the attack
 * surface is "every Unicode code point whose uppercase form is a legal ALC
 * character". CONFUSABLES is that set plus the invisibles and the separators
 * that look like `-`.
 */

import { rng } from '../../src/testing/syntheticTemplates.ts';

/** Default seed. Overridable with ALC_FUZZ_SEED so a failure can be replayed. */
export const FUZZ_SEED = Number(process.env.ALC_FUZZ_SEED ?? 20261008);

/**
 * Mutation rounds per layer. 8 000 keeps the whole fuzz file around nine
 * seconds on a CI runner, which is the budget; raise it with
 * ALC_FUZZ_ITERATIONS for a soak run. The per-input cost is dominated by the
 * `locate()` and `recommendedDigits()` invariants, not by parsing.
 */
export const FUZZ_ITERATIONS = Number(process.env.ALC_FUZZ_ITERATIONS ?? 8000);

/** Seed addresses: one valid, canonical example per frame and anchor shape. */
export const SEEDS: readonly string[] = [
  'BD-T07-03O-531',
  'BD-T07',
  'BD-C07-06O',
  'BD-S01-12I-7',
  'BD-L05-01I-01234567',
  'BV-L-471025',
  'BV-R',
  'BR-L-7A3F',
  'BR-R-0',
  'BR-L-BFFFFFF',
];

/** Legal ALC body characters plus their lowercase forms and the two sigils. */
export const ASCII_ALPHABET = '0123456789ABCDEFILORSTV-~abcdefilorstv';

/**
 * Non-ASCII code points chosen because `String.prototype.toUpperCase` maps them
 * onto legal ALC characters, or because they are invisible, or because they
 * look like the `-` separator. Spec section 3 says an address is ASCII; this is
 * the list that tests whether the implementation agrees.
 *
 *   U+0131 LATIN SMALL LETTER DOTLESS I   -> 'I'  (the depth half)
 *   U+017F LATIN SMALL LETTER LONG S      -> 'S'  (the sacral prefix)
 *   U+00DF LATIN SMALL LETTER SHARP S     -> 'SS' (length-changing)
 *   U+FB01 LATIN SMALL LIGATURE FI        -> 'FI' (length-changing)
 *   U+212A KELVIN SIGN, U+FF22 FULLWIDTH B, U+2170 SMALL ROMAN NUMERAL ONE,
 *   U+13A5 CHEROKEE LETTER V, U+0456/U+04CF Cyrillic i lookalikes
 *   U+200B ZWSP, U+FEFF BOM, U+00A0 NBSP, U+3000 IDEOGRAPHIC SPACE
 *   U+2010 HYPHEN, U+2212 MINUS, U+FF0D FULLWIDTH HYPHEN, U+301C WAVE DASH
 *   lone surrogates, to prove no decoder panics
 */
export const CONFUSABLES: readonly string[] = [
  'ı', 'ſ', 'ß', 'ﬁ', 'ﬅ', 'İ', 'ⅰ', 'Ꭵ',
  '​', ' ', '　', 'K', 'Ｂ', 'і', 'ӏ', 'ẞ',
  'ʀ', 'ᴀ', '①', 'Ⅸ', '﻿', '\ud800', '\udfff', '\t',
  '\n', '\r', ' ', '̇', '‐', '−', '－', '〜',
];

/**
 * Layer 1. One vector per attack idea, grouped by what it attacks.
 *
 * These are asserted against invariants, not against an expected verdict: a
 * fuzz corpus must not encode "this should be rejected", because for most of
 * these either answer is defensible. What is not defensible is accepting an
 * input and then mishandling it later.
 */
export function curatedCorpus(): string[] {
  const out: string[] = [];
  const push = (...xs: string[]) => out.push(...xs);

  // -- canonicalisation: case, whitespace, leading zeros, check symbols
  for (const s of SEEDS) {
    push(s, s.toLowerCase(), ` ${s} `, `\t${s}\n`, s.replace(/-0(\d)/g, '-$1'));
  }

  // -- every vertebral anchor shape, including the out-of-grammar ones
  for (const prefix of ['C', 'T', 'L', 'S']) {
    for (let n = 0; n <= 14; n += 1) {
      push(`BD-${prefix}${String(n).padStart(2, '0')}-03O`, `BD-${prefix}${n}-03O`);
    }
    push(`BD-${prefix}001-03O`, `BD-${prefix}-03O`, `BD-${prefix}0A-03O`);
  }

  // -- every clock sector and both depth halves, plus the off-by-ones
  for (let c = 0; c <= 13; c += 1) {
    for (const d of ['I', 'O', 'X', 'i', 'o', '']) {
      push(`BD-T07-${String(c).padStart(2, '0')}${d}`, `BD-T07-${c}${d}`);
    }
  }

  // -- refinement depth, at and past every cap (per-frame and the global 16)
  for (let n = 0; n <= 18; n += 1) {
    push(`BD-T07-03O-${'0'.repeat(n)}`, `BD-T07-03O-${'7'.repeat(n)}`);
    push(`BV-L-${'0'.repeat(n)}`, `BV-L-${'7'.repeat(n)}`);
    push(`BR-L-${'0'.repeat(n)}`, `BR-L-A${'F'.repeat(Math.max(0, n - 1))}`);
  }
  // digits drawn from the wrong alphabet: the BD-T07-02O-9 regression
  for (const d of '89ABCDEFGXZ') {
    push(`BD-T07-03O-${d}`, `BD-T07-03O-53${d}1`, `BV-L-47${d}`, `BR-L-7${d}3F`);
  }

  // -- malformed anchor shapes and separators
  push(
    '', ' ', '-', '--', '~', '~K', 'BD', 'BD-', '-BD-T07', 'BD-T07-', 'BD--T07',
    'BD-T07--03O', 'BD-T07-03O--531', 'XX-L-1', 'B-T07', 'BDX-T07', 'BD_T07',
    'BD.T07', 'BD T07', 'BD/T07', 'BD-T07-03O-531-2', 'BV-L-47-1', 'BV-LL',
    'BV-L-R', 'BV-M-471', 'BR-L', 'BR-L-C', 'BR-L-FFFFFFF', 'BR-LL-7A3F',
    'BD-T07-03O-531-', 'BD', 'BV', 'BR',
  );

  // -- oversized input, at and past the 64-character cap
  for (const n of [60, 63, 64, 65, 66, 128, 1024]) {
    push('A'.repeat(n), `BD-T07-03O-${'0'.repeat(Math.max(0, n - 11))}`, `BD-${'T07-'.repeat(n / 4)}03O`);
  }

  // -- the check symbol: every Crockford character, on canonical and loose bodies
  for (const c of '0123456789ABCDEFGHJKMNPQRSTVWXYZ') {
    push(`BD-T07-03O~${c}`, `BD-T7-3O~${c}`, `bd-t07-03o~${c}`, `BV-L-471025~${c}`);
  }
  push(
    'BD-T07-03O~', 'BD-T07-03O~~', 'BD-T07-03O~AB', 'BD-T07-03O~I', 'BD-T07-03O~L',
    'BD-T07-03O~O', 'BD-T07-03O~U', 'BD~T07-03O', 'bd~t07', 'BD-T07~03O~K',
  );

  // -- Unicode: confusables, invisibles, normalisation, lone surrogates
  for (const w of CONFUSABLES) {
    push(
      `BD-T07-03${w}`, `BD-${w}01-03O`, `B${w}-T07`, `${w}BD-T07`, `BD-T07${w}`,
      `BV-L-47${w}`, `BD-T07-03O${w}531`, `BD-T07${w}03O`, `BR-L-7A3${w}`,
    );
  }
  // NFC/NFD pairs: the same visual address, decomposed
  push('BD-Ṫ07-03O', 'BD-T07-03Ȯ', 'BḊ-T07');

  return out;
}

/** Layer 2. Random edits to the seeds. Deterministic in `seed`. */
export function mutatedCorpus(seed: number, iterations: number): string[] {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const out: string[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let s: string = pick(SEEDS);
    const edits = 1 + Math.floor(rand() * 3);
    for (let e = 0; e < edits; e += 1) {
      const at = Math.floor(rand() * (s.length + 1));
      const ch = rand() < 0.75 ? pick([...ASCII_ALPHABET]) : pick(CONFUSABLES);
      switch (Math.floor(rand() * 6)) {
        case 0: s = s.slice(0, at) + ch + s.slice(at); break;          // insert
        case 1: s = s.slice(0, at) + s.slice(at + 1); break;           // delete
        case 2: s = s.slice(0, at) + ch + s.slice(at + 1); break;      // substitute
        case 3: s = s.slice(0, at) + s.slice(at).toLowerCase(); break; // case flip
        case 4: s = s.repeat(1 + Math.floor(rand() * 2)); break;       // duplicate
        default: s = s.replace(/-/g, rand() < 0.5 ? '' : '--'); break; // separators
      }
    }
    out.push(s.length > 80 ? s.slice(0, 80) : s);
  }
  return out;
}

/** Layer 3. Addresses that are legal by construction. Deterministic in `seed`. */
export function wellFormedCorpus(seed: number, iterations: number): string[] {
  const rand = rng(seed ^ 0x5eed);
  const pick = (s: string): string => s[Math.floor(rand() * s.length)];
  const out: string[] = [];
  for (let i = 0; i < iterations; i += 1) {
    switch (Math.floor(rand() * 3)) {
      case 0: {
        const prefix = pick('CTLS');
        const max = prefix === 'C' ? 7 : prefix === 'T' ? 12 : 5;
        const level = `${prefix}${String(1 + Math.floor(rand() * max)).padStart(2, '0')}`;
        const clock = `${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}${pick('IO')}`;
        const d = Array.from({ length: Math.floor(rand() * 13) }, () => pick('01234567')).join('');
        out.push(d ? `BD-${level}-${clock}-${d}` : rand() < 0.5 ? `BD-${level}-${clock}` : `BD-${level}`);
        break;
      }
      case 1: {
        const d = Array.from({ length: Math.floor(rand() * 13) }, () => pick('01234567')).join('');
        out.push(d ? `BV-${pick('LR')}-${d}` : `BV-${pick('LR')}`);
        break;
      }
      default: {
        const len = 1 + Math.floor(rand() * 7);
        const d = pick('0123456789AB')
          + Array.from({ length: len - 1 }, () => pick('0123456789ABCDEF')).join('');
        out.push(`BR-${pick('LR')}-${d}`);
        break;
      }
    }
  }
  return out;
}

/** Everything, in a fixed order. */
export function fullCorpus(seed = FUZZ_SEED, iterations = FUZZ_ITERATIONS): string[] {
  return [
    ...curatedCorpus(),
    ...mutatedCorpus(seed, iterations),
    ...wellFormedCorpus(seed, Math.floor(iterations / 3)),
  ];
}
