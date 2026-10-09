/**
 * The minimal reproduction of every open defect from the adversarial pass.
 *
 * Full write-ups, severities and suggested fixes: docs/alc-1-attack-report.md.
 *
 * Each test here asserts that a defect *still reproduces*. That is deliberate.
 * It keeps CI green while the defects are open, it makes each one a single
 * named line in the test output rather than a paragraph in a document nobody
 * re-reads, and when a fix lands the test fails with instructions — which is
 * the only reliable way to notice that a characterisation test has become a
 * guarantee.
 *
 * So: a failure here is good news. Read the message, replace the test with the
 * guarantee it was standing in for, in the suite that should own it from then
 * on, and update the report. Do not just delete it.
 *
 * ## The naming rule, which is load-bearing
 *
 * **A `node:test` title contains `QA-<n>` if and only if defect n is still
 * open and that test is what pins it.** Nothing else in the repo may put a
 * defect id in a test title.
 *
 * That is not cosmetic. `known defects: the report's status table matches the
 * tests` below derives each defect's status by scanning every suite's test
 * titles, and checks it against the status table in
 * docs/alc-1-attack-report.md. So the retirement protocol is:
 *
 *   1. Re-measure, with the measurement that found the defect.
 *   2. Replace the characterisation test with the guarantee, under a title
 *      that states the guarantee and does NOT carry the id. Say in a comment
 *      that it was the QA-<n> characterisation test, so the history survives.
 *   3. Delete the KNOWN_DEFECTS entry in fuzz/invariants.ts.
 *   4. Flip the report row to `**fixed** in <sha>`, and fix the counts
 *      sentence under the table.
 *
 * Skip any of those and the suite goes red naming the one you skipped. The
 * drift this replaced was a row reading "open — locate() still answers
 * homology: 'exact'" that survived a full run after the fix had landed,
 * because the old check only asked whether the id *appeared* in the report.
 *
 * Defects with a natural home elsewhere are pinned there instead; INDEX below
 * is the complete id list, and the status table in the report is the status.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every defect id, so the index above cannot drift from the report. */
export const INDEX = [
  'QA-1', 'QA-2', 'QA-3', 'QA-4', 'QA-5', 'QA-6', 'QA-7', 'QA-8', 'QA-9', 'QA-10', 'QA-11',
  'QA-12', 'QA-13',
] as const;

// QA-5 and QA-7 were retired on 2026-10-09. Both were the same mistake in the
// same function — `splitAddress` doing work on the raw input that spec §7 and
// §3 put after canonicalisation — and both characterisation tests were
// replaced by the guarantee they stood in for, in the suite that owns it:
//
//   QA-5  check symbol verified against the input body, not the canonical one
//         -> conformance.test.ts, 'check symbol: verified against the
//            canonical body, in both directions'
//   QA-7  Unicode confusables surviving toUpperCase() into a valid address
//         -> fuzz.test.ts, 'fuzz: a non-ASCII code point is rejected before
//            case mapping can make it legal'
//
// QA-11 was retired on 2026-10-09 with QA-3, QA-4 and QA-8 (DOG-16):
// `recommendedPrecision` reads the frame descriptor for both bounds —
// `minDigits` as well as `maxDigits` — so it can no longer recommend `BR-L`, a
// string `parse()` rejects, and no longer disagrees with `BR.maxDigits`. All
// four guarantees live with the rest of the precision contract, in
// precision-honesty.test.ts; QA-11's is 'precision: every recommendation is a
// precision its frame can express'.
//
// Nothing in this file is a characterisation test any more. The three tests
// below are the status-table consistency checks, which is why it still imports
// no library code.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, '..', '..', '..', 'docs', 'alc-1-attack-report.md');
const readReport = () => readFileSync(REPORT_PATH, 'utf8');

/** Every `test('...')` title in every suite, with the file it came from. */
function testTitles(): Array<{ file: string; title: string }> {
  const out: Array<{ file: string; title: string }> = [];
  for (const file of readdirSync(HERE).filter((f) => f.endsWith('.test.ts'))) {
    const src = readFileSync(join(HERE, file), 'utf8');
    for (const m of src.matchAll(/^\s*test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm)) {
      out.push({ file, title: m[2] });
    }
  }
  return out;
}

