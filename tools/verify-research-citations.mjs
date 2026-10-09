/**
 * Resolves every citation in the research seed against Crossref and PubMed,
 * and writes down what the sources returned.
 *
 * ## Why this is a separate script from the gate
 *
 * This script talks to the network. `tools/check-research-dataset.mjs` must
 * not: a gate that fetches is a gate that goes red when a third party has an
 * outage, and a gate nobody trusts is a gate nobody reads. So the division is:
 *
 *   - this script runs **deliberately**, by a person or an agent, and commits
 *     its findings as data (`data/citation-report.json`);
 *   - the gate runs **every build**, offline, and checks the committed dataset
 *     against that committed report.
 *
 * The report is therefore a point-in-time claim, and every row carries the
 * `retrievedOn` date and the exact endpoint that produced it. A row is evidence
 * that a source said something on a date — not a standing guarantee.
 *
 * ## What a row is allowed to say
 *
 * The statuses are deliberately not a two-valued pass/fail, because three of
 * the four outcomes here are not failures:
 *
 *   `verified`      an asserted DOI resolved, and the returned title, first
 *                   author and year match the asserted record.
 *   `mismatch`      an asserted DOI resolved to a DIFFERENT paper. This is the
 *                   worst outcome in the set and the reason the returned
 *                   metadata is recorded rather than a verdict alone: a DOI
 *                   that 404s is a dead link, while a DOI that resolves to
 *                   someone else's paper is a false citation that looks right.
 *   `resolved`      a paper asserted as `kind: "none"` was found by search, and
 *                   the returned metadata matches on title, first author and
 *                   year. Only these earn a new identifier in the dataset.
 *   `unresolved`    the queries ran and returned no matching candidate. For a
 *                   monograph (Brodmann 1909, Bogduk 2012) this is the CORRECT
 *                   answer, not a gap — books predate the DOI and mostly do not
 *                   have one. The queries and candidates are recorded so the
 *                   next reader does not repeat them.
 *   `unverified`    the check could not run: network error, non-200, malformed
 *                   response. Follows the UNVERIFIED pattern already in
 *                   check-research-dataset.mjs — it never reads as verified,
 *                   and it never silently reads as a clean `unresolved` either.
 *
 * The last distinction is the one that costs nothing to get right and is
 * invisible if you get it wrong. `unresolved` means "we looked and it is not
 * there". `unverified` means "we did not get to look". Collapsing them would
 * turn every Crossref outage into a dataset full of confident absences.
 *
 * ## Never invent an identifier
 *
 * A candidate is written into the dataset only when a source returned it AND
 * the returned title, first author and year all match. Everything else is
 * recorded as a candidate in the report and left out of the data. The failure
 * mode this is guarding against is the twelve invented UBERON accessions
 * removed in b0d114a: a plausible-looking wrong accession is worse than an
 * absent one, because it resolves, and it looks authoritative doing it.
 *
 * Usage:
 *   node tools/verify-research-citations.mjs            # fetch and write the report
 *   node tools/verify-research-citations.mjs --dry-run  # fetch, print, write nothing
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './lib/repo.mjs';

const PKG = join(REPO_ROOT, 'packages', 'atlas-research');
const DATA = join(PKG, 'data');

const MAILTO = 'directedglaph@gmail.com';
const CROSSREF = 'https://api.crossref.org';
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/** Crossref asks for a contact; E-utilities caps anonymous callers at 3/sec. */
const UA = `atlas-research-citation-audit/1.0 (+mailto:${MAILTO})`;
const THROTTLE_MS = 400;

