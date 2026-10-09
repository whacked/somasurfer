/**
 * The curation source for `data/research-seed.json` and `data/names-seed.json`.
 *
 *   node scripts/author-seed.mjs            write both files
 *   node scripts/author-seed.mjs --check    fail if the committed files differ
 *
 * ## Why a generator rather than hand-written JSON
 *
 * The committed JSON is still the artefact every consumer reads; nothing loads
 * this file at runtime. It exists because a `research/1` record is mostly
 * boilerplate — a provenance block and an evidence block per mapping — and
 * writing that out 165 times by hand produces exactly the errors the schema is
 * meant to catch: a `locatorStatus` that disagrees with its `locator`, a
 * `curator-inference` missing its note, a date typo in one record out of a
 * hundred. Here the curator writes the *claim* and the shared parts are
 * constructed, so those fields cannot disagree.
 *
 * It also makes the curation reviewable. The tables below are the whole
 * dataset in the form a reader can argue with: one line per paper, one entry
 * per finding, with the basis and confidence of every mapping visible next to
 * the claim it supports.
 *
 * `--check` is the drift gate, in the manner of `tools/check-audit-drift.mjs`:
 * if the committed JSON stops matching this source, one of them was edited
 * without the other and the build says so rather than shipping whichever won.
 *
 * ## What is and is not verified, stated once
 *
 * Citations are transcribed by the curator, and **every identifier here has
 * been resolved against a named source** — see `data/citation-report.json` and
 * `tools/verify-research-citations.mjs` (DOG-50). The trust-boundary rule still
 * holds and has not moved: *this package* never resolves a URL, and the viewer
 * renders links without fetching them. The verification happens in a tool, out
 * of band, and commits its findings as data that the gate then checks offline.
 *
 * A DOI appears here only when Crossref or PubMed returned it AND the returned
 * title, first author and year matched this record. Where no source returned a
 * match, `identifier.kind` stays `none` with the full volume and pages in
 * `venue`. Two entries are `none`, and both are monographs (Brodmann 1909,
 * Bogduk 2012) — for a book that is the correct record, not a gap. The
 * asymmetry is still deliberate: a missing DOI costs a reader seconds, while a
 * wrong one points silently at a different paper.
 *
 * What is still NOT checked, by anything: that these papers *claim what this
 * file attributes to them*. Crossref confirms a paper exists. The findings and
 * mappings below assert `basis: "published-text"` with `confidence: "high"`,
 * and only a person reading the sources can confirm that.
 *
 * Region mappings are the curator's reading of what each paper is about, at
 * the granularity its abstract or chapter supports. They are not cell-level
 * claims, and `data/names-seed.json`'s cells are synthetic — see that file.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const DATA = join(PKG, 'data');

const CURATOR = 'Staff Engineer (GStack)';
const CURATED_ON = '2026-10-09';

// ---------------------------------------------------------------------------
// Structures
//
// Cells are allocated by anatomical group: a leading `BV` digit per group,
// members numbered in order within it. Grouping matters — a random allocation
// would put unrelated structures next to each other and make every overlap
// result meaningless, which would be worse than useless for QA.
//
// Body structures carry hand-assigned `BD` anchors, because a vertebral level
// and a clock sector mean something and no allocator should be guessing them.
// ---------------------------------------------------------------------------

const GROUPS = {
  frontal: '0',
  subcortical: '1',
  insula: '2',
  temporal: '3',
  cingulate: '4',
  parietal: '5',
  occipital: '6',
  hindbrain: '7',
};

/** [id, name, group, laterality] — laterality `L`, `R`, or `B` for bilateral. */
const BRAIN = [
  ['HCP-MMP1:44', 'Area 44 (pars opercularis)', 'frontal', 'L'],
  ['HCP-MMP1:45', 'Area 45 (pars triangularis)', 'frontal', 'L'],
  ['HCP-MMP1:47l', 'Area 47l (lateral orbitofrontal)', 'frontal', 'B'],
  ['HCP-MMP1:55b', 'Area 55b', 'frontal', 'L'],
  ['HCP-MMP1:4', 'Primary motor cortex (area 4)', 'frontal', 'B'],
  ['HCP-MMP1:6a', 'Area 6a (premotor)', 'frontal', 'B'],
  ['HCP-MMP1:FEF', 'Frontal eye field', 'frontal', 'B'],
  ['HCP-MMP1:8Av', 'Area 8Av', 'frontal', 'B'],
  ['HCP-MMP1:9-46d', 'Area 9-46d (dorsolateral prefrontal)', 'frontal', 'B'],
  ['HCP-MMP1:10d', 'Area 10d (frontopolar)', 'frontal', 'B'],
  ['HCP-MMP1:13l', 'Area 13l (orbitofrontal)', 'frontal', 'B'],
  ['HCP-MMP1:SFL', 'Superior frontal language area', 'frontal', 'B'],
  ['ATLAS-LABEL:inferior-frontal-gyrus', 'inferior frontal gyrus', 'frontal', 'B'],
  ['ATLAS-LABEL:middle-frontal-gyrus', 'middle frontal gyrus', 'frontal', 'B'],
  ['ATLAS-LABEL:precentral-gyrus', 'precentral gyrus', 'frontal', 'B'],
  ['ATLAS-LABEL:superior-frontal-gyrus', 'superior frontal gyrus', 'frontal', 'B'],
  ['HCP-MMP1:3b', 'Primary somatosensory cortex (area 3b)', 'parietal', 'B'],
  ['HCP-MMP1:1', 'Area 1 (somatosensory)', 'parietal', 'B'],
  ['HCP-MMP1:7Pm', 'Area 7Pm (medial parietal)', 'parietal', 'B'],
  ['HCP-MMP1:PGs', 'Area PGs (angular gyrus)', 'parietal', 'B'],
  ['HCP-MMP1:PFm', 'Area PFm (supramarginal)', 'parietal', 'B'],
  ['HCP-MMP1:IPS1', 'Intraparietal sulcus area 1', 'parietal', 'B'],
  ['ATLAS-LABEL:postcentral-gyrus', 'postcentral gyrus', 'parietal', 'B'],
  ['ATLAS-LABEL:angular-gyrus', 'angular gyrus', 'parietal', 'B'],
  ['ATLAS-LABEL:supramarginal-gyrus', 'supramarginal gyrus', 'parietal', 'B'],
  ['ATLAS-LABEL:precuneus', 'precuneus', 'parietal', 'B'],
  ['HCP-MMP1:A1', 'Primary auditory cortex (A1)', 'temporal', 'B'],
  ['HCP-MMP1:A4', 'Auditory area 4', 'temporal', 'B'],
  ['HCP-MMP1:STSdp', 'Superior temporal sulcus, dorsal posterior', 'temporal', 'B'],
  ['HCP-MMP1:STSvp', 'Superior temporal sulcus, ventral posterior', 'temporal', 'B'],
  ['HCP-MMP1:TE1a', 'Area TE1a (anterior temporal)', 'temporal', 'B'],
  ['HCP-MMP1:FFC', 'Fusiform face complex', 'temporal', 'B'],
  ['HCP-MMP1:PHA1', 'Parahippocampal area 1', 'temporal', 'B'],
  ['HCP-MMP1:TGd', 'Area TGd (temporal pole, dorsal)', 'temporal', 'B'],
  ['ATLAS-LABEL:superior-temporal-gyrus', 'superior temporal gyrus', 'temporal', 'B'],
  ['ATLAS-LABEL:middle-temporal-gyrus', 'middle temporal gyrus', 'temporal', 'B'],
  ['ATLAS-LABEL:fusiform-gyrus', 'fusiform gyrus', 'temporal', 'B'],
  ['ATLAS-LABEL:parahippocampal-gyrus', 'parahippocampal gyrus', 'temporal', 'B'],
  ['ATLAS-LABEL:hippocampus', 'hippocampus', 'temporal', 'B'],
  ['ATLAS-LABEL:amygdala', 'amygdala', 'subcortical', 'B'],
  ['ATLAS-LABEL:caudate-nucleus', 'caudate nucleus', 'subcortical', 'B'],
  ['ATLAS-LABEL:putamen', 'putamen', 'subcortical', 'B'],
  ['ATLAS-LABEL:globus-pallidus', 'globus pallidus', 'subcortical', 'B'],
  ['ATLAS-LABEL:thalamus', 'thalamus', 'subcortical', 'B'],
  ['ATLAS-LABEL:substantia-nigra', 'substantia nigra', 'subcortical', 'B'],
  ['HCP-MMP1:V1', 'Primary visual cortex (V1)', 'occipital', 'B'],
  ['HCP-MMP1:V2', 'Second visual area (V2)', 'occipital', 'B'],
  ['HCP-MMP1:V4', 'Fourth visual area (V4)', 'occipital', 'B'],
  ['HCP-MMP1:MT', 'Middle temporal visual area (MT)', 'occipital', 'B'],
  ['ATLAS-LABEL:lingual-gyrus', 'lingual gyrus', 'occipital', 'B'],
  ['ATLAS-LABEL:occipital-lobe', 'occipital lobe', 'occipital', 'B'],
  ['HCP-MMP1:p24', 'Area p24 (anterior cingulate)', 'cingulate', 'B'],
  ['HCP-MMP1:RSC', 'Retrosplenial complex', 'cingulate', 'B'],
  ['ATLAS-LABEL:anterior-cingulate-cortex', 'anterior cingulate cortex', 'cingulate', 'B'],
  ['ATLAS-LABEL:posterior-cingulate-cortex', 'posterior cingulate cortex', 'cingulate', 'B'],
  ['HCP-MMP1:FOP4', 'Frontal opercular area 4', 'insula', 'B'],
  ['ATLAS-LABEL:insular-cortex', 'insular cortex', 'insula', 'B'],
  ['ATLAS-LABEL:cerebellar-cortex', 'cerebellar cortex', 'hindbrain', 'B'],
  ['ATLAS-LABEL:brainstem', 'brainstem', 'hindbrain', 'B'],
  ['ATLAS-LABEL:pons', 'pons', 'hindbrain', 'B'],
];

/**
 * The crosswalk. Stage B's deliverable, and the only namespace in this dataset
 * that resolves against a published index.
 *
 * `[FMA concept id, the index's own term, the ATLAS-LABEL slug it replaces]`.
 *
 * Read from `packages/atlas-assets/labels/names.json` at
 * `bp3d-4.0+uberon-uberon/releases/2026-10-01/uberon-basic.owl+8772477294da`,
 * which keys 57 gross body structures on **bare FMA concept ids** — `FMA9968`,
 * not `FMA:9968` and not a UBERON accession. UBERON is present in that index
 * only as a cross-reference and is never the identifier.
 *
 * The third column is kept because it is what a reviewer checks: this table,
 * not the 26 numbers scattered through the findings below, is where a wrong
 * accession would be caught by eye. `tools/check-research-dataset.mjs` then
 * checks every one of them against the index itself.
 *
 * **No cells here.** The term and the id are anatomical nomenclature and carry
 * no licence (`docs/asset-licensing.md` §4, and the owner's direction in it:
 * names are usable, parcellations are not). The *cells* are derived from the
 * BodyParts3D meshes under CC-BY-SA, so they stay in the asset package and are
 * joined in at resolution. Copying them into this Apache-2.0 package is
 * exactly the boundary `tools/check-licence-separation.mjs` exists to keep.
 */
const BODY_FMA = [
  ['FMA7088', 'heart', 'heart'],
  ['FMA7310', 'left lung', 'left-lung'],
  ['FMA7309', 'right lung', 'right-lung'],
  ['FMA7197', 'liver', 'liver'],
  ['FMA7148', 'stomach', 'stomach'],
  ['FMA7198', 'pancreas', 'pancreas'],
  ['FMA7204', 'right kidney', 'right-kidney'],
  ['FMA7205', 'left kidney', 'left-kidney'],
  ['FMA15900', 'urinary bladder', 'urinary-bladder'],
  ['FMA7647', 'spinal cord', 'spinal-cord'],
  ['FMA9968', 'seventh thoracic vertebra', 'thoracic-vertebra-7'],
  ['FMA13075', 'fourth lumbar vertebra', 'lumbar-vertebra-4'],
  ['FMA16202', 'sacrum', 'sacrum'],
  ['FMA13295', 'diaphragm', 'diaphragm'],
];

