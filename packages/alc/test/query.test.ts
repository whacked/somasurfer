import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  AlcError,
  ancestorScan,
  ancestors,
  children,
  contains,
  covering,
  coveringScan,
  descendantScan,
  EMPTY_SCAN,
  overlapScan,
  parse,
  prefixRange,
  renderScan,
  scanSorted,
} from '../src/index.ts';
import { rng } from '../src/testing/syntheticTemplates.ts';

/**
 * Canonical addresses across all three frames, as a stand-in for a stored table.
 *
 * Deliberately a few hundred rather than a few thousand: the properties below
 * are checked against the full cross product, so the cost is quadratic, and the
 * claims they test are structural rather than statistical. Depth and frame
 * variety matter; row count does not.
 */
function addressCorpus(): string[] {
  const out = new Set<string>();
  const r = rng(909);
  for (const level of ['C07', 'T07', 'T08', 'L05']) {
    out.add(`BD-${level}`);
    for (let clock = 1; clock <= 12; clock += 1) {
      for (const depth of ['I', 'O']) {
        const anchor = `${String(clock).padStart(2, '0')}${depth}`;
        out.add(`BD-${level}-${anchor}`);
        for (let d = 0; d < 2; d += 1) {
          const digits = Array.from({ length: 1 + Math.floor(r() * 5) }, () => '01234567'[Math.floor(r() * 8)]).join('');
          out.add(`BD-${level}-${anchor}-${digits}`);
        }
      }
    }
  }
  for (const h of ['L', 'R']) {
    out.add(`BV-${h}`);
    for (let d = 0; d < 70; d += 1) {
      const digits = Array.from({ length: 1 + Math.floor(r() * 6) }, () => '01234567'[Math.floor(r() * 8)]).join('');
      out.add(`BV-${h}-${digits}`);
    }
    for (let d = 0; d < 45; d += 1) {
      const n = 1 + Math.floor(r() * 4);
      const digits = Array.from({ length: n }, (_, i) =>
        i === 0 ? '0123456789AB'[Math.floor(r() * 12)] : '0123456789ABCDEF'[Math.floor(r() * 16)],
      ).join('');
      out.add(`BR-${h}-${digits}`);
    }
  }
  return [...out].map((a) => parse(a).canonical);
}

const CORPUS = [...new Set(addressCorpus())].sort();

// ---------------------------------------------------------------------------
test('prefix range: selects exactly the descendants, over a whole corpus', () => {
  // The load-bearing claim: a half-open string range on a canonical address
  // column returns exactly the cells contained by the prefix. Checked against
  // `contains()` — the semantic definition — for every address in the corpus.
  assert.ok(CORPUS.length > 300, `corpus too small to be meaningful: ${CORPUS.length}`);
  for (const prefix of CORPUS) {
    const { lower, upperExclusive } = prefixRange(prefix);
    const byRange = CORPUS.filter((x) => x >= lower && x < upperExclusive);
    const bySemantics = CORPUS.filter((x) => contains(prefix, x));
    assert.deepEqual(byRange, bySemantics, `range for ${prefix} disagreed with containment`);
  }
});

test('prefix range: the bounds are what the spec says they are', () => {
  assert.deepEqual({ ...prefixRange('BD-T07') }, { lower: 'BD-T07', upperExclusive: 'BD-T08' });
  assert.deepEqual({ ...prefixRange('bv-l') }, { lower: 'BV-L', upperExclusive: 'BV-M' });
  assert.deepEqual({ ...prefixRange('BV-L-471') }, { lower: 'BV-L-471', upperExclusive: 'BV-L-472' });
  // The exclusive bound may be a character outside the alphabet; that is fine,
  // and is why the top of an octal run still scans correctly.
  assert.deepEqual({ ...prefixRange('BD-T07-02O-77') }, { lower: 'BD-T07-02O-77', upperExclusive: 'BD-T07-02O-78' });
  assert.deepEqual({ ...prefixRange('BD-T07-02O') }, { lower: 'BD-T07-02O', upperExclusive: 'BD-T07-02P' });
  assert.throws(() => prefixRange('BD-T07-02O-9'), AlcError);
});

test('prefix range: the ordering fact the scan depends on', () => {
  // `-` must sort below every character that can follow it in an address, or a
  // prefix range silently stops meaning "descendants of". This is a property of
  // byte ordering, not of locale collation, which is why `renderScan` emits an
  // explicit binary collation.
  for (const ch of '0123456789ABCDEFILORSTV') {
    assert.ok('-' < ch, `'-' must sort below ${ch}`);
  }
  assert.ok('BD-T07' < 'BD-T07-02O');
  assert.ok('BD-T07-02O' < 'BD-T08');
  // And the hazard, stated so the reason for the COLLATE clause is on record:
  // under a punctuation-ignoring collation these two compare equal.
  assert.notEqual('BD-T0702O', 'BD-T07-02O');
});