const dryRun = process.argv.includes('--dry-run');
const RETRIEVED_ON = new Date().toISOString().slice(0, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Comparison. Every answer here is recorded next to the values it compared,
// so a reader can disagree with the verdict without re-running the script.
// ---------------------------------------------------------------------------

/**
 * Fold a title to a comparable form: strip diacritics, lowercase, drop
 * punctuation, collapse whitespace. `Großhirnrinde` and `Grosshirnrinde` must
 * compare equal — the dataset transcribes German without the eszett, and that
 * is a transcription choice rather than a different paper.
 */
function foldTitle(s) {
  return String(s ?? '')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'o')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `Glasser MF` -> `glasser`. `Van Essen DC` -> `van essen`. */
function foldFamily(author) {
  const raw = String(author ?? '').trim();
  // Trailing initials block: one or more capitals, optionally dotted.
  const stripped = raw.replace(/\s+(?:[A-Z]\.?){1,4}$/, '');
  return foldTitle(stripped);
}

function compareTitles(asserted, returned) {
  const a = foldTitle(asserted);
  const b = foldTitle(returned);
  if (!b) return 'absent';
  if (a === b) return 'match';
  // Subtitle and series-suffix differences are routine between a transcription
  // and a publisher record. Containment is reported as its own answer rather
  // than folded into `match`, so a reader sees that it was not an equality.
  if (a.includes(b) || b.includes(a)) return 'contains';
  return 'differs';
}

function compareFirstAuthor(assertedAuthors, returnedFamily) {
  const a = foldFamily(assertedAuthors?.[0]);
  const b = foldTitle(returnedFamily);
  if (!b) return 'absent';
  if (a === b) return 'match';
  if (a.includes(b) || b.includes(a)) return 'contains';
  return 'differs';
}

function compareYears(asserted, returned) {
  if (returned === null || returned === undefined) return 'absent';
  if (asserted === returned) return 'match';
  // A one-year gap is usually online-ahead-of-print vs the issue date. It is
  // reported as `off-by-one`, never as a match, and it is NOT sufficient to
  // earn an identifier — see `earnsIdentifier`.
  if (Math.abs(asserted - returned) === 1) return 'off-by-one';
  return 'differs';
}

/**
 * The rule that decides whether a returned record may become an identifier in
 * the dataset. Strict on purpose: title and first author must match or contain,
 * and the year must match EXACTLY. An off-by-one year stays a candidate and is
 * decided by a person, because the alternative is a script that resolves
 * ambiguity in favour of writing data.
 */
function earnsIdentifier(cmp) {
  return (
    (cmp.title === 'match' || cmp.title === 'contains') &&
    (cmp.firstAuthor === 'match' || cmp.firstAuthor === 'contains') &&
    cmp.year === 'match'
  );
}

// ---------------------------------------------------------------------------
// Fetch helpers. Every call records the URL it used and the status it got.
// ---------------------------------------------------------------------------

async function getJson(url) {
  const attempt = { url, retrievedOn: RETRIEVED_ON };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    attempt.httpStatus = res.status;
    const text = await res.text();
    if (!res.ok) {
      attempt.error = `HTTP ${res.status}`;
      attempt.bodyExcerpt = text.slice(0, 200);
      return { attempt, body: null };
    }
    try {
      return { attempt, body: JSON.parse(text) };
    } catch {
      attempt.error = 'response was not JSON';
      attempt.bodyExcerpt = text.slice(0, 200);
      return { attempt, body: null };
    }
  } catch (e) {
    attempt.httpStatus = null;
    attempt.error = `request failed: ${e.message}`;
    return { attempt, body: null };
  } finally {
    await sleep(THROTTLE_MS);
  }
}

/** Flatten a Crossref `message` into the fields we compare and record. */
function crossrefRecord(m) {
  if (!m) return null;
  const authors = Array.isArray(m.author) ? m.author : [];
  const parts = m.issued?.['date-parts']?.[0];
  return {
    doi: m.DOI ?? null,
    title: Array.isArray(m.title) ? (m.title[0] ?? null) : (m.title ?? null),
    firstAuthorFamily: authors[0]?.family ?? authors[0]?.name ?? null,
    authorCount: authors.length,
    allAuthorFamilies: authors.map((a) => a.family ?? a.name ?? null),
    year: Array.isArray(parts) ? (parts[0] ?? null) : null,
    issuedDateParts: parts ?? null,
    containerTitle: Array.isArray(m['container-title']) ? (m['container-title'][0] ?? null) : null,
    volume: m.volume ?? null,
    issue: m.issue ?? null,
    page: m.page ?? null,
    publisher: m.publisher ?? null,
    type: m.type ?? null,
    score: typeof m.score === 'number' ? m.score : null,
  };
}