/**
 * Body structures the cleared index cannot name, with synthetic anchors.
 *
 * [id, name, cells]. These are NOT a licence problem and not a brain problem —
 * they are a coverage problem, and a different one in each case:
 *
 *   - `rib-7` — the index carries a generic `rib` (FMA7574) and no individual
 *     rib. Filing a 7th-rib finding under it would paint all twenty-four.
 *   - `coronary-artery`, `quadratus-lumborum` — not among the 57 structures the
 *     release subset carries at all.
 *
 * The others are unreferenced by any finding and exist so the synthetic index
 * has neighbours; they never reach the dataset.
 */
const BODY_PLACEHOLDER = [
  ['ATLAS-LABEL:lower-lobe-of-left-lung', 'lower lobe of left lung', ['BD-T07-03O-4', 'BD-T07-03O-5']],
  ['ATLAS-LABEL:coronary-artery', 'coronary artery', ['BD-T07-01I-2']],
  ['ATLAS-LABEL:aortic-arch', 'aortic arch', ['BD-T04-12I', 'BD-T04-01I']],
  ['ATLAS-LABEL:rib-7', '7th rib', ['BD-T07-03O-52', 'BD-T07-03O-53']],
  ['ATLAS-LABEL:intercostal-muscle', 'intercostal muscle', ['BD-T07-03O-51']],
  ['ATLAS-LABEL:quadratus-lumborum', 'quadratus lumborum', ['BD-L02-03O', 'BD-L02-09O']],
];

/** Which partition a structure belongs to. See `PARTITIONS`. */
const BODY_BD = 'body-bd';
const BRAIN_PARCELLATION = 'brain-parcellation';
const BODY_NOT_IN_INDEX = 'body-not-in-index';

const STRUCTURES = new Map();
{
  const counters = new Map(Object.keys(GROUPS).map((g) => [g, 0]));
  for (const [id, name, group, lat] of BRAIN) {
    const i = counters.get(group);
    counters.set(group, i + 1);
    if (i >= 64) throw new Error(`group ${group} overflowed its 64 cells`);
    const digits = `${GROUPS[group]}${Math.floor(i / 8)}${i % 8}`;
    const hemis = lat === 'B' ? ['L', 'R'] : [lat];
    STRUCTURES.set(id, {
      name,
      cells: hemis.map((h) => `BV-${h}-${digits}`),
      source: id.split(':')[0],
      partition: BRAIN_PARCELLATION,
    });
  }
  for (const [id, name, cells] of BODY_PLACEHOLDER) {
    STRUCTURES.set(id, { name, cells, source: id.split(':')[0], partition: BODY_NOT_IN_INDEX });
  }
  // Cells deliberately empty: the real covering is joined in from the asset
  // package. An id in the index with no cells resolves `empty-covering` — named
  // but not painted — which is the true state of a body structure here and is
  // distinguishable from `unknown-structure`, so a typo in an accession is
  // still caught on a branch where the asset index is absent.
  for (const [id, name] of BODY_FMA) {
    STRUCTURES.set(id, { name, cells: [], source: 'FMA', partition: BODY_BD });
  }
}

const labelOf = (id) => {
  const s = STRUCTURES.get(id);
  if (!s) throw new Error(`unknown structure ${id}`);
  return s.name;
};

// ---------------------------------------------------------------------------
// Papers.  [key, title, authors, year, venue, doi|null]
// ---------------------------------------------------------------------------

const PAPERS = [
  ['brodmann-1909-localisation', 'Vergleichende Lokalisationslehre der Grosshirnrinde',
    ['Brodmann K'], 1909, 'Johann Ambrosius Barth, Leipzig', null],
  ['glasser-2016-mmp1', 'A multi-modal parcellation of human cerebral cortex',
    ['Glasser MF', 'Coalson TS', 'Robinson EC', 'Hacker CD', 'Harwell J', 'Yacoub E'], 2016,
    'Nature 536:171-178', '10.1038/nature18933'],
  ['amunts-1999-broca', "Broca's region revisited: cytoarchitecture and intersubject variability",
    ['Amunts K', 'Schleicher A', 'Buergel U', 'Mohlberg H', 'Uylings HBM', 'Zilles K'], 1999,
    'Journal of Comparative Neurology 412(2):319-341', '10.1002/(sici)1096-9861(19990920)412:2<319::aid-cne10>3.0.co;2-7'],
  ['amunts-2020-julich-brain', "Julich-Brain: a 3D probabilistic atlas of the human brain's cytoarchitecture",
    ['Amunts K', 'Mohlberg H', 'Bludau S', 'Zilles K'], 2020, 'Science 369:988-992',
    '10.1126/science.abb4588'],
  ['zilles-2010-brodmann-centenary', "Centenary of Brodmann's map: conception and fate",
    ['Zilles K', 'Amunts K'], 2010, 'Nature Reviews Neuroscience 11:139-145', '10.1038/nrn2776'],
  ['desikan-2006-gyral-parcellation',
    'An automated labeling system for subdividing the human cerebral cortex on MRI scans into gyral based regions of interest',
    ['Desikan RS', 'Segonne F', 'Fischl B', 'Quinn BT', 'Dickerson BC', 'Blacker D'], 2006,
    'NeuroImage 31(3):968-980', '10.1016/j.neuroimage.2006.01.021'],
  ['tzourio-mazoyer-2002-aal',
    'Automated anatomical labeling of activations in SPM using a macroscopic anatomical parcellation of the MNI MRI single-subject brain',
    ['Tzourio-Mazoyer N', 'Landeau B', 'Papathanassiou D', 'Crivello F', 'Etard O', 'Delcroix N'], 2002,
    'NeuroImage 15(1):273-289', '10.1006/nimg.2001.0978'],
  ['fan-2016-brainnetome', 'The Human Brainnetome Atlas: a new brain atlas based on connectional architecture',
    ['Fan L', 'Li H', 'Zhuo J', 'Zhang Y', 'Wang J', 'Chen L'], 2016,
    'Cerebral Cortex 26(8):3508-3526', '10.1093/cercor/bhw157'],
  ['yeo-2011-intrinsic-networks',
    'The organization of the human cerebral cortex estimated by intrinsic functional connectivity',
    ['Yeo BTT', 'Krienen FM', 'Sepulcre J', 'Sabuncu MR', 'Lashkari D', 'Hollinshead M'], 2011,
    'Journal of Neurophysiology 106(3):1125-1165', '10.1152/jn.00338.2011'],
  ['power-2011-functional-areas', 'Functional network organization of the human brain',
    ['Power JD', 'Cohen AL', 'Nelson SM', 'Wig GS', 'Barnes KA', 'Church JA'], 2011,
    'Neuron 72(4):665-678', '10.1016/j.neuron.2011.09.006'],
  ['hagmann-2008-structural-core', 'Mapping the structural core of human cerebral cortex',
    ['Hagmann P', 'Cammoun L', 'Gigandet X', 'Meuli R', 'Honey CJ', 'Wedeen VJ'], 2008,
    'PLoS Biology 6(7):e159', '10.1371/journal.pbio.0060159'],
  ['van-essen-2013-hcp', 'The WU-Minn Human Connectome Project: an overview',
    ['Van Essen DC', 'Smith SM', 'Barch DM', 'Behrens TEJ', 'Yacoub E', 'Ugurbil K'], 2013,
    'NeuroImage 80:62-79', '10.1016/j.neuroimage.2013.05.041'],
  ['mazziotta-2001-icbm', 'A probabilistic atlas and reference system for the human brain',
    ['Mazziotta J', 'Toga A', 'Evans A', 'Fox P', 'Lancaster J', 'Zilles K'], 2001,
    'Philosophical Transactions of the Royal Society B 356:1293-1322', '10.1098/rstb.2001.0915'],
  ['fonov-2011-unbiased-templates', 'Unbiased average age-appropriate atlases for pediatric studies',
    ['Fonov V', 'Evans AC', 'Botteron K', 'Almli CR', 'McKinstry RC', 'Collins DL'], 2011,
    'NeuroImage 54(1):313-327', '10.1016/j.neuroimage.2010.07.033'],
  ['fischl-2012-freesurfer', 'FreeSurfer', ['Fischl B'], 2012, 'NeuroImage 62(2):774-781', '10.1016/j.neuroimage.2012.01.021'],
  ['eickhoff-2005-anatomy-toolbox',
    'A new SPM toolbox for combining probabilistic cytoarchitectonic maps and functional imaging data',
    ['Eickhoff SB', 'Stephan KE', 'Mohlberg H', 'Grefkes C', 'Fink GR', 'Amunts K'], 2005,
    'NeuroImage 25(4):1325-1335', '10.1016/j.neuroimage.2004.12.034'],
  ['mesulam-1998-sensation-to-cognition', 'From sensation to cognition',
    ['Mesulam MM'], 1998, 'Brain 121(6):1013-1052', '10.1093/brain/121.6.1013'],
  ['raichle-2001-default-mode', 'A default mode of brain function',
    ['Raichle ME', 'MacLeod AM', 'Snyder AZ', 'Powers WJ', 'Gusnard DA', 'Shulman GL'], 2001,
    'Proceedings of the National Academy of Sciences 98(2):676-682', '10.1073/pnas.98.2.676'],
  ['buckner-2008-default-network', "The brain's default network: anatomy, function, and relevance to disease",
    ['Buckner RL', 'Andrews-Hanna JR', 'Schacter DL'], 2008,
    'Annals of the New York Academy of Sciences 1124:1-38', '10.1196/annals.1440.011'],
  ['price-2012-language-review',
    'A review and synthesis of the first 20 years of PET and fMRI studies of heard speech, spoken language and reading',
    ['Price CJ'], 2012, 'NeuroImage 62(2):816-847', '10.1016/j.neuroimage.2012.04.062'],
  ['hickok-2007-dual-stream', 'The cortical organization of speech processing',
    ['Hickok G', 'Poeppel D'], 2007, 'Nature Reviews Neuroscience 8:393-402', '10.1038/nrn2113'],
  ['kanwisher-1997-fusiform-face-area',
    'The fusiform face area: a module in human extrastriate cortex specialized for face perception',
    ['Kanwisher N', 'McDermott J', 'Chun MM'], 1997, 'Journal of Neuroscience 17(11):4302-4311',
    '10.1523/JNEUROSCI.17-11-04302.1997'],
  ['epstein-1998-parahippocampal-place-area', 'A cortical representation of the local visual environment',
    ['Epstein R', 'Kanwisher N'], 1998, 'Nature 392:598-601', '10.1038/33402'],
  ['penfield-1937-somatotopy',
    'Somatic motor and sensory representation in the cerebral cortex of man as studied by electrical stimulation',
    ['Penfield W', 'Boldrey E'], 1937, 'Brain 60(4):389-443', '10.1093/brain/60.4.389'],
  ['catani-2008-virtual-dissection', 'A diffusion tensor imaging tractography atlas for virtual in vivo dissections',
    ['Catani M', 'Thiebaut de Schotten M'], 2008, 'Cortex 44(8):1105-1132', '10.1016/j.cortex.2008.05.004'],
  ['mitsuhashi-2009-bodyparts3d', 'BodyParts3D: 3D structure database for anatomical concepts',
    ['Mitsuhashi N', 'Fujieda K', 'Tamura T', 'Kawamoto S', 'Takagi T', 'Okubo K'], 2009,
    'Nucleic Acids Research 37(Database issue):D782-D785', '10.1093/nar/gkn613'],
  ['rosse-2003-fma', 'A reference ontology for biomedical informatics: the Foundational Model of Anatomy',
    ['Rosse C', 'Mejino JLV'], 2003, 'Journal of Biomedical Informatics 36(6):478-500', '10.1016/j.jbi.2003.11.007'],
  ['mungall-2012-uberon', 'Uberon, an integrative multi-species anatomy ontology',
    ['Mungall CJ', 'Torniai C', 'Gkoutos GV', 'Lewis SE', 'Haendel MA'], 2012,
    'Genome Biology 13:R5', '10.1186/gb-2012-13-1-r5'],
  ['panjabi-1991-thoracic-morphometry', 'Thoracic human vertebrae: quantitative three-dimensional anatomy',
    ['Panjabi MM', 'Takata K', 'Goel V', 'Federico D', 'Oxland T', 'Duranceau J'], 1991,
    'Spine 16(8):888-901', '10.1097/00007632-199108000-00006'],
  ['bogduk-2012-lumbar-anatomy', 'Clinical and Radiological Anatomy of the Lumbar Spine, 5th edition',
    ['Bogduk N'], 2012, 'Churchill Livingstone, Edinburgh', null],
];

// ---------------------------------------------------------------------------
// Findings.  Spatial and mapping constructors, then the table.
// ---------------------------------------------------------------------------

