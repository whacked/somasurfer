/**
 * The address-string-equality guard, at the UI level.
 *
 * DOG-7 landed this guard for the library and it has been green since. But it
 * scans `packages/alc`, and a viewer can reimplement `a === b` in its own
 * comparison code while the library suite stays perfectly green. Spec §6 is a
 * product requirement, not a library note: across subjects, comparing addresses
 * by string agrees only 4% of the time at a 5 mm residual, while the two decoded
 * cells stay 5.9 mm apart — the residual itself.
 *
 * So the guard is wired in twice here, because the two halves catch different
 * things:
 *
 *   STATICALLY, over the viewer-side trees, reusing DOG-7's scanner rather than
 *   writing a second one. This catches the comparison that is never executed by
 *   a test — a branch behind a feature flag, an error path, a code path only a
 *   particular dataset reaches.
 *
 *   BEHAVIOURALLY, through `samePlaceAcrossSubjects` on the driver contract and
 *   the two `equality-guard` matrix rows. This catches the build that does the
 *   comparison somewhere the scanner cannot see it — inside a dependency, in a
 *   template string, in generated code — and it is also what the
 *   `address-string-equality` mutant is caught by.
 *
 * Neither half subsumes the other, which is why both are here.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, type EqualitySite } from '../../alc/test/guards/addressEquality.ts';
import { MUTANTS } from '../src/mutants.ts';
import { runSuite } from '../src/runner.ts';
import { referenceViewer } from '../src/referenceViewer.ts';
import { resolveFixture } from '../src/fixture.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const PACKAGES = dirname(PACKAGE_ROOT);

/**
 * Trees that ship UI code, or stand in for it.
 *
 * `atlas-qa` is scanned too, deliberately: the reference viewer is the stand-in
 * for the product and a guard its own author is exempt from is not a guard.
 * `atlas-web` is the current shipped client. When DOG-36's viewer package
 * lands, adding its directory here is the whole integration.
 */
const UI_TREES = ['atlas-qa', 'atlas-web', 'atlas-viewer'];

function sourceFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'test', 'fixtures'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(root, full));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(relative(root, full).split('\\').join('/'));
    }
  }
  return out.sort();
}

/**
 * A comparison against `null`, `undefined` or `''` is a PRESENCE test.
 *
 * `if (address !== null)` asks whether there is an address at all, which cannot
 * express a cross-subject identity claim — the thing the guard exists to
 * prevent. DOG-7's scanner is deliberately over-eager within its scope and does
 * not make this distinction, which is the right trade for the library; here it
 * would mean nine justifications that all say "this compares against null", and
 * a list of nine inert entries is how a reviewed list stops being read.
 *
 * Narrow on purpose: only these three literals, and only when one side is
 * exactly one of them.
 */
function isPresenceCheck(site: EqualitySite): boolean {
  const sentinel = /^(null|undefined|''|""|``)$/;
  return site.operands.some((o) => sentinel.test(o.trim()));
}

/**
 * In-scope comparisons that are reviewed and correct.
 *
 * Matched on (file, normalised code) like DOG-7's list, so inserting a line
 * above one does not churn the list.
 */
const REVIEWED: ReadonlyArray<{ file: string; code: string; reason: string }> = [
  {
    file: 'src/runner.ts',
    code: 'state.urlAddress === e.urlAddress,',
    reason:
      'The row asserts the URL holds EXACTLY the address the matrix pinned, in one template. String '
      + 'comparison is the correct instrument and covering overlap would be the wrong one: an '
      + 'overlapping-but-different address would satisfy an overlap test while meaning the viewer '
      + 'rewrote the user\'s link. This is a transcription check on a string, not a question about a '
      + 'place.',
  },
  {
    file: 'src/runner.ts',
    code: 'state.selection.address === e.selectionAddress,',
    reason:
      'Same argument as the row above, for the selection panel rather than the URL. Both operands are '
      + 'the matrix\'s own pinned literal and the build\'s echo of it, within a single template.',
  },
  {
    file: 'src/matrix.ts',
    code: 'row.expect.urlAddress !== undefined,',
    reason:
      'Integrity gate on the matrix, not on a view: asks whether the row AUTHOR stated an expectation '
      + 'for the URL. Compares against `undefined`, so it holds no address value at all.',
  },
  {
    file: 'src/matrix.ts',
    code: 'row.expect.selectionAddress !== undefined,',
    reason:
      'As above, for the selection panel\'s expectation rather than the URL\'s. Compares against '
      + '`undefined` to ask whether the row author stated an expectation at all, so it holds no '
      + 'address value and cannot express a claim about a place.',
  },
];