/**
 * Which defects still have a characterisation test, by the naming rule in this
 * file's header: a test title carries `QA-<n>` iff it pins open defect n.
 */
function pinnedDefects(): Map<string, Array<{ file: string; title: string }>> {
  const byId = new Map<string, Array<{ file: string; title: string }>>();
  for (const t of testTitles()) {
    for (const m of t.title.matchAll(/\bQA-(\d+)\b/g)) {
      const id = `QA-${m[1]}`;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id)!.push(t);
    }
  }
  return byId;
}

/** The report's status table, parsed. */
function reportRows(): Map<string, { severity: string; status: string; cell: string }> {
  const rows = new Map<string, { severity: string; status: string; cell: string }>();
  // Scoped to the one table whose header is `| id | severity | status |`. The
  // report has other tables with a QA id in the first column — the retirement
  // evidence one — and reading those as status rows is exactly the kind of
  // false reading this check exists to prevent.
  const lines = readReport().split('\n');
  const start = lines.findIndex((l) => /^\|\s*id\s*\|\s*severity\s*\|\s*status\s*\|\s*$/.test(l));
  assert.notEqual(start, -1, "the report has no '| id | severity | status |' table header");
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const m = /^\|\s*(QA-\d+)\s*\|([^|]*)\|(.*?)\|\s*$/.exec(lines[i]);
    assert.ok(m, `unparseable row in the status table: ${lines[i]}`);
    const cell = m[3];
    const status = /\*\*(open|fixed)\*\*/.exec(cell)?.[1] ?? '';
    rows.set(m[1], { severity: m[2].trim(), status, cell });
  }
  return rows;
}

// ---------------------------------------------------------------------------
test('known defects: the index matches the report', () => {
  // Cheap guard against the ledger and the document drifting apart. Every id in
  // INDEX must appear in the report, and the report must not describe a defect
  // that is missing from INDEX.
  const report = readReport();
  for (const id of INDEX) {
    assert.ok(report.includes(id), `${id} is in the test index but not in docs/alc-1-attack-report.md`);
  }
  for (const m of report.matchAll(/\bQA-(\d+)\b/g)) {
    assert.ok(
      (INDEX as readonly string[]).includes(`QA-${m[1]}`),
      `the report describes QA-${m[1]}, which is missing from INDEX in this file`,
    );
  }
});

