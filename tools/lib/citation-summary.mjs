/**
 * Renders the human-readable citation summary from the machine-readable report.
 *
 * A PURE FUNCTION of `citation-report.json` and nothing else — no clock, no
 * filesystem, no network. That is what lets `tools/check-research-dataset.mjs`
 * re-render it offline and compare, so the markdown cannot drift away from the
 * data it claims to summarise. Same arrangement as
 * `scripts/author-seed.mjs --check`: a generated artifact that is committed, and
 * a gate that proves it is still the output of its generator.
 *
 * Keeping the renderer here rather than in the verifier is deliberate: the
 * verifier needs the network, and the gate must never import anything that
 * does.
 */

/** Statuses that mean an identifier may exist in the dataset. */
export const JUSTIFYING_STATUSES = new Set(['verified', 'resolved']);

const STATUS_BLURB = {
  verified: 'asserted DOI resolved through Crossref to the paper claimed',
  resolved: 'no identifier was asserted; a named source returned one that matches',
  mismatch: 'asserted DOI resolved to a DIFFERENT paper',
  unresolved: 'the queries ran and no candidate matched',
  unverified: 'the check could not run — NOT evidence of anything about the citation',
};

const cmpCell = (c) => {
  if (!c) return '—';
  const marks = { match: '=', contains: '⊃', 'off-by-one': '±1', differs: '≠', absent: '∅' };
  return ['title', 'firstAuthor', 'year'].map((k) => `${k[0]}${marks[c[k]] ?? '?'}`).join(' ');
};

export function renderCitationSummary(report) {
  const rows = report.rows ?? [];
  const tally = report.tally ?? {};
  const out = [];

  out.push('# Citation audit — the research seed’s 30 sources');
  out.push('');
  out.push(
    'GENERATED from `data/citation-report.json` by `tools/lib/citation-summary.mjs`.',
    'Do not hand-edit: `tools/check-research-dataset.mjs` re-renders this file and fails if it differs.',
    'Regenerate the underlying data with `node tools/verify-research-citations.mjs`.',
  );
  out.push('');
  out.push(`- **Retrieved on:** ${report.retrievedOn}`);
  out.push(`- **Dataset:** \`${report.datasetVersion}\` (${rows.length} papers)`);
  for (const s of report.sources ?? []) out.push(`- **Source \`${s.id}\`:** \`${s.endpoint}\` — ${s.note}`);
  out.push('');
  out.push(
    'This is a **point-in-time** record. Each row below is evidence that a named source returned',
    'particular metadata on the date above — not a standing guarantee that it still does.',
  );
  out.push('');

  out.push('## Outcome');
  out.push('');
  out.push('| status | papers | meaning |');
  out.push('| --- | --- | --- |');
  for (const [status, blurb] of Object.entries(STATUS_BLURB)) {
    if (!tally[status]) continue;
    out.push(`| \`${status}\` | ${tally[status]} | ${blurb} |`);
  }
  out.push('');

  const justified = rows.filter((r) => r.identifierJustified);
  const unresolved = rows.filter((r) => r.status === 'unresolved');
  const unverified = rows.filter((r) => r.status === 'unverified');
  const mismatched = rows.filter((r) => r.status === 'mismatch');

  out.push(
    `**${justified.length} of ${rows.length}** papers carry an identifier justified by a named source.` +
      ` **${unresolved.length}** carry none.`,
  );
  out.push('');

  // Corroboration is a second, independent statement: both routes run for every
  // paper, so a DOI can be confirmed by resolution AND found again by a
  // title+author search that was never told the DOI.
  const corroborated = rows.filter((r) => r.corroboration?.agreesWithAsserted === true);
  const contradicted = rows.filter((r) => r.corroboration?.agreesWithAsserted === false);
  if (corroborated.length > 0 || contradicted.length > 0) {
    out.push(
      `Both routes run for every paper, whatever the dataset asserts. **${corroborated.length}** of the` +
        ` ${justified.length} identifiers were *also* returned by an independent title-and-author search` +
        ' that was never given the DOI.',
    );
    out.push('');
    if (contradicted.length > 0) {
      out.push('Where the search found a **different** DOI than the dataset asserts:');
      out.push('');
      for (const r of contradicted) {
        out.push(
          `- **\`${r.paperId}\`** — asserts \`${r.asserted.identifier.value}\`, search returned` +
            ` \`${r.corroboration.searchDoi}\`. Both matched on metadata and the asserted one resolves to the` +
            ' paper claimed; likely a duplicate registration. Recorded, not reconciled.',
        );
      }
      out.push('');
    }
  }

  if (mismatched.length > 0) {
    out.push('### Mismatches — an asserted DOI pointing at a different paper');
    out.push('');
    for (const r of mismatched) out.push(`- **\`${r.paperId}\`** — ${r.reason}`);
    out.push('');
  }

  if (unverified.length > 0) {
    out.push('### UNVERIFIED — the check did not run');
    out.push('');
    out.push(
      'These rows are not failures and not clean absences. The queries did not complete, so nothing',
      'here bears on whether the citation is good. Re-run the verifier.',
      '',
    );
    for (const r of unverified) out.push(`- **\`${r.paperId}\`** — ${r.reason}`);
    out.push('');
  }

  if (unresolved.length > 0) {
    out.push('### Unresolved — no machine-resolvable identifier');
    out.push('');
    out.push(
      'For a monograph this is the **correct** record rather than a gap: books largely predate the DOI.',
      'The queries that were tried are recorded per row in the JSON, so the next reader does not repeat them.',
      '',
    );
    for (const r of unresolved) {
      out.push(`- **\`${r.paperId}\`** — ${r.asserted.firstAuthor} (${r.asserted.year}), *${r.asserted.title}*.`);
      out.push(`  Venue as recorded: ${r.asserted.venue}.`);
      out.push(`  ${r.reason}`);
    }
    out.push('');
  }

  out.push('## Every paper');
  out.push('');
  out.push('`t`/`f`/`y` are title / first author / year: `=` equal, `⊃` one contains the other, `±1` off by one, `≠` differs, `∅` absent.');
  out.push('');
  out.push('| paper | status | identifier | justified by | match |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const ij = r.identifierJustified;
    const id = ij ? `\`${ij.value}\`` : '—';
    const by = ij ? `${(ij.agreedBy ?? [ij.source]).join(' + ')}${ij.candidateRank > 0 ? ` (rank ${ij.candidateRank})` : ''}` : '—';
    out.push(`| \`${r.paperId}\` | \`${r.status}\` | ${id} | ${by} | ${cmpCell(r.comparison)} |`);
  }
  out.push('');

  out.push('## What this does not establish');
  out.push('');
  out.push(
    'Crossref and PubMed confirm that a paper **exists** and what its metadata is. They say nothing',
    'about whether a paper **claims what this dataset attributes to it**. The seed asserts',
    '`provenance.basis: "published-text"` with `confidence: "high"` across its findings and region',
    'mappings, and that assertion is not supported by anything in this report. It is reviewable only',
    'by a person reading the sources, and it is the assertion that carries the real risk: a citation',
    'that resolves perfectly while the claim attached to it is not what the paper found.',
  );
  out.push('');
  out.push(
    'Also unchecked here: whether a DOI still resolves today, and whether the `venue` volume and page',
    'run is correct. The gate compares the dataset against this committed report offline; it does not',
    're-fetch.',
  );
  out.push('');

  return `${out.join('\n')}`.replace(/\n{3,}/g, '\n\n');
}
