import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  AlcError,
  buildNameIndex,
  children,
  containingStructures,
  covering,
  coveringMeasure,
  coveringMeasureWithin,
  findStructures,
  frameRootOf,
  isValid,
  parse,
  resolve,
  resolveCovering,
  structureCovering,
  type NameIndex,
} from '../src/index.ts';
import { rng } from '../src/testing/syntheticTemplates.ts';

/** The spec's worked example: a cell shared between lung, rib and muscle. */
const THORAX_INDEX = buildNameIndex({
  version: 'name-index-2026.10.1',
  structures: [
    { id: 'UBERON:0008946', name: 'lower lobe of left lung', source: 'UBERON', cells: ['BD-T07-03O-5', 'BD-T07-03O-4'] },
    { id: 'UBERON:0002228', name: '7th rib', source: 'UBERON', cells: ['BD-T07-03O-53', 'BD-T07-03O-52'] },
    { id: 'UBERON:0001103', name: 'intercostal muscle', source: 'UBERON', cells: ['BD-T07-03O-51'] },
    { id: 'UBERON:0002048', name: 'left lung', source: 'UBERON', cells: ['BD-T07-03O', 'BD-T07-04O'] },
  ],
});

// ---------------------------------------------------------------------------
test('resolve: returns a ranked list with fractions, never a single name', () => {
  const r = resolve('BD-T07-03O-5', THORAX_INDEX);
  assert.ok(Array.isArray(r.matches));
  assert.ok(r.matches.length > 1, 'a cell generally overlaps several structures');

  // Ranked by fraction descending.
  for (let i = 0; i + 1 < r.matches.length; i += 1) {
    assert.ok(r.matches[i].fraction >= r.matches[i + 1].fraction, 'matches must be ranked');
  }
  const names = r.matches.map((m) => m.structure.name);
  assert.deepEqual(names.slice(0, 2), ['left lung', 'lower lobe of left lung']);

  // The containing structures claim the whole cell; the sub-cell ones claim parts.
  const byId = new Map(r.matches.map((m) => [m.structure.id, m.fraction]));
  assert.equal(byId.get('UBERON:0002048'), 1, 'left lung contains the cell outright');
  assert.equal(byId.get('UBERON:0008946'), 1, 'so does the lower lobe');
  assert.ok(Math.abs(byId.get('UBERON:0002228')! - 2 / 8) < 1e-12, '7th rib covers two of eight children');
  assert.ok(Math.abs(byId.get('UBERON:0001103')! - 1 / 8) < 1e-12, 'intercostal muscle covers one');

  // There is no API that collapses this to a winner.
  assert.equal(typeof (resolve as unknown as Record<string, unknown>).one, 'undefined');
});

test('resolve: pins the name index version, because names move and addresses do not', () => {
  const r = resolve('BD-T07-03O-5', THORAX_INDEX);
  assert.equal(r.indexVersion, 'name-index-2026.10.1');
  assert.equal(r.measure, 'frame');

  // Revise the parcellation: rename a structure, move its covering, bump the
  // version. The address is untouched and still resolves.
  const revised = buildNameIndex({
    version: 'name-index-2027.03.0',
    structures: [
      { id: 'UBERON:0008946', name: 'left lower lobe (revised)', cells: ['BD-T07-03O-50'] },
    ],
  });
  const after = resolve('BD-T07-03O-5', revised);
  assert.equal(after.address, r.address, 'the address is unchanged by a parcellation revision');
  assert.equal(after.indexVersion, 'name-index-2027.03.0');
  assert.equal(after.matches[0].structure.name, 'left lower lobe (revised)');
  assert.ok(Math.abs(after.matches[0].fraction - 1 / 8) < 1e-12);

  // An unversioned index is refused outright: its resolutions would not be reproducible.
  assert.throws(
    () => buildNameIndex({ version: '', structures: [] }),
    (e: unknown) => (e as AlcError).code === 'bad_index_version',
  );
  assert.throws(
    () => buildNameIndex({ structures: [] } as never),
    (e: unknown) => (e as AlcError).code === 'bad_index_version',
  );
});

