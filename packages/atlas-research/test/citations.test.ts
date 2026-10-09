/**
 * The citation record: every identifier in the shipped dataset traces to a
 * named source, and the two that do not are recorded as such.
 *
 * `tools/check-research-dataset.mjs` owns the build-breaking version of this
 * rule and proves it can go red on eight different hand-edits. These tests are
 * the consumer-visible half: what a reader of this package can rely on about
 * `data/citation-report.json`, asserted where the suite will see it rather than
 * only inside a gate script.
 *
 * What none of this establishes — stated here because it is the assertion that
 * carries the risk — is that these papers CLAIM what the findings attribute to
 * them. Crossref confirms a paper exists. Only a person reading the sources can
 * confirm the rest.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { safeHref, sourceLink } from '../src/index.ts';
import { readJson, seedDataset } from './helpers.ts';

interface Row {
  paperId: string;
  status: string;
  retrievedOn: string;
  reason: string;
  identifierJustified: { kind: string; value: string; source: string } | null;
  returned: Record<string, unknown> | null;
  candidates: unknown[] | null;
  queries: { route: string; endpoint: string }[];
}

interface Report {
  schema: string;
  retrievedOn: string;
  datasetVersion: string;
  tally: Record<string, number>;
  sources: { id: string; endpoint: string; endpoints?: string[] }[];
  rows: Row[];
}

const report = readJson('data/citation-report.json') as Report;
const seed = seedDataset();

/** The statuses under which an identifier may exist in the dataset. */
const JUSTIFYING = new Set(['verified', 'resolved']);

const rowFor = (paperId: string): Row | undefined => report.rows.find((r) => r.paperId === paperId);

/**
 * The rule, as a function, so the must-pass case at the bottom can run it
 * against a deliberately corrupted dataset and prove it bites.
 */
