/**
 * Deliberately broken builds, and the cases that must catch each one.
 *
 * A harness nobody has watched fail is decoration. The repo already works this
 * way — `tools/verify-gates.mjs` breaks each CI gate on purpose and requires it
 * to be caught — and this is the same argument applied to §7: thirteen builds,
 * each breaking exactly ONE guarantee, each declaring which case is supposed to
 * notice.
 *
 * Three things make this stronger than "we saw it go red once":
 *
 *  1. **One mutation each.** A build that breaks two things and fails tells you
 *     nothing about which case did the work. Every mutant below overrides the
 *     smallest possible piece of the reference viewer.
 *
 *  2. **The catching case is named, and checked.** `caughtBy` is asserted, so a
 *     mutant that fails for an unrelated reason is not counted as caught. That
 *     is the difference between "the suite went red" and "the row that owns
 *     this requirement went red".
 *
 *  3. **Coverage runs the other way too.** `uncoveredClasses()` lists required
 *     case classes no mutant exercises. The list is allowed to be non-empty —
 *     some classes have no sensible single-point mutation — but it is committed
 *     and reviewed, rather than being whatever happens to be left over.
 *
 * `silently-skips-a-must-pass-case` is the most important one and it is not
 * about the viewer at all. It is a build that declines a capability a must-pass
 * row needs, which is the shape a false green actually takes: nothing errors,
 * nothing is red, and a case silently did not run. The harness must report that
 * as unevaluated and must fail in strict mode. If that mutant ever passes, every
 * other row in this file is worthless, because any of them could be skipped the
 * same way.
 */

import { covering } from '../../alc/src/index.ts';
import type {
  Capability,
  Highlight,
  RankedName,
  ViewState,
  Vec3,
} from './contract.ts';
import { ReferenceViewer, type ReferenceViewerOptions } from './referenceViewer.ts';
import type { CaseClass } from './matrix.ts';
import { REQUIRED_CLASSES, DEEP_LINK_MATRIX } from './matrix.ts';

/** How the harness is expected to notice. */
export type CaughtAs = 'fail' | 'unverified';

export interface Mutant {
  readonly id: string;
  /** The single guarantee this build breaks. */
  readonly breaks: string;
  /** Case ids that MUST notice. Asserted, not hoped for. */
  readonly caughtBy: readonly string[];
  readonly caughtAs: CaughtAs;
  /** Case classes this mutant exercises, for the coverage check. */
  readonly exercises: readonly CaseClass[];
  build(options?: ReferenceViewerOptions): ReferenceViewer;
}

/** Common shape: a reference viewer with one thing wrong, and `kind: 'mutant'`. */
function mutantOf<T extends ReferenceViewer>(
  id: string,
  make: (options: ReferenceViewerOptions) => T,
): (options?: ReferenceViewerOptions) => ReferenceViewer {
  return (options: ReferenceViewerOptions = {}) => {
    const viewer = make({ ...options, buildId: `mutant:${id}` });
    // `kind` decides whether a pass can ever be a product pass. A mutant's
    // cannot, however green it looks.
    Object.defineProperty(viewer, 'kind', { value: 'mutant', writable: false });
    return viewer;
  };
}

