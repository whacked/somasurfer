/**
 * The BodyParts3D / Anatomography source adapter.
 *
 * Everything this pipeline knows about the upstream distribution lives here:
 * where the bytes come from, how a concept id becomes a mesh file, and what
 * the coordinate axes mean. The rest of the pipeline is geometry.
 *
 * SOURCE. Database Center for Life Science (DBCLS), BodyParts3D 4.0,
 * 99%-polygon-reduced OBJ set, IS-A tree, from the NBDC/DBCLS LSDB Archive:
 *
 *   https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html
 *   https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_BP3D_4.0_obj_99.zip
 *   https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_element_parts.txt
 *   https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_parts_list_e.txt
 *   https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_inclusion_relation_list.txt
 *
 * LICENCE. See docs/asset-licensing.md. The short version, because it decides
 * what this file may do: the OBJ payloads carry a CC-BY-SA 2.1 Japan notice in
 * their own header comments, the archive's web licence page now states CC-BY
 * 4.0, and the pipeline holds the share-alike reading. Nothing here is a code
 * dependency on an asset licence — tools/ is CI and authoring tooling, is not
 * published, and is not linked into any code package. CI enforces that
 * boundary for the packages themselves in tools/check-licence-separation.mjs.
 *
 * COORDINATES. Measured, not assumed, and the measurement is in the audit
 * report. BodyParts3D 4.0 is in millimetres, and its axes are DICOM-like LPS:
 *
 *   +x  the subject's LEFT     (spleen centroid x = +86.2, appendix x = -53.7)
 *   +y  POSTERIOR              (the vertebral column sits at y ~ -25..-70,
 *                               with the skin reaching y = -247 anteriorly
 *                               and y = +45 posteriorly: most of the trunk is
 *                               in front of the spine, which is the anatomy)
 *   +z  SUPERIOR               (skin spans z = -78 to 1641, a standing figure)
 *
 * `packages/alc` templates are in LAS — `+x` left, `+y` ANTERIOR, `+z`
 * superior — because `spineGeometry()` derives the azimuth frame as
 * `left = cross(axial, anterior)` and that only points at the subject's left
 * in a left-handed chart. So the adapter negates y and nothing else.
 *
 * Negating one axis is a change of chart, not a mirroring of the subject:
 * `+x` still means left, `+y` still means anterior, `+z` still means superior.
 * `assertLaterality()` re-derives this from the mesh set on every run so a
 * silent upstream axis change cannot ship a left-right flipped atlas.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openZip, parseObj } from './mesh.mjs';

export const SOURCE = Object.freeze({
  dataset: 'BodyParts3D/Anatomography',
  release: '4.0',
  variant: 'isa_BP3D_4.0_obj_99 (IS-A tree, 99% polygon reduction)',
  holder: 'The Database Center for Life Science (DBCLS)',
  archive: 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html',
  files: Object.freeze({
    meshes: 'isa_BP3D_4.0_obj_99.zip',
    elementParts: 'isa_element_parts.txt',
    partsList: 'isa_parts_list_e.txt',
    inclusion: 'isa_inclusion_relation_list.txt',
    partofElementParts: 'partof_element_parts.txt',
    partofPartsList: 'partof_parts_list_e.txt',
    partofInclusion: 'partof_inclusion_relation_list.txt',
  }),
  /**
   * Attribution string required by the licence, verbatim from the archive's
   * licence page and from the OBJ header comments. Shipped with the assets.
   */
  attribution:
    'BodyParts3D, (c) The Database Center for Life Science '
    + 'licensed under CC Attribution-Share Alike 2.1 Japan',
});

/**
 * The ALC-1 `BD` level set, mapped to FMA concept ids present in the mesh set.
 *
 * `C01` and `C02` are the atlas and the axis: FMA names them for what they are
 * rather than by ordinal, so a search for "first cervical vertebra" finds
 * nothing and a pipeline that trusted the ordinal naming would silently ship a
 * 22-level column. There is exactly one sacral level, `S01`, the whole fused
 * sacrum — docs/alc-1-admissibility.md §5 requirement 1, and the reason is
 * measured in §2 of that document.
 */