test('resolve: fractions sum correctly over a cell', () => {
  // A partition: the eight children of a cell, each its own structure.
  const kids = children('BV-L-4').map((c) => c.canonical);
  const partition = buildNameIndex({
    version: 'partition-1',
    structures: kids.map((cell, i) => ({ id: `s${i}`, name: `structure ${i}`, cells: [cell] })),
  });
  const r = resolve('BV-L-4', partition);
  assert.equal(r.matches.length, 8);
  const sum = r.matches.reduce((s, m) => s + m.fraction, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, `fractions summed to ${sum}`);
  assert.ok(Math.abs(r.unclaimedFraction) < 1e-12, `unclaimed was ${r.unclaimedFraction}`);
  for (const m of r.matches) assert.ok(Math.abs(m.fraction - 1 / 8) < 1e-12);

  // A partial cover leaves the rest unclaimed, and the two add to one.
  const partial = buildNameIndex({
    version: 'partial-1',
    structures: [{ id: 'a', name: 'a', cells: kids.slice(0, 3) }],
  });
  const rp = resolve('BV-L-4', partial);
  assert.ok(Math.abs(rp.matches[0].fraction - 3 / 8) < 1e-12);
  assert.ok(Math.abs(rp.matches[0].fraction + rp.unclaimedFraction - 1) < 1e-12);

  // Overlapping structures can sum past one, and unclaimed must still not go
  // negative: it is measured on the union, not on the sum.
  const overlapping = buildNameIndex({
    version: 'overlap-1',
    structures: [
      { id: 'a', name: 'a', cells: kids.slice(0, 6) },
      { id: 'b', name: 'b', cells: kids.slice(3, 8) },
    ],
  });
  const ro = resolve('BV-L-4', overlapping);
  const overlapSum = ro.matches.reduce((s, m) => s + m.fraction, 0);
  assert.ok(overlapSum > 1, 'overlapping structures legitimately sum past one');
  assert.equal(ro.unclaimedFraction, 0, 'the union covers the cell, so nothing is unclaimed');
});

test('resolve: fractions over a cell finer and coarser than the index', () => {
  // Finer than the index: the containing structure claims the whole cell.
  const deep = resolve('BD-T07-03O-5316', THORAX_INDEX);
  assert.ok(deep.matches.every((m) => m.fraction === 1), 'every match contains a cell this fine');

  // Coarser than the index: fractions shrink to the share actually indexed.
  const shallow = resolve('BD-T07', THORAX_INDEX);
  const lung = shallow.matches.find((m) => m.structure.id === 'UBERON:0002048')!;
  assert.ok(Math.abs(lung.fraction - 2 / 24) < 1e-12, 'two of the level\'s 24 azimuth cells');
  assert.ok(shallow.unclaimedFraction > 0.9, 'most of a whole vertebral level is unindexed here');
});

test('resolve: says so when nothing is indexed, and flags an experimental frame', () => {
  const empty = resolve('BV-L-471', buildNameIndex({ version: 'v0', structures: [] }));
  assert.deepEqual([...empty.matches], []);
  assert.equal(empty.unclaimedFraction, 1);
  assert.ok(empty.notes.some((n) => n.includes('no structure')));

  const experimental = resolve('BR-L-7A3F', buildNameIndex({ version: 'v0', structures: [] }));
  assert.ok(experimental.notes.some((n) => n.includes('experimental')));
});

test('resolve: minFraction and limit trim the ranking without distorting it', () => {
  const all = resolve('BD-T07-03O-5', THORAX_INDEX);
  const trimmed = resolve('BD-T07-03O-5', THORAX_INDEX, { minFraction: 0.2 });
  assert.ok(trimmed.matches.length < all.matches.length);
  assert.ok(trimmed.matches.every((m) => m.fraction >= 0.2));
  // Dropping a match from the display must not change what is claimed.
  assert.equal(trimmed.unclaimedFraction, all.unclaimedFraction);

  const limited = resolve('BD-T07-03O-5', THORAX_INDEX, { limit: 2 });
  assert.equal(limited.matches.length, 2);
  assert.deepEqual(limited.matches.map((m) => m.structure.id), all.matches.slice(0, 2).map((m) => m.structure.id));

  for (const bad of [-0.1, 1.5, NaN]) {
    assert.throws(
      () => resolve('BD-T07-03O-5', THORAX_INDEX, { minFraction: bad }),
      (e: unknown) => (e as AlcError).code === 'bad_fraction',
    );
  }
});