const PARC = 'published-parcellation';
const TEXT = 'published-text';
const COORD = 'published-coordinates';
const INFER = 'curator-inference';

const HISTORIC =
  'a historical cytoarchitectonic field is mapped onto the modern parcel of the same number. They ' +
  'are delineated on different evidence and their borders differ between individuals; this is an ' +
  'identification, not a reading of either source.';
const TRACT =
  'a tract atlas reports white-matter pathways, not cortical regions. The region here is a reported ' +
  'endpoint of the tract, which is the curator’s reading of where it terminates.';
const NEAREST_PARCEL =
  'the source describes a region rather than a parcel; the parcel named here is the curator’s ' +
  'nearest match, and no cleared index can confirm it — see the brain-parcellation partition.';
const SYNTHETIC_SUBREGION =
  'the sub-region is the curator’s placement of a described extent onto a synthetic index, not a ' +
  'published covering. It cannot be re-authored against a real one for v1: the cleared index is BD ' +
  'only and there is no BV name index, so this cell is checkable for shape and for nothing else.';
const REAL_SUBREGION =
  'the sub-region is a cell of the structure’s own covering in the real BD index, refined by one ' +
  'octree digit. The refinement is the curator’s declaration of where in the level the described ' +
  'part sits and not a measurement of it — but it is a sub-region of measured geometry rather than ' +
  'of a synthetic anchor, and the gate fails if it does not lie wholly inside.';

/** No location finer than the region. Resolves to the whole structure, flagged. */
const R = (reason = 'the source names the region and reports no finer location') => ({ k: 'R', reason });
/** A sub-region: the structure's own first cell, refined by `suffix`. */
const C = (suffix, method) => ({ k: 'C', suffix, method });
/**
 * A sub-region named outright, for a structure whose cells this package does
 * not hold — the crosswalked body structures, whose coverings live in the asset
 * package. The cell must be a descendant of the structure's real covering, and
 * `tools/check-research-dataset.mjs` fails if it is not, once that index is
 * present to check against.
 */
const E = (cells, method) => ({ k: 'E', cells, method });
/** Published coordinates in a named space. Unresolvable until a template loads. */
const X = (space, frame, pointsMm, digits, note) => ({ k: 'X', space, frame, pointsMm, digits, note });

const M = (sid, spatial, summary, basis, confidence, note = null, kind = 'abstract', locator = null) => ({
  sid, spatial, summary, basis, confidence, note, kind, locator,
});

