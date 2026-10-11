/**
 * The naming layer: `names.json` and `coverings.json`.
 *
 *   node tools/build-name-index.mjs --source <bp3d dir> --uberon <uberon dir>
 *
 * Two files, because they answer two different questions and change at
 * different rates. `names.json` says what a structure id means — its term, its
 * ontology cross-references, where it came from. `coverings.json` says where it
 * is, as a normalised set of ALC-1 cells. A new mesh release moves the
 * coverings and leaves the names alone; a new ontology release does the
 * reverse.
 *
 * WHY A COVERING AND NOT A BOUNDING BOX. `resolve()` answers "what is at this
 * address" with a prefix range scan over a sorted cell list (query.ts), which
 * is only correct if the cells are canonical, disjoint and maximally rolled up.
 * `covering()` establishes exactly those invariants. A bounding box would need
 * every query to test every structure.
 *
 * THE COVERINGS ARE SOLID, NOT SHELLS. A structure's cells are built from
 * points sampled on a regular grid through its interior, not from its mesh
 * vertices. Vertices are on the surface, so a vertex-built covering says the
 * middle of the liver is not liver — which is wrong in the one direction that
 * matters, because the interior is most of the organ. Interior testing is a
 * ray-parity test per element mesh, OR-ed across the parts: see `insideParts`,
 * and note that BodyParts3D builds the heart out of 83 element meshes that
 * share walls, so parity over the merged soup is not the same thing.
 *
 * THE INDEX VERSION IS NOT COSMETIC. `resolve()` stamps it into every result,
 * because a name is only true relative to an index and an address outlives any
 * index. `tools/verify-name-index.mjs` asserts the property that makes this
 * worth doing: the same address, against a deliberately different index
 * version with structures removed, still denotes the same millimetres and only
 * its NAMES change.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { REPO_ROOT, rel } from './lib/repo.mjs';
import { BD_LEVELS, NAMED_STRUCTURES, SOURCE, openSource } from './lib/bp3d.mjs';
import { bounds, buildGrid, insideParts } from './lib/mesh.mjs';

const { covering } = await import('../packages/alc/src/covering.ts');
const { encodeBody } = await import('../packages/alc/src/locate.ts');

function parseArgs(argv) {
  const opts = {
    source: process.env.ALC_BP3D_DIR ?? null,
    uberon: process.env.ALC_UBERON_DIR ?? null,
    template: null,
    digits: 1,
    sampleMm: 8,
    version: null,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    const a = argv[i];
    if (a === '--source') opts.source = next();
    else if (a === '--uberon') opts.uberon = next();
    else if (a === '--template') opts.template = next();
    else if (a === '--digits') opts.digits = Number(next());
    else if (a === '--sample-mm') opts.sampleMm = Number(next());
    else if (a === '--version') opts.version = next();
    else if (a === '--out-dir') opts.outDir = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.source) throw new Error('--source <dir> (or ALC_BP3D_DIR) must name the BodyParts3D source directory');
  if (!Number.isInteger(opts.digits) || opts.digits < 0) throw new Error('--digits must be a non-negative integer');
  if (!(opts.sampleMm > 0)) throw new Error('--sample-mm must be positive');
  opts.outDir ??= join(REPO_ROOT, 'packages', 'atlas-assets', 'labels');
  opts.template ??= join(
    REPO_ROOT, 'packages', 'atlas-assets', 'templates', 'bp3d-4.0-adult-body-centroid.body.json',
  );
  return opts;
}

/**
 * `FMA:nnnnn -> UBERON:nnnnnnn`, from UBERON's own `xref` lines.
 *
 * UBERON is the cross-species reference ontology and carries FMA cross-
 * references for the human terms, so it is the right direction to read the
 * mapping from: FMA does not publish UBERON ids. Only the term block's own
 * `xref:` lines are read — an `xref` inside a `[Typedef]` stanza or a
 * relationship is not a term equivalence.
 *
 * Returns both directions of multiplicity. One FMA id mapping to several
 * UBERON terms is real (UBERON splits some FMA concepts), and it is recorded
 * as a list rather than resolved by picking one.
 */