// ---------------------------------------------------------------------------
test('scan plans: descendants, ancestors and overlap', () => {
  const address = 'BD-T07-02O-531';

  const down = scanSorted(CORPUS, descendantScan(address)).map((i) => CORPUS[i]);
  assert.deepEqual(down, CORPUS.filter((x) => contains(address, x)));

  const up = scanSorted(CORPUS, ancestorScan(address)).map((i) => CORPUS[i]);
  assert.deepEqual(
    up,
    CORPUS.filter((x) => contains(x, address) && x !== address).sort(),
  );

  // Overlap is ancestors plus self plus descendants, because hierarchy cells
  // are nested or disjoint.
  const both = scanSorted(CORPUS, overlapScan(address)).map((i) => CORPUS[i]);
  assert.deepEqual(both, CORPUS.filter((x) => contains(x, address) || contains(address, x)).sort());

  assert.deepEqual([...EMPTY_SCAN.ranges], []);
  assert.deepEqual([...EMPTY_SCAN.exact], []);
  assert.deepEqual(scanSorted(CORPUS, EMPTY_SCAN), []);
});

test('scan plans: a covering scan finds every row touching the covering', () => {
  const r = rng(1010);
  for (let trial = 0; trial < 15; trial += 1) {
    const cells = Array.from({ length: 4 }, () => CORPUS[Math.floor(r() * CORPUS.length)]);
    const c = covering(cells);
    const found = new Set(scanSorted(CORPUS, coveringScan(c)).map((i) => CORPUS[i]));
    const expected = new Set(
      CORPUS.filter((x) => c.cells.some((cell) => contains(cell, x) || contains(x, cell))),
    );
    assert.deepEqual([...found].sort(), [...expected].sort(), `covering ${c.cells}`);
  }
  assert.throws(
    () => coveringScan(['BV-L-4'] as never),
    (e: unknown) => (e as AlcError).code === 'bad_covering',
  );
});

test('scan plans: an ancestor at the frame root is still found', () => {
  // A structure covering filed at the level root must be found by a search for
  // a cell deep inside it. This is the query that makes "what else is here?"
  // work, and it is the one a naive prefix-only scan gets wrong.
  const stored = ['BD-T07'];
  const hits = scanSorted(stored, overlapScan('BD-T07-02O-531642'));
  assert.deepEqual(hits, [0]);
  assert.ok(ancestors('BD-T07-02O-531642').some((a) => a.canonical === 'BD-T07'));
});