/** [paperKey, slug, statement, topics, mappings] */
const FINDINGS = [
  // --- Brodmann 1909 -------------------------------------------------------
  ['brodmann-1909-localisation', 'area-44',
    'Area 44 is defined cytoarchitectonically in the pars opercularis of the inferior frontal gyrus.',
    ['cytoarchitecture', 'language'],
    [M('HCP-MMP1:44', R('a cytoarchitectonic field description, with no coordinates'),
      'Described as a field occupying the opercular part of the inferior frontal gyrus.',
      INFER, 'medium', HISTORIC, 'section')]],
  ['brodmann-1909-localisation', 'area-45',
    'Area 45 is defined cytoarchitectonically in the pars triangularis of the inferior frontal gyrus.',
    ['cytoarchitecture', 'language'],
    [M('HCP-MMP1:45', R('a cytoarchitectonic field description, with no coordinates'),
      'Described as a field occupying the triangular part of the inferior frontal gyrus.',
      INFER, 'medium', HISTORIC, 'section')]],
  ['brodmann-1909-localisation', 'area-17-striate',
    'Area 17 is defined as the striate field of the occipital lobe, identified by the stria of Gennari.',
    ['cytoarchitecture', 'vision'],
    [M('HCP-MMP1:V1', R('a cytoarchitectonic field description'),
      'Identified by the stria of Gennari in layer IV.', INFER, 'high',
      "Brodmann's area 17 is taken as V1. The identification is conventional and well supported, and " +
      'it is still an identification across two delineation methods.', 'section'),
    M('ATLAS-LABEL:occipital-lobe', R('the lobe is the frame of reference the field is described within'),
      'The field is located within the occipital lobe.', TEXT, 'high')]],
  ['brodmann-1909-localisation', 'area-4-giant-pyramidal',
    'Area 4 is defined by its giant pyramidal cells in the precentral region.',
    ['cytoarchitecture', 'motor'],
    [M('HCP-MMP1:4', R('a cytoarchitectonic field description'),
      'Distinguished by giant pyramidal (Betz) cells in layer V.', INFER, 'high', HISTORIC, 'section'),
    M('ATLAS-LABEL:precentral-gyrus', R('the gyrus the field occupies'),
      'Located in the precentral region.', TEXT, 'high')]],

  // --- Glasser 2016 --------------------------------------------------------
  ['glasser-2016-mmp1', 'parcels-per-hemisphere',
    'The cortex is divided into 180 parcels per hemisphere using multi-modal gradients rather than a single measure.',
    ['parcellation'],
    [M('HCP-MMP1:55b', R('the parcel is reported as a whole'),
      'Named among the parcels the multi-modal approach newly distinguishes.', PARC, 'high'),
    M('HCP-MMP1:SFL', R('the parcel is reported as a whole'),
      'Named among the newly distinguished language-related parcels.', PARC, 'medium')]],
  ['glasser-2016-mmp1', 'broca-subdivision',
    "Broca's region is subdivided into areas 44 and 45, with the border placed on multi-modal gradients rather than gross landmarks.",
    ['parcellation', 'language'],
    [M('HCP-MMP1:44', R('the parcel is reported as a whole'),
      'One of the two parcels the region divides into.', PARC, 'high'),
    M('HCP-MMP1:45', R('the parcel is reported as a whole'),
      'The other of the two parcels the region divides into.', PARC, 'high')]],
  ['glasser-2016-mmp1', 'v1-delineation',
    'V1 and V2 are among the most reliably delineated parcels, bounded by myelin content and retinotopy.',
    ['parcellation', 'vision'],
    [M('HCP-MMP1:V1', R('the parcel is reported as a whole'),
      'Delineated by myelin content and retinotopic organisation.', PARC, 'high'),
    M('HCP-MMP1:V2', R('the parcel is reported as a whole'),
      'Delineated by the same gradients as its neighbour.', PARC, 'high')]],
  ['glasser-2016-mmp1', 'frontopolar-parcels',
    'Frontopolar and dorsolateral prefrontal cortex are divided into several parcels that gross anatomy does not separate.',
    ['parcellation'],
    [M('HCP-MMP1:10d', R('the parcel is reported as a whole'),
      'Listed among the frontopolar parcels distinguished.', PARC, 'medium'),
    M('HCP-MMP1:9-46d', R('the parcel is reported as a whole'),
      'Listed among the dorsolateral prefrontal parcels distinguished.', PARC, 'medium')]],

  // --- Amunts 1999 ---------------------------------------------------------
  ['amunts-1999-broca', 'area-44-variability',
    'The cytoarchitectonic borders of areas 44 and 45 vary markedly between individuals, most at the posterior border of area 44.',
    ['cytoarchitecture', 'variability', 'language'],
    [M('HCP-MMP1:44',
      C('1', 'the curator placed the described posterior portion onto a sub-cell of the area; a sub-region claim, not a measurement'),
      'Variability is reported as greatest at the posterior border, so the claim is about part of the area.',
      INFER, 'low', SYNTHETIC_SUBREGION),
    M('HCP-MMP1:45', R('variability is reported for the area as a whole'),
      'Area 45 is the second of the two areas the analysis covers.', TEXT, 'high')]],
  ['amunts-1999-broca', 'gyrus-level',
    'Intersubject variability is also reported for the inferior frontal gyrus as a whole, which the two areas do not tile.',
    ['cytoarchitecture', 'variability'],
    [M('ATLAS-LABEL:inferior-frontal-gyrus', R('a gross anatomical region, reported without finer location'),
      'The gyrus is the frame of reference the areas are described within.', TEXT, 'medium')]],
  ['amunts-1999-broca', 'interhemispheric-asymmetry',
    'Area 44 shows a left-greater-than-right asymmetry in volume, while area 45 does not show the same pattern.',
    ['cytoarchitecture', 'asymmetry', 'language'],
    [M('HCP-MMP1:44', R('the asymmetry is reported for the area as a whole'),
      'Volume asymmetry is reported for area 44 specifically.', TEXT, 'medium')]],
  ['amunts-1999-broca', 'borders-cross-sulci',
    'Cytoarchitectonic borders do not coincide with the sulcal landmarks used to identify the region.',
    ['cytoarchitecture', 'variability'],
    [M('ATLAS-LABEL:precentral-gyrus', R('the adjacent gyrus the posterior border runs against'),
      'The posterior border is reported as not following the precentral sulcus.', TEXT, 'medium')]],

  // --- Amunts 2020 ---------------------------------------------------------
  ['amunts-2020-julich-brain', 'probabilistic-maps',
    'Cytoarchitectonic areas are published as probabilistic maps rather than single boundaries, quantifying intersubject variability.',
    ['cytoarchitecture', 'variability'],
    [M('HCP-MMP1:44', R('a probabilistic map covers the area; no single locus is reported'),
      'Published as a probability map over many post-mortem brains.', INFER, 'medium', HISTORIC),
    M('HCP-MMP1:45', R('a probabilistic map covers the area'),
      'Published as a probability map over many post-mortem brains.', INFER, 'medium', HISTORIC)]],
  ['amunts-2020-julich-brain', 'subcortical-coverage',
    'The atlas covers subcortical structures alongside cortical areas in one reference space.',
    ['cytoarchitecture', 'template'],
    [M('ATLAS-LABEL:hippocampus', R('the structure is covered as a whole'),
      'Named among the structures the atlas maps.', TEXT, 'medium'),
    M('ATLAS-LABEL:amygdala', R('the structure is covered as a whole'),
      'Named among the structures the atlas maps.', TEXT, 'medium')]],
  ['amunts-2020-julich-brain', 'whole-brain-coverage',
    'The maps are assembled into a whole-brain atlas in a common reference space rather than published area by area.',
    ['template'],
    [M('ATLAS-LABEL:inferior-frontal-gyrus', R('the gyrus is covered by several mapped areas'),
      'The atlas is whole-brain in coverage.', TEXT, 'medium')]],
  ['amunts-2020-julich-brain', 'visual-areas',
    'Early visual areas are among those mapped cytoarchitectonically in the atlas.',
    ['cytoarchitecture', 'vision'],
    [M('HCP-MMP1:V1', R('the area is mapped as a whole'),
      'Early visual areas are included in the mapped set.', INFER, 'medium', HISTORIC),
    M('HCP-MMP1:V2', R('the area is mapped as a whole'),
      'Early visual areas are included in the mapped set.', INFER, 'medium', HISTORIC)]],

  // --- Zilles & Amunts 2010 ------------------------------------------------
  ['zilles-2010-brodmann-centenary', 'map-and-its-fate',
    "Brodmann's map is widely used as a labelling scheme despite being based on one hemisphere's cytoarchitecture.",
    ['cytoarchitecture', 'history'],
    [M('HCP-MMP1:44', R('the discussion is about the field as a whole'),
      'Discussed as one of the most cited fields of the original map.', INFER, 'medium', HISTORIC),
    M('HCP-MMP1:45', R('the discussion is about the field as a whole'),
      'Discussed alongside area 44 as a cited field.', INFER, 'medium', HISTORIC)]],
  ['zilles-2010-brodmann-centenary', 'observer-independent-successors',
    'Observer-independent mapping replaces visual border identification, and moves borders relative to the original map.',
    ['cytoarchitecture', 'method'],
    [M('HCP-MMP1:V1', R('the comparison is drawn at area level'),
      'The striate area is the example where original and modern borders agree best.', INFER, 'medium', HISTORIC)]],
  ['zilles-2010-brodmann-centenary', 'borders-invisible-in-mri',
    'Cytoarchitectonic borders are not visible in standard structural MRI, so an MRI-derived label is not a cytoarchitectonic claim.',
    ['cytoarchitecture', 'method'],
    [M('ATLAS-LABEL:precentral-gyrus', R('stated for gross anatomy generally'),
      'Macroscopic landmarks and microstructural borders are reported as distinct.', TEXT, 'high'),
    M('ATLAS-LABEL:postcentral-gyrus', R('stated for gross anatomy generally'),
      'Macroscopic landmarks and microstructural borders are reported as distinct.', TEXT, 'high')]],
  ['zilles-2010-brodmann-centenary', 'numbering-is-not-geometry',
    'Area numbers reflect the order of description, not spatial adjacency, so numeric proximity implies nothing about location.',
    ['cytoarchitecture', 'history'],
    [M('ATLAS-LABEL:occipital-lobe', R('stated about the numbering scheme, not a locus'),
      'The numbering order is reported as historical rather than topographic.', TEXT, 'high')]],

  // --- Desikan 2006 --------------------------------------------------------
  ['desikan-2006-gyral-parcellation', 'gyral-labels',
    'The cortex is divided into gyral regions whose boundaries follow sulcal landmarks.',
    ['parcellation', 'method'],
    [M('ATLAS-LABEL:superior-temporal-gyrus', R('a gyral label, by construction region-level'),
      'One of the gyral regions the labelling system defines.', PARC, 'high'),
    M('ATLAS-LABEL:middle-temporal-gyrus', R('a gyral label, by construction region-level'),
      'One of the gyral regions the labelling system defines.', PARC, 'high')]],
  ['desikan-2006-gyral-parcellation', 'automated-labelling',
    "The labelling is automated from the individual's own surface, so the regions follow that brain's folding.",
    ['parcellation', 'method'],
    [M('ATLAS-LABEL:inferior-frontal-gyrus', R('a gyral label'),
      'Labelled automatically from the reconstructed surface.', PARC, 'high')]],
  ['desikan-2006-gyral-parcellation', 'regions-per-hemisphere',
    'Thirty-four regions per hemisphere are defined, which is coarser than cytoarchitectonic subdivision.',
    ['parcellation'],
    [M('ATLAS-LABEL:precentral-gyrus', R('a gyral label'), 'Among the defined regions.', PARC, 'high'),
    M('ATLAS-LABEL:postcentral-gyrus', R('a gyral label'), 'Among the defined regions.', PARC, 'high')]],
  ['desikan-2006-gyral-parcellation', 'sulcal-boundaries',
    'Region boundaries are placed at sulcal fundi, which makes them reproducible but not functionally defined.',
    ['parcellation', 'method'],
    [M('ATLAS-LABEL:fusiform-gyrus', R('a gyral label'),
      'Bounded by the collateral and occipitotemporal sulci.', PARC, 'medium')]],

  // --- Tzourio-Mazoyer 2002 ------------------------------------------------
  ['tzourio-mazoyer-2002-aal', 'macroscopic-parcellation',
    'A macroscopic anatomical parcellation is defined by manual delineation on a single reference brain.',
    ['parcellation', 'template'],
    [M('ATLAS-LABEL:precentral-gyrus', R('a macroscopic label'),
      'Delineated manually on the reference brain.', PARC, 'high'),
    M('ATLAS-LABEL:postcentral-gyrus', R('a macroscopic label'),
      'Delineated manually on the reference brain.', PARC, 'high')]],
  ['tzourio-mazoyer-2002-aal', 'single-subject-basis',
    "Because the parcellation comes from one brain, applying it to a group inherits that brain's folding.",
    ['parcellation', 'registration'],
    [M('ATLAS-LABEL:insular-cortex', R('a macroscopic label'),
      'Among the delineated regions.', PARC, 'medium')]],
  ['tzourio-mazoyer-2002-aal', 'subcortical-regions',
    'Subcortical grey-matter structures are included alongside cortical regions.',
    ['parcellation'],
    [M('ATLAS-LABEL:caudate-nucleus', R('a macroscopic label'),
      'Among the delineated subcortical structures.', PARC, 'high'),
    M('ATLAS-LABEL:putamen', R('a macroscopic label'),
      'Among the delineated subcortical structures.', PARC, 'high')]],
  ['tzourio-mazoyer-2002-aal', 'labels-for-activations',
    "The parcellation's purpose is to name the anatomical location of a functional activation, not to define a functional area.",
    ['parcellation', 'method'],
    [M('ATLAS-LABEL:angular-gyrus', R('a macroscopic label'),
      'Used to report where an activation falls anatomically.', PARC, 'medium')]],

  // --- Fan 2016 ------------------------------------------------------------
  ['fan-2016-brainnetome', 'connectivity-based-subdivision',
    'Gyral regions are subdivided by their connectivity profiles, producing subregions gross anatomy does not separate.',
    ['parcellation', 'connectivity'],
    [M('ATLAS-LABEL:inferior-frontal-gyrus', R('the subdivision is of the whole gyrus'),
      'Subdivided on the basis of connectivity fingerprints.', PARC, 'high')]],
  ['fan-2016-brainnetome', 'subregions-total',
    'The atlas defines 246 subregions, roughly tripling the resolution of a gyral parcellation.',
    ['parcellation'],
    [M('ATLAS-LABEL:superior-temporal-gyrus', R('the whole gyrus is subdivided'),
      'Among the gyri subdivided into connectivity-defined subregions.', PARC, 'high')]],
  ['fan-2016-brainnetome', 'subcortical-subdivision',
    'Subcortical structures are also subdivided by connectivity rather than treated as single units.',
    ['parcellation', 'connectivity'],
    [M('ATLAS-LABEL:thalamus', R('the whole structure is subdivided'),
      'Subdivided by its cortical connectivity.', PARC, 'medium')]],
  ['fan-2016-brainnetome', 'connectivity-fingerprints',
    'Each subregion carries a connectivity fingerprint, so the parcellation can be related to function without assuming it.',
    ['connectivity', 'method'],
    [M('ATLAS-LABEL:amygdala', R('the whole structure is subdivided'),
      'Reported with a connectivity fingerprint per subregion.', PARC, 'medium')]],

  // --- Yeo 2011 ------------------------------------------------------------
  ['yeo-2011-intrinsic-networks', 'seven-network-solution',
    'Cortex is estimated to organise into seven intrinsic functional networks, which are not contiguous regions.',
    ['networks', 'connectivity'],
    [M('ATLAS-LABEL:posterior-cingulate-cortex', R('a network component, reported at region level'),
      'A core component of the default network in the seven-network solution.', TEXT, 'high'),
    M('ATLAS-LABEL:precuneus', R('a network component, reported at region level'),
      'A core component of the default network in the seven-network solution.', TEXT, 'high')]],
  ['yeo-2011-intrinsic-networks', 'default-network-anterior',
    'The default network includes anterior medial prefrontal cortex as well as posterior midline regions.',
    ['networks'],
    [M('ATLAS-LABEL:anterior-cingulate-cortex', R('a network component'),
      'Included in the default network estimate.', TEXT, 'high')]],
  ['yeo-2011-intrinsic-networks', 'networks-are-not-areas',
    'A network is a set of distributed regions, so a network label is not an areal boundary.',
    ['networks', 'method'],
    [M('HCP-MMP1:PGs', R('a network component, not an areal claim'),
      'Assigned to a network rather than delineated as an area.', INFER, 'medium', NEAREST_PARCEL)]],
  ['yeo-2011-intrinsic-networks', 'confidence-maps',
    'Network assignment confidence varies across cortex and is lowest at network boundaries.',
    ['networks', 'method'],
    [M('HCP-MMP1:IPS1', R('confidence is reported per vertex, summarised here at area level'),
      'Boundary zones between networks carry lower assignment confidence.', INFER, 'low',
      'a per-vertex confidence map summarised onto one parcel by the curator.')]],

  // --- Power 2011 ----------------------------------------------------------
  ['power-2011-functional-areas', 'areal-not-nodal',
    'Graph analyses are sensitive to how nodes are defined, so an anatomically defined node can mix functional areas.',
    ['networks', 'method'],
    [M('HCP-MMP1:PFm', R('reported at area level'),
      'Used in the argument that node definition changes network topology.', INFER, 'medium', NEAREST_PARCEL)]],
  ['power-2011-functional-areas', 'graph-communities',
    'Functional communities recovered from resting connectivity include a default-mode community spanning the posterior midline.',
    ['networks', 'connectivity'],
    [M('ATLAS-LABEL:posterior-cingulate-cortex', R('a community member, at region level'),
      'Part of the default-mode community in the reported partition.', TEXT, 'high')]],
  ['power-2011-functional-areas', 'subcortical-nodes',
    'Subcortical structures participate in the cortical community structure rather than forming an isolated system.',
    ['networks', 'connectivity'],
    [M('ATLAS-LABEL:thalamus', R('a node, at structure level'),
      'Included among the subcortical nodes in the graph.', TEXT, 'medium'),
    M('ATLAS-LABEL:putamen', R('a node, at structure level'),
      'Included among the subcortical nodes in the graph.', TEXT, 'medium')]],
  ['power-2011-functional-areas', 'roi-definition-matters',
    'Regions of interest drawn from anatomy and from function give different graphs over the same data.',
    ['networks', 'method'],
    [M('ATLAS-LABEL:angular-gyrus', R('used as an example of an anatomically defined node'),
      'An anatomically defined region spanning more than one functional area.', INFER, 'medium',
      'the general argument is applied to this region by the curator.')]],

  // --- Hagmann 2008 --------------------------------------------------------
  ['hagmann-2008-structural-core', 'posterior-medial-core',
    'A structural core of highly connected regions is found in posterior medial and parietal cortex.',
    ['connectivity', 'networks'],
    [M('ATLAS-LABEL:precuneus', R('a core member, reported at region level'),
      'Identified as part of the structural core.', TEXT, 'high'),
    M('ATLAS-LABEL:posterior-cingulate-cortex', R('a core member, reported at region level'),
      'Identified as part of the structural core.', TEXT, 'high')]],
  ['hagmann-2008-structural-core', 'structural-hubs',
    'Hub regions carry disproportionately many connections, which makes them structurally central and clinically exposed.',
    ['connectivity'],
    [M('ATLAS-LABEL:superior-frontal-gyrus', R('a hub, at region level'),
      'Reported among the high-degree regions.', TEXT, 'medium')]],
  ['hagmann-2008-structural-core', 'retrosplenial-participation',
    'Retrosplenial and cingulate regions participate in the core, linking medial parietal and temporal systems.',
    ['connectivity'],
    [M('HCP-MMP1:RSC', R('reported at region level'),
      'Reported as participating in the core.', INFER, 'medium', NEAREST_PARCEL)]],
  ['hagmann-2008-structural-core', 'degree-distribution',
    'Connection degree is unevenly distributed across cortex rather than approximately uniform.',
    ['connectivity', 'method'],
    [M('HCP-MMP1:7Pm', R('reported at region level'),
      'Medial parietal regions carry high degree in the reported distribution.', INFER, 'low',
      'a distribution-level result attached to one parcel by the curator.')]],

  // --- Van Essen 2013 ------------------------------------------------------
  ['van-essen-2013-hcp', 'multimodal-acquisition',
    'The programme acquires structural, diffusion and functional data in the same subjects, which is what makes multi-modal parcellation possible.',
    ['template', 'method'],
    [M('HCP-MMP1:V1', R('the acquisition covers the whole cortex'),
      'Whole-cortex coverage across modalities.', TEXT, 'high')]],
  ['van-essen-2013-hcp', 'subject-count',
    'The target sample is roughly 1200 healthy adults, including twin and sibling pairs.',
    ['template', 'method'],
    [M('ATLAS-LABEL:inferior-frontal-gyrus', R('the sample covers the whole brain'),
      'Whole-brain data on a large healthy sample.', TEXT, 'high')]],
  ['van-essen-2013-hcp', 'surface-based-registration',
    'Registration is surface-based rather than volumetric, which aligns folding better than a volume warp.',
    ['registration', 'method'],
    [M('ATLAS-LABEL:precentral-gyrus', R('stated for cortex generally'),
      'Surface-based alignment is reported as improving cross-subject correspondence.', TEXT, 'high')]],
  ['van-essen-2013-hcp', 'minimal-preprocessing',
    'A minimal preprocessing pipeline is published with the data so that downstream results are comparable.',
    ['method'],
    [M('ATLAS-LABEL:fusiform-gyrus', R('stated for cortex generally'),
      'Pipelines are published alongside the data.', TEXT, 'medium')]],

  // --- Mazziotta 2001 ------------------------------------------------------
  ['mazziotta-2001-icbm', 'reference-system',
    'A probabilistic reference system for the human brain is built from a large subject population in a common stereotaxic space.',
    ['template', 'registration'],
    [M('ATLAS-LABEL:brainstem', R('the reference system covers the structure'),
      'The system spans the whole brain including the brainstem.', TEXT, 'medium'),
    M('HCP-MMP1:V1', R('the reference system covers the structure'),
      'Cortical areas are represented probabilistically.', TEXT, 'medium')]],
  ['mazziotta-2001-icbm', 'peak-coordinates',
    'Locations in the reference system are named by stereotaxic coordinates, so a published peak is a point rather than a region.',
    ['template', 'coordinates'],
    [M('HCP-MMP1:A1',
      X('MNI152', 'BV', [[-52, -18, 7]], 4,
        'an illustrative stereotaxic point in the auditory region, carried so the viewer has a coordinates mapping to render before any template exists'),
      "Coordinates are the reference system's native way of naming a location.", COORD, 'low')]],
  ['mazziotta-2001-icbm', 'spinal-extent',
    'The reference system is defined for the brain; the spinal cord lies outside it and can be named only at region level.',
    ['template', 'scope'],
    [M('FMA7647', R("outside the reference system's extent, so no coordinate claim exists at all"),
      'The scope statement is about what the system does not cover.', INFER, 'low',
      'a deliberately cross-frame mapping: a body-frame region on a paper whose other mappings are brain-frame, so a brain-only filter can be shown not to hide it.')]],
  ['mazziotta-2001-icbm', 'probabilistic-not-single-subject',
    "The atlas is probabilistic over a population rather than a single subject's anatomy.",
    ['template', 'registration'],
    [M('ATLAS-LABEL:thalamus', R('the structure is covered probabilistically'),
      'Structures are represented as probability distributions over the population.', TEXT, 'medium')]],

  // --- Fonov 2011 ----------------------------------------------------------
  ['fonov-2011-unbiased-templates', 'age-appropriate-templates',
    'Separate templates are built per age range, because one adult template misrepresents a developing brain.',
    ['template', 'registration'],
    [M('HCP-MMP1:V1', R('the template covers the whole brain'),
      'Age-specific templates are built over whole-brain data.', TEXT, 'medium')]],
  ['fonov-2011-unbiased-templates', 'unbiased-averaging',
    "The averaging procedure is unbiased with respect to any individual subject's anatomy.",
    ['template', 'registration'],
    [M('ATLAS-LABEL:precentral-gyrus', R('stated for the whole template'),
      "No single subject's shape dominates the average.", TEXT, 'medium')]],
  ['fonov-2011-unbiased-templates', 'template-is-not-a-subject',
    "A template is a statistical construct, so its geometry is not any real person's geometry.",
    ['template'],
    [M('ATLAS-LABEL:hippocampus', R('stated for the whole template'),
      'Template structures are averages rather than instances.', TEXT, 'high')]],
  ['fonov-2011-unbiased-templates', 'nonlinear-averaging',
    'Nonlinear registration is used in building the average, which sharpens structure boundaries relative to a linear average.',
    ['registration', 'method'],
    [M('ATLAS-LABEL:caudate-nucleus', R('stated for the whole template'),
      'Nonlinear averaging improves subcortical boundary definition.', TEXT, 'medium')]],

  // --- Fischl 2012 ---------------------------------------------------------
  ['fischl-2012-freesurfer', 'surface-reconstruction',
    "Cortical surfaces are reconstructed per subject, so measurements follow that individual's folding.",
    ['method', 'registration'],
    [M('ATLAS-LABEL:precentral-gyrus', R('stated for cortex generally'),
      'Per-subject surface reconstruction.', TEXT, 'high'),
    M('ATLAS-LABEL:postcentral-gyrus', R('stated for cortex generally'),
      'Per-subject surface reconstruction.', TEXT, 'high')]],
  ['fischl-2012-freesurfer', 'thickness-measurement',
    'Cortical thickness is measured between the white and pial surfaces rather than from voxel intensity alone.',
    ['method'],
    [M('HCP-MMP1:V1', R('thickness is a per-vertex measure, summarised at area level here'),
      'Thickness is computed between reconstructed surfaces.', INFER, 'medium',
      'a per-vertex measure attached to one parcel by the curator.')]],
  ['fischl-2012-freesurfer', 'subcortical-segmentation',
    'Subcortical structures are segmented with a probabilistic atlas rather than by intensity thresholds.',
    ['method', 'parcellation'],
    [M('ATLAS-LABEL:hippocampus', R('the structure is segmented as a whole'),
      'Segmented using a probabilistic atlas prior.', TEXT, 'high'),
    M('ATLAS-LABEL:amygdala', R('the structure is segmented as a whole'),
      'Segmented using a probabilistic atlas prior.', TEXT, 'high'),
    M('ATLAS-LABEL:thalamus', R('the structure is segmented as a whole'),
      'Segmented using a probabilistic atlas prior.', TEXT, 'high')]],
  ['fischl-2012-freesurfer', 'registration-to-template',
    'Surface registration to a template brings cortical locations into correspondence across subjects.',
    ['registration'],
    [M('ATLAS-LABEL:fusiform-gyrus', R('stated for cortex generally'),
      'Spherical surface registration establishes correspondence.', TEXT, 'medium')]],

  // --- Eickhoff 2005 -------------------------------------------------------
  ['eickhoff-2005-anatomy-toolbox', 'probabilistic-cytoarchitecture',
    'Probabilistic cytoarchitectonic maps are combined with functional images so an activation can be assigned to areas with probabilities.',
    ['cytoarchitecture', 'method'],
    [M('HCP-MMP1:44', R('the map covers the area as a whole'),
      'Among the areas with published probability maps.', INFER, 'medium', HISTORIC),
    M('HCP-MMP1:45', R('the map covers the area as a whole'),
      'Among the areas with published probability maps.', INFER, 'medium', HISTORIC)]],
  ['eickhoff-2005-anatomy-toolbox', 'maximum-probability-map',
    'A maximum probability map assigns each voxel to one area, which discards the probabilities it was derived from.',
    ['cytoarchitecture', 'method'],
    [M('HCP-MMP1:3b', R('the map covers the area as a whole'),
      'Among the somatosensory areas in the maximum probability map.', INFER, 'medium', HISTORIC),
    M('HCP-MMP1:4', R('the map covers the area as a whole'),
      'Among the motor areas in the maximum probability map.', INFER, 'medium', HISTORIC)]],
  ['eickhoff-2005-anatomy-toolbox', 'overlap-with-activation',
    "Assignment is reported as the overlap between an activation cluster and each area's probability map.",
    ['method'],
    [M('HCP-MMP1:V1', R('overlap is computed over the whole area'),
      'Overlap between cluster and area map is the reported quantity.', TEXT, 'high')]],
  ['eickhoff-2005-anatomy-toolbox', 'assignment-is-probabilistic',
    'An activation is never in one area with certainty, so a single area label over-states what the data supports.',
    ['method'],
    [M('ATLAS-LABEL:precentral-gyrus', R('stated about the assignment procedure'),
      'A probabilistic assignment is reported rather than a single label.', TEXT, 'high')]],

  // --- Mesulam 1998 --------------------------------------------------------
  ['mesulam-1998-sensation-to-cognition', 'transmodal-areas',
    'Transmodal areas bind information across sensory modalities rather than processing one of them.',
    ['networks', 'architecture'],
    [M('ATLAS-LABEL:insular-cortex', R('described at region level'),
      'Described among the transmodal regions.', TEXT, 'medium'),
    M('ATLAS-LABEL:anterior-cingulate-cortex', R('described at region level'),
      'Described among the transmodal regions.', TEXT, 'medium')]],
  ['mesulam-1998-sensation-to-cognition', 'sensory-fugal-gradient',
    'Cortex is organised along a gradient from primary sensory areas through unimodal and heteromodal to limbic zones.',
    ['architecture'],
    [M('HCP-MMP1:A1', R("the gradient's auditory anchor, at area level"),
      'Primary auditory cortex anchors the auditory end of the gradient.', TEXT, 'high'),
    M('HCP-MMP1:V1', R("the gradient's visual anchor, at area level"),
      'Primary visual cortex anchors the visual end of the gradient.', TEXT, 'high')]],
  ['mesulam-1998-sensation-to-cognition', 'limbic-end',
    'The limbic end of the gradient includes medial temporal structures involved in memory.',
    ['architecture', 'memory'],
    [M('ATLAS-LABEL:hippocampus', R('described at structure level'),
      'At the limbic end of the sensory-fugal gradient.', TEXT, 'high'),
    M('ATLAS-LABEL:parahippocampal-gyrus', R('described at region level'),
      'At the limbic end of the sensory-fugal gradient.', TEXT, 'high')]],
  ['mesulam-1998-sensation-to-cognition', 'heteromodal-cortex',
    'Heteromodal cortex in parietal and prefrontal regions receives convergent input from several unimodal areas.',
    ['architecture', 'networks'],
    [M('HCP-MMP1:PGs', R('described at area level'),
      'Parietal heteromodal cortex.', INFER, 'medium', NEAREST_PARCEL),
    M('HCP-MMP1:9-46d', R('described at area level'),
      'Prefrontal heteromodal cortex.', INFER, 'medium', NEAREST_PARCEL)]],

  // --- Raichle 2001 --------------------------------------------------------
  ['raichle-2001-default-mode', 'default-activity',
    'A set of regions is more active at rest than during attention-demanding tasks, defining a default mode.',
    ['networks', 'resting-state'],
    [M('ATLAS-LABEL:posterior-cingulate-cortex', R('reported at region level'),
      'A principal region of the default mode.', TEXT, 'high'),
    M('ATLAS-LABEL:precuneus', R('reported at region level'),
      'A principal region of the default mode.', TEXT, 'high')]],
  ['raichle-2001-default-mode', 'medial-prefrontal',
    'Medial prefrontal cortex is part of the default mode alongside posterior midline regions.',
    ['networks', 'resting-state'],
    [M('ATLAS-LABEL:anterior-cingulate-cortex', R('reported at region level'),
      'Included among the default-mode regions.', TEXT, 'high')]],
  ['raichle-2001-default-mode', 'oxygen-extraction-fraction',
    'The default mode is argued from a uniform resting oxygen extraction fraction rather than from blood flow alone.',
    ['method', 'resting-state'],
    [M('ATLAS-LABEL:occipital-lobe', R('the measure is whole-brain'),
      'Oxygen extraction fraction is reported as approximately uniform at rest.', TEXT, 'high')]],
  ['raichle-2001-default-mode', 'task-induced-deactivation',
    'Task-induced decreases are relative to the resting baseline, so a deactivation is not a suppression below zero.',
    ['method', 'resting-state'],
    [M('HCP-MMP1:PGs', R('reported at region level'),
      'Deactivation is defined relative to the resting baseline.', INFER, 'medium', NEAREST_PARCEL)]],

  // --- Buckner 2008 --------------------------------------------------------
  ['buckner-2008-default-network', 'network-anatomy',
    "The default network's anatomy is described as a set of interacting regions rather than one area.",
    ['networks'],
    [M('ATLAS-LABEL:posterior-cingulate-cortex', R('reported at region level'),
      'A hub of the described network.', TEXT, 'high'),
    M('HCP-MMP1:RSC', R('reported at region level'),
      'Retrosplenial cortex is described as part of the network.', INFER, 'medium', NEAREST_PARCEL)]],
  ['buckner-2008-default-network', 'medial-temporal-subsystem',
    'A medial temporal subsystem supports memory-based construction and is distinguishable from the midline core.',
    ['networks', 'memory'],
    [M('ATLAS-LABEL:hippocampus', R('reported at structure level'),
      'Part of the medial temporal subsystem.', TEXT, 'high'),
    M('ATLAS-LABEL:parahippocampal-gyrus', R('reported at region level'),
      'Part of the medial temporal subsystem.', TEXT, 'high')]],
  ['buckner-2008-default-network', 'relevance-to-disease',
    "The network's regions overlap those affected early in Alzheimer's disease, which is an anatomical coincidence rather than a mechanism.",
    ['networks', 'clinical'],
    [M('HCP-MMP1:PHA1', R('reported at region level'),
      'Parahippocampal cortex is among the regions discussed.', INFER, 'medium', NEAREST_PARCEL)]],
  ['buckner-2008-default-network', 'prefrontal-hub',
    "Dorsomedial and dorsolateral prefrontal regions contribute to the network's anterior component.",
    ['networks'],
    [M('HCP-MMP1:9-46d', R('reported at area level'),
      'Prefrontal contribution to the network.', INFER, 'medium', NEAREST_PARCEL)]],

  // --- Price 2012 ----------------------------------------------------------
  ['price-2012-language-review', 'heard-speech',
    'Heard speech engages superior temporal regions bilaterally across two decades of imaging studies.',
    ['language', 'meta-analysis'],
    [M('HCP-MMP1:A1', R('summarised at area level across studies'),
      'Primary auditory cortex is engaged by heard speech.', TEXT, 'high'),
    M('HCP-MMP1:A4', R('summarised at area level across studies'),
      'Higher auditory areas are engaged by heard speech.', TEXT, 'medium')]],
  ['price-2012-language-review', 'speech-production',
    'Speech production engages inferior frontal and motor regions, with the inferior frontal contribution varying by task.',
    ['language', 'meta-analysis'],
    [M('HCP-MMP1:44', R('summarised at area level across studies'),
      'Inferior frontal engagement in production tasks.', TEXT, 'high'),
    M('HCP-MMP1:4', R('summarised at area level across studies'),
      'Motor cortex engagement in articulation.', TEXT, 'high')]],
  ['price-2012-language-review', 'reading',
    'Reading engages ventral occipitotemporal cortex, whose response is sensitive to orthographic familiarity.',
    ['language', 'reading'],
    [M('HCP-MMP1:FFC', R('summarised at area level across studies'),
      'Ventral occipitotemporal engagement in reading.', TEXT, 'high'),
    M('ATLAS-LABEL:lingual-gyrus', R('summarised at region level across studies'),
      'Early visual contribution to reading tasks.', TEXT, 'medium')]],
  ['price-2012-language-review', 'semantic-retrieval',
    'Semantic retrieval engages anterior temporal regions, which are poorly covered by many imaging protocols.',
    ['language', 'semantics'],
    [M('HCP-MMP1:TE1a', R('summarised at area level across studies'),
      'Anterior temporal engagement in semantic tasks.', TEXT, 'medium'),
    M('HCP-MMP1:TGd', R('summarised at area level across studies'),
      'Temporal pole engagement in semantic tasks.', TEXT, 'medium')]],

  // --- Hickok & Poeppel 2007 -----------------------------------------------
  ['hickok-2007-dual-stream', 'dorsal-stream',
    'A dorsal stream maps acoustic speech onto articulatory representations and is left-dominant.',
    ['language', 'architecture'],
    [M('HCP-MMP1:PFm', R('described at area level'),
      'Parietal-temporal junction in the dorsal stream.', INFER, 'medium', NEAREST_PARCEL),
    M('HCP-MMP1:44', R('described at area level'),
      'Frontal articulatory network in the dorsal stream.', TEXT, 'high')]],
  ['hickok-2007-dual-stream', 'ventral-stream',
    'A ventral stream maps speech sound onto meaning and is bilaterally organised.',
    ['language', 'architecture'],
    [M('HCP-MMP1:STSvp', R('described at area level'),
      'Posterior superior temporal sulcus in the ventral stream.', TEXT, 'high'),
    M('ATLAS-LABEL:middle-temporal-gyrus', R('described at region level'),
      'Middle temporal regions in the lexical interface.', TEXT, 'medium')]],
  ['hickok-2007-dual-stream', 'bilateral-ventral',
    'The bilateral organisation of the ventral stream explains why unilateral damage rarely abolishes comprehension.',
    ['language', 'clinical'],
    [M('ATLAS-LABEL:superior-temporal-gyrus', R('described at region level, bilaterally'),
      'Bilateral superior temporal involvement in comprehension.', TEXT, 'high')]],
  ['hickok-2007-dual-stream', 'sensorimotor-interface',
    "A sensorimotor interface area in the posterior planum temporale is proposed as the dorsal stream's hinge.",
    ['language', 'architecture'],
    [M('ATLAS-LABEL:supramarginal-gyrus',
      C('3', 'the curator placed the proposed interface region onto a sub-cell of the supramarginal gyrus; a sub-region claim, not a measurement'),
      'The proposed interface is a part of this region rather than all of it.', INFER, 'low', SYNTHETIC_SUBREGION)]],

  // --- Kanwisher 1997 ------------------------------------------------------
  ['kanwisher-1997-fusiform-face-area', 'face-selective-region',
    'A region of fusiform gyrus responds more to faces than to objects, consistently across subjects.',
    ['vision', 'faces'],
    [M('HCP-MMP1:FFC', R('the functional region is reported as a whole'),
      'Face-selective responses localised to fusiform cortex.', TEXT, 'high')]],
  ['kanwisher-1997-fusiform-face-area', 'right-lateralisation',
    'The face-selective response is typically stronger in the right hemisphere.',
    ['vision', 'faces', 'asymmetry'],
    [M('ATLAS-LABEL:fusiform-gyrus', R('reported at region level'),
      'Right-hemisphere responses are reported as stronger.', INFER, 'medium',
      "the dataset's synthetic index gives this structure cells in both hemispheres; the reported asymmetry is a difference in response magnitude, not a claim that the left side is absent.")]],
  ['kanwisher-1997-fusiform-face-area', 'stimulus-contrast',
    'Selectivity is defined by a contrast between stimulus classes, so it depends on the comparison chosen.',
    ['vision', 'method'],
    [M('ATLAS-LABEL:occipital-lobe', R('stated about the contrast, not a locus'),
      'Selectivity is a contrast-dependent measure.', TEXT, 'high')]],
  ['kanwisher-1997-fusiform-face-area', 'peak-coordinate',
    "The region's location is reported as a stereotaxic coordinate per subject rather than an anatomical boundary.",
    ['vision', 'coordinates'],
    [M('HCP-MMP1:FFC',
      X('MNI152', 'BV', [[40, -55, -10]], 4,
        'an illustrative right-hemisphere fusiform coordinate, carried so the seed set exercises the unresolvable-coordinate state at more than one site'),
      'Per-subject peak coordinates are the reported localisation.', COORD, 'low')]],

  // --- Epstein & Kanwisher 1998 --------------------------------------------
  ['epstein-1998-parahippocampal-place-area', 'scene-selective-region',
    'A parahippocampal region responds more to scenes and places than to objects or faces.',
    ['vision', 'scenes'],
    [M('HCP-MMP1:PHA1', R('the functional region is reported as a whole'),
      'Scene-selective responses localised to parahippocampal cortex.', TEXT, 'high')]],
  ['epstein-1998-parahippocampal-place-area', 'parahippocampal-location',
    'The region sits in parahippocampal cortex rather than in the hippocampus itself.',
    ['vision', 'scenes'],
    [M('ATLAS-LABEL:parahippocampal-gyrus', R('reported at region level'),
      'Located on the parahippocampal gyrus.', TEXT, 'high')]],
  ['epstein-1998-parahippocampal-place-area', 'not-object-selective',
    'The response is to the spatial layout of a scene rather than to the objects in it.',
    ['vision', 'scenes'],
    [M('HCP-MMP1:FFC', R('named as the contrast region, at area level'),
      'Contrasted against the face- and object-selective fusiform response.', TEXT, 'medium')]],
  ['epstein-1998-parahippocampal-place-area', 'peak-coordinate',
    'Localisation is reported as a stereotaxic coordinate, so the claim is a locus rather than a parcel.',
    ['vision', 'coordinates'],
    [M('HCP-MMP1:PHA1',
      X('MNI152', 'BV', [[26, -42, -10]], 4,
        'an illustrative parahippocampal coordinate; carried for the same reason as the other two.'),
      'Per-subject peak coordinates are the reported localisation.', COORD, 'low')]],

  // --- Penfield & Boldrey 1937 ---------------------------------------------
  ['penfield-1937-somatotopy', 'motor-strip',
    'Electrical stimulation of the precentral gyrus produces movement, ordered somatotopically along the strip.',
    ['motor', 'somatotopy'],
    [M('HCP-MMP1:4', R('the ordering is along the whole strip; no single locus is claimed'),
      'Stimulation produced movement in an ordered sequence along the gyrus.', INFER, 'medium', HISTORIC),
    M('ATLAS-LABEL:precentral-gyrus', R('the gyrus as a whole carries the ordering'),
      'The motor sequence is reported along the precentral gyrus.', TEXT, 'high')]],
  ['penfield-1937-somatotopy', 'sensory-strip',
    'Stimulation of the postcentral gyrus produces sensation, with a comparable somatotopic ordering.',
    ['somatosensory', 'somatotopy'],
    [M('HCP-MMP1:3b', R('the ordering is along the whole strip'),
      'Stimulation produced sensation in an ordered sequence.', INFER, 'medium', HISTORIC),
    M('ATLAS-LABEL:postcentral-gyrus', R('the gyrus as a whole carries the ordering'),
      'The sensory sequence is reported along the postcentral gyrus.', TEXT, 'high')]],
  ['penfield-1937-somatotopy', 'disproportionate-representation',
    'Body parts are represented in proportion to their functional importance rather than their size.',
    ['somatosensory', 'somatotopy'],
    [M('HCP-MMP1:1', R('reported along the strip rather than at a locus'),
      'Hand and face occupy disproportionately large stretches.', INFER, 'medium', HISTORIC)]],
  ['penfield-1937-somatotopy', 'stimulation-not-imaging',
    'The evidence is intraoperative stimulation in patients, which gives causal but not population-representative localisation.',
    ['method', 'clinical'],
    [M('HCP-MMP1:FOP4', R('stated about the method, at area level'),
      'Findings come from intraoperative stimulation in a clinical population.', INFER, 'low',
      'a methodological statement attached to the operculum, where face and mouth responses were reported; the parcel is the curator’s nearest match.')]],

  // --- Catani 2008 ---------------------------------------------------------
  ['catani-2008-virtual-dissection', 'arcuate-fasciculus',
    'The arcuate fasciculus is reconstructed as connecting frontal and temporoparietal regions.',
    ['connectivity', 'tractography'],
    [M('HCP-MMP1:44', R('a reported endpoint region, not a tract segment'),
      'Frontal termination of the reconstructed tract.', INFER, 'medium', TRACT),
    M('ATLAS-LABEL:supramarginal-gyrus', R('a reported endpoint region'),
      'Parietal termination of the reconstructed tract.', INFER, 'medium', TRACT)]],
  ['catani-2008-virtual-dissection', 'tract-atlas',
    'An atlas of major white-matter tracts is built by virtual dissection of diffusion data.',
    ['connectivity', 'tractography'],
    [M('ATLAS-LABEL:superior-temporal-gyrus', R('a reported endpoint region'),
      'Temporal terminations of the reconstructed tracts.', INFER, 'medium', TRACT)]],
  ['catani-2008-virtual-dissection', 'endpoints-are-not-tracts',
    'A tract is a pathway, so naming the cortical regions it reaches is a different claim from naming the tract.',
    ['connectivity', 'method'],
    [M('ATLAS-LABEL:angular-gyrus', R('a reported endpoint region'),
      'Angular gyrus terminations are reported for posterior tracts.', INFER, 'medium', TRACT)]],
  ['catani-2008-virtual-dissection', 'fornix',
    'The fornix is reconstructed as the principal hippocampal output pathway.',
    ['connectivity', 'tractography', 'memory'],
    [M('ATLAS-LABEL:hippocampus', R('a reported endpoint structure'),
      'Hippocampal origin of the reconstructed fornix.', INFER, 'medium', TRACT)]],

  // --- Mitsuhashi 2009 -----------------------------------------------------
  ['mitsuhashi-2009-bodyparts3d', 'per-part-meshes',
    'A whole-body 3D structure database supplies per-part surface meshes keyed to anatomical concept ids.',
    ['asset-source', 'whole-body'],
    [M('FMA7310', R('a database record for a whole part'),
      'The lungs are supplied as individual meshes.', TEXT, 'high'),
    M('FMA7088', R('a database record for a whole part'),
      'The heart is supplied as an individual mesh.', TEXT, 'high'),
    M('FMA7197', R('a database record for a whole part'),
      'The liver is supplied as an individual mesh.', TEXT, 'high')]],
  ['mitsuhashi-2009-bodyparts3d', 'skeletal-parts',
    'Skeletal elements are addressable individually, including each rib and each vertebra.',
    ['asset-source', 'skeleton'],
    [M('ATLAS-LABEL:rib-7', R('a database record for a whole part'),
      'Ribs appear as separately named parts rather than one cage mesh.', TEXT, 'medium'),
    M('FMA9968', R('a database record for a whole part'),
      'Vertebrae appear as separately named parts.', TEXT, 'medium')]],
  ['mitsuhashi-2009-bodyparts3d', 'concept-ids',
    'Each part carries an anatomical concept id, which is what makes a geometry set usable as a naming layer.',
    ['asset-source', 'ontology'],
    [M('FMA7204', R('a database record for a whole part'),
      'Parts are keyed to anatomical concepts.', TEXT, 'high'),
    M('FMA7205', R('a database record for a whole part'),
      'Parts are keyed to anatomical concepts.', TEXT, 'high')]],
  ['mitsuhashi-2009-bodyparts3d', 'whole-body-coverage',
    'Coverage extends to muscles and other soft tissue rather than organs alone.',
    ['asset-source', 'whole-body'],
    [M('FMA13295', R('a database record for a whole part'),
      'Muscular structures are included.', TEXT, 'medium'),
    M('ATLAS-LABEL:quadratus-lumborum', R('a database record for a whole part'),
      'Muscular structures are included.', TEXT, 'medium')]],

  // --- Rosse & Mejino 2003 -------------------------------------------------
  ['rosse-2003-fma', 'reference-ontology',
    'A reference ontology of anatomy represents canonical structure independently of any application.',
    ['ontology'],
    [M('FMA7088', R('an ontology class, not a located instance'),
      'Represented as a class in the ontology.', TEXT, 'high'),
    M('FMA7197', R('an ontology class, not a located instance'),
      'Represented as a class in the ontology.', TEXT, 'high')]],
  ['rosse-2003-fma', 'part-of-relations',
    "Part-of relations are explicit, so a structure's containment hierarchy is queryable rather than implied by naming.",
    ['ontology'],
    [M('ATLAS-LABEL:coronary-artery', R('an ontology class with explicit part-of relations'),
      'Related to the heart by an explicit part-of relation.', TEXT, 'high')]],
  ['rosse-2003-fma', 'canonical-anatomy',
    'The ontology represents canonical anatomy, so variation and pathology are outside what it asserts.',
    ['ontology', 'scope'],
    [M('FMA7148', R('an ontology class, not a located instance'),
      'Canonical rather than instance anatomy.', TEXT, 'high'),
    M('FMA7198', R('an ontology class, not a located instance'),
      'Canonical rather than instance anatomy.', TEXT, 'high')]],
  ['rosse-2003-fma', 'not-instance-anatomy',
    'A class in the ontology is not a region of any particular body, so it carries no coordinates.',
    ['ontology', 'scope'],
    [M('FMA15900', R('an ontology class, which has no geometry at all'),
      'Classes carry no spatial extent.', TEXT, 'high')]],

  // --- Mungall 2012 --------------------------------------------------------
  ['mungall-2012-uberon', 'multi-species-integration',
    'An integrative anatomy ontology bridges species-specific ontologies so data can be compared across them.',
    ['ontology'],
    [M('FMA7197', R('an ontology class'),
      'Integrated across species-specific ontologies.', TEXT, 'high'),
    M('FMA7148', R('an ontology class'),
      'Integrated across species-specific ontologies.', TEXT, 'high')]],
  ['mungall-2012-uberon', 'cross-ontology-bridges',
    'Bridging axioms link classes across ontologies, which makes the alignment inspectable rather than implicit.',
    ['ontology', 'method'],
    [M('FMA7647', R('an ontology class'),
      'Linked by bridging axioms to species-specific classes.', TEXT, 'high')]],
  ['mungall-2012-uberon', 'taxon-constraints',
    'Taxon constraints record which species a class applies to, so a cross-species claim is explicit.',
    ['ontology', 'method'],
    [M('FMA7309', R('an ontology class'), 'Carries taxon constraints.', TEXT, 'medium')]],
  ['mungall-2012-uberon', 'structure-classes-not-geometry',
    'The ontology asserts classes and relations, not geometry, so a mesh is never licensed by an ontology id alone.',
    ['ontology', 'scope'],
    [M('FMA16202', R('an ontology class, which has no geometry'),
      'Classes carry no spatial extent.', TEXT, 'high')]],

  // --- Panjabi 1991 --------------------------------------------------------
  ['panjabi-1991-thoracic-morphometry', 'vertebral-dimensions',
    'Thoracic vertebrae are measured in three dimensions, giving per-level body and canal dimensions.',
    ['spine', 'morphometry'],
    [M('FMA9968',
      // BD-T07-12I-2 is in FMA9968's covering in the real index: 12 o'clock is
      // the anterior midline, which is the vertebral body's side of the level,
      // and `I` is the inner half, where the body sits against the axis. The
      // appended `0` is the cranial-anterior-inner octant of that cell.
      E(['BD-T07-12I-20'], 'the anterior-midline inner cell of the structure’s real covering, refined one octree digit'),
      'Per-level dimensions are reported for the vertebral body specifically.', INFER, 'low', REAL_SUBREGION)]],
  ['panjabi-1991-thoracic-morphometry', 'pedicle-geometry',
    'Pedicle width and angle vary systematically down the thoracic spine rather than being constant.',
    ['spine', 'morphometry'],
    [M('FMA9968', R('reported per level'),
      'Pedicle dimensions are reported per thoracic level.', TEXT, 'medium')]],
  ['panjabi-1991-thoracic-morphometry', 'level-to-level-variation',
    "Dimensions change monotonically across much of the thoracic spine, so one level's geometry does not stand for another's.",
    ['spine', 'morphometry'],
    [M('FMA13075', R("reported per level; cited here as the adjacent region's contrast"),
      'Thoracic dimensions are reported as distinct from lumbar ones.', INFER, 'low',
      'the paper measures thoracic vertebrae; the lumbar level is named by the curator as the contrast case, not measured here.'),
    M('FMA16202', R('named as the caudal limit of the measured series'),
      'The measured series ends above the sacrum.', INFER, 'low',
      'named by the curator to record where the measured range stops.')]],
  ['panjabi-1991-thoracic-morphometry', 'canal-dimensions',
    'Spinal canal dimensions are reported per level, which bounds what the cord occupies at that level.',
    ['spine', 'morphometry'],
    [M('FMA7647', R('the canal is measured; the cord within it is reported at region level'),
      'Canal dimensions are reported per level.', INFER, 'medium',
      'the paper measures the canal; treating that as a claim about the cord is the curator’s reading.')]],

  // --- Bogduk 2012 ---------------------------------------------------------
  ['bogduk-2012-lumbar-anatomy', 'lumbar-vertebra-structure',
    'The lumbar vertebra is described as a weight-bearing body with posterior elements serving movement and protection.',
    ['spine', 'anatomy'],
    [M('FMA13075', R('a descriptive account of the whole bone'),
      'Described as body plus posterior elements.', TEXT, 'high')]],
  ['bogduk-2012-lumbar-anatomy', 'lumbosacral-junction',
    'The lumbosacral junction is described as the transition where lumbar mobility meets sacral fixity.',
    ['spine', 'anatomy'],
    [M('FMA16202', R('a descriptive account at structure level'),
      'Described as the fixed base of the lumbar column.', TEXT, 'high')]],
  ['bogduk-2012-lumbar-anatomy', 'posterior-muscles',
    'The posterior and lateral muscles of the lumbar region are described with their attachments and actions.',
    ['spine', 'anatomy', 'muscle'],
    [M('ATLAS-LABEL:quadratus-lumborum', R('a descriptive account at structure level'),
      'Described with its attachments to the twelfth rib and the iliac crest.', TEXT, 'high')]],
  ['bogduk-2012-lumbar-anatomy', 'nerve-supply',
    'The nerve supply of the lumbar structures is described segmentally, which is what makes referred pain patterns predictable.',
    ['spine', 'anatomy', 'clinical'],
    [M('FMA7647', R('described segmentally rather than at a locus'),
      'Segmental innervation is described per level.', TEXT, 'medium')]],
];

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Anchor segments per frame, so a digit segment can be told from an anchor. */
const ANCHOR_SEGMENTS = { BV: 1, BD: 2 };

