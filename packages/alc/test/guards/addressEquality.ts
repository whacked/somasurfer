/**
 * A standing guard against `a === b` on addresses.
 *
 * Spec section 6 is a product requirement, not a library note: comparing
 * addresses across subjects by string equality agrees only 4% of the time at a
 * 5 mm residual, while the two decoded cells stay 5.9 mm apart — the residual
 * itself. The strings disagree; the addresses are right. So any screen or query
 * that matches findings across subjects by comparing address strings is wrong,
 * and the library's job is to make that call hard to reach.
 *
 * Equality is still correct *within* one template, so this cannot be a blanket
 * ban. It is a scoped, reviewed-exception scheme:
 *
 *   IN SCOPE is any comparison or membership test on an address *value* — a
 *   `.canonical`, a `.withCheck`, a `.digits`, an indexed `.anchors[...]`, an
 *   `address`-named identifier, or a bare `parse()`/`format()` result. These are
 *   the expressions that can answer "is this the same cell", which is the
 *   question that must not be asked across subjects.
 *
 *   OUT OF SCOPE is `.frame` and any `.length`. A frame id is a coordinate
 *   system, not a place: comparing frames is how `samePlace()` *refuses* to
 *   answer, and dispatching on one is how each frame reaches its own decoder.
 *   A segment count is arity, not position. Neither can express a cross-subject
 *   identity claim, so neither needs sign-off — which is also what keeps this
 *   guard from going red every time unrelated code moves a line.
 *
 *   REVIEWED below is the in-scope list, each entry with the reason it is safe.
 *   Anything in scope and not listed fails the suite until somebody writes the
 *   sentence "this is safe because...".
 *
 * The scanner is regex-based and deliberately over-eager within its scope: a
 * false positive costs one line of justification, a false negative costs a
 * wrong clinical answer.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface EqualitySite {
  /** Path relative to the package root, forward slashes. */
  file: string;
  line: number;
  /** The source line, normalised to single spaces. */
  code: string;
  kind: 'equality' | 'membership';
  /** The operand texts, as the scanner saw them. */
  operands: [string, string];
}

/**
 * An expression that evaluates to an address, or to the part of one that
 * identifies a cell. This is the scope of the guard.
 *
 * The three rules here are structural and hold whatever the variable is
 * called. `isAddressName` below adds a naming convention — address variables in
 * this package are called `address` or `addr` — as the belt to these braces.
 */
const ADDRESS_VALUE: readonly RegExp[] = [
  /\.(?:canonical|withCheck|digits)$/, //        a.canonical, a.digits
  /\.anchors\s*\[[^\]]*\]$/, //                  a.anchors[k]
  /^(?:parse|format)\s*\(/, //                   parse(x) compared directly
];

/**
 * The naming rule, matched on *words* rather than on a substring.
 *
 * It was `/addr|alccode/i` against the whole identifier until a vertebral level
 * registry called `ADDRESSABLE` tripped the guard: the letters a-d-d-r appear
 * inside an adjective that holds no address value at all. A substring rule
 * cannot tell `findingAddr` from `addressable`, and a guard that fires on
 * English rather than on code is a guard somebody switches off — which costs
 * more than the false negative it was buying.
 *
 * Splitting on camel-case and separator boundaries keeps every real form —
 * `address`, `addrB`, `findingAddr`, `subjectAddresses`, `ADDRESS_A` — because
 * an address word survives the split in all of them, while `ADDRESSABLE` splits
 * to the single word `addressable`. It concedes nothing on the dangerous
 * collection case either: `new Set(addresses)` is caught by `taintedCollections`
 * below, which reads the *initialiser* and never the binding's name.
 */
const ADDRESS_WORDS: ReadonlySet<string> = new Set([
  'addr', 'addrs', 'address', 'addresses', 'alccode', 'alccodes',
]);