export const BD_LEVELS = Object.freeze([
  ['C01', 'FMA12519', 'atlas'],
  ['C02', 'FMA12520', 'axis'],
  ['C03', 'FMA12521', 'third cervical vertebra'],
  ['C04', 'FMA12522', 'fourth cervical vertebra'],
  ['C05', 'FMA12523', 'fifth cervical vertebra'],
  ['C06', 'FMA12524', 'sixth cervical vertebra'],
  ['C07', 'FMA12525', 'seventh cervical vertebra'],
  ['T01', 'FMA9165', 'first thoracic vertebra'],
  ['T02', 'FMA9187', 'second thoracic vertebra'],
  ['T03', 'FMA9209', 'third thoracic vertebra'],
  ['T04', 'FMA9248', 'fourth thoracic vertebra'],
  ['T05', 'FMA9922', 'fifth thoracic vertebra'],
  ['T06', 'FMA9945', 'sixth thoracic vertebra'],
  ['T07', 'FMA9968', 'seventh thoracic vertebra'],
  ['T08', 'FMA9991', 'eighth thoracic vertebra'],
  ['T09', 'FMA10014', 'ninth thoracic vertebra'],
  ['T10', 'FMA10037', 'tenth thoracic vertebra'],
  ['T11', 'FMA10059', 'eleventh thoracic vertebra'],
  ['T12', 'FMA10081', 'twelfth thoracic vertebra'],
  ['L01', 'FMA13072', 'first lumbar vertebra'],
  ['L02', 'FMA13073', 'second lumbar vertebra'],
  ['L03', 'FMA13074', 'third lumbar vertebra'],
  ['L04', 'FMA13075', 'fourth lumbar vertebra'],
  ['L05', 'FMA13076', 'fifth lumbar vertebra'],
  ['S01', 'FMA16202', 'sacrum'],
]);

export const SKIN_FMA = 'FMA7163';

/**
 * The structures `names.json` and `coverings.json` are built from.
 *
 * Each row is `[fma, expectedTerm, tree]`, and `expectedTerm` is checked
 * against the source's own table on every build. It is not decoration: an FMA
 * id whose term has changed upstream is a different concept, and a naming layer
 * that shipped `FMA7088` still labelled "heart" after it stopped meaning the
 * heart would be wrong in the one way a naming layer must never be. The build
 * fails rather than warns.
 *
 * WHY TWO TREES. BodyParts3D publishes an IS-A tree and a PART-OF tree. The
 * whole-organ concepts a reader wants — heart, liver, the lungs, the brain —
 * exist only in the PART-OF tree, which is the aggregative one: `FMA7088` is
 * 83 element meshes there and absent from the IS-A tables entirely. The two
 * trees share their element mesh files, and every PART-OF element id used here
 * was checked to be present in the IS-A archive, so one 136 MB download serves
 * both and `loadMesh` takes the tree as an argument.
 *
 * This is a curated set, not everything with a mesh. 2 234 element files and
 * ~2 900 IS-A concepts include things like "sphenoid part of right middle
 * cerebral artery", which is a real concept and not a useful answer to "what is
 * at this address". The 25 vertebral levels are added by the builder from
 * BD_LEVELS, so a `BD-T07` prefix resolves to its own vertebra as well as to
 * whatever soft tissue surrounds it.
 */