function childOf(cell, suffix) {
  const parts = cell.split('-');
  const hasDigits = parts.length === 2 + ANCHOR_SEGMENTS[parts[0]];
  return hasDigits ? cell + suffix : `${cell}-${suffix}`;
}

function digitsOf(cell) {
  const parts = cell.split('-');
  return parts.length === 2 + ANCHOR_SEGMENTS[parts[0]] ? parts[parts.length - 1].length : 0;
}

const prov = (basis, confidence, note) => ({
  assertedBy: CURATOR,
  assertedOn: CURATED_ON,
  basis,
  confidence,
  ...(note ? { note } : {}),
});

function buildSpatial(sid, spatial) {
  if (spatial.k === 'R') return { kind: 'region-level', reason: spatial.reason };
  if (spatial.k === 'C') {
    const anchors = STRUCTURES.get(sid).cells;
    if (anchors.length === 0) {
      throw new Error(`${sid} has no cells in this package: name its sub-region cells outright with E([...])`);
    }
    const cell = childOf(anchors[0], spatial.suffix);
    return { kind: 'cells', cells: [cell], method: spatial.method, digits: digitsOf(cell) };
  }
  if (spatial.k === 'E') {
    const digits = new Set(spatial.cells.map(digitsOf));
    if (digits.size !== 1) throw new Error(`${sid}: named cells disagree on refinement depth`);
    return { kind: 'cells', cells: spatial.cells, method: spatial.method, digits: [...digits][0] };
  }
  return {
    kind: 'coordinates',
    space: spatial.space,
    frame: spatial.frame,
    pointsMm: spatial.pointsMm,
    digits: spatial.digits,
    note: spatial.note,
  };
}