export const MUTANTS: readonly Mutant[] = [
  {
    id: 'point-rendered-cell',
    breaks: 'the cell is drawn as a point instead of at its true extent, so borrowed precision looks exact',
    caughtBy: ['canonical-body', 'over-precise', 'select-structure-without-leaving-atlas'],
    caughtAs: 'fail',
    exercises: ['canonical', 'over-precise'],
    build: mutantOf('point-rendered-cell', (o) =>
      new (class extends ReferenceViewer {
        async state(): Promise<ViewState> {
          const s = await super.state();
          if (!s.cell) return s;
          return Object.freeze({
            ...s,
            cell: Object.freeze({ ...s.cell, kind: 'point' as const, extentMm: [0, 0, 0] as unknown as Vec3 }),
          }) as ViewState;
        }
      })(o)),
  },
  {
    id: 'filter-leaks-into-paper-mappings',
    breaks: "the anatomical filter narrows a selected paper's own mappings, hiding its other regions",
    caughtBy: ['paper-reveals-all-its-regions'],
    caughtAs: 'fail',
    exercises: [],
    build: mutantOf('filter-leaks-into-paper-mappings', (o) =>
      new (class extends ReferenceViewer {
        protected computeHighlights(): Highlight[] {
          const all = super.computeHighlights();
          if (!this.filter) return all;
          // The one `if` that is the whole defect: DOG-1 §3 says the filter
          // narrows the paper LIST and never this.
          const inFilter = new Set(
            this.fixture.structures.find((s) => s.id === this.filter)?.cells ?? [],
          );
          return all.filter((h) => h.cells.some((c) => inFilter.has(c)));
        }
      })(o)),
  },
  {
    id: 'selection-switches-atlas',
    breaks: 'selecting the brain in the body atlas navigates to the brain atlas automatically',
    caughtBy: ['explicit-brain-navigation'],
    caughtAs: 'fail',
    exercises: [],
    build: mutantOf('selection-switches-atlas', (o) =>
      new (class extends ReferenceViewer {
        async clickStructure(structureId: string): Promise<ViewState> {
          const s = await super.clickStructure(structureId);
          if (/brain/i.test(structureId)) {
            this.atlas = 'brain';
            return super.state();
          }
          return s;
        }
      })(o)),
  },
  {
    id: 'return-loses-the-previous-view',
    breaks: 'returning from the brain atlas resets the body view instead of restoring it',
    caughtBy: ['return-to-body-with-previous-view-intact'],
    caughtAs: 'fail',
    exercises: ['cross-atlas-restore'],
    build: mutantOf('return-loses-the-previous-view', (o) =>
      new (class extends ReferenceViewer {
        async returnToBody(): Promise<ViewState> {
          // Navigates back, but drops the stash — the camera and layers go to
          // their defaults and the selection is lost.
          this.stashedBodyView = null;
          this.atlas = 'body';
          return super.state();
        }
      })(o)),
  },
  {
    id: 'fold-reported-as-clamp',
    breaks: 'a fold is reported as the point having left the body, which is what it did before DOG-9',
    caughtBy: ['folded-reports-fold-not-clamp'],
    caughtAs: 'fail',
    exercises: ['folded'],
    build: mutantOf('fold-reported-as-clamp', (o) =>
      new (class extends ReferenceViewer {
        async state(): Promise<ViewState> {
          const s = await super.state();
          if (!s.messages.some((m) => m.code === 'folded')) return s;
          return Object.freeze({
            ...s,
            messages: Object.freeze(
              s.messages.map((m) =>
                m.code === 'folded'
                  ? { ...m, code: 'clamped_cranial' as const, text: 'outside the modelled body surface' }
                  : m,
              ),
            ),
          }) as ViewState;
        }
      })(o)),
  },
  {
    id: 'variant-swallowed-as-absent',
    breaks: "a recognised count anomaly reports homology 'absent', so a patient needing a level mapping looks like a typo",
    caughtBy: ['variant-T13', 'variant-L06', 'variant-S06'],
    caughtAs: 'fail',
    exercises: ['variant'],
    build: mutantOf('variant-swallowed-as-absent', (o) =>
      new (class extends ReferenceViewer {
        async state(): Promise<ViewState> {
          const s = await super.state();
          return Object.freeze({
            ...s,
            messages: Object.freeze(
              s.messages.map((m) =>
                m.code === 'homology_variant' ? { ...m, code: 'homology_absent' as const } : m,
              ),
            ),
          }) as ViewState;
        }
      })(o)),
  },
  {
    id: 'clamp-does-not-name-which-end',
    breaks: 'both ends of the vertebral column report the same clamp message',
    caughtBy: ['clamped-caudal'],
    caughtAs: 'fail',
    exercises: ['clamped-caudal'],
    build: mutantOf('clamp-does-not-name-which-end', (o) =>
      new (class extends ReferenceViewer {
        async state(): Promise<ViewState> {
          const s = await super.state();
          return Object.freeze({
            ...s,
            messages: Object.freeze(
              s.messages.map((m) =>
                m.code === 'clamped_caudal'
                  ? { ...m, code: 'clamped_cranial' as const, text: 'outside the column' }
                  : m,
              ),
            ),
          }) as ViewState;
        }
      })(o)),
  },
  {
    id: 'c08-rejected-without-the-correction',
    breaks: 'C08 is refused with a bare range message, so the user never learns the C8 nerve root is what exists',
    caughtBy: ['c08-rejected-with-the-correction-named'],
    caughtAs: 'fail',
    exercises: ['c08-correction'],
    build: mutantOf('c08-rejected-without-the-correction', (o) =>
      new (class extends ReferenceViewer {
        async state(): Promise<ViewState> {
          const s = await super.state();
          return Object.freeze({
            ...s,
            messages: Object.freeze(
              s.messages.map((m) =>
                m.code === 'rejected_level'
                  ? { ...m, text: 'not an addressable vertebral level.' }
                  : m,
              ),
            ),
          }) as ViewState;
        }
      })(o)),
  },
  {
    id: 'over-precise-drawn-at-full-precision',
    breaks: 'an over-precise address is resolved and drawn at the digits it carried, with no notice',
    caughtBy: ['over-precise'],
    caughtAs: 'fail',
    exercises: ['over-precise'],
    build: mutantOf('over-precise-drawn-at-full-precision', (o) =>
      new (class extends ReferenceViewer {
        // The template's limit stops being consulted, so nothing is truncated
        // and the `over_precise` notice never fires.
        protected usefulDigits(): number {
          return 99;
        }
      })(o)),
  },
  {
    id: 'address-string-equality',
    breaks: '"same place?" is answered by comparing canonical address strings',
    caughtBy: [
      'equality-guard-different-strings-same-place',
      'equality-guard-same-string-not-asserted-same',
      'compare-two-papers',
    ],
    caughtAs: 'fail',
    exercises: ['equality-guard'],
    build: mutantOf('address-string-equality', (o) =>
      new (class extends ReferenceViewer {
        async samePlaceAcrossSubjects(
          cellsA: readonly string[],
          cellsB: readonly string[],
        ): Promise<{ same: boolean; basis: string }> {
          // Spec §6's defect, in one line: at a 5 mm residual these strings
          // agree 4% of the time while the decoded cells are 5.9 mm apart.
          const a = covering([...cellsA]).cells.join(',');
          const b = covering([...cellsB]).cells.join(',');
          return { same: a === b, basis: 'string-equality' };
        }
      })(o)),
  },
  {
    id: 'deep-link-drops-the-digits',
    breaks: 'a deep link restores the anchor cell and discards the refinement digits, so the view is coarser than the link',
    caughtBy: ['canonical-body', 'loose-body-same-view'],
    caughtAs: 'fail',
    exercises: ['canonical', 'loose'],
    build: mutantOf('deep-link-drops-the-digits', (o) =>
      new (class extends ReferenceViewer {
        protected applyAddress(input: string, options: { fromUrl?: boolean } = {}): void {
          const stripped = input.replace(/^([A-Z]{2}(?:-[^-]+){1,2})-[0-7]+$/i, '$1');
          super.applyAddress(stripped, options);
        }
      })(o)),
  },
  {
    id: 'single-name-instead-of-a-ranked-list',
    breaks: 'the panel shows one name instead of a ranked list with containment fractions',
    caughtBy: ['select-structure-without-leaving-atlas'],
    caughtAs: 'fail',
    exercises: [],
    build: mutantOf('single-name-instead-of-a-ranked-list', (o) =>
      new (class extends ReferenceViewer {
        protected rankedNames(address: string): RankedName[] {
          const all = super.rankedNames(address);
          // The top match, presented as the answer. A cell overlapping several
          // structures now claims to be one of them.
          return all.slice(0, 1).map((n) => ({ ...n, fraction: 1 }));
        }
      })(o)),
  },
  {
    id: 'silently-skips-a-must-pass-case',
    breaks:
      'the build declines a capability a must-pass row needs, so the row does not run — nothing errors, '
      + 'nothing is red, and the requirement is simply not tested',
    // Nothing "fails" here, which is the point: the harness has to notice the
    // absence of evidence. `--strict` turns it into a failure.
    caughtBy: ['folded-reports-fold-not-clamp', 'no-template'],
    caughtAs: 'unverified',
    exercises: [],
    build: mutantOf('silently-skips-a-must-pass-case', (o) =>
      new ReferenceViewer({ ...o, withhold: ['qa-template-override'] as Capability[] })),
  },
];

