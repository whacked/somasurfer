/**
 * What must be true of every input `parse()` accepts.
 *
 * A fuzzer for a parser cannot assert "this string should be rejected" — for
 * most hostile strings either verdict is defensible. What is never defensible
 * is the shape of the `BD-T07-02O-9` regression: `parse()` accepts an input and
 * a later stage rejects it, mis-handles it, or disagrees with it. So every
 * check here is conditional on acceptance, and asks whether the rest of the
 * library honours what the parser let through.
 *
 * KNOWN_DEFECTS is a ledger, and it is deliberately bidirectional:
 *
 *   - a violation of an invariant that is NOT in the ledger fails the suite;
 *   - a ledger entry that no longer reproduces ALSO fails the suite.
 *
 * So the suite stays green while filed defects are open, goes red the moment a
 * new one lands, and goes red again when one is fixed — at which point the
 * entry is deleted and the invariant becomes a plain guarantee. Each entry
 * names the defect id in docs/alc-1-attack-report.md.
 */

import {
  CROCKFORD,
  ancestors,
  checkSymbol,
  children,
  contains,
  locate,
  normalizeCovering,
  parse,
  recommendedDigits,
  samePlace,
  type TemplateSet,
} from '../../src/index.ts';

export interface Violation {
  invariant: string;
  input: string;
  detail: string;
}

/**
 * The `BD` vertebral level set, transcribed by hand rather than imported.
 *
 * Spec section 4 gives the canonical column: "C01-C07, T01-T12, L01-L05, S01
 * (S02-S05 reserved, not realised by any template)". Reserved means reserved
 * *in the grammar*, so S02-S05 are legal to write.
 *
 * Section 9 then requires the count anomalies — "lumbosacral transitional
 * vertebrae, C7 rib variants and six-lumbar configurations affect a meaningful
 * share of people" — to be addressable and reported as `homology: 'absent'`
 * rather than rejected or guessed. `bodySpine.ts` realises that as
 * `ANOMALOUS_LEVELS = ['T13', 'L06', 'S06']`, which is the fix for QA-6.
 *
 * Transcribed, not imported from `ADDRESSABLE_LEVELS`, on purpose: importing the
 * list the parser itself uses would make this invariant tautological. It has to
 * be an independent statement of the grammar, so a change to the parser's set
 * shows up here as a failure demanding a spec update.
 *
 * NOTE for whoever next edits the spec: section 4's grammar block still lists
 * only the canonical column and does not name T13, L06 or S06. The
 * implementation is right and the document is behind. See the QA-6 entry in
 * docs/alc-1-attack-report.md.
 */
