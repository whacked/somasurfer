/**
 * The landmarks of the first-party lobe labels, placed by us on the ICBM152
 * 2009c cerebral surface (the CSF-carved surface of tools/build-icbm-cortex.mjs).
 * Every coordinate is MNI152 2009c asymmetric, millimetres, RAS. No
 * parcellation was read to place any of them.
 *
 * How they were placed. Sulci were found on the surface itself, as SULCAL
 * BASINS: connected sets of vertices deeper than 6 mm by the depth measure of
 * tools/lib/icbm-surface-measures.mjs, rendered and identified by their course
 * (the central sulcus is the basin running from the dorsal margin at y -34 to
 * y -14 between the precentral and postcentral gyri; the parieto-occipital
 * sulcus the medial basin from the dorsal margin at y -78 down to the calcarine
 * at y -56; and so on, per boundary below). A control point is either a basin
 * extremity read off the surface, or a point chosen on a rendered view.
 * Each boundary names the lobe on each side of it by a direction (`sides`;
 * one entry per segment where it changes along the boundary).
 * Sulcal control points snap to the deepest vertex within 5 mm (the fundus);
 * `surface` points to the nearest vertex; `rim` points to the nearest vertex
 * touching the medial wall or a cut face. tools/lib/icbm-lobes.mjs traces and
 * floods them; lobes.json records each point as given and as snapped.
 *
 * Conventions, stated because textbooks differ:
 *   - Frontal / parietal on the medial surface: the central sulcus is carried
 *     over the dorsal margin and down to the cingulate sulcus by a line, which
 *     splits the paracentral lobule.
 *   - Limbic lobe: the cingulate gyrus and the isthmus, between the cingulate
 *     and subparietal sulci above and the medial wall below, closed posteriorly
 *     by the lower parieto-occipital sulcus and inferiorly by a line from the
 *     anterior end of the calcarine (its junction with the parieto-occipital
 *     sulcus) to the medial wall. The parahippocampal gyrus is NOT limbic here:
 *     it is labelled temporal. (The brief names the cingulate sulcus as the
 *     limbic landmark and no collateral sulcus.)
 *   - Insula: inside the circular sulcus, placed as the border of the insular
 *     floor (tools/lib/icbm-lobes.mjs, `insularFloor`), not by control points.
 *   - Occipital: behind the line from the parieto-occipital sulcus at the dorsal
 *     margin to the preoccipital notch (laterally), behind the parieto-occipital
 *     sulcus (medially), and behind lines from the notch and from the calcarine
 *     junction to the tentorial cut (basally). The calcarine itself is inside
 *     the occipital lobe and is not a boundary.
 *   - Lateral fissure: frontal and parietal above, temporal below, meeting at
 *     the circular sulcus; anterior to the insula along the fissure's stem to
 *     the medial wall; posterior to it along the posterior ramus to its end,
 *     then by a line to the parieto-occipital line.
 */

const P = (mni, snap, role) => ({ mni, snap, role });