function readUberonXrefs(oboText) {
  const byFma = new Map();
  let id = null;
  let name = null;
  let inTerm = false;
  for (const line of oboText.split('\n')) {
    if (line.startsWith('[')) {
      inTerm = line.startsWith('[Term]');
      id = null;
      name = null;
      continue;
    }
    if (!inTerm) continue;
    if (line.startsWith('id: ')) id = line.slice(4).trim();
    else if (line.startsWith('name: ')) name = line.slice(6).trim();
    else if (line.startsWith('xref: FMA:') && id?.startsWith('UBERON:')) {
      const fma = `FMA${line.slice(10).trim().split(/\s/)[0]}`;
      if (!byFma.has(fma)) byFma.set(fma, []);
      byFma.get(fma).push({ id, name });
    }
  }
  return byFma;
}

const opts = parseArgs(process.argv.slice(2));
const source = openSource(opts.source);
const template = JSON.parse(readFileSync(opts.template, 'utf8'));

let uberon = new Map();
let uberonProvenance = null;
if (opts.uberon) {
  const obo = join(opts.uberon, 'basic.obo');
  if (!existsSync(obo)) {
    throw new Error(
      `${obo} is missing. Fetch it with:\n  curl -o basic.obo http://purl.obolibrary.org/obo/uberon/basic.obo`,
    );
  }
  const text = readFileSync(obo, 'utf8');
  uberon = readUberonXrefs(text);
  const header = text.slice(0, text.indexOf('\n[')).split('\n');
  uberonProvenance = {
    file: 'uberon/basic.obo',
    url: 'http://purl.obolibrary.org/obo/uberon/basic.obo',
    licence: 'CC-BY-3.0',
    licenceUrl: 'https://creativecommons.org/licenses/by/3.0/',
    holder: 'The UBERON project / OBO Foundry',
    dataVersion: header.find((l) => l.startsWith('data-version:'))?.slice(13).trim() ?? null,
    sha256: createHash('sha256').update(text).digest('hex'),
    fmaXrefs: uberon.size,
  };
}

/**
 * Everything to be indexed: the 25 vertebral levels, then the curated
 * structure list. The levels come first so a reader of `names.json` sees the
 * addressing skeleton before the soft tissue hung on it.
 */
const wanted = [
  ...BD_LEVELS.map(([level, fma, term]) => ({ fma, term, tree: 'isa', level })),
  ...NAMED_STRUCTURES.map(([fma, term, tree]) => ({ fma, term, tree, level: null })),
];

const structures = [];
const coverings = [];
const report = [];

