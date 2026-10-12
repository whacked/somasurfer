/**
 * Region links (DOG-130), on a synthetic world small enough to reason about.
 *
 * The committed index over the real seed and the real brain meshes is gated
 * by tools/check-crosswalk.mjs, which runs `checkRegionIndex` on it. These
 * cases pin the same invariants where every input is visible, including the
 * ones the real data cannot reach today: there is no HCP-MMP1 → gyrus link at
 * all while the cortex is held, and no coordinate link while every curated
 * coordinate falls outside the shipped structures.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  buildRegionIndex,
  checkRegionIndex,
  REPRESENTATIONS,
  validateCrosswalk,
  type Crosswalk,
  type RegionIndex,
  type RepresentationData,
} from '../src/index.ts';
import type { Finding, Paper, RegionMapping, ResearchDataset, SpatialDetail } from '../src/types.ts';

const rep = (id: string) => REPRESENTATIONS.find((r) => r.id === id)!;
const PROV = { assertedBy: 'test', assertedOn: '2026-10-11', basis: 'published-text', confidence: 'high' } as const;
const REGISTRATION_MM = 8.55;
const PUTAMEN_L_MNI = [-26, 1, 0] as const;

const REGION: SpatialDetail = { kind: 'region-level', reason: 'test' };

function mapping(id: string, scheme: string, term: string, label: string, spatial: SpatialDetail = REGION): RegionMapping {
  return {
    id,
    structureId: term,
    structureIdSource: scheme,
    structureLabel: label,
    spatial,
    evidence: { summary: 'test', kind: 'abstract', locator: null, locatorStatus: 'not-recorded' },
    provenance: PROV,
  };
}

function paper(id: string): Paper {
  return {
    id,
    title: id,
    authors: ['A'],
    year: 2000,
    venue: 'V',
    identifier: { kind: 'none', value: null },
    sourceUrl: null,
    provenance: PROV,
  };
}

function finding(id: string, paperId: string, mappings: RegionMapping[]): Finding {
  return { id, paperId, statement: id, topics: [], mappings, provenance: PROV };
}

/** Five papers, one per route the resolver has. */
function dataset(): ResearchDataset {
  return {
    schema: 'research/1',
    version: 'test-1',
    structureIdSources: ['FMA', 'HCP-MMP1', 'ATLAS-LABEL'],
    authoredAgainst: { status: 'fixture', nameIndexVersion: 'test' },
    curation: { curatedBy: 't', curatedOn: '2026-10-11', method: 't', citationCheck: 't', notRecorded: [] },
    papers: ['p:term', 'p:hcp', 'p:coord', 'p:held', 'p:body'].map(paper),
    findings: [
      finding('f:term', 'p:term', [mapping('m:putamen', 'ATLAS-LABEL', 'ATLAS-LABEL:putamen', 'putamen')]),
      finding('f:hcp', 'p:hcp', [mapping('m:a4', 'HCP-MMP1', 'HCP-MMP1:A4', 'Auditory area 4')]),
      finding('f:coord', 'p:coord', [
        mapping('m:in', 'HCP-MMP1', 'HCP-MMP1:4', 'Primary motor cortex (area 4)', {
          kind: 'coordinates',
          space: 'MNI152',
          frame: 'BV',
          pointsMm: [PUTAMEN_L_MNI],
          digits: 4,
        }),
        mapping('m:out', 'HCP-MMP1', 'HCP-MMP1:4', 'Primary motor cortex (area 4)', {
          kind: 'coordinates',
          space: 'MNI152',
          frame: 'BV',
          pointsMm: [[40, -55, -10]],
          digits: 4,
        }),
      ]),
      finding('f:held', 'p:held', [mapping('m:precentral', 'ATLAS-LABEL', 'ATLAS-LABEL:precentral-gyrus', 'precentral gyrus')]),
      finding('f:body', 'p:body', [
        mapping('m:heart', 'FMA', 'FMA7088', 'heart'),
        mapping('m:rib', 'ATLAS-LABEL', 'ATLAS-LABEL:rib-7', '7th rib'),
      ]),
    ],
  };
}

