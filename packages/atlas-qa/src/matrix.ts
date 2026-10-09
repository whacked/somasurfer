/**
 * The deep-link matrix: enumerated, not sampled.
 *
 * Plan §7 puts two rows on QA that need a viewer — "viewer journeys" and "deep
 * links" — and the deep-link half is the one that rots if it is written late.
 * The reason is specific. Every case below is a *failure* or *degradation*
 * case, and the natural way to write those against a finished build is to try
 * things until something breaks, which produces a suite shaped like the bugs
 * that happened to be present on the day. Authored from the spec first, the
 * suite is shaped like the requirement, and the build has to come to it.
 *
 * ## Enumerated
 *
 * `REQUIRED_CLASSES` is the enumeration, and `matrixIntegrityProblems()` fails
 * if any class has no row, or no must-pass row where the class is itself
 * must-pass. That is the mechanism against the specific thing this task was
 * created to prevent: a must-pass case quietly going missing. Deleting the
 * `C08` row does not reduce the matrix, it breaks the gate.
 *
 * ## Every row names its observable behaviour
 *
 * `expect.observable` is prose for a human; the rest of `expect` is the same
 * claim in machine-checkable form. Both are required. The prose is what makes a
 * failure report readable; the fields are what make it a test. Where they could
 * disagree, the fields win, and `matrixIntegrityProblems()` checks the prose is
 * actually present and actually a sentence rather than the word "works".
 *
 * `expect.unchanged` is the half that is easiest to leave out and hardest to
 * add later: a rejected address must change *nothing else*, and a suite that
 * only checks the error appeared will pass a build that also silently moved the
 * camera, dropped the selection and cleared the paper list.
 *
 * ## Derived from measurement, not from memory
 *
 * Every pinned address, flag and message below was measured against
 * `@gstack/alc` on `anat-adult-p50` / `anat-hyperkyphotic-short-wide` /
 * `syn-brain-adult` before it was written down, and `oracle` records what was
 * measured. `test/oracle.test.ts` re-derives all of it from the library on
 * every run, so if the library's answer changes, the matrix is reported as
 * stale instead of silently asserting history. That is the difference between
 * a pinned expectation and a stale one.
 */

import type { Capability, Facet, MessageCode, Vec3 } from './contract.ts';

/**
 * Which template the row is resolved against.
 *
 * `fold-fixture` is the DOG-9 finding-1 counterexample — a template the
 * per-level audit clears and which folds anyway. A pipeline must never produce
 * it, which is exactly why the viewer has to be shown behaving correctly when
 * handed one: `folded` is a runtime fact about an address in a template, and a
 * build with no folding template available has never displayed the message.
 */
export type TemplateChoice = 'body' | 'fold-fixture' | 'brain' | 'no-brain';

/**
 * QA seams the build must honour, as URL parameters.
 *
 * Declared here rather than discovered, because the alternative is QA reaching
 * into the build's internals, which makes the suite a second implementation of
 * the viewer. These are the only three, they are inert in production builds
 * (unknown parameters are ignored — see the `url-unknown-params` row), and each
 * one exists because a required behaviour is otherwise unreachable from
 * outside:
 *
 *   qa_template=fold-fixture   `folded` needs a folding template
 *   qa_template=no-brain       `no_template` needs a missing template
 *   qa_assets=fail             asset-load failure needs a failing load
 */
export const QA_URL_PARAMS = {
  template: 'qa_template',
  assets: 'qa_assets',
} as const;

/** The enumeration. A class with no row is a hole, and the gate says so. */
export const REQUIRED_CLASSES = [
  'default-view',
  'canonical',
  'loose',
  'check-symbol',
  'over-precise',
  'clamped-cranial',
  'clamped-caudal',
  'folded',
  'variant',
  'absent',
  'malformed',
  'c08-correction',
  'frame-disabled',
  'no-template',
  'length-cap',
  'assets-unavailable',
  'equality-guard',
  'cross-atlas-restore',
  'url-hygiene',
] as const;

export type CaseClass = (typeof REQUIRED_CLASSES)[number];

/**
 * Classes that must carry at least one must-pass row.
 *
 * Everything the plan states as a requirement rather than a nicety. The two
 * omissions are deliberate and are the only two: `url-hygiene` is robustness
 * rather than a stated requirement, and nothing in the plan says an unknown
 * query parameter must be ignored rather than rejected.
 */
export const MUST_PASS_CLASSES: readonly CaseClass[] = REQUIRED_CLASSES.filter(
  (c) => c !== 'url-hygiene',
);

/** What the camera is required to do. `unchanged` is a requirement, not an absence of one. */
export type CameraExpectation =
  /** Flies to the resolved cell's centre. */
  | 'flies-to-cell'
  /** Must not move. Every rejection row, and every row whose address has no millimetres. */
  | 'unchanged';

/** How the row's view is reached. */
export type MatrixInput =
  | { kind: 'url'; url: string }
  /**
   * A click at a point in template millimetres — plan §4's raycast result.
   * The clamped rows need this: `clamped` is raised when millimetres are turned
   * into an address, so it is not reachable by pasting an address at all.
   */
  | { kind: 'click-point'; pointMm: Vec3; digits: number; template: TemplateChoice };

