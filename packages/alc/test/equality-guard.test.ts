/**
 * The standing guard on cross-subject address comparison.
 *
 * Spec section 6: "Never compare addresses across subjects with string
 * equality." At a 5 mm residual and 3 digits the strings agree 4% of the time,
 * while the decoded cells stay 5.9 mm apart — the residual itself. The
 * addresses localise correctly; only the strings differ.
 *
 * Two halves, because either alone is gameable:
 *
 *   STATIC   — every address-value comparison in src/ is either absent or
 *              signed off in guards/addressEquality.ts REVIEWED. New code that
 *              adds one fails this suite. Demonstrated below against seven
 *              deliberately introduced comparisons.
 *   SEMANTIC — the measured reason the rule exists, so that renaming variables
 *              past the scanner still leaves a test that says why.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  children,
  contains,
  coveringsIntersect,
  encodeBrainVolume,
  locate,
  overlaps,
  samePlace,
} from '../src/index.ts';
import { bvLocalToMm } from '../src/frames/brainVolume.ts';
import {
  ADULT_MALE,
  buildBodyTemplate,
  BRAIN_ADULT,
  BRAIN_CHILD,
  buildBrainTemplate,
  rng,
} from '../src/testing/syntheticTemplates.ts';
import {
  REVIEWED,
  identifierWords,
  isAddressName,
  reviewedEntry,
  scanSource,
  scanTree,
  stripComments,
  unsanctioned,
} from './guards/addressEquality.ts';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const brainAdult = buildBrainTemplate(BRAIN_ADULT);
const brainChild = buildBrainTemplate(BRAIN_CHILD, [3, -2, 1]);

// ---------------------------------------------------------------------------
// STATIC
// ---------------------------------------------------------------------------

test('equality guard: no unsanctioned address comparison exists in src/', () => {
  const sites = scanTree(PACKAGE_ROOT, 'src');
  const bad = unsanctioned(sites);
  const detail = bad
    .map((s) => `  ${s.file}:${s.line}  ${s.code}\n      operands: ${JSON.stringify(s.operands)}`)
    .join('\n');
  assert.equal(
    bad.length,
    0,
    `${bad.length} address comparison(s) in src/ are not signed off.\n`
      + 'Comparing addresses for cross-subject identity is wrong (spec section 6): use samePlace() with\n'
      + 'an explicit toleranceMm, or overlaps()/coveringsIntersect() within one template. If the\n'
      + 'comparison really is safe, add it to REVIEWED in test/guards/addressEquality.ts with the\n'
      + `reason.\n${detail}`,
  );
});

test('equality guard: every REVIEWED entry still matches real source', () => {
  // A sign-off for a line that no longer exists is rot, and it would silently
  // pre-approve a future line that happens to look the same.
  //
  // One exception, narrow and deliberate: an entry naming a file that is not in
  // this tree at all is *held*, not rotten. Sibling tasks land in an order this
  // guard has no business policing, and failing here would only teach whoever
  // hits it to delete a sign-off that is about to be needed again. A sign-off
  // naming a file that *is* present and no longer contains the line is still
  // rot, which is the case that can actually pre-approve something.
  const sites = scanTree(PACKAGE_ROOT, 'src');
  for (const entry of REVIEWED) {
    const held = !existsSync(join(PACKAGE_ROOT, entry.file));
    assert.ok(
      held || sites.some((s) => reviewedEntry(s) === entry),
      `REVIEWED entry no longer matches any source line — delete it:\n  ${entry.file}: ${entry.code}`,
    );
    assert.ok(entry.reason.length > 60, `REVIEWED entry for ${entry.file} needs a real reason`);
  }
});

test('equality guard: fails against a deliberately introduced a === b', () => {
  // The demonstration the guard is worth having. Each mutant is a form the
  // defect realistically takes; all seven must be caught.
  const mutants: Array<[string, string]> = [
    [
      'the obvious one',
      'export function sameFinding(a: string, b: string): boolean {\n'
        + '  return parse(a).canonical === parse(b).canonical;\n}\n',
    ],
    [
      'via named locals',
      'const left = parse(a);\nconst right = parse(b);\nif (left.canonical !== right.canonical) return false;\n',
    ],
    [
      'via address-named identifiers',
      'function match(addressA: string, addressB: string) {\n  return addressA === addressB;\n}\n',
    ],
    [
      'via the digit segment alone',
      'if (subject.digits === other.digits) return true;\n',
    ],
    [
      'via Set membership',
      'const seen = new Set(addresses);\nif (seen.has(candidate)) return true;\n',
    ],
    [
      'via an array of canonical forms',
      'const subjectAddresses = [a.canonical, b.canonical];\nif (subjectAddresses.includes(candidate)) return true;\n',
    ],
    [
      'comparing parse() results directly',
      'if (parse(a) === parse(b)) return true;\n',
    ],
  ];

  for (const [name, source] of mutants) {
    const sites = scanSource('src/mutant.ts', source);
    assert.ok(sites.length > 0, `the guard did not detect the mutant: ${name}\n${source}`);
    assert.equal(
      unsanctioned(sites).length,
      sites.length,
      `the mutant "${name}" was wrongly pre-approved by a REVIEWED entry`,
    );
  }

  // And the guard really does gate the real tree: inject a mutant into a copy
  // of a real source file and confirm the whole-tree check would go red.
  const realFile = 'src/compare.ts';
  const injected = `${stripComments('')}export function wrong(a: string, b: string) {\n`
    + '  return parse(a).canonical === parse(b).canonical;\n}\n';
  assert.ok(unsanctioned(scanSource(realFile, injected)).length > 0);
});

test('equality guard: does not fire on comparisons that are not about place', () => {
  // The negative controls. If these trip, the guard is noise and will be
  // switched off, which is worse than not having it.
  const benign = [
    ['frame dispatch', "if (a.frame === b.frame) return locate(a, templates);\n"],
    ['frame id literal', "if (a.frame === 'BR') throw new AlcError('disabled', 'frame_disabled');\n"],
    ['anchor arity', 'if (a.anchors.length === 2) return parse(x);\n'],
    ['digit count', 'if (a.digits.length >= descriptor.maxDigits) return [];\n'],
    ['character in an alphabet', 'if (!descriptor.digitAlphabet.includes(ch)) throw e;\n'],
    ['frame registry', 'experimental: !ENABLED_FRAMES.has(frame),\n'],
    ['a comparison described in a comment', '// never write parse(a).canonical === parse(b).canonical\nreturn overlaps(a, b);\n'],
    ['a comparison inside a block comment', '/* parse(a).canonical === parse(b).canonical is wrong */\nreturn overlaps(a, b);\n'],
    ['an error code', "if ((e as AlcError).code === 'bad_digit') return null;\n"],
    // The real regression. `ADDRESSABLE` is the registry of vertebral levels an
    // address may name; a substring rule read the a-d-d-r inside it as an
    // address value and failed the suite on a level-label lookup.
    ['a registry whose name merely contains the letters addr',
      'const ADDRESSABLE = new Set(VERTEBRAL_LEVELS);\nif (!ADDRESSABLE.has(label)) problems.push(label);\n'],
    ['a flag whose name merely contains the letters addr',
      "if (opts.requireAddressableLabels === true) check(t);\n"],
  ] as const;
  for (const [name, source] of benign) {
    assert.deepEqual(
      scanSource('src/benign.ts', source).map((s) => s.code),
      [],
      `the guard fired on a benign comparison: ${name}`,
    );
  }
});