const crosswalk = (): Crosswalk => ({
  schema: 'atlas-crosswalk/1',
  version: 'test',
  assertedBy: 't',
  assertedOn: '2026-10-11',
  entries: [
    { term: 'ATLAS-LABEL:putamen', label: 'putamen', how: 'exact-term', completeness: 'same', targets: [{ representation: 'zanatomy-gross-anatomy', label: 'Putamen' }] },
    {
      term: 'HCP-MMP1:A4',
      label: 'Auditory area 4',
      how: 'crosswalk',
      completeness: 'overlaps',
      targets: [{ representation: 'zanatomy-gross-anatomy', label: 'Superior temporal gyrus (Lateral part)' }],
      why: 'A4 lies on the lateral superior temporal gyrus',
    },
    {
      term: 'HCP-MMP1:4',
      label: 'Primary motor cortex (area 4)',
      how: 'crosswalk',
      completeness: 'overlaps',
      targets: [{ representation: 'zanatomy-gross-anatomy', label: 'Precentral gyrus' }],
      why: 'area 4 lies on the precentral gyrus',
    },
    { term: 'ATLAS-LABEL:precentral-gyrus', label: 'precentral gyrus', how: 'exact-term', completeness: 'same', targets: [{ representation: 'zanatomy-gross-anatomy', label: 'Precentral gyrus' }] },
    { term: 'ATLAS-LABEL:rib-7', label: '7th rib', how: 'exact-term', completeness: 'none', targets: [], why: 'no individual rib is named' },
  ],
});

/**
 * The brain as a representation. `cortexCleared` moves the precentral gyrus
 * from held to shipped and changes nothing else: the swap the cortex decision
 * may make, done as data.
 */
function brain({ cortexCleared = false } = {}): RepresentationData {
  const both = (id: number, label: string) => [
    { id: String(id), name: `${label}.l`, label, side: 'left' as const },
    { id: String(id + 1), name: `${label}.r`, label, side: 'right' as const },
  ];
  const precentral = both(30, 'Precentral gyrus');
  return {
    representation: rep('zanatomy-gross-anatomy'),
    version: 'test-brain',
    structures: [...both(10, 'Putamen'), ...both(20, 'Superior temporal gyrus (Lateral part)'), ...(cortexCleared ? precentral : [])],
    held: cortexCleared ? [] : precentral.map((s) => ({ name: s.name, label: s.label, side: s.side, because: 'undeclared material' })),
    // Inside the left putamen within 5 mm of PUTAMEN_L_MNI, inside nothing elsewhere.
    locate: (p) =>
      Math.hypot(p[0] - PUTAMEN_L_MNI[0], p[1] - PUTAMEN_L_MNI[1], p[2] - PUTAMEN_L_MNI[2]) < 5
        ? { inside: [{ id: '10', depthMm: 2 }], nearest: { id: '10', distanceMm: 2 } }
        : { inside: [], nearest: { id: '21', distanceMm: 0.5 } },
    coordinatePrecision: { mm: REGISTRATION_MM, basis: 'held-out error at the red nucleus' },
  };
}

const body: RepresentationData = {
  representation: rep('bodyparts3d-bd'),
  version: 'test-body',
  structures: [{ id: 'FMA7088', name: 'heart', label: 'heart', side: null }],
  held: [],
};

const world = (opts = {}) => [brain(opts), body];
const build = (opts = {}): RegionIndex => buildRegionIndex({ dataset: dataset(), crosswalk: crosswalk(), representations: world(opts) });
const allLinks = (index: RegionIndex) => index.mappings.flatMap((o) => o.links);

// ---------------------------------------------------------------------------