export const SPEC_BD_LEVELS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 7 }, (_, i) => `C0${i + 1}`),
  ...Array.from({ length: 12 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 5 }, (_, i) => `L0${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `S0${i + 1}`),
  // Count anomalies, addressable so they can be reported rather than guessed.
  'T13', 'L06', 'S06',
]);

/** Error codes `locate()` is documented to throw (spec section 9). */
const DOCUMENTED_LOCATE_CODES: ReadonlySet<string> = new Set([
  'no_template',
  'frame_disabled',
  'degenerate_template',
  'absent_level',
]);

/**
 * Open defects, by invariant. See docs/alc-1-attack-report.md for the minimal
 * reproduction and the suggested fix of each.
 *
 * `expectHits` is a floor, not an exact count: it exists so that deleting the
 * corpus layer that finds a defect cannot silently retire the ledger entry.
 */
export const KNOWN_DEFECTS: ReadonlyArray<{
  invariant: string;
  defectId: string;
  summary: string;
  expectHits: number;
}> = [
  // QA-7 (INV-ASCII) was retired on 2026-10-09: `splitAddress` now rejects any
  // code point outside printable ASCII on the *raw* input, before `trim()` and
  // `toUpperCase()` can rewrite it. The 59 hits this entry carried were the
  // U+0131/U+017F confusables plus the tab- and newline-padded seeds, and all
  // 59 are now rejections. The invariant stands unqualified above.
  //
  // QA-5 (INV-CHECK-CANONICAL and INV-CHECK-ACCEPTS-LOOSE-CANONICAL) was
  // retired on 2026-10-09: `parse()` verifies the supplied symbol against the
  // canonical body it resolved to, not against the uppercased input. Both
  // invariants stand unqualified above, and they are two halves of one
  // statement — a guard must validate the thing it resolves to, in both
  // directions.
  //
  // QA-6 (INV-GRAMMAR-LEVEL) was retired on 2026-10-08: canonicalLevel() now
  // holds a per-level set, admitting the three real count anomalies and
  // rejecting everything else with the correction named. The invariant stands
  // unqualified above.
  // QA-3 (INV-RECOMMENDED-NOT-OVERPRECISE) was retired on 2026-10-09:
  // `recommendedPrecision()` now takes the lowest of the three ceilings — the
  // residual, `maxUsefulDigits` and the frame descriptor's own digit range — and
  // returns which one bound it. The invariant stands unqualified below.
];

const ledgerFor = (invariant: string) => KNOWN_DEFECTS.find((d) => d.invariant === invariant);

/**
 * Run every invariant against one input. Returns the violations found; an input
 * that `parse()` rejects yields none, because rejection is always acceptable.
 */
export function checkInvariants(input: string, templates: TemplateSet): Violation[] {
  const out: Violation[] = [];
  const fail = (invariant: string, detail: string) => out.push({ invariant, input, detail });

  let a: ReturnType<typeof parse>;
  try {
    a = parse(input);
  } catch {
    return out;
  }

  // -- The parser's own contract -------------------------------------------

  // Spec section 3: "ASCII, case-insensitive on input". An accepted input must
  // therefore have been ASCII; anything else means the alphabet check ran after
  // a Unicode case mapping had already rewritten the string.
  if (/[^\x20-\x7e]/.test(input)) {
    fail('INV-ASCII', `non-ASCII input accepted as ${a.canonical}`);
  }

  // Canonicalisation must be a fixed point.
  try {
    const again = parse(a.canonical);
    if (again.canonical !== a.canonical) {
      fail('INV-IDEMPOTENT', `${a.canonical} re-canonicalised to ${again.canonical}`);
    }
    if (again.level !== a.level || again.frame !== a.frame) {
      fail('INV-IDEMPOTENT', `re-parse changed frame/level for ${a.canonical}`);
    }
  } catch (e) {
    fail('INV-CANONICAL-REPARSE', `canonical form rejected: ${(e as { code?: string }).code}`);
  }

  // -- The check symbol (spec section 7) -----------------------------------

  const upper = input.trim().toUpperCase();
  const tilde = upper.indexOf('~');
  if (tilde >= 0) {
    const supplied = upper.slice(tilde + 1);
    const canonical = checkSymbol(a.canonical);
    // "Position-weighted sum mod 32 over the canonical body." An accepted check
    // symbol must be the one the canonical body implies, or the guard is
    // validating something other than the address it resolves to.
    if (supplied !== canonical) {
      fail(
        'INV-CHECK-CANONICAL',
        `accepted check ${supplied} but the canonical body ${a.canonical} implies ${canonical}`,
      );
    }
  }

  // The canonical form plus its own check symbol must always be accepted.
  if (!safeParses(a.withCheck)) {
    fail('INV-CHECK-ACCEPTS-CANONICAL', `${a.withCheck} was rejected`);
  }

  // And so must the *input* body plus the canonical check symbol: a human who
  // drops a leading zero and then transcribes the check symbol correctly must
  // not be told the code is damaged.
  const looseBody = upper.split('~')[0];
  const withCanonicalCheck = `${looseBody}~${checkSymbol(a.canonical)}`;
  if (!safeParses(withCanonicalCheck)) {
    fail('INV-CHECK-ACCEPTS-LOOSE-CANONICAL', `${withCanonicalCheck} was rejected`);
  }

  // A check symbol outside Crockford base-32 can never be produced, so it must
  // never be accepted either.
  if (tilde >= 0 && upper.slice(tilde + 1).length === 1 && CROCKFORD.indexOf(upper.slice(tilde + 1)) < 0) {
    fail('INV-CHECK-ALPHABET', `accepted a non-Crockford check symbol ${upper.slice(tilde + 1)}`);
  }

  // -- The grammar (spec section 4) ----------------------------------------

  if (a.frame === 'BD' && !SPEC_BD_LEVELS.has(a.anchors[0])) {
    fail('INV-GRAMMAR-LEVEL', `${a.anchors[0]} is not in the BD level set`);
  }

  // -- The hierarchy guarantee (spec section 3) ----------------------------

  try {
    const chain = [...ancestors(a.canonical).map((x) => x.canonical), a.canonical];
    for (let i = 0; i + 1 < chain.length; i += 1) {
      if (!contains(chain[i], chain[i + 1])) {
        fail('INV-ANCESTOR-CONTAINS', `${chain[i]} does not contain ${chain[i + 1]}`);
      }
      if (parse(chain[i]).level >= parse(chain[i + 1]).level) {
        fail('INV-ANCESTOR-COARSER', `${chain[i]} is not strictly coarser than ${chain[i + 1]}`);
      }
    }
  } catch (e) {
    fail('INV-HIERARCHY-THROWS', `ancestors() threw ${(e as { code?: string }).code}`);
  }

  try {
    for (const c of children(a.canonical)) {
      if (!contains(a.canonical, c.canonical)) {
        fail('INV-CHILD-CONTAINED', `${a.canonical} does not contain its child ${c.canonical}`);
      }
    }
  } catch (e) {
    fail('INV-CHILDREN-THROWS', `children() threw ${(e as { code?: string }).code}`);
  }

  try {
    const nc = normalizeCovering([a.canonical]);
    if (nc.length !== 1 || nc[0] !== a.canonical) {
      fail('INV-COVERING-SINGLETON', `normalizeCovering([${a.canonical}]) = ${JSON.stringify(nc)}`);
    }
  } catch (e) {
    fail('INV-COVERING-THROWS', `normalizeCovering() threw ${(e as { code?: string }).code}`);
  }

  // -- The later stages must honour what the parser accepted ---------------

  try {
    const l = locate(a.canonical, templates);
    const finite = l.pointMm.every(Number.isFinite);
    // NaN millimetres are legitimate only as a declared no-answer: 'absent' for
    // a level this template does not have, or 'variant' for a recognised count
    // anomaly awaiting a registration-supplied mapping. Anything else is a NaN
    // nobody declared.
    if (!finite && l.flags.homology !== 'absent' && l.flags.homology !== 'variant') {
      fail('INV-LOCATE-NAN-UNDECLARED', `NaN pointMm with flags ${JSON.stringify(l.flags)}`);
    }
    // And the converse: a declared no-answer must not also report millimetres,
    // or a consumer reading pointMm first never sees the declaration.
    if (finite && (l.flags.homology === 'absent' || l.flags.homology === 'variant')) {
      fail('INV-LOCATE-NOANSWER-WITH-MM', `homology ${l.flags.homology} with finite pointMm`);
    }
    if (finite && !l.extentMm.every(Number.isFinite)) {
      fail('INV-LOCATE-EXTENT-NAN', `finite point but extent ${JSON.stringify(l.extentMm)}`);
    }
    if (finite && l.extentMm.some((e) => e < 0)) {
      fail('INV-LOCATE-EXTENT-NEGATIVE', `extent ${JSON.stringify(l.extentMm)}`);
    }
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'none';
    if (!DOCUMENTED_LOCATE_CODES.has(code)) {
      fail('INV-LOCATE-UNDOCUMENTED-THROW', `${code}: ${String((e as Error).message).slice(0, 80)}`);
    }
  }

  // An address is trivially the same place as itself, at zero tolerance.
  try {
    const sp = samePlace(a.canonical, a.canonical, templates, { toleranceMm: 0 });
    if (!sp.same && !sp.notes.some((n) => n.includes('absent'))) {
      fail('INV-SELF-SAMEPLACE', `samePlace(x, x) = ${JSON.stringify(sp)}`);
    }
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'none';
    if (!DOCUMENTED_LOCATE_CODES.has(code)) {
      fail('INV-SAMEPLACE-UNDOCUMENTED-THROW', code);
    }
  }

  // Precision honesty: the function whose documented job is "how many digits
  // should I display?" must not answer with a precision the same library calls
  // over-precise one call later.
  try {
    const d = recommendedDigits(a.canonical, templates, 0.05);
    if (d > 0) {
      const padded = `${a.frame}-${a.anchors.join('-')}-${(a.digits + '0'.repeat(16)).slice(0, d)}`;
      if (locate(padded, templates).flags.overPrecise) {
        fail('INV-RECOMMENDED-NOT-OVERPRECISE', `recommended ${d} digits, which locate() flags overPrecise`);
      }
    }
  } catch {
    // A frame with no template cannot be asked this; not an invariant breach.
  }

  return out;
}

function safeParses(s: string): boolean {
  try {
    parse(s);
    return true;
  } catch {
    return false;
  }
}

export interface SweepResult {
  inputs: number;
  accepted: number;
  /** Violations of invariants with no ledger entry. These fail the suite. */
  unexpected: Violation[];
  /** Hits per invariant, for the ledger reconciliation. */
  hits: Map<string, { count: number; first: Violation }>;
}

/** Run the invariants over a corpus and separate known from unknown breaches. */
export function sweep(corpus: readonly string[], templates: TemplateSet): SweepResult {
  const hits = new Map<string, { count: number; first: Violation }>();
  const unexpected: Violation[] = [];
  let accepted = 0;

  for (const input of corpus) {
    if (safeParses(input)) accepted += 1;
    for (const v of checkInvariants(input, templates)) {
      const seen = hits.get(v.invariant);
      if (seen) seen.count += 1;
      else hits.set(v.invariant, { count: 1, first: v });
      if (!ledgerFor(v.invariant) && unexpected.length < 20) unexpected.push(v);
    }
  }

  return { inputs: corpus.length, accepted, unexpected, hits };
}