test('equality guard: the naming rule reads words, not substrings', () => {
  // Both halves of the narrowing that fixed the ADDRESSABLE false positive.
  // The first half is why the guard is still trusted; the second is why it is
  // still worth having. Losing either silently is the failure mode.
  for (const name of ['address', 'addr', 'addrB', 'addressA', 'findingAddr',
    'subjectAddresses', 'ADDRESS_A', 'alcCode', 'o.addr']) {
    assert.ok(isAddressName(name), `the naming rule stopped recognising ${name}`);
  }
  for (const name of ['ADDRESSABLE', 'addressable', 'requireAddressableLabels',
    'readdirSync', 'label', 'level', 'ALC_VERSION', 'errorCode', 'e.code']) {
    assert.ok(!isAddressName(name), `the naming rule fires on ${name}, which holds no address`);
  }
  assert.deepEqual(identifierWords('subjectAddresses'), ['subject', 'addresses']);
  assert.deepEqual(identifierWords('ADDRESSABLE'), ['addressable']);
  assert.deepEqual(identifierWords('ADDRESS_A'), ['address', 'a']);

  // And the structural rules do not depend on the name at all, so a collection
  // built out of addresses is still tainted however it is called.
  assert.ok(
    scanSource('src/x.ts', 'const levels = new Set(addresses);\nif (levels.has(candidate)) f();\n')
      .length > 0,
    'taint no longer propagates from an address-valued initialiser',
  );
});

