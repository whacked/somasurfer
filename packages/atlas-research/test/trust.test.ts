import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { covering } from '../../alc/src/index.ts';
import {
  anatomyScan,
  browseByAnatomy,
  formatCitation,
  isSafeUrl,
  safeHref,
  scanPredicate,
  sourceLink,
} from '../src/index.ts';
import { fixtureIndex, PKG_DIR } from './helpers.ts';

const index = fixtureIndex();

// ---------------------------------------------------------------------------
// URLs: allow-listed, not deny-listed
// ---------------------------------------------------------------------------

const ACCEPTED = [
  'https://doi.org/10.1038/nature18933',
  'http://example.org/paper',
  'https://example.org:8443/paper?q=1#fig2',
  'https://user@example.org/paper',
];

const REFUSED: [string, string][] = [
  ['javascript:alert(1)', 'the classic'],
  ['JavaScript:alert(1)', 'scheme comparison is case-insensitive in browsers'],
  ['  javascript:alert(1)', 'leading whitespace is stripped before dispatch'],
  ['java\tscript:alert(1)', 'a tab inside the scheme is stripped by the browser, so a string deny-list misses it'],
  ['java\nscript:alert(1)', 'and so is a newline'],
  ['java\rscript:alert(1)', 'and a carriage return'],
  ['jav\u0000ascript:alert(1)', 'and a NUL'],
  ['data:text/html;base64,PHNjcmlwdD4=', 'data: can carry a document'],
  ['vbscript:msgbox(1)', 'still dispatched by some engines'],
  ['blob:https://example.org/uuid', 'a blob URL is not a citation'],
  ['file:///etc/passwd', 'local filesystem'],
  ['about:blank', 'not a source'],
  ['//example.org/paper', 'protocol-relative is not absolute'],
  ['/papers/1', 'relative'],
  ['example.org/paper', 'no scheme at all'],
  ['doi:10.1038/nature18933', 'a DOI is an identifier, not a URL'],
  ['', 'empty'],
];

test('safeHref accepts absolute http(s) and nothing else', () => {
  for (const url of ACCEPTED) {
    assert.ok(safeHref(url), `${url} should be accepted`);
    assert.ok(isSafeUrl(url));
  }
  for (const [url, why] of REFUSED) {
    assert.equal(safeHref(url), null, `${JSON.stringify(url)} must be refused (${why})`);
    assert.equal(isSafeUrl(url), false, JSON.stringify(url));
  }
});

test('safeHref refuses non-strings without throwing', () => {
  for (const junk of [null, undefined, 42, {}, [], true, Symbol('x')]) {
    assert.equal(safeHref(junk as unknown), null);
  }
});

test('a refused URL produces a link with no href and a stated reason', () => {
  const link = sourceLink('Someone (2020). A paper. Venue.', 'javascript:alert(1)');
  assert.equal(link.href, null);
  assert.ok(link.unlinkedReason?.includes('rejected'));
  // Still traceable: the citation text is the fallback, so a reader can search
  // for the paper even when the recorded URL was unusable.
  assert.ok(link.text.includes('A paper'));
});

test('an absent URL is distinguished from a refused one', () => {
  const absent = sourceLink('Brodmann K (1909). ...', null);
  assert.equal(absent.href, null);
  assert.ok(absent.unlinkedReason?.includes('no source URL recorded'));
  assert.ok(!absent.unlinkedReason?.includes('rejected'));
});

test('every link carries noopener noreferrer and opens detached', () => {
  for (const m of index.mappings) {
    assert.equal(m.link.rel, 'noopener noreferrer');
    assert.equal(m.link.target, '_blank');
  }
  const linked = index.mappings.filter((m) => m.link.href !== null);
  const unlinked = index.mappings.filter((m) => m.link.href === null);
  assert.ok(linked.length > 0, 'the fixture has linkable papers');
  assert.ok(unlinked.length > 0, 'and papers with no link, so the unlinked path is exercised');
  for (const m of unlinked) assert.ok(m.link.unlinkedReason, 'an unlinked citation must say why');
});

test('a citation with no identifier says so rather than printing a blank', () => {
  const c = formatCitation({
    authors: ['Brodmann K'],
    year: 1909,
    title: 'Vergleichende Lokalisationslehre der Grosshirnrinde',
    venue: 'Barth, Leipzig',
    identifier: { kind: 'none', value: null },
  });
  assert.ok(c.includes('no persistent identifier recorded'));
});

// ---------------------------------------------------------------------------
// Rendered, never fetched
// ---------------------------------------------------------------------------

/** Every source file in the package, excluding tests and fixtures. */
function packageSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) out.push(p);
    }
  };
  walk(join(PKG_DIR, 'src'));
  return out;
}