/** What the library said when this row was authored. Re-derived by the oracle test. */
export type OracleClaim =
  | {
      kind: 'locate';
      address: string;
      template: TemplateChoice;
      flags: { homology?: string; overPrecise?: boolean; folded?: boolean; clamped?: boolean };
      pointIsNaN?: boolean;
    }
  | { kind: 'reject'; input: string; code: string; messageContains?: readonly string[] }
  | { kind: 'encode'; template: TemplateChoice; pointMm: Vec3; digits: number; address: string; clamped: boolean }
  | { kind: 'canonicalises'; input: string; canonical: string };

export interface MatrixRow {
  readonly id: string;
  readonly classes: readonly CaseClass[];
  /**
   * A must-pass row is one the plan states as a requirement. The harness fails
   * if one of these is skipped or cannot be evaluated — see `runner.ts`. Making
   * this a field rather than a convention is what lets the integrity gate check
   * that the requirement classes still have must-pass coverage.
   */
  readonly mustPass: boolean;
  readonly input: MatrixInput;
  readonly requires: readonly Capability[];
  readonly expect: {
    /** One sentence, in observable terms. Gated for presence and for not being "works". */
    readonly observable: string;
    /** Which message appears. */
    readonly messages: readonly MessageCode[];
    /** Which message must NOT appear. This is where fold-vs-clamp is enforced. */
    readonly forbiddenMessages?: readonly MessageCode[];
    readonly camera: CameraExpectation;
    /** What does not change. */
    readonly unchanged: readonly Facet[];
    /** Canonical address the URL must hold afterwards, or null for "no address". */
    readonly urlAddress?: string | null;
    /** The cell must be drawn at its true extent, never as a point. */
    readonly cellKind?: 'extent' | null;
    /** Digits the cell is DISPLAYED at, where that differs from the address's. */
    readonly displayedDigits?: number;
    readonly atlas?: 'body' | 'brain';
    /** Substrings the message must contain, where the wording is itself the requirement. */
    readonly textMustContain?: readonly string[];
    /** Selection must be cleared / preserved / set to this address. */
    readonly selectionAddress?: string | null;
    readonly assetsAvailable?: boolean;
    /** Names must still resolve even though geometry failed (plan §6, last row). */
    readonly namesResolve?: boolean;
  };
  readonly oracle?: readonly OracleClaim[];
  /** Why this row exists, where that is not obvious. Shown in the report on failure. */
  readonly why?: string;
}

const BODY_URL = (address: string, extra = ''): string => `/?a=${encodeURIComponent(address)}${extra}`;

/** `BD-T07-03O-` is 11 characters, so 53 digits is exactly the 64-character cap. */
const AT_CAP = `BD-T07-03O-${'5'.repeat(53)}`;
const OVER_CAP = `BD-T07-03O-${'5'.repeat(54)}`;

/** Rejections share a shape: nothing moves, nothing is selected, nothing is lost. */
const REJECTION_UNCHANGED: readonly Facet[] = [
  'atlas', 'camera', 'layers', 'selection', 'cell', 'names', 'filter', 'selectedPapers', 'highlights',
];