function unjustifiedIdentifiers(papers: readonly { id: string; identifier: { kind: string; value: string | null } }[]) {
  const bad: string[] = [];
  for (const p of papers) {
    if (p.identifier.kind === 'none') continue;
    const row = rowFor(p.id);
    if (!row || !JUSTIFYING.has(row.status)) {
      bad.push(`${p.id}: no justifying row`);
      continue;
    }
    if (String(row.identifierJustified?.value).toLowerCase() !== String(p.identifier.value).toLowerCase()) {
      bad.push(`${p.id}: report justifies ${row.identifierJustified?.value}, dataset carries ${p.identifier.value}`);
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Coverage and justification
// ---------------------------------------------------------------------------

test('the report covers every seed paper and no others', () => {
  assert.equal(report.schema, 'citation-report/1');
  assert.equal(report.datasetVersion, seed.version);
  const reported = report.rows.map((r) => r.paperId).sort();
  const expected = seed.papers.map((p) => p.id).sort();
  assert.deepEqual(reported, expected);
  assert.equal(new Set(reported).size, reported.length, 'a paper is reported twice');
});

test('every identifier in the dataset is justified by a named source', () => {
  // The whole point. An identifier nothing returned is the failure mode that
  // put twelve invented UBERON accessions in the fixture before b0d114a.
  assert.deepEqual(unjustifiedIdentifiers(seed.papers), []);
  const withId = seed.papers.filter((p) => p.identifier.kind !== 'none');
  assert.ok(withId.length >= 20, `enough identifiers to be worth checking; found ${withId.length}`);
});

test('a justifying row records what the source actually returned', () => {
  // A row that only says "verified" is a verdict with no evidence under it, and
  // would be indistinguishable from a fabricated one.
  const declared = new Set(report.sources.map((s) => s.id));
  for (const r of report.rows.filter((x) => JUSTIFYING.has(x.status))) {
    assert.ok(r.returned && Object.values(r.returned).some((v) => v !== null), `${r.paperId} returned nothing`);
    assert.ok(r.identifierJustified?.value, `${r.paperId} justifies no identifier`);
    assert.ok(declared.has(r.identifierJustified.source), `${r.paperId} cites undeclared source`);
  }
});

test('every row is a point-in-time claim against a declared endpoint', () => {
  const endpoints = report.sources.flatMap((s) => s.endpoints ?? [s.endpoint]);
  for (const r of report.rows) {
    assert.match(r.retrievedOn, /^\d{4}-\d{2}-\d{2}$/, `${r.paperId} has no retrievedOn`);
    assert.ok(r.queries.length > 0, `${r.paperId} records no query`);
    for (const q of r.queries) {
      assert.ok(
        endpoints.some((e) => q.endpoint.startsWith(e.split('?')[0])),
        `${r.paperId} queried ${q.endpoint}, which no declared source covers`,
      );
    }
  }
});

test('both routes are recorded for every paper, not just the one the dataset needed', () => {
  // Otherwise adopting a discovered DOI erases the search that found it, and
  // the evidence for an identifier survives only in git history.
  for (const r of report.rows) {
    assert.ok(
      r.queries.some((q) => q.route === 'crossref-search'),
      `${r.paperId} records no title-and-author search`,
    );
    assert.ok(
      r.queries.some((q) => q.route === 'pubmed-esearch'),
      `${r.paperId} records no PubMed route`,
    );
    assert.ok(r.candidates !== null, `${r.paperId} records no candidate list`);
  }
});

test('the tally is the rows’ tally and not a stale literal', () => {
  const recomputed: Record<string, number> = {};
  for (const r of report.rows) recomputed[r.status] = (recomputed[r.status] ?? 0) + 1;
  assert.deepEqual(report.tally, recomputed);
});

// ---------------------------------------------------------------------------
// The papers that resolved to nothing
// ---------------------------------------------------------------------------

test('a paper with no identifier says why, and carries no URL', () => {
  const none = seed.papers.filter((p) => p.identifier.kind === 'none');
  assert.ok(none.length > 0, 'the policy is exercised');
  for (const p of none) {
    const row = rowFor(p.id);
    assert.ok(row, `${p.id} has no row`);
    assert.ok(!JUSTIFYING.has(row.status), `${p.id} is kind "none" but its row justifies an identifier`);
    assert.ok(row.reason.length > 40, `${p.id}: "${row.reason}" is not a reason`);
    assert.equal(p.identifier.value, null);
    assert.equal(p.sourceUrl, null, `${p.id} has no identifier but does have a URL`);
    // An unresolved paper must still be findable by hand, which is the whole
    // justification for shipping one.
    assert.ok(p.authors.length > 0 && p.venue.length > 0 && p.year > 1800, `${p.id} is not resolvable by hand`);
  }
});

// ---------------------------------------------------------------------------
// The trust boundary, now that a real DOI exercises it
// ---------------------------------------------------------------------------

test('a DOI containing angle brackets cannot reach an href raw', () => {
  // Amunts 1999 carries a Wiley SICI DOI: 10.1002/(SICI)...<319::AID-CNE10>...
  // The angle brackets are injection-shaped, and this is the first record in
  // the dataset that makes the README's "render text as text" rule concrete
  // rather than theoretical.
  const paper = seed.papers.find((p) => p.id === 'paper:amunts-1999-broca');
  assert.ok(paper, 'the SICI-DOI paper is still in the seed');
  assert.ok(paper.identifier.value?.includes('<'), 'this test is pointless if the DOI lost its brackets');

  const href = safeHref(paper.sourceUrl);
  assert.ok(href !== null, 'a registered DOI must still produce a link');
  assert.ok(!/[<>]/.test(href), `an angle bracket survived into the href: ${href}`);
  assert.ok(href.includes('%3C') && href.includes('%3E'), 'the brackets should be percent-encoded, not dropped');

  // The citation text keeps the DOI verbatim — it is text, and the consumer
  // contract in README.md requires textContent. What must not happen is the
  // link silently disappearing because the URL looked hostile.
  const link = sourceLink('Amunts K (1999).', paper.sourceUrl);
  assert.equal(link.unlinkedReason, null);
  assert.equal(link.href, href);
});

// ---------------------------------------------------------------------------
// The must-pass case: this suite's checks can fail
// ---------------------------------------------------------------------------

test('the justification check can fail', () => {
  // Without this, `every identifier is justified` would pass just as happily
  // against a function that returned [] unconditionally. Point a paper at a
  // DOI no source returned and the check must name it.
  const corrupted = seed.papers.map((p) =>
    p.id === 'paper:glasser-2016-mmp1' ? { ...p, identifier: { kind: 'doi', value: '10.9999/invented' } } : p,
  );
  const found = unjustifiedIdentifiers(corrupted);
  assert.equal(found.length, 1, `expected exactly one defect, got ${JSON.stringify(found)}`);
  assert.match(found[0], /glasser-2016-mmp1/);
  assert.match(found[0], /10\.9999\/invented/);

  // And a paper with no row at all is caught too, not silently skipped.
  const orphan = unjustifiedIdentifiers([
    { id: 'paper:not-in-the-report', identifier: { kind: 'doi', value: '10.1234/x' } },
  ]);
  assert.deepEqual(orphan, ['paper:not-in-the-report: no justifying row']);
});
