/**
 * Generates the first-party placeholder assets in packages/atlas-assets.
 *
 * These are a fixture, not a product. Their job is to give the build, the
 * performance budget and the licence separation check something real to
 * operate on while the mesh source decision (DOG-2 D1) is open — and to be
 * obviously first-party, so no third-party obligation can be hiding in the
 * repository before that decision lands.
 *
 * The shell is a tube of revolution around the ALC-1 reference spine curve, at
 * roughly the resolution we expect a low-detail body mesh to ship at. It is
 * built from the same anatomical template the conformance suite uses, so the
 * fixture's size and shape are not arbitrary numbers.
 *
 *   node tools/make-placeholder-geometry.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, rel } from './lib/repo.mjs';
import { VERTEBRAL_LEVELS, spineGeometry } from '../packages/alc/src/index.ts';
import { ADULT_P50, buildAnatomicalBodyTemplate } from '../packages/alc/src/testing/anatomicalTemplates.ts';

const ASSETS = join(REPO_ROOT, 'packages', 'atlas-assets');

/** Rings per vertebral level and azimuth samples per ring. Low-detail tier. */
const RINGS_PER_LEVEL = 6;
const AZIMUTHS = 64;
/** Coordinates are quantised to 0.1 mm: finer than the mesh, far smaller on the wire. */
const MM = 1;

const template = buildAnatomicalBodyTemplate({ ...ADULT_P50, id: 'placeholder-body-shell' });
const geo = spineGeometry(template);

const q = (v) => Math.round(v * 10 ** MM) / 10 ** MM;

function radiusAt(slab, turns) {
  const n = slab.surfaceRadiiMm.length;
  let x = (turns % 1) * n;
  if (x < 0) x += n;
  const i = Math.floor(x);
  const f = x - i;
  return slab.surfaceRadiiMm[i % n] + (slab.surfaceRadiiMm[(i + 1) % n] - slab.surfaceRadiiMm[i % n]) * f;
}

const positions = [];
const levelOfRing = [];

template.slabs.forEach((slab, i) => {
  for (let k = 0; k < RINGS_PER_LEVEL; k += 1) {
    const u = (k + 0.5) / RINGS_PER_LEVEL;
    // Nodes, directions and the azimuth frame all come from spineGeometry, not
    // from the raw slab fields: that is the frame the addresses are defined in,
    // and its basis is re-orthogonalised against each segment's direction.
    const centre = [0, 1, 2].map((c) => geo.nodes[i][c] + geo.dirs[i][c] * u * geo.lens[i]);
    levelOfRing.push(slab.label);
    for (let a = 0; a < AZIMUTHS; a += 1) {
      const turns = a / AZIMUTHS;
      const angle = turns * 2 * Math.PI;
      const rho = radiusAt(slab, turns);
      // t = 0 is the anterior midline, increasing toward the subject's left.
      for (let c = 0; c < 3; c += 1) {
        positions.push(
          q(centre[c] + (geo.anterior[i][c] * Math.cos(angle) + geo.left[i][c] * Math.sin(angle)) * rho),
        );
      }
    }
  }
});

const rings = levelOfRing.length;
const indices = [];
for (let r = 0; r + 1 < rings; r += 1) {
  for (let a = 0; a < AZIMUTHS; a += 1) {
    const a2 = (a + 1) % AZIMUTHS;
    const v00 = r * AZIMUTHS + a;
    const v01 = r * AZIMUTHS + a2;
    const v10 = (r + 1) * AZIMUTHS + a;
    const v11 = (r + 1) * AZIMUTHS + a2;
    indices.push(v00, v10, v11, v00, v11, v01);
  }
}

mkdirSync(join(ASSETS, 'geometry'), { recursive: true });
mkdirSync(join(ASSETS, 'labels'), { recursive: true });

const shell = {
  id: 'placeholder-body-shell',
  detail: 'lowres',
  generatedBy: 'tools/make-placeholder-geometry.mjs',
  attribution: 'placeholder-body-shell',
  units: 'mm',
  quantisationMm: 10 ** -MM,
  templateId: template.id,
  frame: 'BD',
  rings,
  azimuths: AZIMUTHS,
  ringLevels: levelOfRing,
  vertexCount: positions.length / 3,
  triangleCount: indices.length / 3,
  positions,
  indices,
};

const labels = {
  id: 'alc-1-levels',
  attribution: 'alc-1-level-index',
  frame: 'BD',
  comment: 'Addressable vertebral levels. S02-S05 are reserved in the grammar and absent from templates.',
  levels: VERTEBRAL_LEVELS.map((label) => ({
    label,
    addressable: template.slabs.some((s) => s.label === label),
    region: { C: 'cervical', T: 'thoracic', L: 'lumbar', S: 'sacral' }[label[0]],
  })),
};

const write = (p, value) => {
  writeFileSync(join(ASSETS, p), JSON.stringify(value) + '\n');
  console.log(`wrote ${rel(join(ASSETS, p))}`);
};

write('geometry/placeholder-body-shell.lowres.json', shell);
write('labels/alc-1-levels.json', labels);
console.log(`${shell.vertexCount} vertices, ${shell.triangleCount} triangles, ${rings} rings`);