export const DEEP_LINK_MATRIX: readonly MatrixRow[] = [
  // -------------------------------------------------------------------------
  // The baseline. Without this row every "unchanged" assertion below is
  // anchored to nothing.
  // -------------------------------------------------------------------------
  {
    id: 'default-no-address',
    classes: ['default-view'],
    mustPass: true,
    input: { kind: 'url', url: '/' },
    requires: ['body-atlas', 'deep-link'],
    expect: {
      observable:
        'With no address in the URL the body atlas opens at its default camera and default layers, '
        + 'nothing is selected, and no message of any kind is shown.',
      messages: [],
      forbiddenMessages: ['rejected_grammar', 'rejected_level', 'no_template', 'assets_unavailable'],
      camera: 'unchanged',
      unchanged: [],
      urlAddress: null,
      atlas: 'body',
      selectionAddress: null,
      assetsAvailable: true,
    },
    why: 'The default view is the reference every other row diffs against.',
  },

  // -------------------------------------------------------------------------
  // Canonical and loose forms. The requirement is not "both parse" — the
  // library's own suite covers that — it is that both restore the SAME view.
  // -------------------------------------------------------------------------
  {
    id: 'canonical-body',
    classes: ['canonical'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BD-T07-03O-531') },
    requires: ['body-atlas', 'deep-link', 'ranked-names'],
    expect: {
      observable:
        'The camera flies to the centre of the T07 two-o\'clock outer cell, the cell is outlined at its '
        + 'true extent of roughly 3.4 x 9.5 x 9.4 mm, a ranked name list with containment fractions and '
        + 'the name-index version is shown, and the URL keeps the canonical address.',
      messages: ['name_index_version'],
      forbiddenMessages: ['over_precise', 'clamped_cranial', 'clamped_caudal', 'folded', 'homology_variant', 'homology_absent'],
      camera: 'flies-to-cell',
      unchanged: ['atlas'],
      urlAddress: 'BD-T07-03O-531',
      cellKind: 'extent',
      displayedDigits: 3,
      atlas: 'body',
      selectionAddress: 'BD-T07-03O-531',
    },
    oracle: [{ kind: 'locate', address: 'BD-T07-03O-531', template: 'body', flags: { homology: 'exact' } }],
  },
  {
    id: 'loose-body-same-view',
    classes: ['loose', 'canonical'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('bd-t7-3o-531') },
    requires: ['body-atlas', 'deep-link'],
    expect: {
      observable:
        'The loose form restores a view identical to the canonical row\'s in every facet, and the URL is '
        + 'rewritten to the canonical address. Accepting the loose form but landing somewhere else would '
        + 'be worse than rejecting it.',
      messages: ['name_index_version'],
      camera: 'flies-to-cell',
      unchanged: ['atlas'],
      urlAddress: 'BD-T07-03O-531',
      cellKind: 'extent',
      atlas: 'body',
      selectionAddress: 'BD-T07-03O-531',
    },
    oracle: [{ kind: 'canonicalises', input: 'bd-t7-3o-531', canonical: 'BD-T07-03O-531' }],
    why: 'Transcription from print or speech produces the loose form; it is the common case, not the edge one.',
  },
  {
    id: 'check-symbol-accepted',
    classes: ['check-symbol', 'canonical'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BD-T07-03O-531~S') },
    requires: ['body-atlas', 'deep-link'],
    expect: {
      observable:
        'An address carrying its correct check symbol restores the same view as the bare address, and the '
        + 'URL holds the canonical body without the symbol.',
      messages: ['name_index_version'],
      camera: 'flies-to-cell',
      unchanged: ['atlas'],
      urlAddress: 'BD-T07-03O-531',
      cellKind: 'extent',
      atlas: 'body',
    },
    oracle: [{ kind: 'canonicalises', input: 'BD-T07-03O-531~S', canonical: 'BD-T07-03O-531' }],
  },
  {
    id: 'check-symbol-mismatch-rejected',
    classes: ['check-symbol', 'malformed'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BD-T07-03O-531~T') },
    requires: ['deep-link'],
    expect: {
      observable:
        'A damaged check symbol is refused with a message naming the symbol the address implies, the '
        + 'camera does not move, and nothing is selected. The address is NOT resolved on the grounds that '
        + 'the body parses.',
      messages: ['rejected_check'],
      forbiddenMessages: ['name_index_version'],
      camera: 'unchanged',
      unchanged: REJECTION_UNCHANGED,
      urlAddress: null,
      cellKind: null,
      selectionAddress: null,
    },
    oracle: [{ kind: 'reject', input: 'BD-T07-03O-531~T', code: 'check_failed', messageContains: ['implies'] }],
    why: 'The check symbol exists to catch transcription damage; resolving anyway would waste it.',
  },

  // -------------------------------------------------------------------------
  // Over-precision. The honesty requirement, and the one most likely to be
  // implemented as "resolve it and say nothing".
  // -------------------------------------------------------------------------
  {
    id: 'over-precise',
    classes: ['over-precise'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BD-T07-03O-531246') },
    requires: ['body-atlas', 'deep-link'],
    expect: {
      observable:
        'A six-digit address against a template that justifies five resolves and flies to the cell, but '
        + 'the outline is drawn at the FIVE-digit extent and a notice names both counts. The address in '
        + 'the URL is left exactly as given — it is not silently truncated, because the user\'s address is '
        + 'not wrong, only finer than this template can answer.',
      messages: ['over_precise', 'name_index_version'],
      forbiddenMessages: ['folded', 'clamped_cranial', 'clamped_caudal'],
      camera: 'flies-to-cell',
      unchanged: ['atlas'],
      urlAddress: 'BD-T07-03O-531246',
      cellKind: 'extent',
      displayedDigits: 5,
      atlas: 'body',
      textMustContain: ['6', '5'],
    },
    oracle: [
      { kind: 'locate', address: 'BD-T07-03O-531246', template: 'body', flags: { overPrecise: true, homology: 'exact' } },
      { kind: 'locate', address: 'BD-T07-03O-53124', template: 'body', flags: { overPrecise: false, homology: 'exact' } },
    ],
    why: 'Plan §4: rendering the cell at its true extent rather than as a point is the whole honesty argument.',
  },

  // -------------------------------------------------------------------------
  // Clamping, at each end of the column. Reached by a click rather than a
  // paste, because `clamped` is raised turning millimetres INTO an address.
  // -------------------------------------------------------------------------
  {
    id: 'clamped-cranial',
    classes: ['clamped-cranial'],
    mustPass: true,
    input: { kind: 'click-point', pointMm: [0, 0, 400], digits: 3, template: 'body' },
    requires: ['body-atlas', 'click-select'],
    expect: {
      observable:
        'A point 400 mm above the top of the column is addressed at C01 with a notice naming the CRANIAL '
        + 'end specifically. It is never silently projected, and the message is not the caudal one.',
      messages: ['clamped_cranial', 'name_index_version'],
      forbiddenMessages: ['clamped_caudal', 'folded'],
      camera: 'flies-to-cell',
      unchanged: ['atlas', 'layers'],
      urlAddress: 'BD-C01-12O-300',
      cellKind: 'extent',
      atlas: 'body',
      textMustContain: ['above'],
    },
    oracle: [{ kind: 'encode', template: 'body', pointMm: [0, 0, 400], digits: 3, address: 'BD-C01-12O-300', clamped: true }],
    why: 'Plan §6 requires the clamp to name which end. One message for both ends is the defect.',
  },
  {
    id: 'clamped-caudal',
    classes: ['clamped-caudal'],
    mustPass: true,
    input: { kind: 'click-point', pointMm: [0, 0, -1107.4], digits: 3, template: 'body' },
    requires: ['body-atlas', 'click-select'],
    expect: {
      observable:
        'A point 400 mm below the bottom of the column is addressed at S01 with a notice naming the CAUDAL '
        + 'end specifically, and not the cranial one.',
      messages: ['clamped_caudal', 'name_index_version'],
      forbiddenMessages: ['clamped_cranial', 'folded'],
      camera: 'flies-to-cell',
      unchanged: ['atlas', 'layers'],
      urlAddress: 'BD-S01-12O-645',
      cellKind: 'extent',
      atlas: 'body',
      textMustContain: ['below'],
    },
    oracle: [{ kind: 'encode', template: 'body', pointMm: [0, 0, -1107.4], digits: 3, address: 'BD-S01-12O-645', clamped: true }],
  },
  {
    id: 'clamped-address-replayed-is-not-a-clamp',
    classes: ['clamped-cranial', 'canonical'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BD-C01-12O-300') },
    requires: ['body-atlas', 'deep-link'],
    expect: {
      observable:
        'Deep-linking the address that a clamp PRODUCED restores that cell and does NOT claim a clamp '
        + 'happened: the clamp was a fact about the original point, not about the address. Showing the '
        + 'clamp notice here would tell a user their perfectly good address is out of bounds.',
      messages: ['name_index_version'],
      forbiddenMessages: ['clamped_cranial', 'clamped_caudal'],
      camera: 'flies-to-cell',
      unchanged: ['atlas'],
      urlAddress: 'BD-C01-12O-300',
      cellKind: 'extent',
      atlas: 'body',
    },
    oracle: [{ kind: 'locate', address: 'BD-C01-12O-300', template: 'body', flags: { homology: 'exact', clamped: false } }],
    why:
      'This row pins a decision rather than reporting one: the plan does not say whether a replayed '
      + 'clamped address re-announces the clamp. QA\'s reading is that it must not, because the address '
      + 'denotes the cell and nothing about it is out of range. Challenge it here, before the build exists.',
  },

  // -------------------------------------------------------------------------
  // Folding. The same address, two templates, two behaviours.
  // -------------------------------------------------------------------------
  {
    id: 'folded-reports-fold-not-clamp',
    classes: ['folded'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BD-T06-12O-311', `&${QA_URL_PARAMS.template}=fold-fixture`) },
    requires: ['body-atlas', 'deep-link', 'qa-template-override'],
    expect: {
      observable:
        'Against the folding fixture the anterior T06 cell reports a FOLD, naming every competing level '
        + '(C07 and T06), and says the address is ambiguous. It must not be reported as the point having '
        + 'left the body: this point is well inside it, and the coordinate system is what failed.',
      messages: ['folded'],
      forbiddenMessages: ['clamped_cranial', 'clamped_caudal'],
      camera: 'flies-to-cell',
      unchanged: ['atlas'],
      urlAddress: 'BD-T06-12O-311',
      cellKind: 'extent',
      atlas: 'body',
      textMustContain: ['C07', 'T06'],
    },
    oracle: [{ kind: 'locate', address: 'BD-T06-12O-311', template: 'fold-fixture', flags: { folded: true } }],
    why:
      'Before DOG-9 a fold surfaced as "outside the modelled body surface" for a point 200 mm inside it. '
      + 'The library distinguishes them now; this row is what stops the UI re-merging them.',
  },
  {
    id: 'same-address-unfolded-in-a-sound-template',
    classes: ['folded'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BD-T06-12O-311') },
    requires: ['body-atlas', 'deep-link'],
    expect: {
      observable:
        'The identical address against the sound body template resolves with no fold notice at all. The '
        + 'fold is a property of the template, not of the address, and a build that warns on the address '
        + 'has learned the wrong lesson.',
      messages: ['name_index_version'],
      forbiddenMessages: ['folded', 'clamped_cranial', 'clamped_caudal'],
      camera: 'flies-to-cell',
      unchanged: ['atlas'],
      urlAddress: 'BD-T06-12O-311',
      cellKind: 'extent',
      atlas: 'body',
    },
    oracle: [{ kind: 'locate', address: 'BD-T06-12O-311', template: 'body', flags: { folded: false, homology: 'exact' } }],
    why: 'The negative half of the fold pair. Without it, "always warn" passes the row above.',
  },

  // -------------------------------------------------------------------------
  // homology: 'variant' — all three declared anomalies, each its own row.
  // Enumerated, because "we tested T13" is how L06 and S06 go missing.
  // -------------------------------------------------------------------------
  ...(['T13', 'L06', 'S06'] as const).map((level): MatrixRow => ({
    id: `variant-${level}`,
    classes: ['variant'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL(`BD-${level}-03O`) },
    requires: ['body-atlas', 'deep-link'],
    expect: {
      observable:
        `${level} is a recognised vertebral count anomaly. The address is accepted, a notice says this is `
        + 'real anatomy the template does not realise and that an explicit level mapping is required, and '
        + 'the camera DOES NOT MOVE — there are no millimetres to fly to, and inventing some would be the '
        + 'guess the whole flag exists to refuse. It must not be reported as an absent level.',
      messages: ['homology_variant'],
      forbiddenMessages: ['homology_absent', 'rejected_level', 'folded'],
      camera: 'unchanged',
      unchanged: ['camera', 'layers', 'atlas'],
      urlAddress: `BD-${level}-03O`,
      cellKind: null,
      atlas: 'body',
      textMustContain: ['mapping'],
    },
    oracle: [
      {
        kind: 'locate',
        address: `BD-${level}-03O`,
        template: 'body',
        flags: { homology: 'variant' },
        pointIsNaN: true,
      },
    ],
    why:
      'A patient needing a level mapping and a typo used to produce the same flag and the same sentence. '
      + 'Three outcomes need three answers; this row holds the UI to the one the library now gives.',
  })),

  // -------------------------------------------------------------------------
  // homology: 'absent' — the reserved sacral range, every one of S02..S05.
  // -------------------------------------------------------------------------
  ...(['S02', 'S03', 'S04', 'S05'] as const).map((level): MatrixRow => ({
    id: `absent-${level}`,
    classes: ['absent'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL(`BD-${level}-03O`) },
    requires: ['body-atlas', 'deep-link'],
    expect: {
      observable:
        `${level} is reserved in the grammar and realised by no template: the address is accepted, the `
        + 'notice says this level is not in the current template, and the camera does not move. The '
        + 'message is distinct from the variant one, because reserved space is not anatomy.',
      messages: ['homology_absent'],
      forbiddenMessages: ['homology_variant', 'rejected_level', 'folded'],
      camera: 'unchanged',
      unchanged: ['camera', 'layers', 'atlas'],
      urlAddress: `BD-${level}-03O`,
      cellKind: null,
      atlas: 'body',
    },
    oracle: [
      {
        kind: 'locate',
        address: `BD-${level}-03O`,
        template: 'body',
        flags: { homology: 'absent' },
        pointIsNaN: true,
      },
    ],
  })),
  {
    id: 'sacrum-S01-is-not-absent',
    classes: ['absent'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BD-S01-03O') },
    requires: ['body-atlas', 'deep-link'],
    expect: {
      observable:
        'S01 is the one addressable sacral level and resolves normally. The four rows above must not have '
        + 'been implemented as "anything sacral is absent".',
      messages: ['name_index_version'],
      forbiddenMessages: ['homology_absent', 'homology_variant'],
      camera: 'flies-to-cell',
      unchanged: ['atlas'],
      urlAddress: 'BD-S01-03O',
      cellKind: 'extent',
      atlas: 'body',
    },
    oracle: [{ kind: 'locate', address: 'BD-S01-03O', template: 'body', flags: { homology: 'exact' } }],
  },

  // -------------------------------------------------------------------------
  // Rejections. Each must happen before any geometry, and change nothing else.
  // -------------------------------------------------------------------------
  {
    id: 'malformed-bad-digit',
    classes: ['malformed'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BD-T07-02O-9') },
    requires: ['deep-link'],
    expect: {
      observable:
        'A digit outside the octal alphabet is refused inline, naming the alphabet and the offending '
        + 'character, before any geometry runs. Nothing else on the page changes.',
      messages: ['rejected_grammar'],
      forbiddenMessages: ['name_index_version', 'homology_absent'],
      camera: 'unchanged',
      unchanged: REJECTION_UNCHANGED,
      urlAddress: null,
      cellKind: null,
      selectionAddress: null,
      textMustContain: ['01234567'],
    },
    oracle: [{ kind: 'reject', input: 'BD-T07-02O-9', code: 'bad_digit', messageContains: ['01234567'] }],
    why:
      'This exact string once parsed cleanly and failed later inside a frame-specific decoder. It is the '
      + 'regression case for validating the alphabet in parse(), kept at the UI level too.',
  },
  {
    id: 'malformed-unknown-frame',
    classes: ['malformed'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('XX-T07-03O') },
    requires: ['deep-link'],
    expect: {
      observable:
        'An unknown frame id is refused with the known frames named, and the default body view is left '
        + 'exactly as it was.',
      messages: ['rejected_grammar'],
      camera: 'unchanged',
      unchanged: REJECTION_UNCHANGED,
      urlAddress: null,
      cellKind: null,
      textMustContain: ['BD', 'BV', 'BR'],
    },
    oracle: [{ kind: 'reject', input: 'XX-T07-03O', code: 'unknown_frame', messageContains: ['known frames'] }],
  },
  {
    id: 'malformed-empty-address',
    classes: ['malformed', 'url-hygiene'],
    mustPass: false,
    input: { kind: 'url', url: '/?a=' },
    requires: ['deep-link'],
    expect: {
      observable:
        'An empty `a` parameter is treated as no address rather than as a malformed one: the default view '
        + 'opens with no error. A link truncated by a mail client should not look like a broken address.',
      messages: [],
      camera: 'unchanged',
      unchanged: [],
      urlAddress: null,
      cellKind: null,
      atlas: 'body',
    },
  },
  {
    id: 'c08-rejected-with-the-correction-named',
    classes: ['c08-correction', 'malformed'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BD-C08-03O') },
    requires: ['deep-link'],
    expect: {
      observable:
        'C08 is refused, and the message NAMES THE CORRECTION: there is no eighth cervical vertebra, the '
        + 'C8 nerve root is what exists, it exits below C07, and the user probably wants C07 or T01. A '
        + 'bare "not an addressable level" is a failure of this row even though the address is rejected.',
      messages: ['rejected_level'],
      forbiddenMessages: ['homology_variant', 'homology_absent'],
      camera: 'unchanged',
      unchanged: REJECTION_UNCHANGED,
      urlAddress: null,
      cellKind: null,
      textMustContain: ['nerve root', 'C07', 'T01'],
    },
    oracle: [
      {
        kind: 'reject',
        input: 'BD-C08-03O',
        code: 'bad_level',
        messageContains: ['no eighth cervical vertebra', 'nerve root', 'C07 or T01'],
      },
    ],
    why:
      'The only row in the matrix where the prose IS the behaviour. A typo must never look like an '
      + 'anomaly, and the way a user learns that is the sentence.',
  },
  {
    id: 'length-at-the-64-character-cap',
    classes: ['length-cap'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL(AT_CAP) },
    requires: ['deep-link'],
    expect: {
      observable:
        'A 64-character input is INSIDE the cap, so it is not refused for length — it is refused for '
        + 'carrying 53 refinement digits where BD allows 12, and the message says so. The cap is '
        + 'inclusive, and the digit cap is the bound that actually bites.',
      messages: ['rejected_grammar'],
      forbiddenMessages: ['rejected_too_long'],
      camera: 'unchanged',
      unchanged: REJECTION_UNCHANGED,
      urlAddress: null,
      cellKind: null,
      textMustContain: ['12'],
    },
    oracle: [{ kind: 'reject', input: AT_CAP, code: 'bad_precision', messageContains: ['12'] }],
    why:
      'No legal ALC-1 address can reach 64 characters — BD\'s longest is 23 with its check symbol. So the '
      + 'cap row is necessarily a rejection row, and which rejection it is matters: `too_long` here would '
      + 'mean the cap had become exclusive. `test/oracle.test.ts` asserts the no-legal-64 premise, so a '
      + 'future frame that makes long addresses legal breaks this row instead of quietly invalidating it.',
  },
  {
    id: 'length-over-the-64-character-cap',
    classes: ['length-cap'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL(OVER_CAP) },
    requires: ['deep-link'],
    expect: {
      observable:
        'A 65-character input is refused for LENGTH, before the frame registry is consulted at all. The '
        + 'trust boundary runs in front of every frame-specific code path.',
      messages: ['rejected_too_long'],
      camera: 'unchanged',
      unchanged: REJECTION_UNCHANGED,
      urlAddress: null,
      cellKind: null,
    },
    oracle: [{ kind: 'reject', input: OVER_CAP, code: 'too_long' }],
  },

  // -------------------------------------------------------------------------
  // The two refusals that have a fallback, and must offer it.
  // -------------------------------------------------------------------------
  {
    id: 'br-frame-disabled',
    classes: ['frame-disabled'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BR-L-1') },
    requires: ['deep-link'],
    expect: {
      observable:
        'A BR cortical-surface address is accepted by the grammar and refused by the viewer: the message '
        + 'explains the frame ships disabled in v1, and OFFERS THE COARSEST RESOLVABLE ANCESTOR rather '
        + 'than leaving the user at a dead end. The camera does not move until they take the offer.',
      messages: ['frame_disabled', 'coarsest_ancestor_offered'],
      forbiddenMessages: ['rejected_grammar'],
      camera: 'unchanged',
      unchanged: ['camera', 'layers', 'selection', 'atlas'],
      cellKind: null,
    },
    oracle: [{ kind: 'reject', input: 'BR-L-1', code: 'frame_disabled' }],
    why: 'Plan §4 and §6 both require the offer. A refusal with no route forward is the thing being avoided.',
  },
  {
    id: 'no-template',
    classes: ['no-template'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BV-L-4721', `&${QA_URL_PARAMS.template}=no-brain`) },
    requires: ['deep-link', 'qa-template-override'],
    expect: {
      observable:
        'A well-formed BV address with no brain template loaded is explained as a missing template — not '
        + 'as a bad address — and the coarsest resolvable ancestor is offered. The distinction matters: '
        + 'the user\'s address is correct and the build is incomplete.',
      messages: ['no_template', 'coarsest_ancestor_offered'],
      forbiddenMessages: ['rejected_grammar', 'frame_disabled'],
      camera: 'unchanged',
      unchanged: ['camera', 'layers', 'selection'],
      cellKind: null,
    },
    oracle: [{ kind: 'reject', input: 'BV-L-4721', code: 'no_template' }],
  },
  {
    id: 'brain-deep-link-resolves',
    classes: ['canonical', 'cross-atlas-restore'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BV-L-4721') },
    requires: ['brain-atlas', 'deep-link'],
    expect: {
      observable:
        'A BV address deep-links straight into the BRAIN atlas with the cell outlined at its true extent. '
        + 'Arriving by URL is the one way the brain atlas may be entered without the explicit action, '
        + 'because the user named it.',
      messages: ['name_index_version'],
      forbiddenMessages: ['no_template', 'frame_disabled'],
      camera: 'flies-to-cell',
      unchanged: [],
      urlAddress: 'BV-L-4721',
      cellKind: 'extent',
      atlas: 'brain',
    },
    oracle: [{ kind: 'locate', address: 'BV-L-4721', template: 'brain', flags: { homology: 'exact' } }],
  },

  // -------------------------------------------------------------------------
  // Asset failure. Plan §6's last row, and the easiest one to get wrong by
  // showing a blank page.
  // -------------------------------------------------------------------------
  {
    id: 'assets-unavailable-addresses-still-resolve',
    classes: ['assets-unavailable'],
    mustPass: true,
    input: { kind: 'url', url: BODY_URL('BD-T07-03O-531', `&${QA_URL_PARAMS.assets}=fail`) },
    requires: ['deep-link', 'asset-failure-reporting', 'ranked-names'],
    expect: {
      observable:
        'With the geometry failing to load the atlas says so plainly, and the address STILL parses and '
        + 'still resolves to its ranked name list. A failed mesh fetch must not take the addressing layer '
        + 'down with it, because names and addresses need no mesh at all.',
      messages: ['assets_unavailable', 'name_index_version'],
      forbiddenMessages: ['rejected_grammar', 'no_template'],
      camera: 'unchanged',
      unchanged: ['layers'],
      urlAddress: 'BD-T07-03O-531',
      atlas: 'body',
      assetsAvailable: false,
      namesResolve: true,
    },
  },

  // -------------------------------------------------------------------------
  // The address-string-equality guard, at the UI level.
  // -------------------------------------------------------------------------
  {
    id: 'equality-guard-different-strings-same-place',
    classes: ['equality-guard'],
    mustPass: true,
    input: { kind: 'url', url: '/' },
    requires: ['deep-link'],
    expect: {
      observable:
        'Asked whether two DIFFERENT address strings from two subjects denote the same place at a 6 mm '
        + 'residual, the build answers yes, via covering overlap. A build comparing strings says no. '
        + 'Spec §6: string equality agrees only 4% of the time at a 5 mm residual.',
      messages: [],
      camera: 'unchanged',
      unchanged: [],
    },
    why:
      'The unit layer has had this guard since DOG-7, but it scans the library. A viewer can reimplement '
      + '`a === b` in its own comparison code and the library suite will stay green, which is exactly the '
      + 'regression this row is here to catch.',
  },
  {
    id: 'equality-guard-same-string-not-asserted-same',
    classes: ['equality-guard'],
    mustPass: true,
    input: { kind: 'url', url: '/' },
    requires: ['deep-link'],
    expect: {
      observable:
        'Asked about two IDENTICAL strings across subjects, the build still answers from geometry and '
        + 'names the basis as a tolerance rather than as string identity. Getting the right answer for '
        + 'the wrong reason is how the previous row starts passing again later.',
      messages: [],
      camera: 'unchanged',
      unchanged: [],
    },
  },

  // -------------------------------------------------------------------------
  // URL hygiene.
  // -------------------------------------------------------------------------
  {
    id: 'url-unknown-params',
    classes: ['url-hygiene'],
    mustPass: false,
    input: { kind: 'url', url: BODY_URL('BD-T07-03O-531', '&utm_source=paper&zoom=9') },
    requires: ['deep-link'],
    expect: {
      observable:
        'Unknown query parameters are ignored and the address still restores its view. Links are pasted '
        + 'into papers and mail clients, which add parameters.',
      messages: ['name_index_version'],
      camera: 'flies-to-cell',
      unchanged: ['atlas'],
      urlAddress: 'BD-T07-03O-531',
      cellKind: 'extent',
      atlas: 'body',
    },
  },
];

// ---------------------------------------------------------------------------
// Integrity of the matrix itself
// ---------------------------------------------------------------------------

/** Phrases that are not an observable behaviour, however many words surround them. */
const EMPTY_PHRASES = [/^works$/i, /^ok$/i, /^passes$/i, /^no errors?$/i, /^as expected$/i, /^correct$/i];

/**
 * Everything wrong with the matrix as authored, as opposed to with a build.
 *
 * This is the gate that works today, with no viewer in existence, and it is the
 * one that answers the question this task was created by: how do we know a
 * must-pass case has not quietly gone missing? Because removing it fails this.
 */
export function matrixIntegrityProblems(rows: readonly MatrixRow[] = DEEP_LINK_MATRIX): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const at = `row ${row.id}`;
    if (seen.has(row.id)) problems.push(`${at}: duplicate row id`);
    seen.add(row.id);
    if (!/^[a-z0-9-]+$/.test(row.id)) problems.push(`${at}: id must be kebab-case`);
    if (row.classes.length === 0) problems.push(`${at}: belongs to no case class`);
    for (const c of row.classes) {
      if (!(REQUIRED_CLASSES as readonly string[]).includes(c)) {
        problems.push(`${at}: unknown case class ${JSON.stringify(c)}`);
      }
    }

    const observable = row.expect.observable?.trim() ?? '';
    if (observable.length < 40) {
      problems.push(
        `${at}: expect.observable is ${observable.length} characters. Name the observable behaviour — `
        + 'which message appears, what the camera does, what does not change.',
      );
    }
    if (EMPTY_PHRASES.some((p) => p.test(observable))) {
      problems.push(`${at}: expect.observable says ${JSON.stringify(observable)}, which is not a behaviour.`);
    }

    // A row that asserts nothing cannot fail, and a row that cannot fail is
    // decoration. Every row must make at least one positive claim.
    const claims = [
      row.expect.messages.length > 0,
      (row.expect.forbiddenMessages?.length ?? 0) > 0,
      row.expect.urlAddress !== undefined,
      row.expect.cellKind !== undefined,
      row.expect.atlas !== undefined,
      row.expect.unchanged.length > 0,
      row.expect.selectionAddress !== undefined,
      row.expect.assetsAvailable !== undefined,
      row.expect.camera === 'unchanged',
      row.classes.includes('equality-guard'),
    ];
    if (!claims.some(Boolean)) problems.push(`${at}: asserts nothing that could fail`);

    if (row.expect.textMustContain && row.expect.messages.length === 0) {
      problems.push(`${at}: requires message text but names no message code to find it in`);
    }
    // The fold/clamp pair is the one conflation the plan calls out by name, so
    // it is checked structurally rather than left to each row's author.
    const msgs = new Set<MessageCode>(row.expect.messages);
    const forbidden = new Set<MessageCode>(row.expect.forbiddenMessages ?? []);
    if (msgs.has('folded') && !(forbidden.has('clamped_cranial') || forbidden.has('clamped_caudal'))) {
      problems.push(`${at}: asserts a fold without forbidding the clamp messages. They are never conflated.`);
    }
    if ((msgs.has('clamped_cranial') || msgs.has('clamped_caudal')) && !forbidden.has('folded')) {
      problems.push(`${at}: asserts a clamp without forbidding the fold message.`);
    }
    if (msgs.has('clamped_cranial') && !forbidden.has('clamped_caudal')) {
      problems.push(`${at}: asserts the cranial clamp without forbidding the caudal one. Which end is the requirement.`);
    }
    if (msgs.has('clamped_caudal') && !forbidden.has('clamped_cranial')) {
      problems.push(`${at}: asserts the caudal clamp without forbidding the cranial one.`);
    }
    if (msgs.has('homology_variant') && !forbidden.has('homology_absent')) {
      problems.push(`${at}: asserts a variant without forbidding 'absent'. Reserved space is not anatomy.`);
    }
    if (msgs.has('homology_absent') && !forbidden.has('homology_variant')) {
      problems.push(`${at}: asserts an absent level without forbidding 'variant'.`);
    }
    for (const code of msgs) {
      if (forbidden.has(code)) problems.push(`${at}: ${code} is both required and forbidden`);
    }
    if ((msgs.has('frame_disabled') || msgs.has('no_template')) && !msgs.has('coarsest_ancestor_offered')) {
      problems.push(
        `${at}: ${[...msgs].join('/')} must come with the coarsest resolvable ancestor on offer (plan §4).`,
      );
    }
    // A cell with no millimetres must not be flown to. `variant` and `absent`
    // both return NaN, so a row claiming a camera move is asserting a bug.
    if ((msgs.has('homology_variant') || msgs.has('homology_absent')) && row.expect.camera !== 'unchanged') {
      problems.push(`${at}: the address resolves to NaN millimetres, so the camera cannot fly to it`);
    }
    if (row.expect.cellKind === 'extent' && row.expect.camera !== 'flies-to-cell') {
      problems.push(`${at}: draws a cell but does not say the camera reaches it`);
    }
  }

  // Coverage of the enumeration.
  for (const cls of REQUIRED_CLASSES) {
    const inClass = rows.filter((r) => r.classes.includes(cls));
    if (inClass.length === 0) {
      problems.push(
        `case class ${JSON.stringify(cls)} has no row. The matrix is enumerated, not sampled: either add `
        + 'the row or remove the class from REQUIRED_CLASSES and say why in the commit.',
      );
      continue;
    }
    if (MUST_PASS_CLASSES.includes(cls) && !inClass.some((r) => r.mustPass)) {
      problems.push(
        `case class ${JSON.stringify(cls)} has ${inClass.length} row(s) and none is must-pass. `
        + 'A requirement with only advisory coverage is a requirement nobody is held to.',
      );
    }
  }

  // The three declared anomalies and the four reserved sacral levels, by name.
  // Enumerated coverage of a set is checkable; "we tested the variant case" is not.
  for (const level of ['T13', 'L06', 'S06']) {
    if (!rows.some((r) => r.id === `variant-${level}`)) problems.push(`no variant row for ${level}`);
  }
  for (const level of ['S02', 'S03', 'S04', 'S05']) {
    if (!rows.some((r) => r.id === `absent-${level}`)) problems.push(`no absent row for ${level}`);
  }

  return problems;
}

export function rowsByClass(cls: CaseClass, rows: readonly MatrixRow[] = DEEP_LINK_MATRIX): MatrixRow[] {
  return rows.filter((r) => r.classes.includes(cls));
}

export const MUST_PASS_ROW_IDS: readonly string[] = DEEP_LINK_MATRIX.filter((r) => r.mustPass).map((r) => r.id);