test('equality guard: the scanner reads code, not prose', () => {
  // stripComments must preserve line numbers, or every reported location is
  // wrong and nobody will trust the output.
  const source = '/* a\n   b */\nconst x = 1;\n// c\nif (p.canonical === q.canonical) f();\n';
  assert.equal(stripComments(source).split('\n').length, source.split('\n').length);
  const sites = scanSource('src/x.ts', source);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].line, 5);
  // String literals survive, so a frame id stays readable as a literal.
  assert.ok(stripComments("const f = 'BD';\n").includes("'BD'"));
});

// ---------------------------------------------------------------------------
// SEMANTIC
// ---------------------------------------------------------------------------

test('equality guard: string equality is measurably the wrong question', () => {
  // The number in spec section 6, re-measured here rather than quoted, so the
  // guard carries its own justification. Same construction as compare.test.ts
  // but asserted as the *reason for the guard*: if this ever stops being true,
  // the guard should be reconsidered rather than silently kept.
  const r = rng(90210);
  const trials = 3000;
  const residualMm = 5;
  let stringAgreed = 0;
  let samePlaceAgreed = 0;
  let sumGapMm = 0;

  for (let i = 0; i < trials; i += 1) {
    const hemisphere = r() < 0.5 ? 'L' : 'R';
    const p = bvLocalToMm(brainAdult, hemisphere, {
      a: r() * 0.9,
      b: 0.1 + r() * 0.8,
      c: 0.1 + r() * 0.8,
    });
    const x = r() * 2 - 1;
    const y = r() * 2 - 1;
    const z = r() * 2 - 1;
    const n = Math.hypot(x, y, z) || 1;
    const q: [number, number, number] = [
      p[0] + (x / n) * residualMm,
      p[1] + (y / n) * residualMm,
      p[2] + (z / n) * residualMm,
    ];

    const a = encodeBrainVolume(brainAdult, p, 5).address;
    const b = encodeBrainVolume(brainAdult, q, 5).address;
    if (a === b) stringAgreed += 1;
    const sp = samePlace(a, b, { brainVolume: brainAdult }, { toleranceMm: residualMm });
    if (sp.same) samePlaceAgreed += 1;
    sumGapMm += sp.gapMm;
  }

  const stringRate = stringAgreed / trials;
  const samePlaceRate = samePlaceAgreed / trials;
  const meanGapMm = sumGapMm / trials;

  assert.ok(stringRate < 0.1, `string equality recognised ${(stringRate * 100).toFixed(1)}% — too reliable to justify the guard`);
  assert.ok(samePlaceRate > 0.99, `samePlace recognised only ${(samePlaceRate * 100).toFixed(1)}%`);
  // The addresses are not wrong, only the strings: the mean centre gap stays at
  // the order of the residual rather than blowing up.
  assert.ok(
    meanGapMm < residualMm * 2,
    `mean centre gap ${meanGapMm.toFixed(2)} mm should stay near the ${residualMm} mm residual`,
  );
});