const normalise = (s: string): string => s.replace(/\s+/g, ' ').replace(/[;{,]+$/, '').trim();

function reviewed(site: EqualitySite): boolean {
  return REVIEWED.some(
    (r) => r.file === site.file && normalise(r.code) === normalise(site.code),
  );
}

function scanTree(packageName: string): EqualitySite[] {
  const root = join(PACKAGES, packageName);
  if (!existsSync(join(root, 'src'))) return [];
  return sourceFiles(join(root, 'src'))
    .map((f) => join('src', f))
    .flatMap((file) => scanSource(file, readFileSync(join(root, file), 'utf8')));
}

test('no unsanctioned address-string comparison in any UI tree', () => {
  const problems: string[] = [];
  for (const pkg of UI_TREES) {
    for (const site of scanTree(pkg)) {
      if (isPresenceCheck(site) || reviewed(site)) continue;
      problems.push(
        `${pkg}/${site.file}:${site.line} [${site.kind}] ${site.code}\n`
        + '      Addresses are never compared by value across subjects. Use the @gstack/alc covering '
        + 'primitives, or add a REVIEWED entry in this file saying why this one is safe.',
      );
    }
  }
  assert.deepEqual(problems, [], `unsanctioned address comparisons:\n  ${problems.join('\n  ')}`);
});

test('the scanner still fires, so a clean tree means clean and not broken', () => {
  // Without this, deleting the scanner's regexes would read as a pristine
  // codebase. An empty finding list has two causes and they must be
  // distinguishable.
  const sites = scanSource(
    'src/pretend.ts',
    'const a = parse(x);\nconst b = parse(y);\nif (a.canonical === b.canonical) return true;\n',
  );
  assert.ok(
    sites.length > 0,
    'the scanner found nothing in a file that literally compares two canonical addresses. It is broken, '
    + 'and every clean result above is meaningless.',
  );
  assert.equal(sites[0].kind, 'equality');
});

test('the scanner catches the membership form too', () => {
  // `const seen = new Set(addresses); seen.has(other)` is the quiet version of
  // the same defect, and the receiver's own name gives nothing away.
  const sites = scanSource(
    'src/pretend.ts',
    'const seen = new Set(addresses);\nif (seen.has(candidate)) return true;\n',
  );
  assert.ok(sites.some((s) => s.kind === 'membership'), 'the membership form is not detected');
});

test('every REVIEWED entry still matches a real site', () => {
  // A stale exemption is worse than none: it reads as review having happened
  // for a line that has since changed or moved.
  const all = UI_TREES.flatMap((pkg) => scanTree(pkg));
  for (const entry of REVIEWED) {
    assert.ok(
      all.some((s) => s.file === entry.file && normalise(s.code) === normalise(entry.code)),
      `REVIEWED entry for ${entry.file} no longer matches any site: ${JSON.stringify(entry.code)}. `
      + 'Remove it, or update it to the line as it now reads.',
    );
  }
});

test('every REVIEWED entry gives a reason, not a shrug', () => {
  for (const entry of REVIEWED) {
    assert.ok(
      entry.reason.length >= 80,
      `the exemption for ${entry.file} is ${entry.reason.length} characters. The cost of an exemption is `
      + 'one sentence explaining why it is safe; that is the only thing keeping the list honest.',
    );
  }
});

// ---------------------------------------------------------------------------
// The behavioural half
// ---------------------------------------------------------------------------

test('the reference build answers "same place?" from geometry, not from strings', () => {
  const driver = referenceViewer({ fixture: resolveFixture({ preferOwn: true }) });
  return driver.samePlaceAcrossSubjects(['BD-T07-03O-531'], ['BD-T07-03O-530'], 25).then((answer) => {
    assert.notEqual(
      answer.basis,
      'string-equality',
      'the build compared address strings to answer a cross-subject question',
    );
    assert.equal(
      answer.same,
      true,
      'two adjacent cells a few millimetres apart are the same place at a 25 mm tolerance. Answering '
      + 'no here is the string-equality answer, whatever the basis field claims.',
    );
  });
});

test('a build that compares strings is caught by the equality-guard rows', async () => {
  // The negative control for this specific requirement, asserted here as well
  // as in negative-control.test.ts, because this is the file somebody reads
  // when they want to know whether the guard works.
  const mutant = MUTANTS.find((m) => m.id === 'address-string-equality');
  assert.ok(mutant, 'the address-string-equality mutant has been removed');
  const fixture = resolveFixture({ preferOwn: true });
  const report = await runSuite(mutant.build({ fixture }), { strict: true, fixture });

  assert.equal(report.harnessVerdict, 'FAIL', 'a string-comparing build must fail the suite');
  const failed = new Set(report.results.filter((r) => r.outcome === 'fail').map((r) => r.id));
  for (const id of mutant.caughtBy) {
    assert.ok(failed.has(id), `row ${id} was supposed to catch the string-equality build and did not`);
  }
});