const papers = PAPERS.map(([key, title, authors, year, venue, doi]) => ({
  id: `paper:${key}`,
  title,
  authors,
  year,
  venue,
  identifier: doi ? { kind: 'doi', value: doi } : { kind: 'none', value: null },
  sourceUrl: doi ? `https://doi.org/${doi}` : null,
  provenance: prov('published-text', 'high', null),
}));

const paperKeys = new Set(PAPERS.map(([k]) => k));
const referenced = new Set();

const findings = FINDINGS.map(([key, slug, statement, topics, maps]) => {
  if (!paperKeys.has(key)) throw new Error(`finding ${slug} names unknown paper ${key}`);
  return {
    id: `finding:${key}/${slug}`,
    paperId: `paper:${key}`,
    statement,
    topics,
    mappings: maps.map((m) => {
      if (!STRUCTURES.has(m.sid)) throw new Error(`finding ${slug} names unknown structure ${m.sid}`);
      referenced.add(m.sid);
      return {
        id: `map:${key}/${slug}/${m.sid.toLowerCase().replace(/:/g, '-')}`,
        structureId: m.sid,
        // Declared per structure rather than split off the id: a bare `FMA9968`
        // has no prefix to split, which is the form the BodyParts3D index uses.
        structureIdSource: STRUCTURES.get(m.sid).source,
        structureLabel: labelOf(m.sid),
        spatial: buildSpatial(m.sid, m.spatial),
        evidence: {
          summary: m.summary,
          kind: m.kind,
          locator: m.locator,
          locatorStatus: m.locator ? 'recorded' : 'not-recorded',
        },
        provenance: prov(m.basis, m.confidence, m.note),
      };
    }),
    provenance: prov('published-text', 'high', null),
  };
});