test('equality guard: equality is not even right across templates for identical strings', () => {
  // The sharpest form of the rule. Two findings with the *same* address string,
  // resolved in two templates, are not at the same millimetres — so string
  // equality is not merely lossy across subjects, it is answering a different
  // question. This is what a screen that matches on the string gets wrong.
  const r = rng(13579);
  let identicalStrings = 0;
  let actuallyColocated = 0;
  for (let i = 0; i < 500; i += 1) {
    const hemisphere = r() < 0.5 ? 'L' : 'R';
    const local = { a: r() * 0.9, b: 0.1 + r() * 0.8, c: 0.1 + r() * 0.8 };
    const a = encodeBrainVolume(brainAdult, bvLocalToMm(brainAdult, hemisphere, local), 5).address;
    const b = encodeBrainVolume(brainChild, bvLocalToMm(brainChild, hemisphere, local), 5).address;
    if (a !== b) continue;
    identicalStrings += 1;
    const sp = samePlace(a, b, {}, {
      toleranceMm: 1,
      templatesA: { brainVolume: brainAdult },
      templatesB: { brainVolume: brainChild },
    });
    if (sp.same) actuallyColocated += 1;
  }
  assert.ok(identicalStrings > 100, `expected homologous points to share addresses, got ${identicalStrings}`);
  assert.ok(
    actuallyColocated < identicalStrings,
    'identical address strings in two templates were assumed coregistered',
  );
});

/**
 * Every cell reachable from `root` at `depth`, capped so the pair count stays
 * quadratic in something small. Children are addresses, not strings.
 */
function cellsAtDepth(root: string, depth: number, cap = 40): string[] {
  let level = [root];
  for (let d = 0; d < depth; d += 1) {
    const next: string[] = [];
    for (const a of level) {
      try {
        next.push(...children(a).map((c) => c.canonical));
      } catch { /* a frame that does not subdivide here */ }
    }
    if (next.length === 0) break;
    level = next.slice(0, cap);
  }
  return level;
}