for (const want of wanted) {
  // The term check is the point of listing expected terms at all.
  const actual = source.nameOf(want.fma, want.tree);
  if (actual === null) {
    throw new Error(
      `${want.fma} is absent from the ${want.tree} parts list. The structure list in `
      + 'tools/lib/bp3d.mjs names a concept this release does not carry.',
    );
  }
  if (actual !== want.term) {
    throw new Error(
      `${want.fma} is "${actual}" in the ${want.tree} tree, but the structure list expects `
      + `"${want.term}". An FMA id whose term changed is a different concept; fix the list rather `
      + 'than shipping a mislabelled structure.',
    );
  }

  const parts = source.loadParts(want.fma, want.tree);
  if (parts.length === 0) throw new Error(`${want.fma} (${actual}) has no element mesh in the archive`);

  // One grid per part, so the interior test is a union of solids.
  const solids = parts.map((p) => ({ ...bounds(p.V), grid: buildGrid(p.V, p.F) }));
  const lo = [0, 1, 2].map((a) => Math.min(...solids.map((s) => s.lo[a])));
  const hi = [0, 1, 2].map((a) => Math.max(...solids.map((s) => s.hi[a])));

  // Sample on a grid whose phase is fixed to the template origin rather than
  // to this structure's own bounding box, so two adjacent structures sample the
  // same lattice and their coverings abut instead of interleaving.
  //
  // The step halves until the structure is actually resolved. A fixed step
  // measures the big organs and silently misses the thin ones: at 8 mm the
  // spinal cord — a ~10 mm tube — produced zero interior points, which is a
  // statement about the sampling and not about the cord. The step that was
  // finally used is recorded per structure, so nobody has to infer it.
  const stats = { ambiguous: 0 };
  let step = opts.sampleMm;
  let pointsMm = [];
  const sampleFloorMm = 1;
  for (; step >= sampleFloorMm; step /= 2) {
    const first = (a) => Math.ceil(lo[a] / step) * step;
    pointsMm = [];
    for (let z = first(2); z <= hi[2]; z += step) {
      for (let y = first(1); y <= hi[1]; y += step) {
        for (let x = first(0); x <= hi[0]; x += step) {
          const p = [x, y, z];
          if (insideParts(solids, p, stats)) pointsMm.push(p);
        }
      }
    }
    if (pointsMm.length > 0) break;
  }

  // Having SOME interior points is not the same as having resolved the
  // structure. The spinal cord yielded 5 points for a 450 mm tube, because the
  // decimated cord mesh is not closed along most of its length and parity
  // silently reports "outside" there. Five points is not a thin structure, it
  // is a failed measurement that happens to be non-empty — so the samples are
  // required to SPAN the structure before they are believed.
  const span = (pts, a) => {
    let lo2 = Infinity;
    let hi2 = -Infinity;
    for (const p of pts) {
      if (p[a] < lo2) lo2 = p[a];
      if (p[a] > hi2) hi2 = p[a];
    }
    return hi2 - lo2;
  };
  let resolvedSpan = 0;
  if (pointsMm.length > 0) {
    const ratios = [0, 1, 2].map((a) => {
      const extent = hi[a] - lo[a];
      return extent > 2 * step ? span(pointsMm, a) / extent : 1;
    });
    resolvedSpan = Math.min(...ratios);
    if (resolvedSpan < 0.5) pointsMm = [];
  }

  // A structure the interior test cannot resolve at 1 mm is either not closed
  // or not a solid, and both happen in a decimated mesh set. It is NOT dropped
  // and NOT silently accepted: the covering falls back to the surface and says
  // so, because for a structure thinner than a cell the surface covering and
  // the solid one are the same set anyway, and for anything else the flag is
  // the warning a reader needs.
  let coverage = 'solid';
  if (pointsMm.length === 0) {
    coverage = 'surface';
    step = NaN;
    for (const p of parts) {
      for (let i = 0; i < p.V.length; i += 3) pointsMm.push([p.V[i], p.V[i + 1], p.V[i + 2]]);
    }
    if (pointsMm.length === 0) {
      throw new Error(`${want.fma} (${actual}) has neither interior samples nor vertices`);
    }
  }

  // Encode every interior point, then normalise.
  //
  // A CLAMPED POINT IS NOT A CELL OF THIS STRUCTURE. `encodeBody` flags a point
  // it had to clamp — past an end of the vertebral column, or outside the
  // modelled skin — and returns the nearest address instead. Keeping those
  // would be actively wrong, not merely imprecise: the brain lies almost
  // entirely above `C01`, so every one of its points clamps onto the top
  // level and a covering built from them would claim the brain IS the first
  // cervical level. So clamped points are dropped from the covering and
  // counted, and `inFrameFraction` publishes how much of the structure the
  // `BD` frame actually reaches.
  const cells = [];
  let clamped = 0;
  const notes = new Set();
  for (const p of pointsMm) {
    const { address, flags } = encodeBody(template, p, opts.digits);
    for (const n of flags.notes ?? []) notes.add(n);
    if (flags.clamped) { clamped += 1; continue; }
    cells.push(address);
  }
  const inFrameFraction = (pointsMm.length - clamped) / pointsMm.length;
  if (cells.length === 0) {
    throw new Error(
      `${want.fma} (${actual}) has no sample inside the BD frame: all ${pointsMm.length} clamped `
      + `(${[...notes].join('; ')}). This structure is not addressable in BD and must not be listed `
      + 'as though it were — remove it from NAMED_STRUCTURES or address it in another frame.',
    );
  }
  const c = covering(cells);

  const xrefs = uberon.get(want.fma) ?? [];
  structures.push({
    id: want.fma,
    name: actual,
    source: 'FMA',
    ...(want.level ? { bdLevel: want.level } : {}),
    tree: want.tree,
    elementMeshes: parts.length,
    uberon: xrefs.map((x) => x.id),
    ...(xrefs.length ? { uberonNames: xrefs.map((x) => x.name) } : {}),
  });
  coverings.push({
    id: want.fma,
    coverage,
    ...(clamped > 0 ? { inFrameFraction: Math.round(inFrameFraction * 1e4) / 1e4 } : {}),
    cells: [...c.cells],
  });
  report.push({
    id: want.fma,
    name: actual,
    parts: parts.length,
    coverage,
    sampleMm: Number.isFinite(step) ? step : null,
    samples: pointsMm.length,
    cells: c.cells.length,
    clampedPoints: clamped,
    inFrameFraction: Math.round(inFrameFraction * 1e4) / 1e4,
    partlyOutsideFrame: clamped > 0,
    ambiguousTests: stats.ambiguous,
    uberon: xrefs.length,
    notes: [...notes],
  });
}