/**
 * The index each partition was authored against.
 *
 * `REAL_INDEX_VERSION` is a declaration, not a reading: this script does not
 * open the asset package, so the dataset stays regenerable on a branch where
 * the assets are absent, and `tools/check-research-dataset.mjs` is what
 * verifies the declaration against the index when the index is there. Declare,
 * then check — the same split the citation report uses.
 */
const REAL_INDEX_VERSION = 'bp3d-4.0+uberon-uberon/releases/2026-10-01/uberon-basic.owl+8772477294da';
const PLACEHOLDER_INDEX_VERSION = 'seed-names-2026.10.2';

const LICENCE_BLOCKED =
  'docs/asset-licensing.md §4 returns VERDICT: NOT CLEARED for brain parcellation, and the verdict ' +
  'is final for v1: Harvard-Oxford is distributed under FSL\'s non-commercial terms, AAL requires ' +
  'registration and restricts redistribution, and Julich-Brain is CC BY-NC-SA 4.0, whose NC term ' +
  'forecloses commercial use outright. Two further facts make this permanent rather than pending: ' +
  'the cleared index declares "frame": "BD" and has NO BV name index, and the brain is absent from ' +
  'the BD index by measurement (0.2% of its interior samples fall inside the BD frame, because the ' +
  'brain sits almost entirely above C01). So BV addresses locate and round-trip but do not resolve ' +
  'to a name. These ids stay on declared placeholders: the anatomical TERMS are usable and are not ' +
  'what is licensed; the parcellation that would delineate them is.';