test('equality guard: disjoint cells are never the same place at zero tolerance', () => {
  // Forbidding `a === b` only blocks the wrong answer one way round. This is
  // the other way round, and it is the stronger statement: two *disjoint* cells
  // share no millimetre point, so at toleranceMm 0 "same place" must be false
  // whatever the precision, the frame or the depth. Suggested by the DOG-5
  // review, which found two coarse cases; the sweep below measured the blast
  // radius at 1 329 of 3 424 pairs (38.8%) and is now the standing invariant.
  //
  // QA-12 was a defect in the sanctioned replacement for string equality, which
  // is what made it worse than the thing it replaces: a screen that followed
  // the spec and called samePlace() got a false "yes" where `a === b` would at
  // least have said no. Cause: cellRadiusMm() was half the cell's 3-D
  // *diagonal*, charged against a centre gap measured along one axis, so two
  // adjacent siblings could never come out disjoint. Fixed under DOG-5.
  const body = buildBodyTemplate(ADULT_MALE);
  const templates = { body, brainVolume: brainAdult };

  const offenders: string[] = [];
  let pairs = 0;
  for (const root of ['BD-T07', 'BV-L']) {
    for (let depth = 1; depth <= 3; depth += 1) {
      const cells = cellsAtDepth(root, depth);
      for (let i = 0; i < cells.length; i += 1) {
        for (let j = i + 1; j < cells.length; j += 1) {
          const [a, b] = [cells[i], cells[j]];
          if (contains(a, b) || contains(b, a)) continue; // not disjoint
          pairs += 1;
          const r = samePlace(a, b, templates, { toleranceMm: 0 });
          if (r.same && offenders.length < 10) {
            offenders.push(
              `${a} vs ${b}: same=true, gap ${r.gapMm.toFixed(1)} mm, budget ${r.budgetMm.toFixed(1)} mm`,
            );
          }
        }
      }
    }
  }

  assert.ok(pairs > 3000, `expected a wide sweep, got ${pairs} disjoint pairs`);
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length}+ of ${pairs} disjoint pairs report the same place at zero tolerance.\n`
      + 'Two cells that share no millimetre point cannot be the same place at any tolerance, least\n'
      + `of all zero. Check that cellRadiusMm() has not gone back to the 3-D diagonal.\n${offenders.join('\n')}`,
  );

  // The cases the DOG-5 review quoted, now the right way round and
  // deterministic: two whole vertebral levels and the two cerebral hemispheres
  // are each emphatically not the same place.
  for (const [a, b, expectedGap] of [
    ['BV-L', 'BV-R', 68.0],
    ['BD-T06', 'BD-T08', 49.5],
    ['BD-T06-12O', 'BD-T07-12O', 16.3],
  ] as Array<[string, string, number]>) {
    const r = samePlace(a, b, templates, { toleranceMm: 0 });
    assert.equal(r.same, false, `${a} vs ${b} are disjoint and must not compare equal`);
    // The gap is real and unchanged — it was never the gap that was wrong.
    assert.ok(Math.abs(r.gapMm - expectedGap) < 1, `${a} vs ${b}: gap ${r.gapMm.toFixed(1)} mm`);
    // The refusal has to be earned one of the two legitimate ways, so that a
    // future regression cannot make `same` false for an unrelated reason:
    // either the directional reach no longer covers the gap, or the structural
    // short-circuit fired because these are disjoint cells of one template.
    const structural = r.notes.some((n) => n.includes('share no millimetre point'));
    assert.ok(
      r.budgetMm <= r.gapMm || structural,
      `${a} vs ${b}: refused with budget ${r.budgetMm.toFixed(1)} mm over gap ${r.gapMm.toFixed(1)} mm `
        + 'and no structural note — the answer is right for no stated reason',
    );
  }

  // The structural short-circuit is scoped to zero tolerance, which is the
  // distinction that makes it correct rather than merely strict: at zero the
  // caller has asked whether these share a millimetre point, and disjoint cells
  // of one template definitively do not. State a tolerance and it is a
  // geometric question again.
  assert.equal(samePlace('BV-L', 'BV-R', templates, { toleranceMm: 0 }).same, false);
  assert.equal(samePlace('BV-L', 'BV-R', templates, { toleranceMm: 50 }).same, true);

  // A cell and its own ancestor remain the same place at zero tolerance: the
  // invariant above is about *disjoint* pairs, not about all pairs.
  assert.equal(samePlace('BV-L-47', 'BV-L-471', templates, { toleranceMm: 0 }).same, true);

  // And the mechanism that caused QA-12, kept as a number so the diagonal
  // cannot come back: it overstates a cell's reach along its finest axis
  // several-fold, in both frames, at every precision.
  for (const address of ['BV-L-471', 'BV-L-47102', 'BD-T07-03O-531']) {
    const e = locate(address, templates).extentMm;
    const inflation = Math.hypot(e[0], e[1], e[2]) / Math.min(e[0], e[1], e[2]);
    assert.ok(inflation > 3, `${address}: diagonal overstates the finest axis by ${inflation.toFixed(2)}x`);
  }
});

test('equality guard: the sanctioned calls answer the question equality cannot', () => {
  // The guard is only defensible if the alternative works. These are the calls
  // a consumer should reach for instead, exercised so the suite names them.
  assert.equal(overlaps('BV-L-471', 'BV-L-47'), true);
  assert.equal(overlaps('BV-L-471', 'BV-L-472'), false);
  assert.equal(coveringsIntersect(['BV-L-47'], ['BV-L-4710']), true);
  // samePlace cannot be called without stating what "same" means.
  assert.throws(
    () => samePlace('BV-L-471', 'BV-L-471', { brainVolume: brainAdult }, { toleranceMm: Number.NaN }),
    (e: unknown) => (e as { code?: string }).code === 'bad_tolerance',
  );
  assert.throws(
    () => samePlace('BV-L-471', 'BV-L-471', { brainVolume: brainAdult }, { toleranceMm: -1 }),
    (e: unknown) => (e as { code?: string }).code === 'bad_tolerance',
  );
  // And it refuses outright across frames rather than returning false.
  assert.throws(
    () =>
      samePlace('BV-L-471', 'BD-T07-02O-531', { brainVolume: brainAdult }, { toleranceMm: 5 }),
    (e: unknown) => (e as { code?: string }).code === 'frame_mismatch',
  );
});