export const NAMED_STRUCTURES = Object.freeze([
  // Thoracic and abdominal viscera.
  ['FMA7088', 'heart', 'partof'],
  ['FMA7309', 'right lung', 'partof'],
  ['FMA7310', 'left lung', 'partof'],
  ['FMA7197', 'liver', 'partof'],
  ['FMA7202', 'gallbladder', 'partof'],
  ['FMA7148', 'stomach', 'partof'],
  ['FMA7196', 'spleen', 'isa'],
  ['FMA7198', 'pancreas', 'partof'],
  ['FMA7206', 'duodenum', 'partof'],
  ['FMA14545', 'ascending colon', 'partof'],
  ['FMA14546', 'transverse colon', 'partof'],
  ['FMA14547', 'descending colon', 'partof'],
  ['FMA14544', 'rectum', 'partof'],
  ['FMA14542', 'appendix', 'partof'],
  ['FMA7204', 'right kidney', 'partof'],
  ['FMA7205', 'left kidney', 'partof'],
  ['FMA15900', 'urinary bladder', 'partof'],
  ['FMA9600', 'prostate', 'partof'],
  ['FMA7131', 'esophagus', 'partof'],
  ['FMA7394', 'trachea', 'partof'],
  ['FMA3734', 'aorta', 'partof'],
  ['FMA13295', 'diaphragm', 'partof'],
  // Nervous system.
  //
  // The BRAIN IS DELIBERATELY ABSENT. It was listed here, and the measurement
  // removed it: 0.2% of its interior samples fall inside the `BD` frame,
  // because the brain sits almost entirely above `C01` and `encodeBody` clamps
  // every such point onto the top cervical level. A covering built from those
  // would assert that the brain IS the first cervical vertebra. The brain is a
  // `BV` structure, and `BV` has no name index at all — clearing a brain
  // parcellation licence is the open question in docs/asset-licensing.md, and
  // until it is cleared `BV` ships coordinates without names. Leaving the
  // brain out of `BD` is what "without names" has to look like in the data.
  ['FMA7647', 'spinal cord', 'partof'],
  // Skeleton, beyond the vertebral column the BD levels already name.
  ['FMA7574', 'rib', 'isa'],
  ['FMA7485', 'sternum', 'partof'],
  ['FMA16585', 'hip bone', 'isa'],
  ['FMA13394', 'scapula', 'isa'],
  ['FMA13321', 'clavicle', 'isa'],
  ['FMA13303', 'humerus', 'isa'],
  ['FMA9611', 'femur', 'isa'],
  ['FMA52748', 'mandible', 'partof'],
  // The surface itself, so `r = 1` has a name.
  ['FMA7163', 'skin', 'partof'],
]);

/** Asymmetric viscera, used to re-derive the laterality of `+x` on every run. */
const LATERALITY_WITNESSES = Object.freeze([
  { fma: 'FMA7196', name: 'spleen', side: 'left' },
  { fma: 'FMA14542', name: 'appendix', side: 'right' },
]);

const ENTRY_PREFIX = 'isa_BP3D_4.0_obj_99/';

/** Open a source directory: the mesh archive plus the three tables we read. */
export function openSource(dir) {
  const path = (name) => join(dir, name);
  for (const f of Object.values(SOURCE.files)) {
    if (!existsSync(path(f))) {
      throw new Error(
        `${path(f)} is missing. Fetch the BodyParts3D source set first:\n`
        + `  B=https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST\n`
        + Object.values(SOURCE.files).map((n) => `  curl -o ${n} $B/${n}`).join('\n'),
      );
    }
  }
  const zip = openZip(path(SOURCE.files.meshes));
  const read = (key) => readFileSync(path(SOURCE.files[key]), 'utf8');
  return buildSource({
    zip,
    dir,
    tables: {
      isa: { elementParts: read('elementParts'), partsList: read('partsList'), inclusion: read('inclusion') },
      partof: {
        elementParts: read('partofElementParts'),
        partsList: read('partofPartsList'),
        inclusion: read('partofInclusion'),
      },
    },
  });
}

/** `concept id -> element mesh file ids`. A compound concept is several files. */
function readElements(text) {
  const elements = new Map();
  for (const line of text.split('\n').slice(1)) {
    if (!line) continue;
    const [concept, , file] = line.split('\t');
    if (!concept || !file) continue;
    if (!elements.has(concept)) elements.set(concept, []);
    elements.get(concept).push(file.trim());
  }
  return elements;
}