test('the synthetic world is sound: no invariant fires, and the crosswalk validates', () => {
  assert.deepEqual(validateCrosswalk(crosswalk(), world(), dataset()), []);
  assert.deepEqual(checkRegionIndex(build(), world()), []);
});

test('every link records how it was made, and a precision that matches', () => {
  const links = allLinks(build());
  assert.ok(links.length > 0);
  for (const l of links) {
    assert.ok(['exact-term', 'crosswalk', 'coordinate'].includes(l.how), `${l.mappingId}: ${l.how}`);
    const expected = { 'exact-term': 'exact', crosswalk: 'approximate', coordinate: 'mm' }[l.how];
    assert.equal(l.precision.kind, expected, `${l.mappingId} → ${l.structureName}`);
  }
});

test('resolve(finding) returns structureId, how and precision for each link', () => {
  const index = build();
  const links = index.resolve('f:term');
  assert.deepEqual(
    links.map((l) => [l.structureId, l.how, l.precision.kind, l.side]),
    [
      ['10', 'exact-term', 'exact', 'left'],
      ['11', 'exact-term', 'exact', 'right'],
    ],
  );
  // A term gives no side, so the links do not claim one came from the source.
  assert.ok(links.every((l) => l.sideFromSource === false));
  assert.deepEqual(index.resolve(dataset().findings[0]), links);
});

test('an HCP-MMP1 → gyrus link is crosswalk, approximate, and keeps the area name', () => {
  const links = build().resolve('f:hcp');
  assert.equal(links.length, 2);
  for (const l of links) {
    assert.equal(l.how, 'crosswalk');
    assert.equal(l.precision.kind, 'approximate');
    assert.ok(l.precision.kind === 'approximate' && l.precision.why.includes('A4'));
    assert.deepEqual(l.source, { scheme: 'HCP-MMP1', term: 'HCP-MMP1:A4', label: 'Auditory area 4' });
    assert.equal(l.crosswalk?.completeness, 'overlaps');
  }
});

test('a coordinate inside a structure links as coordinate, with the registration error, never exact-term', () => {
  const index = build();
  const placed = allLinks(index).filter((l) => l.coordinate !== undefined);
  assert.equal(placed.length, 1);
  const [l] = placed;
  assert.equal(l.mappingId, 'm:in');
  assert.equal(l.structureName, 'Putamen.l');
  assert.equal(l.how, 'coordinate');
  assert.deepEqual(l.precision, { kind: 'mm', mm: REGISTRATION_MM, basis: 'held-out error at the red nucleus' });
  assert.equal(l.sideFromSource, true);
  assert.deepEqual(l.coordinate?.mniMm, PUTAMEN_L_MNI);
  // The acceptance criterion, over the whole index.
  assert.equal(allLinks(index).filter((x) => x.coordinate !== undefined && x.how === 'exact-term').length, 0);
});

test('no coordinate link claims a precision tighter than the registration', () => {
  for (const l of allLinks(build())) {
    if (l.how !== 'coordinate') continue;
    assert.ok(l.precision.kind === 'mm' && l.precision.mm >= REGISTRATION_MM, `${l.mappingId}: ${JSON.stringify(l.precision)}`);
  }
});

test('a coordinate inside nothing is reported with its nearest structure and is not linked to it', () => {
  const out = build().mappings.find((o) => o.mappingId === 'm:out')!;
  assert.equal(out.links.filter((l) => l.how === 'coordinate').length, 0);
  const u = out.unplaced.find((x) => x.route === 'coordinate')!;
  assert.equal(u.code, 'coordinate-outside-shipped-structures');
  assert.match(u.detail, /the nearest is Superior temporal gyrus \(Lateral part\)\.r, 0\.5 mm away/);
  assert.match(u.detail, /Not linked: nearest is not containing/);
});