/** Required case classes no mutant exercises. Committed and reviewed, not left over. */
export function uncoveredClasses(): CaseClass[] {
  const covered = new Set<CaseClass>(MUTANTS.flatMap((m) => [...m.exercises]));
  return REQUIRED_CLASSES.filter((c) => !covered.has(c));
}

/**
 * Classes with no mutation, each with the reason.
 *
 * Same scheme as the equality guard's REVIEWED list: a gap costs one sentence
 * of justification, which is cheap enough to write and expensive enough that
 * nobody writes it for a gap that should have been closed. `test/negative-control.test.ts`
 * fails if this list and `uncoveredClasses()` disagree, so a class that loses
 * its mutant has to be explained here before the suite goes green again.
 */
export const UNMUTATED_CLASSES: ReadonlyArray<{ cls: CaseClass; reason: string }> = [
  {
    cls: 'default-view',
    reason:
      'the baseline every other row diffs against. A mutation here does not produce one wrong row, it '
      + 'invalidates the comparison in all of them, so what it would measure is not a defect the suite '
      + 'can attribute.',
  },
  {
    cls: 'check-symbol',
    reason:
      'the check symbol is computed and verified entirely inside `parse()`, which this harness does not '
      + 'reimplement. A UI cannot get it wrong without reimplementing it, and the library suite already '
      + 'owns that case (DOG-17 retired QA-5 into `conformance.test.ts`).',
  },
  {
    cls: 'clamped-cranial',
    reason:
      'covered in the other direction: `clamp-does-not-name-which-end` collapses the caudal message into '
      + 'the cranial one, so the pair is mutated once rather than twice. A second mutant collapsing the '
      + 'cranial into the caudal would test the same line of code.',
  },
  {
    cls: 'absent',
    reason:
      '`variant-swallowed-as-absent` already mutates the variant/absent distinction, and it is the '
      + 'dangerous direction — reporting real anatomy as reserved grammar. The reverse mutation would '
      + 'make S02 claim to be an anomaly, which no implementation mistake produces: the anomaly set is a '
      + 'literal in the library.',
  },
  {
    cls: 'malformed',
    reason:
      'rejection happens in `parse()` before the viewer sees anything, so the only UI-level mutation is '
      + 'to resolve anyway — which is `deep-link-drops-the-digits` in a less honest form. The row still '
      + 'runs and still asserts; it just has no single-point mutation of its own.',
  },
  {
    cls: 'frame-disabled',
    reason:
      'the refusal and the ancestor offer both come from one branch that `no-template` also exercises, '
      + 'and `silently-skips-a-must-pass-case` is pointed at `no-template` precisely because the pair '
      + 'shares that branch.',
  },
  {
    cls: 'no-template',
    reason:
      'exercised by `silently-skips-a-must-pass-case` as the skipped row, which is the stronger test: it '
      + 'checks the harness notices the row not running at all.',
  },
  {
    cls: 'length-cap',
    reason:
      'the 64-character cap is enforced in `splitAddress()`, upstream of every frame and of the viewer. '
      + 'There is no UI-level way to get it wrong short of not calling `parse()`, which '
      + '`deep-link-drops-the-digits` already covers.',
  },
  {
    cls: 'assets-unavailable',
    reason:
      'a genuine gap, and a deliberate one for now. Mutating it needs a build that reports assets fine '
      + 'while failing to load them, which the reference viewer cannot express without a second asset '
      + 'path — and inventing one here would be mutating the stand-in rather than a guarantee. Close this '
      + 'against the real build in task 7 (DOG-39), where the asset loader exists.',
  },
  {
    cls: 'url-hygiene',
    reason: 'advisory rows only, by design — nothing in the plan states that unknown parameters must be ignored.',
  },
];

/** Mutants whose declared `caughtBy` names a case the matrix and journey do not contain. */
export function danglingCaughtBy(): string[] {
  const known = new Set<string>([
    ...DEEP_LINK_MATRIX.map((r) => r.id),
    'default-body-view',
    'change-layers',
    'select-structure-without-leaving-atlas',
    'explicit-brain-navigation',
    'region-research',
    'paper-reveals-all-its-regions',
    'compare-two-papers',
    'return-to-body-with-previous-view-intact',
  ]);
  return MUTANTS.flatMap((m) => m.caughtBy.filter((id) => !known.has(id)).map((id) => `${m.id} -> ${id}`));
}