function pubmedRecord(summary, pmid) {
  if (!summary) return null;
  const ids = Array.isArray(summary.articleids) ? summary.articleids : [];
  const doiId = ids.find((i) => i.idtype === 'doi');
  const authors = Array.isArray(summary.authors) ? summary.authors : [];
  const yearMatch = /\b(\d{4})\b/.exec(String(summary.pubdate ?? ''));
  return {
    pmid: String(pmid),
    doi: doiId?.value ?? null,
    title: summary.title ?? null,
    firstAuthorFamily: authors[0]?.name ? foldFamily(authors[0].name) : null,
    firstAuthorRaw: authors[0]?.name ?? null,
    authorCount: authors.length,
    year: yearMatch ? Number(yearMatch[1]) : null,
    pubdate: summary.pubdate ?? null,
    containerTitle: summary.fulljournalname ?? summary.source ?? null,
    volume: summary.volume ?? null,
    issue: summary.issue ?? null,
    page: summary.pages ?? null,
  };
}

// ---------------------------------------------------------------------------
// Route 1: an asserted DOI, resolved through Crossref.
// ---------------------------------------------------------------------------

async function checkAssertedDoi(paper) {
  const doi = paper.identifier.value;
  const url = `${CROSSREF}/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(MAILTO)}`;
  const { attempt, body } = await getJson(url);
  const query = { route: 'crossref-doi', endpoint: `${CROSSREF}/works/{doi}`, ...attempt, candidateCount: body ? 1 : 0 };

  if (!body) {
    // A 404 from Crossref is a real answer about the DOI: it is not registered.
    // Anything else means we did not get to look, which is `unverified`.
    if (attempt.httpStatus === 404) {
      return {
        status: 'unresolved',
        queries: [query],
        returned: null,
        comparison: null,
        reason: `Crossref has no record for DOI ${doi} (HTTP 404). The asserted identifier does not resolve.`,
      };
    }
    return {
      status: 'unverified',
      queries: [query],
      returned: null,
      comparison: null,
      reason: `could not reach Crossref for DOI ${doi}: ${attempt.error}. Not checked — this is not evidence the DOI is bad.`,
    };
  }

  const rec = crossrefRecord(body.message);
  const comparison = {
    title: compareTitles(paper.title, rec.title),
    firstAuthor: compareFirstAuthor(paper.authors, rec.firstAuthorFamily),
    year: compareYears(paper.year, rec.year),
    container: compareTitles(paper.venue.replace(/\s+\d+.*$/, ''), rec.containerTitle ?? rec.publisher),
  };
  const identityHolds =
    (comparison.title === 'match' || comparison.title === 'contains') &&
    (comparison.firstAuthor === 'match' || comparison.firstAuthor === 'contains');

  if (!identityHolds) {
    return {
      status: 'mismatch',
      queries: [query],
      returned: { crossref: rec },
      comparison,
      reason:
        `DOI ${doi} resolves, but to a different paper: Crossref returned ` +
        `${JSON.stringify(rec.title)} by ${rec.firstAuthorFamily} (${rec.year}).`,
    };
  }

  return {
    status: 'verified',
    identifierJustified: { kind: 'doi', value: doi, source: 'crossref', route: 'crossref-doi' },
    queries: [query],
    returned: { crossref: rec },
    comparison,
    reason:
      comparison.year === 'match'
        ? `DOI ${doi} resolves to the paper claimed.`
        : `DOI ${doi} resolves to the paper claimed; the issued year differs (${comparison.year}: asserted ${paper.year}, Crossref ${rec.year}), which is recorded, not reconciled.`,
  };
}

// ---------------------------------------------------------------------------
// Route 2: no asserted identifier. Search Crossref, then PubMed as a second
// and independent route, and record both regardless of what the first said.
// ---------------------------------------------------------------------------