test('no network client is reachable from this package', () => {
  // The acceptance criterion is "rendered, never fetched", and the way that
  // gets violated is one convenience call added months later to resolve a DOI
  // -- which would make the atlas issue a request per curated row, to a host
  // chosen by whoever last edited the dataset.
  const banned: [RegExp, string][] = [
    [/\bfetch\s*\(/, 'fetch()'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/from\s+['"]node:https?['"]/, 'node:http(s)'],
    [/require\(\s*['"]node:https?['"]\s*\)/, 'node:http(s)'],
    [/from\s+['"](axios|node-fetch|undici|got|superagent)['"]/, 'an HTTP client package'],
    [/\bnavigator\.sendBeacon\b/, 'sendBeacon'],
    [/\bnew\s+WebSocket\b/, 'WebSocket'],
    [/\bnew\s+EventSource\b/, 'EventSource'],
    [/\bimport\s*\(\s*`/, 'a dynamic import with an interpolated specifier'],
  ];
  const files = packageSources();
  assert.ok(files.length >= 7, `expected the package's sources, found ${files.length}`);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [re, what] of banned) {
      // Comments mentioning these by name are fine and are the reason the
      // match is required to be code: strip line and block comments first.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!re.test(code), `${file} references ${what}; curated links are rendered, never fetched`);
    }
  }
});

test('the package declares no runtime dependency outside the monorepo', () => {
  const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      assert.ok(dep.startsWith('@gstack/'), `${field}.${dep} is a third-party dependency`);
    }
  }
  assert.equal(manifest.atlas?.licenceClass, 'code', 'the licence class is declared, never inferred');
});

test('the fixtures are data, not code', () => {
  for (const name of readdirSync(join(PKG_DIR, 'fixtures'))) {
    assert.ok(name.endsWith('.json'), `fixtures/${name} is not JSON`);
    const stat = statSync(join(PKG_DIR, 'fixtures', name));
    assert.ok(stat.size > 0);
    JSON.parse(readFileSync(join(PKG_DIR, 'fixtures', name), 'utf8'));
  }
});

// ---------------------------------------------------------------------------
// Prefix range scans are parameterised, never interpolated
// ---------------------------------------------------------------------------

const SCAN_TARGETS: (string | ReturnType<typeof covering>)[] = [
  'BV-L-040',
  'BD-T07-03O-5',
  covering(['BV-L-04', 'BD-T07-03O']),
  covering([]),
];

test('a rendered scan binds every address and interpolates none', () => {
  for (const target of SCAN_TARGETS) {
    const plan = anatomyScan(target);
    const q = scanPredicate(plan);
    // Every value the plan carries must appear in params and never in text.
    const values = [...plan.ranges.flatMap((r) => [r.lower, r.upperExclusive]), ...plan.exact];
    for (const v of values) {
      assert.ok(q.params.includes(v), `${v} was not bound as a parameter`);
      assert.ok(!q.text.includes(v), `${v} was interpolated into the SQL text: ${q.text}`);
    }
    // No address-shaped literal of any kind in the text.
    assert.ok(!/\b(BD|BV|BR)-/.test(q.text), `an address reached the SQL text: ${q.text}`);
  }
});

test('an empty scan renders as FALSE, not as nothing', () => {
  // A predicate that vanishes turns "nothing matches" into "everything
  // matches". The library guarantees this; the assertion is here because this
  // package is what builds the empty plan.
  const q = scanPredicate(anatomyScan(covering([])));
  assert.equal(q.text, 'FALSE');
  assert.deepEqual([...q.params], []);
});

test('a hostile column name is refused, not escaped', () => {
  assert.throws(
    () => scanPredicate(anatomyScan('BV-L-040'), { column: 'cell"; DROP TABLE papers; --' }),
    (e: Error & { code?: string }) => e.code === 'bad_column',
  );
});

test('every dialect emits an explicit binary collation', () => {
  // The bug that survives CI: under a locale collation, punctuation is
  // ignorable at the primary level and the prefix bounds stop meaning what
  // they say -- a scan that returns subtly wrong rows and never errors.
  const plan = anatomyScan('BV-L-040');
  for (const [dialect, needle] of [
    ['postgres', 'COLLATE "C"'],
    ['sqlite', 'COLLATE BINARY'],
    ['mysql', 'COLLATE utf8mb4_bin'],
  ] as const) {
    const q = scanPredicate(plan, { dialect });
    assert.ok(q.text.includes(needle), `${dialect} lost its binary collation: ${q.text}`);
  }
});

test('a malformed address is rejected before any query is built', () => {
  for (const bad of ['BV-L-9', 'BD-C08-01I', 'BV-L-1-2', 'nonsense', 'BD-T07-02O-'.padEnd(80, 'Z')]) {
    assert.throws(() => anatomyScan(bad), /.*/, `${bad} should not produce a scan`);
    assert.throws(() => browseByAnatomy(index, bad), /.*/, `${bad} should not reach a query`);
  }
});

test('a non-address, non-covering query argument is refused', () => {
  for (const junk of [null, undefined, 42, {}, [], ['BV-L-040']]) {
    assert.throws(() => anatomyScan(junk as unknown as string));
    assert.throws(() => browseByAnatomy(index, junk as unknown as string));
  }
});

test('the in-memory scan and the plan agree on what matches', () => {
  // The two halves of "same bounds everywhere": whatever the plan selects from
  // the sorted key array is what the browse result reports.
  for (const cell of ['BV-L-040', 'BV-L-600', 'BD-T07-03O-5']) {
    const r = browseByAnatomy(index, cell);
    const plan = anatomyScan(cell);
    assert.deepEqual(
      [...r.scan.ranges].map((x) => x.lower),
      [...plan.ranges].map((x) => x.lower),
    );
    assert.deepEqual([...r.scan.exact], [...plan.exact]);
  }
});