/**
 * The index version.
 *
 * Built from the things that, if they changed, would change a name: the source
 * release, the ontology release, and the structure set itself. The trailing
 * hash covers the structure ids and terms, so adding a structure or correcting
 * a term produces a different version without anyone having to remember to
 * bump it. The template id is NOT in here — a different body template moves the
 * coverings, not the names, and `coverings.json` carries it separately.
 */
const nameFingerprint = createHash('sha256')
  .update(structures.map((s) => `${s.id}\t${s.name}\t${s.uberon.join(',')}`).join('\n'))
  .digest('hex')
  .slice(0, 12);
const version = opts.version
  ?? `bp3d-${SOURCE.release}+uberon-${uberonProvenance?.dataVersion ?? 'none'}+${nameFingerprint}`;

const names = {
  $comment: [
    'The naming layer. Generated by tools/build-name-index.mjs; do not hand-edit.',
    'Load with buildNameIndex({ version, structures }) after joining coverings.json by id.',
    '`version` is stamped into every resolve() result: a name is only true relative',
    'to an index, and an address outlives any index.',
  ],
  version,
  frame: 'BD',
  structureCount: structures.length,
  provenance: {
    generator: 'tools/build-name-index.mjs',
    fma: {
      note:
        'Structure ids are FMA concept ids as carried by the BodyParts3D release. Terms are the '
        + "release's own English labels, and the build fails if one has changed.",
      source: SOURCE,
    },
    uberon: uberonProvenance,
    nameFingerprint,
  },
  structures,
};

const coveringsFile = {
  $comment: [
    'Prefix sets per structure, so name resolution is a range scan rather than a scan.',
    'Generated by tools/build-name-index.mjs; do not hand-edit.',
    'Cells are canonical, pairwise disjoint and maximally rolled up - the invariants',
    'covering() establishes and query.ts depends on. Join to names.json by `id`.',
  ],
  indexVersion: version,
  frame: 'BD',
  template: template.id,
  digits: opts.digits,
  sampleMm: opts.sampleMm,
  provenance: {
    generator: 'tools/build-name-index.mjs',
    interiorTest:
      'ray parity per element mesh, OR-ed across the parts of a concept (insideParts); '
      + 'solid, not a surface shell',
    totals: {
      structures: coverings.length,
      cells: coverings.reduce((n, c) => n + c.cells.length, 0),
      samples: report.reduce((n, r) => n + r.samples, 0),
      surfaceOnlyStructures: report.filter((r) => r.coverage === 'surface').map((r) => r.id),
      clampedPoints: report.reduce((n, r) => n + r.clampedPoints, 0),
      partlyOutsideFrame: report.filter((r) => r.clampedPoints > 0).map((r) => r.id),
      ambiguousInteriorTests: report.reduce((n, r) => n + r.ambiguousTests, 0),
    },
    perStructure: report,
  },
  coverings,
};

const namesPath = join(opts.outDir, 'names.json');
const coveringsPath = join(opts.outDir, 'coverings.json');
writeFileSync(namesPath, `${JSON.stringify(names, null, 1)}\n`);
writeFileSync(coveringsPath, `${JSON.stringify(coveringsFile, null, 1)}\n`);

const totals = coveringsFile.provenance.totals;
console.log([
  `index version ${version}`,
  `  ${structures.length} structures, ${totals.cells} cells at ${opts.digits} digit(s),`
    + ` ${totals.samples.toLocaleString('en-GB')} samples`,
  `  sample step ${[...new Set(report.map((r) => r.sampleMm))].filter(Number.isFinite).sort((a, b) => b - a).join(', ')} mm`
    + (totals.surfaceOnlyStructures.length
      ? `; SURFACE-ONLY coverage for ${totals.surfaceOnlyStructures.join(', ')}`
      : '; every structure resolved as a solid'),
  `  ${structures.filter((s) => s.uberon.length > 0).length} structures carry an UBERON cross-reference`,
  `  clamped points ${totals.clampedPoints}, ambiguous interior tests ${totals.ambiguousInteriorTests}`,
  `  wrote ${rel(namesPath)} and ${rel(coveringsPath)}`,
].join('\n'));
for (const r of report.filter((x) => x.clampedPoints > 0).sort((a, b) => a.inFrameFraction - b.inFrameFraction)) {
  console.log(
    `  ${r.id} ${r.name}: ${(r.inFrameFraction * 100).toFixed(1)}% in frame`
    + ` (${r.clampedPoints}/${r.samples} dropped) - ${r.notes.join('; ')}`,
  );
}