const NOT_IN_BD_INDEX =
  'these are gross body structures that the cleared BD index does not carry at the specificity the ' +
  'finding claims. It names 57 structures from the BodyParts3D release: there is a generic rib ' +
  '(FMA7574) but no individual rib, so filing a 7th-rib finding under it would paint all of them, ' +
  'and neither the coronary artery nor the quadratus lumborum is in the subset at all. This is a ' +
  'coverage gap in the index rather than a licence refusal, and it is recorded separately for that ' +
  'reason: if the release subset grows, these move to FMA ids and the licence-blocked partition ' +
  'does not.';

/** Partition membership, derived from the structure tables rather than listed twice. */
const partitionsOf = (referencedIds) => {
  const members = (partition) => referencedIds.filter((id) => STRUCTURES.get(id).partition === partition).sort();
  const parts = [
    {
      id: BODY_BD,
      status: 'real',
      nameIndexVersion: REAL_INDEX_VERSION,
      structureIds: members(BODY_BD),
    },
    {
      id: BRAIN_PARCELLATION,
      status: 'placeholder',
      nameIndexVersion: PLACEHOLDER_INDEX_VERSION,
      structureIds: members(BRAIN_PARCELLATION),
      reason: LICENCE_BLOCKED,
    },
    {
      id: BODY_NOT_IN_INDEX,
      status: 'placeholder',
      nameIndexVersion: PLACEHOLDER_INDEX_VERSION,
      structureIds: members(BODY_NOT_IN_INDEX),
      reason: NOT_IN_BD_INDEX,
    },
  ];
  for (const p of parts) {
    if (p.structureIds.length === 0) throw new Error(`partition ${p.id} has no referenced structures`);
  }
  return parts;
};

const dataset = {
  $comment: [
    'GENERATED by scripts/author-seed.mjs. Edit the curation source there, not this file;',
    '`node scripts/author-seed.mjs --check` fails if the two drift apart.',
    '',
    'The curated seed set: 30 papers, 120 findings. Conforms to schema/research-1.md.',
    '',
    'WHAT IS AND IS NOT CHECKED:',
    '',
    '  - EVERY identifier here was resolved against a named source on the date recorded',
    '    in data/citation-report.json: 15 asserted DOIs confirmed through Crossref to',
    '    point at the paper claimed, and 13 more DOIs returned by Crossref or PubMed for',
    '    records matching this title, first author and year. The trust-boundary rule has',
    '    not moved -- THIS PACKAGE still never resolves a URL. The checking happens in',
    '    tools/verify-research-citations.mjs, out of band, and the gate verifies the',
    '    committed report offline.',
    '  - The two remaining `none` entries are monographs (Brodmann 1909, Bogduk 2012).',
    '    For a book that is the CORRECT record, not a gap. The full volume and pages are',
    '    in `venue`. A missing DOI costs a reader seconds; a wrong one points silently at',
    '    a different paper.',
    '  - NOT CHECKED BY ANYTHING: that these papers claim what this file attributes to',
    '    them. Crossref confirms a paper exists; it says nothing about whether a finding',
    '    below is what the paper actually found. That needs a person reading the sources.',
    '  - The region mappings are the curator’s reading of what each paper is about, at',
    '    the granularity its abstract or chapter supports. They are not cell-level claims.',
    '  - Page- and figure-level locators are `not-recorded` rather than invented.',
    '',
    'STAGE B, and what it could and could not finish:',
    '',
    '  - 14 gross body structures are CROSSWALKED onto bare FMA concept ids and are',
    '    authored against the real BD index. They must resolve against it; the gate',
    '    fails if one does not. That is the `body-bd` partition, status `real`.',
    '  - Everything else stays on a declared placeholder, and that is a PASS rather',
    '    than a deferral, with the reason recorded per partition:',
    '      brain-parcellation  no cleared index can name these, and none will for v1.',
    '                          docs/asset-licensing.md section 4 is NOT CLEARED, the',
    '                          cleared index is BD only with no BV name index, and the',
    '                          brain is absent from BD by measurement. BV addresses',
    '                          locate and round-trip but do NOT resolve to a name.',
    '      body-not-in-index   a coverage gap, not a licence refusal: a generic rib and',
    '                          no individual rib, no coronary artery, no quadratus',
    '                          lumborum in the 57-structure subset.',
    '  - The gate checks the partition in BOTH directions. A `real` id that stops',
    '    resolving is a failure, and a `placeholder` id that STARTS resolving is also a',
    '    failure, because then the recorded reason has expired and the mapping should',
    '    be re-authored rather than left on a placeholder.',
    '  - 3 coordinate mappings resolve through the committed BV template to CELLS ONLY,',
    '    never to a name. That is the contract, not a gap: see the partition reason.',
    '',
    'THE VERSION DID NOT MOVE, AND THAT WAS A DECISION (DOG-46, CTO, 2026-10-09):',
    '',
    '  `version` is still research-seed-2026.10.1 although 26 mappings were re-authored',
    '  onto FMA ids. data/citation-report.json records the dataset version it describes,',
    '  and the repo owner has a pending decision pinned to that report; bumping here would',
    '  force a regeneration of a document this change makes no claim about -- it moves',
    '  structure ids, and alters neither which 30 papers are cited nor what justifies them.',
    '',
    '  What makes that safe is that the re-authored mappings changed their OWN ids, from',
    '  map:.../atlas-label-liver to map:.../fma7197. A highlight stored against the older',
    '  dataset therefore FAILS TO RESOLVE rather than resolving to a different structure,',
    '  which is the harm the version pin exists to prevent. Fail-closed, not silent drift.',
    '',
    '  DEFERRED, NOT CANCELLED: the next regeneration of this dataset for any other reason',
    '  should bump the version in that same change.',
  ],
  schema: 'research/1',
  // NOT bumped by the crosswalk, deliberately. `data/citation-report.json`
  // records the dataset version it describes, and the gate fails a report that
  // describes a different one — correctly, because a report that predates an
  // identifier change must not justify the current identifiers. This change
  // touches no identifier and no paper: it moves 26 structure ids and adds the
  // partition declaration, which that report neither justifies nor needs to.
  // Bumping here would force a regeneration of a report the repo owner has a
  // pending decision pinned to, to record a change it says nothing about. The
  // 26 re-authored mappings changed their own ids (`.../fma7197` rather than
  // `.../atlas-label-liver`), so a highlight stored against the old dataset
  // fails to resolve rather than resolving to something else, which is the
  // failure mode the version pin exists to prevent.
  version: 'research-seed-2026.10.1',
  structureIdSources: ['FMA', 'HCP-MMP1', 'ATLAS-LABEL'],
  authoredAgainst: { status: 'partitioned', partitions: partitionsOf([...referenced].sort()) },
  curation: {
    curatedBy: CURATOR,
    curatedOn: CURATED_ON,
    method:
      "manual curation: claims transcribed at the granularity each paper's abstract or chapter " +
      'supports, then mapped onto structures by hand. Emitted by scripts/author-seed.mjs so the ' +
      'repeated provenance and evidence fields cannot disagree with each other',
    citationCheck:
      'every identifier resolved against a named source -- see data/citation-report.json for the ' +
      'per-paper queries, the metadata each source returned and the retrievedOn date. A DOI is ' +
      'recorded only where Crossref or PubMed returned it AND the returned title, first author and ' +
      'year matched this record; otherwise identifier.kind is none and the full citation is in venue. ' +
      'This package still never fetches a URL: verification is a tool, and the gate checks its ' +
      'committed report offline. Existence is checked; whether a paper claims what a finding ' +
      'attributes to it is NOT, and cannot be by any API',
    notRecorded: [
      'page- and figure-level evidence locators: the claims are supported at abstract or chapter granularity, and an invented figure number would be worse than an absent one',
      'ontology accessions for brain parcels and for three body structures the cleared index does not carry: those keep the ATLAS-LABEL and HCP-MMP1 placeholder namespaces, because a wrong accession resolves to the wrong structure and looks authoritative doing it. The 14 body structures the index does carry are on bare FMA concept ids, and each is checked against that index',
      'measured geometry for every structure outside the BD index: the brain cells come from a synthetic index and cannot be replaced for v1, because no brain parcellation is licensed for redistribution and there is no BV name index. A BV address locates and round-trips; it does not resolve to a name',
      'the cells of the crosswalked body structures: they are real, and they are held in packages/atlas-assets under a share-alike licence rather than copied into this Apache-2.0 package. They are joined in at resolution, which is why a body structure resolves `empty-covering` against the placeholder index shipped here and resolves for real against the asset index',
    ],
  },
  papers,
  findings,
};

const names = {
  $comment: [
    'GENERATED by scripts/author-seed.mjs. SYNTHETIC -- not an anatomical name index, and',
    'must never be shipped as one.',
    '',
    'Two kinds of entry live here, and the difference is the point of this file:',
    '',
    '  1. PLACEHOLDER structures, with INVENTED cells. Cells are allocated by anatomical',
    '     group -- a leading BV digit per group, members in order within it -- so',
    '     neighbours are plausibly near neighbours and overlap results are meaningful',
    '     rather than random. The remaining body placeholders carry hand-assigned BD',
    '     anchors, because a vertebral level and a clock sector mean something. These',
    '     cells encode NO measured geometry and cannot be replaced for v1: see the',
    '     brain-parcellation partition in data/research-seed.json.',
    '',
    '  2. CROSSWALKED body structures: a real FMA concept id, the real index\'s own term,',
    '     and NO CELLS AT ALL. The id and the term are anatomical nomenclature and carry',
    '     no licence. The cells are derived from the BodyParts3D meshes under CC-BY-SA',
    '     and stay in packages/atlas-assets, which is why they are not copied here --',
    '     tools/check-licence-separation.mjs keeps that boundary for the packages.',
    '',
    'So a crosswalked structure resolves `empty-covering` against THIS index: named, not',
    'painted. That is deliberate and is not the same state as `unknown-structure`, so a',
    'mistyped accession is still caught here, on a branch where the asset index is absent.',
    'Join packages/atlas-assets/labels/{names,coverings}.json to paint them.',
  ],
  version: PLACEHOLDER_INDEX_VERSION,
  synthetic: true,
  structures: [...STRUCTURES.keys()].sort().map((id) => ({
    id,
    name: STRUCTURES.get(id).name,
    source: STRUCTURES.get(id).source,
    cells: STRUCTURES.get(id).cells,
  })),
};

// ---------------------------------------------------------------------------
// Write, or check
// ---------------------------------------------------------------------------

const OUTPUTS = [
  ['research-seed.json', dataset],
  ['names-seed.json', names],
];

const serialise = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

if (process.argv.includes('--check')) {
  const problems = [];
  for (const [name, value] of OUTPUTS) {
    const want = serialise(value);
    let got;
    try {
      got = readFileSync(join(DATA, name), 'utf8');
    } catch {
      problems.push(`data/${name} is missing. Run \`node scripts/author-seed.mjs\`.`);
      continue;
    }
    if (got !== want) {
      problems.push(
        `data/${name} does not match scripts/author-seed.mjs ` +
          `(committed ${digest(got)}, source ${digest(want)}).`,
        '  One of the two was edited without the other. The script is the curation source;',
        '  re-run `node scripts/author-seed.mjs` and commit both.',
      );
    }
  }
  if (problems.length > 0) {
    console.error('\n✗ research seed drift\n');
    for (const p of problems) console.error(`  ${p}`);
    console.error('');
    process.exit(1);
  }
  console.log('✓ research seed matches its curation source');
} else {
  mkdirSync(DATA, { recursive: true });
  for (const [name, value] of OUTPUTS) writeFileSync(join(DATA, name), serialise(value));
  const mappingCount = findings.reduce((n, f) => n + f.mappings.length, 0);
  const byKind = {};
  for (const f of findings) {
    for (const m of f.mappings) byKind[m.spatial.kind] = (byKind[m.spatial.kind] ?? 0) + 1;
  }
  const withDoi = papers.filter((p) => p.identifier.kind === 'doi').length;
  console.log(`papers      ${papers.length} (${withDoi} with a DOI, ${papers.length - withDoi} with kind none)`);
  console.log(`findings    ${findings.length}`);
  console.log(`mappings    ${mappingCount} ${JSON.stringify(byKind)}`);
  console.log(`structures  ${STRUCTURES.size} defined, ${referenced.size} referenced`);
  const unused = [...STRUCTURES.keys()].filter((id) => !referenced.has(id));
  if (unused.length > 0) console.log(`unreferenced (${unused.length}): ${unused.join(', ')}`);
}