test('a BV cell is placed at its centre, with half its diagonal added to the error', () => {
  const ds = dataset();
  const f = finding('f:cell', 'p:term', [
    mapping('m:cell', 'ATLAS-LABEL', 'ATLAS-LABEL:putamen', 'putamen', { kind: 'cells', cells: ['BV-L-0'], method: 't', digits: 1 }),
  ]);
  const template = {
    id: 'icbm152-2009c-asym',
    acMm: [0, 0, 0],
    left: [-1, 0, 0],
    anterior: [0, 1, 0],
    superior: [0, 0, 1],
    extents: { left: 72.5, right: 72.5, anterior: 73.5, posterior: 108.5, superior: 82.5, inferior: 72.5 },
  };
  const seen: number[][] = [];
  const b = { ...brain(), locate: (p: readonly number[]) => (seen.push([...p]), { inside: [{ id: '10', depthMm: 1 }], nearest: null }) };
  const index = buildRegionIndex({
    dataset: { ...ds, findings: [...ds.findings, f] },
    crosswalk: crosswalk(),
    representations: [b, body],
    templates: { brainVolume: template } as never,
  });
  const l = index.resolve('f:cell').find((x) => x.how === 'coordinate')!;
  assert.equal(l.coordinate?.from, 'cell');
  assert.equal(l.coordinate?.address, 'BV-L-0');
  // BV-L-0 is the left half's lower-posterior-medial octant: x from 0 to -36.25.
  assert.ok(seen[0][0] < 0 && seen[0][0] > -36.25, `centre ${seen[0]}`);
  assert.ok(l.precision.kind === 'mm' && l.precision.mm > REGISTRATION_MM);
  assert.ok(l.precision.kind === 'mm' && /half the diagonal of cell BV-L-0/.test(l.precision.basis));
  assert.deepEqual(checkRegionIndex(index, [b, body]), []);
});

test('a term whose every target is held resolves to a stated hold, and its paper says so', () => {
  const index = build();
  const o = index.mappings.find((x) => x.mappingId === 'm:precentral')!;
  assert.equal(o.links.length, 0);
  assert.equal(o.unplaced[0].code, 'structure-held');
  assert.match(o.unplaced[0].detail, /Precentral gyrus\. Held because: undeclared material/);
  const p = index.papers.find((x) => x.paperId === 'p:held')!;
  assert.deepEqual(p.regions, []);
  assert.deepEqual(p.emptyBecause.map((e) => [e.code, e.mappingIds]), [['structure-held', ['m:precentral']]]);
});

test('every paper is non-empty or carries a stated reason', () => {
  const index = build();
  for (const p of index.papers) {
    assert.ok(p.regions.length > 0 || p.emptyBecause.length > 0, p.paperId);
  }
  assert.equal(index.coverage.papers.nonEmpty + index.coverage.papers.emptyWithStatedReason, index.coverage.papers.total);
});

test('clearing the cortex is a data change: the same crosswalk and resolver reach it', () => {
  const before = build();
  const after = build({ cortexCleared: true });
  assert.equal(before.resolve('f:held').length, 0);
  assert.deepEqual(
    after.resolve('f:held').map((l) => [l.structureName, l.how]),
    [
      ['Precentral gyrus.l', 'exact-term'],
      ['Precentral gyrus.r', 'exact-term'],
    ],
  );
  // The HCP-MMP1 area 4 mappings now reach their gyrus too, as crosswalk.
  assert.ok(after.resolve('f:coord').some((l) => l.how === 'crosswalk' && l.structureName === 'Precentral gyrus.l'));
  // And the criterion holds under both, with nothing to rewrite.
  assert.deepEqual(checkRegionIndex(before, world()), []);
  assert.deepEqual(checkRegionIndex(after, world({ cortexCleared: true })), []);
  assert.ok(after.coverage.papers.nonEmpty > before.coverage.papers.nonEmpty);
});