// ---------------------------------------------------------------------------
test('resolve: the prefix-scan lookup agrees with a brute-force scan', () => {
  // The index answers queries with a binary search plus a prefix range walk.
  // That optimisation is only worth having if it is exactly equivalent to
  // checking every structure, so check it against every structure.
  const r = rng(1313);
  const structures = Array.from({ length: 60 }, (_, i) => ({
    id: `s${i}`,
    name: `structure ${i}`,
    cells: Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
      const digits = Array.from({ length: 1 + Math.floor(r() * 4) }, () => '01234567'[Math.floor(r() * 8)]).join('');
      return `BV-${r() < 0.5 ? 'L' : 'R'}-${digits}`;
    }),
  }));
  const index = buildNameIndex({ version: 'generated-1', structures });

  for (let probe = 0; probe < 300; probe += 1) {
    const digits = Array.from({ length: 1 + Math.floor(r() * 5) }, () => '01234567'[Math.floor(r() * 8)]).join('');
    const address = parse(`BV-${r() < 0.5 ? 'L' : 'R'}-${digits}`).canonical;
    const viaIndex = resolve(address, index).matches;

    const brute: Array<{ id: string; fraction: number }> = [];
    for (let i = 0; i < index.structures.length; i += 1) {
      const fraction = coveringMeasureWithin(index.coverings[i], address);
      if (fraction > 0) brute.push({ id: index.structures[i].id, fraction });
    }
    brute.sort((x, y) => y.fraction - x.fraction || (x.id < y.id ? -1 : 1));
    assert.deepEqual(
      viaIndex.map((m) => ({ id: m.structure.id, fraction: m.fraction })),
      brute,
      `index and brute force disagreed for ${address}`,
    );
  }
});

// ---------------------------------------------------------------------------
test('name -> covering: the reverse direction returns a minimal prefix set', () => {
  const lung = structureCovering('UBERON:0002048', THORAX_INDEX);
  assert.deepEqual([...lung.cells], ['BD-T07-03O', 'BD-T07-04O']);

  // A structure given as a complete sibling group comes back rolled up, which
  // is what keeps a covering small enough to ship and query.
  const rolled = buildNameIndex({
    version: 'rolled-1',
    structures: [{ id: 'whole', name: 'whole cell', cells: children('BV-L-4').map((c) => c.canonical) }],
  });
  assert.deepEqual([...structureCovering('whole', rolled).cells], ['BV-L-4']);

  assert.throws(
    () => structureCovering('nope', THORAX_INDEX),
    (e: unknown) => (e as AlcError).code === 'unknown_structure',
  );
});

test('containingStructures: the hierarchical reading, coarsest first', () => {
  const chain = containingStructures('BD-T07-03O-531', THORAX_INDEX).map((s) => s.name);
  assert.deepEqual(chain, ['left lung', 'lower lobe of left lung', '7th rib']);
  // Nothing is inferred from a fraction: a structure that merely overlaps is absent.
  assert.equal(containingStructures('BD-T07-03O-5', THORAX_INDEX).map((s) => s.id).includes('UBERON:0001103'), false);
  assert.deepEqual(containingStructures('BV-L-471', THORAX_INDEX), []);
});

test('findStructures: name search for a UI, case-insensitive and bounded', () => {
  assert.deepEqual(findStructures('LUNG', THORAX_INDEX).map((s) => s.id).sort(), [
    'UBERON:0002048',
    'UBERON:0008946',
  ]);
  assert.deepEqual(findStructures('uberon:0001103', THORAX_INDEX).map((s) => s.name), ['intercostal muscle']);
  assert.deepEqual(findStructures('   ', THORAX_INDEX), []);
  assert.equal(findStructures('e', THORAX_INDEX, 2).length, 2, 'the limit is respected');
});