/** `subjectAddresses` → ['subject', 'addresses']; `ADDRESSABLE` → ['addressable']. */
export function identifierWords(name: string): string[] {
  return (name.split('.').pop() ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * True when an identifier names an address by this package's convention.
 *
 * Adjacent words are also joined before matching, so `alcCode` counts via the
 * pair `alc`+`code` while `ALC_VERSION` does not — `code` on its own would have
 * swept up every `errorCode` in the package.
 */
export const isAddressName = (operand: string): boolean => {
  if (!/^[\w$]+(?:\.[\w$]+)*$/.test(operand)) return false;
  const words = identifierWords(operand);
  return words.some((w, i) => ADDRESS_WORDS.has(w)
    || (i + 1 < words.length && ADDRESS_WORDS.has(w + words[i + 1])));
};

/** Arity and frame checks, excluded with a reason — see the module header. */
const OUT_OF_SCOPE = /\.(?:length|size|frame)$/;

const isAddressValue = (operand: string, tainted: ReadonlySet<string> = new Set()): boolean => {
  const o = operand.trim();
  if (!o || OUT_OF_SCOPE.test(o)) return false;
  if (tainted.has(o)) return true;
  return ADDRESS_VALUE.some((r) => r.test(o)) || isAddressName(o);
};

/**
 * Identifiers bound to a collection of addresses.
 *
 * `const seen = new Set(addresses); if (seen.has(other))` is the quiet form of
 * the same defect, and the receiver's own name gives nothing away. One pass over
 * the file propagates the taint from the constructor argument to the binding.
 * This is a heuristic, not dataflow analysis: a collection built by `push` in a
 * loop, or named without an address word anywhere in its provenance, is not
 * detected. That residual risk is why the REVIEWED list is the primary
 * mechanism and why equality-guard.test.ts also asserts the *semantics*.
 */
function taintedCollections(code: string): Set<string> {
  const out = new Set<string>();
  const patterns = [
    /(?:const|let|var)\s+([\w$]+)\s*=\s*new\s+(?:Set|Map)\s*\(\s*([^;]*?)\)\s*;/g,
    /(?:const|let|var)\s+([\w$]+)(?:\s*:[^=]+)?\s*=\s*\[([^\];]*)\]\s*;/g,
    /(?:const|let|var)\s+([\w$]+)(?:\s*:[^=]+)?\s*=\s*([\w$.]+\.map\([^;]*?)\s*;/g,
  ];
  for (const p of patterns) {
    for (const m of code.matchAll(p)) {
      const name = m[1];
      const init = m[2] ?? '';
      // Word-level, for the same reason as isAddressName: `new Set(ADDRESSABLE)`
      // is a registry of level labels, not a collection of addresses.
      const addressish =
        /\.(?:canonical|withCheck|digits)\b/.test(init)
        || (init.match(/[\w$]+/g) ?? []).some((t) => isAddressName(t));
      if (addressish) out.add(name);
    }
  }
  return out;
}

/**
 * One operand: a dotted path, with optional call arguments, subscripts or a
 * string literal. Subscripts matter — `o.anchors[k] !== i.anchors[k]` is an
 * address-value comparison and an operand grammar that stopped at `[` would
 * have read it as the harmless `o.anchors`.
 */
const OPERAND = String.raw`(?:[\w$.]|\[[^\]]*\]|\([^()]*\)|'[^']*'|"[^"]*")+`;

const EQUALITY = new RegExp(
  `(${OPERAND})\\s*(===|!==|==(?!=)|!=(?!=))\\s*(${OPERAND})`,
  'g',
);

/** Set/Map/Array membership: the quieter way to compare addresses by value. */
const MEMBERSHIP = /([A-Za-z_$][\w$.]*)\s*\.\s*(has|includes|indexOf|lastIndexOf)\s*\(([^()]*)\)/g;

/** Collections whose members are characters or frame ids, never addresses. */
const CONSTANT_REGISTRY =
  /^(?:[\w$.]*\.)?(?:CHECK_ALPHABET|CROCKFORD|HEX|OCTAL|ENABLED_FRAMES|FRAMES|VERTEBRAL_LEVELS|SPEC_BD_LEVELS|digitAlphabet|alphabet)$/;

/**
 * In-scope comparisons that are reviewed and correct.
 *
 * Matched on (file, normalised code), not on line number, so inserting a line
 * above one of these does not churn the list. If you are adding an entry and
 * the reason is "both addresses come from the same template", name the
 * template — and prefer `overlaps()`, whose docstring scopes itself to one.
 */
export const REVIEWED: ReadonlyArray<{ file: string; code: string; reason: string }> = [
  {
    file: 'src/address.ts',
    code: 'if (o.anchors[k] !== i.anchors[k]) return false',
    reason:
      'contains(): the structural prefix test inside one frame. This is the hierarchy relation the whole '
      + 'scheme is built on — two cells in one frame are nested or disjoint by construction — not an '
      + 'identity test between two subjects. Cross-subject callers reach it only through overlaps(), '
      + 'which documents itself as valid within a single template.',
  },
  {
    file: 'src/covering.ts',
    code: 'for (let guard = 0; cur.canonical !== o.canonical; guard += 1) {',
    reason:
      'relativeMeasure(): the loop walks `inner` up its own ancestor chain until it reaches `outer`, and '
      + 'the equality is that walk\'s termination test. contains() was already checked on the line above, '
      + 'so both addresses are in one frame, and the result is a dimensionless frame measure rather than '
      + 'millimetres in anybody\'s body.',
  },
];

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist']);

/** Every .ts file under `dir`, as paths relative to `root`, sorted. */
export function sourceFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(root, full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(relative(root, full).split('\\').join('/'));
    }
  }
  return out.sort();
}