test('a body FMA id resolves by identity, and an unnamed body term carries the crosswalk reason', () => {
  const index = build();
  const heart = index.mappings.find((o) => o.mappingId === 'm:heart')!;
  assert.deepEqual(
    heart.links.map((l) => [l.representation, l.structureId, l.how]),
    [['bodyparts3d-bd', 'FMA7088', 'exact-term']],
  );
  const rib = index.mappings.find((o) => o.mappingId === 'm:rib')!;
  assert.deepEqual(rib.unplaced.map((u) => [u.code, u.detail]), [['not-in-representation', 'no individual rib is named']]);
});

test('paper → regions and region → papers agree, both ways', () => {
  const index = build();
  let pairs = 0;
  for (const p of index.papers) {
    for (const r of index.regionsFor(p.paperId)) {
      const back = index.papersFor(r.key).find((x) => x.paperId === p.paperId);
      assert.ok(back, `${p.paperId} → ${r.key} has no way back`);
      assert.deepEqual(back.links, r.links);
      pairs += 1;
    }
  }
  for (const s of index.structures) {
    for (const pid of s.paperIds) assert.ok(index.regionsFor(pid).some((r) => r.key === s.key), `${s.key} → ${pid}`);
  }
  assert.ok(pairs > 0);
});

test('checkRegionIndex goes red on each broken invariant', () => {
  const index = build();
  const reps = world();
  const link = index.resolve('f:term')[0];
  const withLink = (extra: object) => ({
    ...index,
    mappings: index.mappings.map((o, i) => (i === 0 ? { ...o, links: [...o.links, { ...link, ...extra }] } : o)),
  });
  const point = { coordinate: { from: 'coordinates', mniMm: [0, 0, 0], depthMm: 1 } };
  assert.ok(checkRegionIndex(withLink(point), reps).some((p) => /placed coordinate is labelled exact-term/.test(p)));
  assert.ok(
    checkRegionIndex(withLink({ ...point, how: 'coordinate', precision: { kind: 'mm', mm: 2, basis: 'b' } }), reps).some((p) =>
      /tighter than the registration's measured 8\.55 mm/.test(p),
    ),
  );
  assert.ok(
    checkRegionIndex(withLink({ source: { scheme: 'HCP-MMP1', term: 'HCP-MMP1:A4', label: 'A4' } }), reps).some((p) =>
      /HCP-MMP1 link labelled exact-term/.test(p),
    ),
  );
  const noReason = { ...index, papers: index.papers.map((p) => (p.paperId === 'p:held' ? { ...p, emptyBecause: [] } : p)) };
  assert.ok(checkRegionIndex(noReason, reps).some((p) => /p:held: no region and no stated reason/.test(p)));
  const lost = { ...index, structures: index.structures.map((s, i) => (i === 0 ? { ...s, paperIds: [] } : s)) };
  assert.ok(checkRegionIndex(lost, reps).some((p) => /round trip/.test(p)));
});

test('validateCrosswalk refuses an exact HCP-MMP1 entry, a misspelt target and a term with no entry', () => {
  const reps = world();
  const exact = crosswalk();
  (exact.entries[1] as { how: string }).how = 'exact-term';
  assert.ok(validateCrosswalk(exact, reps).some((p) => /HCP-MMP1:A4: claims exact-term/.test(p)));

  const typo = crosswalk();
  (typo.entries[0].targets[0] as { label: string }).label = 'Putamen (sic)';
  assert.ok(validateCrosswalk(typo, reps).some((p) => /target "Putamen \(sic\)" is not a structure/.test(p)));

  const missing = { ...crosswalk(), entries: crosswalk().entries.slice(1) };
  assert.ok(validateCrosswalk(missing, reps, dataset()).some((p) => /ATLAS-LABEL:putamen has no crosswalk entry/.test(p)));
});

// ---------------------------------------------------------------------------
// The lobe-labelled cortex (owner card 6a774981, DOG-151)
// ---------------------------------------------------------------------------