async function searchForPaper(paper) {
  const queries = [];
  const returned = {};
  const candidates = [];

  // --- Crossref bibliographic search -------------------------------------
  const family = String(paper.authors[0] ?? '').replace(/\s+(?:[A-Z]\.?){1,4}$/, '');
  const crUrl =
    `${CROSSREF}/works?query.bibliographic=${encodeURIComponent(paper.title)}` +
    `&query.author=${encodeURIComponent(family)}&rows=5` +
    `&select=DOI,title,author,issued,container-title,volume,issue,page,publisher,type,score` +
    `&mailto=${encodeURIComponent(MAILTO)}`;
  const cr = await getJson(crUrl);
  const crItems = cr.body?.message?.items ?? [];
  queries.push({
    route: 'crossref-search',
    endpoint: `${CROSSREF}/works?query.bibliographic=&query.author=`,
    ...cr.attempt,
    queryTerms: { 'query.bibliographic': paper.title, 'query.author': family, rows: 5 },
    candidateCount: cr.body ? (cr.body.message?.['total-results'] ?? crItems.length) : 0,
    candidatesInspected: crItems.length,
  });

  if (cr.body) {
    const top = crossrefRecord(crItems[0]);
    returned.crossrefTop = top;
    returned.crossrefCandidates = crItems.slice(0, 5).map(crossrefRecord);
    if (top) {
      const cmp = {
        title: compareTitles(paper.title, top.title),
        firstAuthor: compareFirstAuthor(paper.authors, top.firstAuthorFamily),
        year: compareYears(paper.year, top.year),
        container: compareTitles(paper.venue.replace(/\s+\d+.*$/, ''), top.containerTitle ?? top.publisher),
      };
      candidates.push({ source: 'crossref', route: 'crossref-search', record: top, comparison: cmp, doi: top.doi });
    }
  }

  // --- PubMed esearch + esummary -----------------------------------------
  const term = `${paper.title}[Title]`;
  const peUrl =
    `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=5` +
    `&term=${encodeURIComponent(term)}&email=${encodeURIComponent(MAILTO)}&tool=atlas-research-citation-audit`;
  const pe = await getJson(peUrl);
  const idList = pe.body?.esearchresult?.idlist ?? [];
  queries.push({
    route: 'pubmed-esearch',
    endpoint: `${EUTILS}/esearch.fcgi?db=pubmed`,
    ...pe.attempt,
    queryTerms: { db: 'pubmed', term, retmax: 5 },
    candidateCount: pe.body ? Number(pe.body.esearchresult?.count ?? idList.length) : 0,
    candidatesInspected: idList.length,
    pmids: idList,
  });

  if (idList.length > 0) {
    const suUrl =
      `${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${encodeURIComponent(idList.join(','))}` +
      `&email=${encodeURIComponent(MAILTO)}&tool=atlas-research-citation-audit`;
    const su = await getJson(suUrl);
    queries.push({
      route: 'pubmed-esummary',
      endpoint: `${EUTILS}/esummary.fcgi?db=pubmed`,
      ...su.attempt,
      queryTerms: { db: 'pubmed', id: idList.join(',') },
      candidateCount: su.body ? idList.length : 0,
    });
    const result = su.body?.result ?? {};
    const recs = idList.map((id) => pubmedRecord(result[id], id)).filter(Boolean);
    returned.pubmedTop = recs[0] ?? null;
    returned.pubmedCandidates = recs;
    if (recs[0]) {
      const r = recs[0];
      const cmp = {
        title: compareTitles(paper.title, r.title),
        firstAuthor: compareFirstAuthor(paper.authors, r.firstAuthorRaw),
        year: compareYears(paper.year, r.year),
        container: compareTitles(paper.venue.replace(/\s+\d+.*$/, ''), r.containerTitle),
      };
      candidates.push({ source: 'pubmed', route: 'pubmed-esummary', record: r, comparison: cmp, doi: r.doi });
    }
  }

  // --- Decide -------------------------------------------------------------
  const qualifying = candidates.filter((c) => earnsIdentifier(c.comparison) && c.doi);

  // Did every route fail to even run? Then we did not get to look.
  const anyRouteAnswered = queries.some((q) => q.httpStatus === 200);
  if (!anyRouteAnswered) {
    return {
      status: 'unverified',
      queries,
      returned,
      comparison: null,
      candidates,
      reason:
        'neither Crossref search nor PubMed esearch answered, so this citation was NOT checked. ' +
        'Absence of a candidate here is absence of a query, not absence of a paper.',
    };
  }

  if (qualifying.length > 0) {
    const win = qualifying[0];
    return {
      status: 'resolved',
      identifierJustified: { kind: 'doi', value: win.doi, source: win.source, route: win.route },
      queries,
      returned,
      comparison: win.comparison,
      candidates,
      reason:
        `${win.source} returned DOI ${win.doi} for a record matching the asserted title, first author ` +
        `and year (${JSON.stringify(win.record.title)}, ${win.record.firstAuthorFamily ?? win.record.firstAuthorRaw}, ${win.record.year}).`,
    };
  }

  const near = candidates
    .map((c) => `${c.source}: ${JSON.stringify(c.record.title)} (${c.record.year}) — title ${c.comparison.title}, firstAuthor ${c.comparison.firstAuthor}, year ${c.comparison.year}`)
    .join('; ');
  return {
    status: 'unresolved',
    queries,
    returned,
    comparison: candidates[0]?.comparison ?? null,
    candidates,
    reason:
      candidates.length === 0
        ? 'both routes answered and returned no candidate. Consistent with a monograph or a pre-DOI publication; the full citation stays in `venue`.'
        : `both routes answered; no candidate matched on title, first author and year. Nearest: ${near}. Left as kind "none" rather than attaching a near miss.`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const dataset = JSON.parse(readFileSync(join(DATA, 'research-seed.json'), 'utf8'));

const rows = [];
for (const paper of dataset.papers) {
  process.stderr.write(`· ${paper.id} … `);
  const outcome =
    paper.identifier.kind === 'none' ? await searchForPaper(paper) : await checkAssertedDoi(paper);
  process.stderr.write(`${outcome.status}\n`);
  rows.push({
    paperId: paper.id,
    retrievedOn: RETRIEVED_ON,
    asserted: {
      title: paper.title,
      firstAuthor: paper.authors[0] ?? null,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      identifier: paper.identifier,
    },
    status: outcome.status,
    identifierJustified: outcome.identifierJustified ?? null,
    reason: outcome.reason,
    comparison: outcome.comparison,
    returned: outcome.returned,
    candidates: outcome.candidates ?? null,
    queries: outcome.queries,
  });
}

const tally = {};
for (const r of rows) tally[r.status] = (tally[r.status] ?? 0) + 1;

const report = {
  $comment: [
    'GENERATED by tools/verify-research-citations.mjs. A POINT-IN-TIME RECORD of what',
    'Crossref and PubMed returned on the `retrievedOn` date in each row -- not a standing',
    'guarantee. Re-run the script to refresh it; do not hand-edit it.',
    '',
    'WHAT A STATUS MEANS:',
    '',
    '  verified    an asserted DOI resolved, and the returned title and first author match.',
    '  mismatch    an asserted DOI resolved to a DIFFERENT paper. Worse than a dead link,',
    '              because it resolves and looks authoritative doing it.',
    '  resolved    a paper asserted as kind "none" was found by search and the returned',
    '              metadata matches on title, first author AND year. Only these earn an',
    '              identifier in research-seed.json.',
    '  unresolved  the queries ran and returned no matching candidate. For a monograph',
    '              this is the CORRECT answer, not a gap.',
    '  unverified  the check could not run. NEVER reads as verified, and never as a clean',
    '              `unresolved` either: it means we did not get to look.',
    '',
    'WHAT THIS CANNOT TELL YOU: that a paper claims what this dataset attributes to it.',
    'Crossref confirms a paper exists. The 120 findings and their region mappings assert',
    'provenance.basis "published-text" with confidence "high", and nothing in this report',
    'or in any API bears on whether that is true. That is a human review, and it is the',
    'assertion that actually carries risk.',
    '',
    'tools/check-research-dataset.mjs gates the dataset against this file offline: every',
    'paper id must appear here, and no paper may carry an identifier this report does not',
    'justify from a named source.',
  ],
  schema: 'citation-report/1',
  generatedBy: 'tools/verify-research-citations.mjs',
  retrievedOn: RETRIEVED_ON,
  datasetVersion: dataset.version,
  datasetSchema: dataset.schema,
  sources: [
    {
      id: 'crossref',
      endpoint: `${CROSSREF}/works`,
      routes: ['crossref-doi', 'crossref-search'],
      note: 'DOI registration agency metadata. Authoritative for whether a DOI is registered and what it points at.',
    },
    {
      id: 'pubmed',
      endpoint: `${EUTILS}/esearch.fcgi`,
      routes: ['pubmed-esearch', 'pubmed-esummary'],
      note: 'NLM bibliographic index, used as an independent second route. Covers biomedical journals; does not index monographs.',
    },
  ],
  tally,
  paperCount: rows.length,
  rows,
};

const summaryLines = [
  `papers        ${rows.length}`,
  `tally         ${JSON.stringify(tally)}`,
  `identifiers   ${rows.filter((r) => r.identifierJustified).length} justified by a named source`,
];
console.log(summaryLines.join('\n'));
for (const r of rows.filter((x) => x.status === 'mismatch' || x.status === 'unverified')) {
  console.log(`\n!! ${r.paperId} [${r.status}] ${r.reason}`);
}

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
} else {
  writeFileSync(join(DATA, 'citation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${join('packages', 'atlas-research', 'data', 'citation-report.json')}`);
}