const LEFT = {
  side: 'left',
  seeds: [
    { lobe: 'frontal', mni: [-42, 40, 20] },
    { lobe: 'parietal', mni: [-40, -55, 52] },
    { lobe: 'temporal', mni: [-62, -25, -10] },
    { lobe: 'occipital', mni: [-28, -98, 4] },
    { lobe: 'insula', mni: [-41, -2, -1] },
    { lobe: 'limbic', mni: [-5, 10, 35] },
    { lobe: 'medialWall', mni: [-4, -12, 5] },
  ],
  boundaries: [
    {
      key: 'centralSulcus',
      landmark: 'central sulcus',
      separates: ['frontal', 'parietal'],
      sides: { frontal: [0, 1, 0], parietal: [0, -1, 0] },
      kind: 'sulcus',
      placement: 'fundus of the depth > 6 mm basin running from the dorsal margin (its highest vertex) to its lowest vertex, then on to the deepest vertex of the separate basin in line with it below, which reaches to 2 cm above the lateral fissure',
      points: [
        P([-12, -34, 75], 'sulcus', 'dorsal end, at the dorsal margin'),
        P([-55, -27, 58], 'sulcus', 'mid course, chosen on the lateral view'),
        P([-41, -20, 38], 'sulcus', 'lowest vertex of the upper basin'),
        P([-52, -8, 27], 'sulcus', 'ventral end, deepest vertex of the lower basin'),
      ],
    },
    {
      key: 'centralToCingulate',
      landmark: 'central sulcus carried over the dorsal margin to the cingulate sulcus',
      separates: ['frontal', 'parietal'],
      sides: { frontal: [0, 1, 0], parietal: [0, -1, 0] },
      kind: 'line',
      placement: 'line from the central sulcus dorsal end, across the medial surface at the same coronal level, to the cingulate sulcus',
      points: [
        P([-12, -34, 75], 'sulcus', 'central sulcus dorsal end'),
        P([-2, -33, 63], 'surface', 'medial surface below the margin'),
        P([-14, -31, 41], 'sulcus', 'cingulate sulcus at the marginal ramus'),
      ],
    },
    {
      key: 'centralToInsula',
      landmark: 'central sulcus ventral end to the circular sulcus',
      separates: ['frontal', 'parietal'],
      sides: { frontal: [0, 1, 0], parietal: [0, -1, 0] },
      kind: 'line',
      placement: 'line from the central sulcus ventral end down the opercular face to the superior limb of the circular sulcus',
      points: [
        P([-52, -8, 27], 'sulcus', 'central sulcus ventral end'),
        P([-36, -9, 14], 'sulcus', 'circular sulcus, superior limb'),
      ],
    },
    {
      key: 'lateralFissureStem',
      landmark: 'lateral fissure, stem',
      separates: ['frontal', 'temporal'],
      sides: { frontal: [0, 1, 1], temporal: [0, -1, -1] },
      kind: 'sulcus',
      placement: 'from the limen of the insula forward through the fissure to where its stem opens on the inferior surface, along the groove between the temporal pole and the orbital surface (points chosen on the inferior view, snapped into the groove), then medially to the medial wall',
      points: [
        P([-35, 17, -11], 'sulcus', 'circular sulcus at the limen'),
        P([-44, 23, -20], 'sulcus', 'lateral end of the stem groove'),
        P([-38, 24, -23], 'sulcus', 'stem groove'),
        P([-24, 19, -26], 'sulcus', 'medial end of the stem groove'),
        P([-7, 8, -11], 'surface', 'medial end, on the anterior medial-wall line'),
      ],
    },
    {
      key: 'lateralFissureLip',
      landmark: 'lateral fissure, its opening on the lateral surface',
      separates: ['frontal', 'parietal', 'temporal'],
      sides: [
        { frontal: [0, 0, 1], temporal: [0, 0, -1] },
        { frontal: [0, 0, 1], temporal: [0, 0, -1] },
        { frontal: [0, 0, 1], temporal: [0, 0, -1] },
        { parietal: [0, 0, 1], temporal: [0, 0, -1] },
        { parietal: [0, 0, 1], temporal: [0, 0, -1] },
        { parietal: [0, 0, 1], temporal: [0, 0, -1] },
      ],
      kind: 'line',
      bandMm: 5,
      placement: 'line along the opening of the fissure on the lateral surface, from the lateral end of its stem to its posterior end, 5 mm wide: in the template the opercula and the superior temporal gyrus touch across the opening in places, and the fissure, not its fundus, is what separates the lobes there; points are the most lateral surface at the fissure on the lateral view, split where the central sulcus meets it',
      points: [
        P([-44, 23, -20], 'sulcus', 'lateral end of the stem groove'),
        P([-54, 21, -4], 'surface', 'anterior opening'),
        P([-62, 4, -1], 'surface', 'opening'),
        P([-66, -10, 5], 'surface', 'opening, below the central sulcus'),
        P([-70, -26, 12], 'surface', 'opening'),
        P([-69, -41, 19], 'surface', 'opening'),
        P([-57, -46, 29], 'sulcus', 'posterior end of the fissure'),
      ],
    },
    {
      key: 'lateralFissurePosterior',
      landmark: 'lateral fissure, posterior ramus',
      separates: ['parietal', 'temporal'],
      sides: { parietal: [0, 0, 1], temporal: [0, 0, -1] },
      kind: 'sulcus',
      placement: 'from the posterior point of the circular sulcus along the posterior ramus to its end, the most posterior vertex of the fissure basin',
      points: [
        P([-35, -28, 17], 'sulcus', 'circular sulcus, posterior'),
        P([-57, -46, 29], 'sulcus', 'posterior end of the fissure'),
      ],
    },
    {
      key: 'lateralFissureToOccipital',
      landmark: 'line from the posterior end of the lateral fissure to the parieto-occipital line',
      separates: ['parietal', 'temporal'],
      sides: { parietal: [0, 0, 1], temporal: [0, 0, -1] },
      kind: 'line',
      placement: 'line on the lateral surface',
      points: [
        P([-57, -46, 29], 'sulcus', 'posterior end of the fissure'),
        P([-56, -74, 19], 'surface', 'on the parieto-occipital line, chosen on the lateral view'),
      ],
    },
    {
      key: 'parietoOccipitalLine',
      landmark: 'parieto-occipital sulcus to preoccipital notch',
      separates: ['occipital', 'parietal', 'temporal'],
      sides: [{ parietal: [0, 1, 0], occipital: [0, -1, 0] }, { temporal: [0, 1, 0], occipital: [0, -1, 0] }],
      kind: 'line',
      placement: 'line over the lateral surface from where the parieto-occipital sulcus notches the dorsal margin to the preoccipital notch on the inferolateral margin',
      points: [
        P([-12, -78, 47], 'sulcus', 'parieto-occipital sulcus at the dorsal margin'),
        P([-56, -74, 19], 'surface', 'lateral surface, where the lateral fissure line meets it'),
        P([-58, -69, -11], 'surface', 'preoccipital notch'),
      ],
    },
    {
      key: 'parietoOccipitalSulcus',
      landmark: 'parieto-occipital sulcus',
      separates: ['occipital', 'parietal', 'limbic'],
      sides: [{ parietal: [0, 1, 0], occipital: [0, -1, 0] }, { parietal: [0, 1, 0], occipital: [0, -1, 0] }, { limbic: [0, 1, 0], occipital: [0, -1, 0] }, { limbic: [0, 1, 0], occipital: [0, -1, 0] }],
      kind: 'sulcus',
      placement: 'fundus of the two medial basins (depth > 6 mm) that run from the dorsal margin to the calcarine junction',
      points: [
        P([-12, -78, 47], 'sulcus', 'at the dorsal margin'),
        P([-16, -78, 39], 'sulcus', 'upper basin'),
        P([-18, -68, 28], 'sulcus', 'where the subparietal sulcus line meets it'),
        P([-20, -61, 20], 'sulcus', 'deepest vertex'),
        P([-16, -56, 4], 'sulcus', 'junction with the calcarine sulcus'),
      ],
    },
    {
      key: 'cingulateSulcus',
      landmark: 'cingulate sulcus',
      separates: ['limbic', 'frontal', 'parietal'],
      sides: [{ frontal: [0, 0, 1], limbic: [0, 0, -1] }, { frontal: [0, 0, 1], limbic: [0, 0, -1] }, { frontal: [0, 1, 1], limbic: [0, -1, -1] }, { frontal: [0, 1, 0], limbic: [0, -1, 0] }, { frontal: [0, 0, -1], limbic: [0, 0, 1] }],
      kind: 'sulcus',
      placement: 'fundus from the marginal ramus forward over the corpus callosum and round the genu to the subcallosal area, then to the medial wall',
      points: [
        P([-14, -31, 41], 'sulcus', 'at the marginal ramus'),
        P([-6, -2, 44], 'sulcus', 'above the body of the corpus callosum'),
        P([-3, 24, 42], 'sulcus', 'anterior'),
        P([-5, 46, 15], 'sulcus', 'round the genu'),
        P([-3, 39, -5], 'sulcus', 'subgenual'),
        P([-3, 20, -6], 'surface', 'subcallosal end, on the anterior medial-wall line'),
      ],
    },
    {
      key: 'subparietalSulcus',
      landmark: 'subparietal sulcus',
      separates: ['limbic', 'parietal'],
      sides: { parietal: [0, 0, 1], limbic: [0, 0, -1] },
      kind: 'sulcus',
      placement: 'posterior continuation of the cingulate sulcus below the marginal ramus, through the subparietal basin, to the parieto-occipital sulcus',
      points: [
        P([-14, -31, 41], 'sulcus', 'cingulate sulcus at the marginal ramus'),
        P([-11, -53, 41], 'sulcus', 'subparietal basin'),
        P([-18, -68, 28], 'sulcus', 'parieto-occipital sulcus'),
      ],
    },
    {
      key: 'isthmusLine',
      landmark: 'anterior end of the calcarine sulcus to the medial wall',
      separates: ['limbic', 'temporal'],
      sides: { limbic: [0, 0, 1], temporal: [0, 0, -1] },
      kind: 'line',
      placement: 'line from the calcarine junction to the medial wall behind the splenium, closing the isthmus off from the parahippocampal gyrus',
      points: [
        P([-16, -56, 4], 'sulcus', 'calcarine junction'),
        P([-1, -38, 6], 'rim', 'under the splenium, where the posterior medial-wall line starts'),
      ],
    },
    {
      key: 'occipitotemporalMedial',
      landmark: 'anterior end of the calcarine sulcus to the tentorial cut',
      separates: ['occipital', 'temporal'],
      sides: { temporal: [0, 1, 0], occipital: [0, -1, 0] },
      kind: 'line',
      placement: 'line down the medial surface from the calcarine junction to the cut',
      points: [
        P([-16, -56, 4], 'sulcus', 'calcarine junction'),
        P([-20, -58, -8], 'rim', 'tentorial cut'),
      ],
    },
    {
      key: 'occipitotemporalBasal',
      landmark: 'preoccipital notch to the tentorial cut',
      separates: ['occipital', 'temporal'],
      sides: { temporal: [0, 1, 0], occipital: [0, -1, 0] },
      kind: 'line',
      placement: 'line across the inferior surface from the notch to the cut',
      points: [
        P([-58, -69, -11], 'surface', 'preoccipital notch'),
        P([-50, -64, -22], 'rim', 'tentorial cut'),
      ],
    },
    {
      key: 'medialWallPosterior',
      landmark: 'medial wall, behind the thalamus: from the splenium to the tentorial cut',
      separates: ['medialWall', 'temporal'],
      sides: { medialWall: [0, 1, 0], temporal: [0, -1, 0] },
      kind: 'line',
      placement: 'line from the underside of the splenium down to the tentorial cut, behind the pulvinar; points chosen on the medial view',
      points: [
        P([-1, -38, 6], 'rim', 'under the splenium'),
        P([-13, -36, -5], 'rim', 'tentorial cut'),
      ],
    },
    {
      key: 'medialWallLateral',
      landmark: 'medial wall, beside the brainstem cut: the choroid-fissure side of the diencephalon',
      separates: ['medialWall', 'temporal'],
      sides: { medialWall: [1, 0, 1], temporal: [-1, 0, -1] },
      kind: 'line',
      placement: 'line along the lateral side of the brainstem cut, between the diencephalon and the medial surface of the temporal lobe, from the lower end of the posterior line to the start of the anterior one; points chosen on the inferior view',
      points: [
        P([-13, -36, -5], 'rim', 'tentorial cut, lower end of the posterior line'),
        P([-17, -25, -10], 'surface', 'beside the brainstem cut'),
        P([-17, -12, -12], 'surface', 'beside the brainstem cut'),
        P([-10, -5, -14], 'rim', 'front of the brainstem cut'),
      ],
    },
    {
      key: 'medialWallAnterior',
      landmark: 'medial wall, in front of the diencephalon: from the brainstem cut through the anterior perforated substance to the rostrum of the corpus callosum',
      separates: ['medialWall', 'temporal', 'frontal', 'limbic'],
      sides: [
        { medialWall: [0, 0, 1], temporal: [0, 0, -1] },
        { medialWall: [0, 0, 1], frontal: [0, 0, -1] },
        { medialWall: [0, -1, 0], limbic: [0, 1, 0] },
      ],
      kind: 'line',
      placement: 'line from the front of the brainstem cut, under the hypothalamus and through the anterior perforated substance, up the lamina terminalis to the rostrum; points chosen on the medial view',
      points: [
        P([-10, -5, -14], 'rim', 'front of the brainstem cut'),
        P([-7, 8, -11], 'surface', 'anterior perforated substance, where the fissure stem ends'),
        P([-3, 20, -6], 'surface', 'where the cingulate sulcus ends'),
        P([-1, 26, -3], 'rim', 'rostrum of the corpus callosum'),
      ],
    },
  ],
};

