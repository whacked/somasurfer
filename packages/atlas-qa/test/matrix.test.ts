/**
 * The matrix as an artefact: is it still enumerated, and does every row still
 * say what it expects?
 *
 * These are the gates that work today, with no viewer in existence, and they
 * are the ones that answer the question DOG-38 was created by: how do we know a
 * must-pass case has not quietly gone missing? Because removing it fails this
 * file.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DEEP_LINK_MATRIX,
  MUST_PASS_CLASSES,
  MUST_PASS_ROW_IDS,
  REQUIRED_CLASSES,
  matrixIntegrityProblems,
  rowsByClass,
} from '../src/matrix.ts';
import { JOURNEY, journeyIntegrityProblems } from '../src/journey.ts';
import { CAPABILITIES, MESSAGE_CODES } from '../src/contract.ts';

test('the matrix passes its own integrity gate', () => {
  const problems = matrixIntegrityProblems();
  assert.deepEqual(problems, [], `matrix integrity:\n  ${problems.join('\n  ')}`);
});

test('the journey passes its own integrity gate', () => {
  const problems = journeyIntegrityProblems();
  assert.deepEqual(problems, [], `journey integrity:\n  ${problems.join('\n  ')}`);
});

test('every required case class has at least one row', () => {
  const empty = REQUIRED_CLASSES.filter((c) => rowsByClass(c).length === 0);
  assert.deepEqual(empty, [], `case classes with no row: ${empty.join(', ')}`);
});

test('every must-pass case class has at least one must-pass row', () => {
  const uncovered = MUST_PASS_CLASSES.filter((c) => !rowsByClass(c).some((r) => r.mustPass));
  assert.deepEqual(uncovered, [], `classes with only advisory coverage: ${uncovered.join(', ')}`);
});

test('the issue\'s named minimum coverage is all present, by row', () => {
  // Spelled out from the acceptance criteria rather than derived, so that a
  // reorganisation of the case classes cannot drop one of them. This is the
  // list DOG-38 asks for in so many words.
  const required: Array<[string, (id: string) => boolean]> = [
    ['canonical form', (id) => id === 'canonical-body'],
    ['loose form', (id) => id === 'loose-body-same-view'],
    ['overPrecise', (id) => id === 'over-precise'],
    ['clamped, cranial end', (id) => id === 'clamped-cranial'],
    ['clamped, caudal end', (id) => id === 'clamped-caudal'],
    ['folded', (id) => id === 'folded-reports-fold-not-clamp'],
    ["homology 'variant' T13", (id) => id === 'variant-T13'],
    ["homology 'variant' L06", (id) => id === 'variant-L06'],
    ["homology 'variant' S06", (id) => id === 'variant-S06'],
    ["homology 'absent' S02", (id) => id === 'absent-S02'],
    ["homology 'absent' S03", (id) => id === 'absent-S03'],
    ["homology 'absent' S04", (id) => id === 'absent-S04'],
    ["homology 'absent' S05", (id) => id === 'absent-S05'],
    ['a rejected malformed address', (id) => id === 'malformed-bad-digit'],
    ['C08 with the correction named', (id) => id === 'c08-rejected-with-the-correction-named'],
    ['a BR address (frame_disabled)', (id) => id === 'br-frame-disabled'],
    ['a missing template (no_template)', (id) => id === 'no-template'],
    ['an address at the 64-character cap', (id) => id === 'length-at-the-64-character-cap'],
  ];
  const ids = DEEP_LINK_MATRIX.map((r) => r.id);
  const missing = required.filter(([, match]) => !ids.some(match)).map(([what]) => what);
  assert.deepEqual(missing, [], `the matrix no longer covers: ${missing.join('; ')}`);
  // And each of them must be must-pass: the issue says so.
  const advisory = required
    .filter(([, match]) => DEEP_LINK_MATRIX.some((r) => match(r.id) && !r.mustPass))
    .map(([what]) => what);
  assert.deepEqual(advisory, [], `named coverage that is only advisory: ${advisory.join('; ')}`);
});

test('every row names an observable behaviour rather than "works"', () => {
  for (const row of DEEP_LINK_MATRIX) {
    assert.ok(
      row.expect.observable.trim().length >= 40,
      `row ${row.id} does not state its observable behaviour`,
    );
    assert.ok(
      !/^(works|ok|passes|correct|as expected)\.?$/i.test(row.expect.observable.trim()),
      `row ${row.id} says ${JSON.stringify(row.expect.observable)}, which is not a behaviour`,
    );
  }
});

test('every row says what does not change, or why it does not need to', () => {
  // A rejection row with no `unchanged` list is the specific hole: the error
  // appears, and the camera has also moved and the selection has gone, and
  // nothing notices.
  for (const row of DEEP_LINK_MATRIX) {
    const rejects = row.expect.messages.some((m) => m.startsWith('rejected_'));
    if (!rejects) continue;
    assert.ok(
      row.expect.unchanged.length >= 4,
      `rejection row ${row.id} lists only ${row.expect.unchanged.length} unchanged facets. A refusal `
      + 'must change nothing else, and checking only that the error appeared passes a build that also '
      + 'moved the camera and dropped the selection.',
    );
  }
});

test('row ids are unique and stable-looking', () => {
  const ids = DEEP_LINK_MATRIX.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate row id');
  for (const id of ids) assert.match(id, /^[a-z][A-Za-z0-9-]*$/, `row id ${id} is not kebab-case`);
});

test('every message code a row references is in the closed set', () => {
  const known = new Set<string>(MESSAGE_CODES);
  for (const row of DEEP_LINK_MATRIX) {
    for (const code of [...row.expect.messages, ...(row.expect.forbiddenMessages ?? [])]) {
      assert.ok(known.has(code), `row ${row.id} references unknown message code ${code}`);
    }
  }
});

test('every capability a row or step requires is in the closed set', () => {
  const known = new Set<string>(CAPABILITIES);
  for (const row of DEEP_LINK_MATRIX) {
    for (const c of row.requires) assert.ok(known.has(c), `row ${row.id} requires unknown capability ${c}`);
  }
  for (const step of JOURNEY) {
    for (const c of step.requires) assert.ok(known.has(c), `step ${step.id} requires unknown capability ${c}`);
  }
});

test('the fold and clamp messages are never asserted together', () => {
  // Plan §6 calls this conflation out by name, and it is the one pair where a
  // row asserting the wrong thing would look reasonable.
  for (const row of DEEP_LINK_MATRIX) {
    const msgs = new Set<string>(row.expect.messages);
    const forbidden = new Set<string>(row.expect.forbiddenMessages ?? []);
    if (msgs.has('folded')) {
      assert.ok(
        forbidden.has('clamped_cranial') || forbidden.has('clamped_caudal'),
        `row ${row.id} asserts a fold without forbidding a clamp`,
      );
    }
    if (msgs.has('clamped_cranial')) assert.ok(forbidden.has('clamped_caudal'), `row ${row.id}`);
    if (msgs.has('clamped_caudal')) assert.ok(forbidden.has('clamped_cranial'), `row ${row.id}`);
  }
});

test('a must-pass row cannot be demoted without this suite noticing', () => {
  // The count is pinned deliberately. Demoting a row to advisory is a
  // legitimate change and a reviewable one; doing it silently is not, and this
  // is the line that makes it reviewable. Raise the number when you add
  // must-pass rows; lower it only in the same commit as the reason.
  assert.equal(
    MUST_PASS_ROW_IDS.length,
    30,
    `the matrix has ${MUST_PASS_ROW_IDS.length} must-pass rows, this suite expects 30. If you added `
    + 'rows, raise the number. If a row was demoted or deleted, say why in the commit.',
  );
});

test('the journey is the eight DOG-1 §7 clauses, in order', () => {
  assert.deepEqual(
    JOURNEY.map((s) => s.id),
    [
      'default-body-view',
      'change-layers',
      'select-structure-without-leaving-atlas',
      'explicit-brain-navigation',
      'region-research',
      'paper-reveals-all-its-regions',
      'compare-two-papers',
      'return-to-body-with-previous-view-intact',
    ],
    'the journey no longer matches DOG-1 §7 clause for clause',
  );
  for (const step of JOURNEY) {
    assert.ok(step.mustPass, `step ${step.id} encodes a §7 clause and must be must-pass`);
    assert.ok(step.clause.length > 10, `step ${step.id} does not cite its clause`);
  }
});

test('each journey step depends only on earlier steps', () => {
  const seen = new Set<string>();
  for (const step of JOURNEY) {
    for (const dep of step.dependsOn) {
      assert.ok(seen.has(dep), `step ${step.id} depends on ${dep}, which is not an earlier step`);
    }
    seen.add(step.id);
  }
});