/**
 * Blank out comments, preserving line numbers, so a comparison written in prose
 * — this file's own header, for instance — is not mistaken for code. String
 * literals are kept, because a frame id written as `'BD'` is exactly the kind of
 * operand the scope rule needs to see.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i += 1; }
    } else if (c === '/' && next === '*') {
      i += 2;
      out += '  ';
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      i += 2;
      out += '  ';
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') { out += '  '; i += 2; continue; }
        out += source[i] === '\n' ? '\n' : source[i];
        i += 1;
      }
      out += quote;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Scan one file's source text for in-scope address-value comparisons. */
export function scanSource(file: string, source: string): EqualitySite[] {
  const code = stripComments(source);
  const rawLines = source.split('\n');
  const lineAt = (index: number): number => {
    let count = 1;
    for (let i = 0; i < index; i += 1) if (code[i] === '\n') count += 1;
    return count;
  };
  const sites: EqualitySite[] = [];
  const add = (index: number, whole: string, kind: EqualitySite['kind'], operands: [string, string]) => {
    const line = lineAt(index);
    sites.push({
      file,
      line,
      code: (rawLines[line - 1] ?? whole).trim().replace(/\s+/g, ' '),
      kind,
      operands,
    });
  };

  const tainted = taintedCollections(code);

  for (const m of code.matchAll(EQUALITY)) {
    const operands: [string, string] = [m[1] ?? '', m[3] ?? ''];
    if (!operands.some((o) => isAddressValue(o, tainted))) continue;
    add(m.index ?? 0, m[0], 'equality', operands);
  }
  for (const m of code.matchAll(MEMBERSHIP)) {
    const receiver = (m[1] ?? '').trim();
    const argument = (m[3] ?? '').trim();
    if (CONSTANT_REGISTRY.test(receiver)) continue;
    if (!isAddressValue(receiver, tainted) && !isAddressValue(argument, tainted)) continue;
    add(m.index ?? 0, m[0], 'membership', [receiver, argument]);
  }

  const seen = new Set<string>();
  return sites.filter((s) => {
    const key = `${s.file}:${s.line}:${s.kind}:${s.operands.join('|')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Scan a tree. Paths in the result are relative to `root`. */
export function scanTree(root: string, subdir = 'src'): EqualitySite[] {
  return sourceFiles(root, join(root, subdir))
    .flatMap((file) => scanSource(file, readFileSync(join(root, file), 'utf8')))
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').replace(/[;{]+$/, '').trim();

/** The REVIEWED entry clearing a site, or null. */
export function reviewedEntry(site: EqualitySite): (typeof REVIEWED)[number] | null {
  return (
    REVIEWED.find((r) => r.file === site.file && normalise(r.code) === normalise(site.code)) ?? null
  );
}

/** In-scope sites with no REVIEWED entry. These are what the test fails on. */
export function unsanctioned(sites: readonly EqualitySite[]): EqualitySite[] {
  return sites.filter((s) => reviewedEntry(s) === null);
}