/**
 * The right hemisphere starts from the left placement mirrored (x -> -x), and
 * every point is snapped on the right surface itself, so a sulcal point lands
 * on the right hemisphere's own fundus within 5 mm. Where the asymmetric
 * template put a right landmark further than that, or the result was checked
 * and found wrong, the point is replaced in RIGHT_ADJUSTED, keyed by boundary
 * and point index, and lobes.json says which points were adjusted.
 */
const SYLVIAN_END_RIGHT = { mni: [55, -33, 29], why: 'the right fissure is shorter; its posterior end is the most posterior vertex of the right fissure basin' };
const RIGHT_ADJUSTED = {
  'lateralFissureLip:5': { mni: [66, -31, 20], why: 'the right fissure ends at y -33, so the last opening point moves forward' },
  'lateralFissureLip:6': SYLVIAN_END_RIGHT,
  'lateralFissurePosterior:1': SYLVIAN_END_RIGHT,
  'lateralFissureToOccipital:0': SYLVIAN_END_RIGHT,
};
const mirror = (p) => [-p[0], p[1], p[2]];
/** Boundaries only the right needs. */
const RIGHT_EXTRA = [
  {
    key: 'parietoOccipitalMedialSurface',
    landmark: 'parieto-occipital sulcus, its course on the medial surface',
    separates: ['occipital', 'parietal', 'limbic'],
    sides: [
      { parietal: [0, 1, 0], occipital: [0, -1, 0] },
      { parietal: [0, 1, 0], occipital: [0, -1, 0] },
      { limbic: [0, 1, 0], occipital: [0, -1, 0] },
      { limbic: [0, 1, 0], occipital: [0, -1, 0] },
    ],
    kind: 'line',
    bandMm: 5,
    placement: 'on the right the parieto-occipital sulcus does not open onto the medial surface of the template: the surface passes over it, 15 to 20 mm from its fundus, and the fundus trace alone leaves that surface open. Its course there is a line on the medial surface over the fundus control points, each found as the most medial surface vertex at the fundus point\'s (y, z)',
    points: [
      P([2, -74, 51], 'surface', 'medial surface over the sulcus at the dorsal margin'),
      P([3, -76, 35], 'surface', 'over the upper basin'),
      P([0, -65, 25], 'surface', 'over the deepest vertex'),
      P([1, -59, 15], 'surface', 'over the lower course'),
      P([3, -59, 6], 'surface', 'over the calcarine junction'),
    ],
  },
];
/** Whole boundaries placed afresh on the right, where the mirrored course was wrong. */
const RIGHT_REPLACED = {
  subparietalSulcus: {
    why: 'mirrored, the path climbed onto the right parieto-occipital sulcus and ran down beside it; a point between the two keeps it on the subparietal course',
    points: [
      P([14, -31, 41], 'sulcus', 'cingulate sulcus at the marginal ramus'),
      P([11, -53, 41], 'sulcus', 'subparietal basin'),
      P([13, -60, 33], 'surface', 'between the subparietal and parieto-occipital sulci'),
      P([18, -68, 28], 'sulcus', 'parieto-occipital sulcus'),
    ],
    kind: 'line',
  },
};
const RIGHT = {
  side: 'right',
  seeds: LEFT.seeds.map((s) => ({ ...s, mni: RIGHT_ADJUSTED[`seed:${s.lobe}`] ?? mirror(s.mni) })),
  boundaries: LEFT.boundaries.map((b) => (RIGHT_REPLACED[b.key] ? {
    ...b,
    kind: RIGHT_REPLACED[b.key].kind ?? b.kind,
    sides: mirrorSides(b.sides),
    placement: `${b.placement}. On the right: ${RIGHT_REPLACED[b.key].why}`,
    points: RIGHT_REPLACED[b.key].points,
  } : {
    ...b,
    sides: Array.isArray(b.sides) ? b.sides.map((sd) => mirrorSides(sd)) : mirrorSides(b.sides),
    points: b.points.map((pt, k) => {
      const adjusted = RIGHT_ADJUSTED[`${b.key}:${k}`];
      return adjusted ? { ...pt, mni: adjusted.mni, role: `${pt.role} (adjusted on the right: ${adjusted.why})` } : { ...pt, mni: mirror(pt.mni), role: `${pt.role} (mirrored from the left placement)` };
    }),
  })).concat(RIGHT_EXTRA),
};
function mirrorSides(sides) {
  return Object.fromEntries(Object.entries(sides).map(([lobe, d]) => [lobe, mirror(d)]));
}

export const LANDMARKS = Object.freeze({ left: LEFT, right: RIGHT });
