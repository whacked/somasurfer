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
  const elementParts = readFileSync(path(SOURCE.files.elementParts), 'utf8');
  const partsList = readFileSync(path(SOURCE.files.partsList), 'utf8');
  const inclusion = readFileSync(path(SOURCE.files.inclusion), 'utf8');
  return buildSource({ zip, elementParts, partsList, inclusion, dir });
}

/** Testable core: everything already read into memory. */
export function buildSource({ zip, elementParts, partsList, inclusion, dir }) {
  // concept id -> element mesh file ids. A compound concept is several files.
  const elements = new Map();
  for (const line of elementParts.split('\n').slice(1)) {
    if (!line) continue;
    const [concept, , file] = line.split('\t');
    if (!concept || !file) continue;
    if (!elements.has(concept)) elements.set(concept, []);
    elements.get(concept).push(file.trim());
  }

  // concept id -> English term.
  const names = new Map();
  for (const line of partsList.split('\n').slice(1)) {
    if (!line) continue;
    const [concept, , en] = line.split('\t');
    if (concept && en) names.set(concept, en.trim());
  }

  const loadMesh = (fma) => {
    const files = (elements.get(fma) ?? []).filter((f) => zip.has(`${ENTRY_PREFIX}${f}.obj`));
    if (files.length === 0) return null;
    const V = [];
    const F = [];
    for (const f of files) {
      const part = parseObj(zip.read(`${ENTRY_PREFIX}${f}.obj`).toString('utf8'));
      const base = V.length / 3;
      for (let i = 0; i < part.V.length; i += 3) {
        // LPS -> LAS: negate y so `+y` is anterior. See the header.
        V.push(part.V[i], -part.V[i + 1], part.V[i + 2]);
      }
      for (let i = 0; i < part.F.length; i += 1) F.push(part.F[i] + base);
    }
    return { fma, files, V: Float64Array.from(V), F: Int32Array.from(F) };
  };

  return {
    dir,
    elements,
    names,
    inclusion,
    loadMesh,
    nameOf: (fma) => names.get(fma) ?? null,
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