// ---------------------------------------------------------------------------
test('renderScan: every value is a bind parameter, never text', () => {
  const c = covering(['BD-T07-02O', 'BV-L-4', 'BR-L-7A']);
  const plan = coveringScan(c);
  const q = renderScan(plan, { column: 'alc_address' });

  // The values that must appear in params and must not appear in text.
  const values = [
    ...plan.ranges.flatMap((r) => [r.lower, r.upperExclusive]),
    ...plan.exact,
  ];
  for (const v of values) {
    assert.ok(q.params.includes(v), `${v} should be bound as a parameter`);
    assert.equal(q.text.includes(v), false, `${v} leaked into the SQL text`);
  }
  assert.equal(q.params.length, plan.ranges.length * 2 + plan.exact.length);

  // The text is a whitelist of structure: identifiers, operators, placeholders.
  assert.match(q.text, /^[\s()"'.A-Za-z_0-9$?,<>=]+$/);
  assert.ok(Object.isFrozen(q));
  assert.ok(Object.isFrozen(q.params));
});

test('renderScan: placeholders are numbered per dialect and bind in order', () => {
  const plan = coveringScan(covering(['BV-L-4', 'BV-R-5']));
  const pg = renderScan(plan, { column: 'addr', dialect: 'postgres' });
  const expectedPlaceholders = pg.params.map((_, i) => `$${i + 1}`);
  for (const p of expectedPlaceholders) assert.ok(pg.text.includes(p), `missing ${p}`);
  // Order matters: $1 must be the first value pushed.
  assert.equal(pg.params[0], plan.ranges[0].lower);
  assert.equal(pg.params[1], plan.ranges[0].upperExclusive);

  for (const dialect of ['sqlite', 'mysql'] as const) {
    const q = renderScan(plan, { column: 'addr', dialect });
    assert.equal(q.params.length, pg.params.length);
    assert.equal((q.text.match(/\?/g) ?? []).length, q.params.length);
    assert.deepEqual([...q.params], [...pg.params]);
  }
  assert.throws(
    () => renderScan(plan, { column: 'addr', dialect: 'oracle' as never }),
    (e: unknown) => (e as AlcError).code === 'bad_dialect',
  );
});

test('renderScan: the column name is validated, because it cannot be a parameter', () => {
  const plan = descendantScan('BV-L-4');
  assert.match(renderScan(plan, { column: 'alc_address' }).text, /"alc_address"/);
  assert.match(renderScan(plan, { column: 'findings.alc_address' }).text, /"findings"\."alc_address"/);
  assert.match(renderScan(plan, { column: 'addr', dialect: 'mysql' }).text, /`addr`/);

  for (const bad of [
    'addr; DROP TABLE findings',
    'addr" OR "1"="1',
    "addr' --",
    '*',
    '1addr',
    'a'.repeat(200),
    'schema.table.column',
    '',
    'addr)',
    null,
    42,
  ] as never[]) {
    assert.throws(
      () => renderScan(plan, { column: bad }),
      (e: unknown) => (e as AlcError).code === 'bad_column',
      `column ${JSON.stringify(bad)} should be refused`,
    );
  }
});

test('renderScan: binary collation is emitted by default, because locale collation breaks the range', () => {
  const plan = descendantScan('BV-L-4');
  assert.match(renderScan(plan, { column: 'addr' }).text, /COLLATE "C"/);
  assert.match(renderScan(plan, { column: 'addr', dialect: 'sqlite' }).text, /COLLATE BINARY/);
  assert.match(renderScan(plan, { column: 'addr', dialect: 'mysql' }).text, /COLLATE utf8mb4_bin/);
  assert.equal(renderScan(plan, { column: 'addr', omitCollate: true }).text.includes('COLLATE'), false);
});

test('renderScan: an empty plan renders FALSE, not an empty predicate', () => {
  // An empty predicate would turn "nothing matches" into "everything matches".
  const q = renderScan(EMPTY_SCAN, { column: 'addr' });
  assert.equal(q.text, 'FALSE');
  assert.deepEqual([...q.params], []);
  assert.equal(renderScan(coveringScan(covering([])), { column: 'addr' }).text, 'FALSE');
});

// ---------------------------------------------------------------------------
test('no interpolated query path exists anywhere in the package source', () => {
  // The acceptance criterion, as a test rather than a convention. Any string or
  // template literal that looks like SQL must be free of interpolation, and the
  // only module allowed to build SQL at all is query.ts.
  //
  // Keywords are matched case-sensitively in upper case. Matching them
  // case-insensitively hits ordinary English — "come from", "absent from
  // template", "select" — and an assertion that fires on prose is an assertion
  // that gets deleted.
  const SQL_TOKENS = /\b(SELECT|INSERT|UPDATE|DELETE|WHERE|JOIN|VALUES|COLLATE)\b/;
  const offences: string[] = [];

  for (const file of walk('src')) {
    const source = readFileSync(file, 'utf8');

    // Template literals containing both interpolation and SQL keywords.
    for (const literal of source.match(/`(?:[^`\\]|\\.)*`/gs) ?? []) {
      if (literal.includes('${') && SQL_TOKENS.test(literal)) {
        offences.push(`${file}: interpolated template literal containing SQL: ${literal.slice(0, 80)}`);
      }
    }
    // String concatenation into something SQL-shaped.
    for (const line of source.split('\n')) {
      if (SQL_TOKENS.test(line) && /['"][^'"]*\s(?:=|>=|<|IN)\s*['"]\s*\+/i.test(line)) {
        offences.push(`${file}: concatenated SQL: ${line.trim().slice(0, 80)}`);
      }
    }
    // SQL construction lives in exactly one module, so there is exactly one
    // place to audit.
    if (!file.endsWith('query.ts') && SQL_TOKENS.test(source)) {
      offences.push(`${file}: builds SQL outside query.ts`);
    }
  }
  assert.deepEqual(offences, [], `interpolated or stray query construction found:\n${offences.join('\n')}`);

  // And the one module that does build SQL binds every value.
  const querySource = readFileSync('src/query.ts', 'utf8');
  assert.ok(querySource.includes('bind(r.lower)'), 'range bounds must go through bind()');
  assert.ok(querySource.includes('bind(r.upperExclusive)'), 'range bounds must go through bind()');
  assert.ok(
    !/\$\{(?:r\.lower|r\.upperExclusive|k|key|cell|address)\}/.test(querySource),
    'no address value may be interpolated into SQL text',
  );

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  }
});

test('scanSorted: matches the database semantics on a shuffled, duplicated table', () => {
  // The in-memory scan is the reference for the SQL one, so it has to behave
  // like an index scan: duplicates, unsorted insertion, ascending output.
  const r = rng(1111);
  const rows = [...CORPUS, ...CORPUS.slice(0, 50)].sort(() => (r() < 0.5 ? -1 : 1)).sort();
  const address = 'BV-L-47';
  const hits = scanSorted(rows, overlapScan(address));
  assert.deepEqual([...hits], [...hits].sort((a, b) => a - b), 'output must be ascending');
  assert.equal(new Set(hits).size, hits.length, 'output must be deduplicated by index');
  const found = hits.map((i) => rows[i]);
  for (const x of found) {
    assert.ok(contains(address, x) || contains(x, address), `${x} should not have matched ${address}`);
  }
  const expectedCount = rows.filter((x) => contains(address, x) || contains(x, address)).length;
  assert.equal(found.length, expectedCount);
  assert.ok(children(address).length > 0);
});