test("known defects: the report's status table matches the tests", () => {
  // The check the previous one could not make. "Appears in both places" let a
  // row claim QA-1 was open for a full run after the fix landed, because the
  // id appeared either way. This one reads the actual tests.
  const rows = reportRows();
  const pinned = pinnedDefects();

  // Every defect has exactly one status row, and no row is unparseable.
  for (const id of INDEX) {
    const row = rows.get(id);
    assert.ok(row, `${id} has no status row in the report's status table`);
    assert.ok(
      row.status === 'open' || row.status === 'fixed',
      `${id}'s status row states neither **open** nor **fixed**: ${row.cell.trim()}`,
    );
  }
  for (const id of rows.keys()) {
    assert.ok(
      (INDEX as readonly string[]).includes(id),
      `the status table has a row for ${id}, which is missing from INDEX`,
    );
  }

  // The two directions that matter.
  for (const id of INDEX) {
    const { status, cell } = rows.get(id)!;
    const tests = pinned.get(id) ?? [];
    const where = tests.map((t) => `${t.file} "${t.title}"`).join(', ');

    if (status === 'open') {
      assert.ok(
        tests.length > 0,
        `the report says ${id} is open, but no test title carries ${id}, so nothing is `
          + 'watching it. Either the defect was fixed and this row was never flipped — '
          + `set it to '**fixed** in <sha>' — or the characterisation test was deleted `
          + 'instead of being replaced, which is the one thing the protocol forbids. '
          + "See this file's header.",
      );
    } else {
      assert.equal(
        tests.length,
        0,
        `the report says ${id} is fixed, but a characterisation test still pins it: `
          + `${where}. Either the fix has not landed and the row is premature, or the `
          + 'test has become a guarantee and its title must lose the defect id (keep '
          + "the id in a comment). See this file's header.",
      );
      // A retirement that cannot say what fixed it is not a retirement.
      assert.match(
        cell,
        /\*\*fixed\*\*\s+in\s+`[0-9a-f]{7,40}`/,
        `${id} is marked fixed but the row cites no commit. Write '**fixed** in `
          + `\`<sha>\`'. Row: ${cell.trim()}`,
      );
    }
  }

  // The per-defect section heading carries the same claim as the table, and a
  // reader scrolling to the write-up sees the heading, not the table.
  const report = readReport();
  const headings = new Map(
    [...report.matchAll(/^###\s+(QA-\d+)\s+—\s*(.*)$/gm)].map((m) => [m[1], m[2]]),
  );
  for (const id of INDEX) {
    const heading = headings.get(id);
    assert.ok(heading, `${id} has no '### ${id} — ...' section in the report`);
    const saysFixed = /\bFIXED\b/.test(heading);
    assert.equal(
      saysFixed,
      rows.get(id)!.status === 'fixed',
      `${id}'s status row says ${rows.get(id)!.status} but its section heading `
        + `${saysFixed ? 'is marked FIXED' : 'is not marked FIXED'}: "### ${id} — ${heading}"`,
    );
  }

  // An open defect's `**Pinned:**` line must name a file the test is in, so the
  // report can still be used to find the test.
  for (const id of INDEX) {
    if (rows.get(id)!.status !== 'open') continue;
    const files = new Set((pinned.get(id) ?? []).map((t) => t.file));
    const claims = [...report.matchAll(/\*\*Pinned:\*\*([^]*?)(?=\n\n|\n#|$)/g)]
      .map((m) => m[1])
      .filter((c) => new RegExp(`\\b${id}\\b`).test(c));
    if (claims.length === 0) continue; // not every defect spells out a Pinned line
    assert.ok(
      claims.some((c) => [...files].some((f) => c.includes(f))),
      `the report's **Pinned:** line for ${id} names none of the files the test is `
        + `actually in (${[...files].join(', ')}). Claims: ${JSON.stringify(claims)}`,
    );
  }
});

test("known defects: the report's closed count matches its own rows", () => {
  // The prose under the table said "Five of the twelve", then "Eight of the
  // thirteen", against six fixed rows. It is a derived number, so derive it.
  const rows = reportRows();
  const fixed = [...rows.entries()].filter(([, r]) => r.status === 'fixed').map(([id]) => id);
  const openHigh = [...rows.entries()]
    .filter(([, r]) => r.status === 'open' && r.severity === 'High')
    .map(([id]) => id);

  // Line wrapping is not part of the claim, so match against flattened prose.
  const report = readReport().replace(/\s+/g, ' ');
  const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
    'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen'];
  const word = (n: number) => WORDS[n]?.toLowerCase() ?? String(n);
  const claim = /\*\*(\w+) of the (\w+) are closed\*\*/.exec(report);
  assert.ok(claim, "the report must state '**<N> of the <M> are closed**' under the status table");
  assert.equal(
    claim[1].toLowerCase(), word(fixed.length),
    `the report claims ${claim[1]} defects are closed; ${fixed.length} rows say fixed `
      + `(${fixed.join(', ')})`,
  );
  assert.equal(
    claim[2].toLowerCase(), word(rows.size),
    `the report claims ${claim[2]} defects in total; the table has ${rows.size} rows`,
  );

  // And the list of still-open High defects, which is the part a reader acts on.
  const listed = /The (\w+) High ones? still open[,:]? ([^.]*?),? are\b/.exec(report);
  assert.ok(listed, "the report must name the still-open High defects as 'The <N> High ones still open, <ids>, are ...'");
  assert.equal(listed[1].toLowerCase(), word(openHigh.length),
    `the report says ${listed[1]} High defects are open; the table says ${openHigh.length}`);
  for (const id of openHigh) {
    assert.ok(listed[2].includes(id), `${id} is High and open but is not in the report's list: "${listed[2]}"`);
  }
  for (const m of listed[2].matchAll(/\bQA-\d+\b/g)) {
    assert.ok(openHigh.includes(m[0]),
      `the report lists ${m[0]} as a still-open High defect, but the table does not`);
  }
});