/** `concept id -> English term`. */
function readNames(text) {
  const names = new Map();
  for (const line of text.split('\n').slice(1)) {
    if (!line) continue;
    const [concept, , en] = line.split('\t');
    if (concept && en) names.set(concept, en.trim());
  }
  return names;
}

/** Testable core: everything already read into memory. */
export function buildSource({ zip, tables, dir }) {
  const trees = {};
  for (const [name, t] of Object.entries(tables)) {
    trees[name] = { elements: readElements(t.elementParts), names: readNames(t.partsList), inclusion: t.inclusion };
  }

  const tree = (which) => {
    const t = trees[which];
    if (!t) throw new Error(`no ${which} tree loaded; expected one of ${Object.keys(trees).join(', ')}`);
    return t;
  };

  /** Element mesh files for a concept, as separate closed parts. */
  const loadParts = (fma, which = 'isa') => {
    const t = tree(which);
    const files = (t.elements.get(fma) ?? []).filter((f) => zip.has(`${ENTRY_PREFIX}${f}.obj`));
    return files.map((f) => {
      const part = parseObj(zip.read(`${ENTRY_PREFIX}${f}.obj`).toString('utf8'));
      const V = new Float64Array(part.V.length);
      for (let i = 0; i < part.V.length; i += 3) {
        // LPS -> LAS: negate y so `+y` is anterior. See the header.
        V[i] = part.V[i];
        V[i + 1] = -part.V[i + 1];
        V[i + 2] = part.V[i + 2];
      }
      return { file: f, V, F: part.F };
    });
  };

  /** The same meshes merged into one triangle soup, for whole-shape measures. */
  const loadMesh = (fma, which = 'isa') => {
    const parts = loadParts(fma, which);
    if (parts.length === 0) return null;
    const V = [];
    const F = [];
    for (const part of parts) {
      const base = V.length / 3;
      for (let i = 0; i < part.V.length; i += 1) V.push(part.V[i]);
      for (let i = 0; i < part.F.length; i += 1) F.push(part.F[i] + base);
    }
    return {
      fma,
      files: parts.map((p) => p.file),
      V: Float64Array.from(V),
      F: Int32Array.from(F),
    };
  };

  return {
    dir,
    trees,
    loadMesh,
    loadParts,
    nameOf: (fma, which = 'isa') => tree(which).names.get(fma) ?? null,
    inclusionOf: (which = 'isa') => tree(which).inclusion,
  };
}

/**
 * Re-derive which side `+x` is, from the mesh set itself.
 *
 * This exists because getting it wrong is both easy and invisible: a
 * left-right flipped atlas passes every fold gate, every round trip and every
 * conformance test, and is only wrong about the patient. So the sign is
 * measured against viscera whose side is not in question, on every build, and
 * the build fails rather than warns.
 *
 * Returns the witnesses' measured centroids so the audit report can publish
 * them instead of asserting the convention.
 */
export function assertLaterality(source) {
  const witnesses = [];
  for (const w of LATERALITY_WITNESSES) {
    const mesh = source.loadMesh(w.fma);
    if (!mesh) throw new Error(`laterality witness ${w.name} (${w.fma}) is absent from the mesh set`);
    let sum = 0;
    const n = mesh.V.length / 3;
    for (let i = 0; i < mesh.V.length; i += 3) sum += mesh.V[i];
    const meanX = sum / n;
    const observed = meanX > 0 ? 'left' : 'right';
    witnesses.push({ ...w, meanXMm: meanX, observed, vertices: n });
    if (observed !== w.side) {
      throw new Error(
        `laterality check failed: ${w.name} centroid x = ${meanX.toFixed(1)} mm reads as the subject's `
        + `${observed}, but it is on the ${w.side}. The source's axis convention changed; fix `
        + 'tools/lib/bp3d.mjs rather than shipping a left-right flipped atlas.',
      );
    }
  }
  return witnesses;
}