/** A synthetic ICBM152 cortex with two lobes per side, in the shape DOG-151 was asked for. */
const lobes: RepresentationData = {
  representation: rep('icbm152-2009c-cortex-lobes'),
  version: 'test-lobes',
  structures: ['Frontal lobe', 'Parietal lobe'].flatMap((label, i) => [
    { id: String(100 + i * 2), name: `${label}.l`, label, side: 'left' as const },
    { id: String(101 + i * 2), name: `${label}.r`, label, side: 'right' as const },
  ]),
  held: [],
};

/** The crosswalk with area 4 also targeting its lobe, as the committed one does. */
function crosswalkWithLobes(lobeLabel = 'Frontal lobe'): Crosswalk {
  const c = crosswalk();
  return {
    ...c,
    entries: c.entries.map((e) =>
      e.term === 'HCP-MMP1:4' ? { ...e, targets: [...e.targets, { representation: 'icbm152-2009c-cortex-lobes', label: lobeLabel }] } : e,
    ),
  };
}

/** Area 4 reported with no coordinate: the case the owner's approval is about. */
function datasetWithArea4(): ResearchDataset {
  const ds = dataset();
  return {
    ...ds,
    papers: [...ds.papers, paper('p:area4')],
    findings: [...ds.findings, finding('f:area4', 'p:area4', [mapping('m:area4', 'HCP-MMP1', 'HCP-MMP1:4', 'Primary motor cortex (area 4)')])],
  };
}

test('a coordinate-free HCP-MMP1 area reaches its lobe as crosswalk, approximate, with its own name, while its gyrus is held', () => {
  const reps = [...world(), lobes];
  const index = buildRegionIndex({ dataset: datasetWithArea4(), crosswalk: crosswalkWithLobes(), representations: reps });
  const links = index.resolve('f:area4');
  assert.deepEqual(
    links.map((l) => [l.representation, l.structureName, l.how, l.precision.kind]),
    [
      ['icbm152-2009c-cortex-lobes', 'Frontal lobe.l', 'crosswalk', 'approximate'],
      ['icbm152-2009c-cortex-lobes', 'Frontal lobe.r', 'crosswalk', 'approximate'],
    ],
  );
  for (const l of links) {
    assert.deepEqual(l.source, { scheme: 'HCP-MMP1', term: 'HCP-MMP1:4', label: 'Primary motor cortex (area 4)' });
    // The finer target is held, and the lobe link says so rather than standing in for it silently.
    assert.deepEqual(l.crosswalk?.heldTargets, ['Precentral gyrus']);
  }
  assert.deepEqual(checkRegionIndex(index, reps), []);
  assert.deepEqual(validateCrosswalk(crosswalkWithLobes(), reps, datasetWithArea4()), []);
});

test('without the lobe data, the hold names the lobe targets that were not supplied', () => {
  const index = buildRegionIndex({ dataset: datasetWithArea4(), crosswalk: crosswalkWithLobes(), representations: world() });
  const o = index.mappings.find((x) => x.mappingId === 'm:area4')!;
  assert.equal(o.links.length, 0);
  assert.equal(o.unplaced[0].code, 'structure-held');
  assert.match(o.unplaced[0].detail, /every supplied target of HCP-MMP1:4/);
  assert.match(o.unplaced[0].detail, /Its targets in icbm152-2009c-cortex-lobes were not supplied\./);
});

test('validateCrosswalk refuses a lobe label the lobe cortex does not carry, once its data is supplied', () => {
  const reps = [...world(), lobes];
  assert.ok(
    validateCrosswalk(crosswalkWithLobes('Frontal Lobe'), reps).some((p) =>
      /target "Frontal Lobe" is not a structure of icbm152-2009c-cortex-lobes test-lobes/.test(p),
    ),
  );
  // And it cannot check it without the data: that is what the gate reports as UNVERIFIED.
  assert.deepEqual(validateCrosswalk(crosswalkWithLobes('Frontal Lobe'), world()), []);
});