// ---------------------------------------------------------------------------
test('resolveCovering: a finding spanning cells resolves by measure-weighted fraction', () => {
  // Two cells of very different sizes. The structure filling the big one must
  // outrank the structure filling the small one.
  const finding = covering(['BV-L-4', 'BV-L-50']);
  const index = buildNameIndex({
    version: 'weighted-1',
    structures: [
      { id: 'big', name: 'fills the coarse cell', cells: ['BV-L-4'] },
      { id: 'small', name: 'fills the fine cell', cells: ['BV-L-50'] },
    ],
  });
  const r = resolveCovering(finding, index);
  assert.equal(r.indexVersion, 'weighted-1');
  assert.deepEqual(r.matches.map((m) => m.structure.id), ['big', 'small']);

  // Weights: BV-L-4 is 1/8 of its frame root, BV-L-50 is 1/64. Total 9/64.
  const total = 1 / 8 + 1 / 64;
  assert.ok(Math.abs(coveringMeasure(finding) - total) < 1e-12);
  assert.ok(Math.abs(r.matches[0].fraction - (1 / 8) / total) < 1e-12);
  assert.ok(Math.abs(r.matches[1].fraction - (1 / 64) / total) < 1e-12);
  const sum = r.matches.reduce((s, m) => s + m.fraction, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, `weighted fractions summed to ${sum}`);
  assert.ok(Math.abs(r.unclaimedFraction) < 1e-12);

  const empty = resolveCovering(covering([]), index);
  assert.deepEqual([...empty.matches], []);
  assert.ok(empty.notes.includes('empty covering'));
  assert.throws(
    () => resolveCovering(['BV-L-4'] as never, index),
    (e: unknown) => (e as AlcError).code === 'bad_covering',
  );
});

test('frameRootOf and coveringMeasure: the denominator is the frame root', () => {
  assert.equal(frameRootOf('BD-T07-02O-5316'), 'BD-T07');
  assert.equal(frameRootOf('BD-T07'), 'BD-T07');
  assert.equal(frameRootOf('BV-L-471'), 'BV-L');
  assert.equal(frameRootOf('BR-L-7A3F'), 'BR-L-7');
  assert.equal(coveringMeasure(covering(['BV-L', 'BV-R'])), 2);
  assert.equal(coveringMeasure(covering(['BD-T07', 'BD-T08'])), 2);
  assert.equal(coveringMeasure(covering([])), 0);
});

// ---------------------------------------------------------------------------
test('name index: malformed input is refused at build time, not at query time', () => {
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ id: '', name: 'x', cells: [] }, 'bad_structure'],
    [{ id: 'x', name: '', cells: [] }, 'bad_structure'],
    [{ id: 'x', cells: [] }, 'bad_structure'],
    [{ id: 'x', name: 'x', cells: ['BD-T07-02O-9'] }, 'bad_structure_covering'],
    [{ id: 'x', name: 'x', cells: ['not an address'] }, 'bad_structure_covering'],
    [{ id: 'x', name: 'x', cells: ['BD-T07-HIPPOCAMPUS'] }, 'bad_structure_covering'],
  ];
  for (const [structure, code] of bad) {
    assert.throws(
      () => buildNameIndex({ version: 'v', structures: [structure as never] }),
      (e: unknown) => (e as AlcError).code === code,
      `${JSON.stringify(structure)} should fail with ${code}`,
    );
  }
  assert.throws(
    () => buildNameIndex({
      version: 'v',
      structures: [{ id: 'dup', name: 'a', cells: [] }, { id: 'dup', name: 'b', cells: [] }],
    }),
    (e: unknown) => (e as AlcError).code === 'duplicate_structure',
  );
  // A hand-built object is not an index: the lookup tables live in a WeakMap.
  assert.throws(
    () => resolve('BV-L-4', { version: 'fake', structures: [], coverings: [] } as NameIndex),
    (e: unknown) => (e as AlcError).code === 'bad_name_index',
  );
});

test('an address can never contain a parcellation name', () => {
  // The structural guarantee behind "a parcellation revision cannot invalidate
  // an issued address": a name is not expressible in the grammar at all.
  for (const attempt of [
    'BD-T07-HIPPOCAMPUS',
    'BV-L-AMYGDALA',
    'BV-LUNG-471',
    'UBERON:0002048',
    'BD-T07-02O-531@UBERON:0002048',
  ]) {
    assert.equal(isValid(attempt), false, `${attempt} must not parse`);
  }
  // The legal alphabet has no room for one: 24 symbols, none of them a separator
  // that could introduce a name.
  const index = THORAX_INDEX;
  for (const s of index.structures) {
    for (const cell of structureCovering(s.id, index).cells) {
      assert.equal(cell.includes(s.name), false, `${cell} must not embed ${s.name}`);
      assert.match(cell, /^[0-9A-Z-]+$/);
    }
  }
});
