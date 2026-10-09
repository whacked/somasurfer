/**
 * The honesty requirements, asserted.
 *
 * Every test here corresponds to a stage-A acceptance criterion that is about
 * the viewer telling the truth rather than about it working. They are kept
 * together because they share one failure mode: each of them passes trivially
 * if the viewer silently does nothing, so each asserts the *presence* of a
 * specific message, not merely the absence of a crash.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { locate, parse } from '../src/alc.js';
import { NOTICE_CODES, coarsestResolvable, errorNotice, locateNotices } from '../src/viewer/flags.js';
import { demote, selectAddress } from '../src/viewer/select.js';
import { meshBounds } from '../src/viewer/template.js';
import { foldingTemplates, nameIndex, templates } from './support.js';

const codesOf = (model) => model.notices.map((n) => n.code);

describe('a cell renders at its true extent, not as a point', () => {
  it('gives a coarse address a visibly larger extent than a fine one', () => {
    const t = templates();
    const coarse = selectAddress('BD-T07-03O', { templates: t });
    const fine = selectAddress('BD-T07-03O-531', { templates: t });

    for (const model of [coarse, fine]) {
      assert.ok(model.ok);
      assert.ok(model.extentMm.every((v) => Number.isFinite(v) && v > 0));
    }
    // Every axis of the coarse cell is strictly larger. If the viewer ever
    // rendered a marker instead of a cell these would be equal.
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(
        coarse.extentMm[axis] > fine.extentMm[axis],
        `axis ${axis}: coarse ${coarse.extentMm[axis]} should exceed fine ${fine.extentMm[axis]}`,
      );
    }
  });

  it('builds cell geometry that spans the reported extent, not a degenerate point', () => {
    const model = selectAddress('BD-T07-03O', { templates: templates() });
    assert.ok(model.cell, 'a resolvable cell must produce geometry');
    const bounds = meshBounds(model.cell);
    // The drawn hull has to be at least as big as the smallest reported axis.
    // A point-rendered cell would have radius ~0 and fail here.
    const smallestAxis = Math.min(...model.extentMm);
    assert.ok(
      bounds.radius * 2 >= smallestAxis * 0.9,
      `drawn diameter ${bounds.radius * 2} should cover the ${smallestAxis} mm axis`,
    );
  });

  it('curves the drawn cell: a whole-level cell is not a straight box', () => {
    // A BD cell sweeping a full turn must bend with the spine. Its 12 edge
    // polylines are subdivided; if the geometry were a straight box every
    // polyline would be collinear.
    const model = selectAddress('BD-T07', { templates: templates() });
    assert.ok(model.cell);
    const bent = model.cell.edges.some((line) => {
      if (line.length < 3) return false;
      const [a, b, c] = [line[0], line[Math.floor(line.length / 2)], line[line.length - 1]];
      const chord = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const viaMid =
        Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) +
        Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
      return viaMid > chord * 1.01;
    });
    assert.ok(bent, 'at least one cell edge must follow the frame rather than cut a chord');
  });
});

describe('an over-precise address resolves, is demoted, and says so', () => {
  const t = templates();
  const limit = t.body.maxUsefulDigits;
  const written = `BD-T07-03O-${'5'.repeat(limit + 4)}`;

  it('still resolves rather than being rejected', () => {
    const model = selectAddress(written, { templates: t });
    assert.ok(model.ok);
    assert.equal(model.address, parse(written).canonical);
  });

  it('draws at the template limit, not as written', () => {
    const model = selectAddress(written, { templates: t });
    assert.ok(model.demoted);
    assert.equal(parse(model.displayAddress).digits.length, limit);
    assert.equal(model.displayAddress, demote(written, limit));
  });

  it('says so — the notice survives the re-locate that clears the flag', () => {
    // The regression this pins: select() re-locates at the demoted address,
    // which is correctly no longer overPrecise, so a notice read back off that
    // result would be silent in exactly the case the rule is about.
    const model = selectAddress(written, { templates: t });
    assert.ok(codesOf(model).includes('over-precise'));
    const notice = model.notices.find((n) => n.code === 'over-precise');
    assert.match(notice.detail, /drawn AND named/);
    assert.ok(notice.detail.includes(model.displayAddress));
  });

  it('names the cell at the demoted address too, so names and geometry agree', () => {
    const model = selectAddress(written, { templates: t, nameIndex: nameIndex() });
    const direct = selectAddress(model.displayAddress, { templates: t, nameIndex: nameIndex() });
    assert.deepEqual(
      model.names.matches.map((m) => m.id),
      direct.names.matches.map((m) => m.id),
    );
  });

  it('reports an extent no finer than the template justifies', () => {
    const model = selectAddress(written, { templates: t });
    const atLimit = locate(demote(written, limit), t);
    assert.deepEqual(model.extentMm, atLimit.extentMm);
  });
});

describe('every flag surfaces, and folded is never conflated with clamped', () => {
  it('reports homology variant for a recognised count anomaly, and draws nothing', () => {
    for (const address of ['BD-T13-03O', 'BD-L06-03O', 'BD-S06-03O']) {
      const model = selectAddress(address, { templates: templates() });
      assert.ok(model.ok, `${address} is real anatomy and must not be rejected`);
      assert.ok(codesOf(model).includes('homology-variant'), `${address} must surface as variant`);
      assert.equal(model.cell, null, `${address} must not be given invented geometry`);
      assert.ok(model.extentMm.every((v) => Number.isNaN(v)));
    }
  });

  it('reports homology absent for reserved sacral space, distinctly from variant', () => {
    const model = selectAddress('BD-S03-03O', { templates: templates() });
    assert.ok(model.ok);
    const codes = codesOf(model);
    assert.ok(codes.includes('homology-absent'));
    assert.ok(!codes.includes('homology-variant'), 'reserved space is not an anatomical variant');
  });

  // The anterior skin cells of the DOG-9 counterexample. The fold is non-local
  // — upper-thoracic bisector planes fan out anteriorly and claim skin several
  // levels below — so it only shows up near r = 1 on the anterior midline,
  // which is why these are three digits deep at clock 12 rather than at the
  // azimuth segment.
  const FOLDED_CELLS = ['BD-T07-12O-111', 'BD-T08-12O-111', 'BD-T10-12O-111'];

  it('reports folded for a template whose frame folds', () => {
    const folding = foldingTemplates();
    for (const address of FOLDED_CELLS) {
      const model = selectAddress(address, { templates: folding });
      assert.ok(model.ok, `${address} must still resolve`);
      assert.ok(codesOf(model).includes('folded'), `${address} must surface as folded`);
      // The millimetres are deterministic, so the cell still draws. A fold is
      // a statement about the coordinate system, not a refusal to answer.
      assert.ok(model.cell, `${address} still has geometry`);
      const notice = model.notices.find((n) => n.code === 'folded');
      assert.match(notice.detail, /inside the modelled body/);
      assert.ok(
        notice.notes.some((n) => /claimed by 2 levels|does not survive a round trip/.test(n)),
        'the library note naming the competing levels must be carried through',
      );
    }
  });

  it('does not flag a fold on the admissible template — the message means something', () => {
    // Without this, "folded" passing above would be consistent with the viewer
    // flagging everything. The same cells on the admissible adult template are
    // clean.
    const t = templates();
    for (const address of FOLDED_CELLS) {
      const model = selectAddress(address, { templates: t });
      assert.ok(model.ok);
      assert.ok(!codesOf(model).includes('folded'), `${address} must be clean on anat-adult-p50`);
    }
  });

  it('gives folded and clamped disjoint vocabulary', () => {
    const folded = locateNotices({ templateId: 'x', flags: { folded: true } })[0];
    const clamped = locateNotices({ templateId: 'x', flags: { clamped: true } })[0];
    assert.notEqual(folded.code, clamped.code);
    assert.notEqual(folded.title, clamped.title);
    // The specific historical defect: a fold reported as "outside the body".
    assert.ok(!/outside/.test(folded.detail), 'a fold must never say the point is outside');
    assert.match(clamped.detail, /beyond the extent|boundary/);
    assert.match(folded.detail, /inside the modelled body/);
  });

  it('reports both when a cell is both folded and clamped', () => {
    const codes = locateNotices({
      templateId: 'x',
      flags: { folded: true, clamped: true },
    }).map((n) => n.code);
    assert.deepEqual(new Set(codes), new Set(['folded', 'clamped']));
  });

  it('gives every notice code a distinct title', () => {
    const titles = new Map();
    const samples = [
      ...locateNotices({ templateId: 'x', flags: { overPrecise: true } }, { overPrecise: true }),
      ...locateNotices({ templateId: 'x', flags: { folded: true } }),
      ...locateNotices({ templateId: 'x', flags: { clamped: true } }),
      ...locateNotices({ templateId: 'x', flags: { homology: 'variant' } }),
      ...locateNotices({ templateId: 'x', flags: { homology: 'absent' } }),
      errorNotice({ code: 'no_template' }, 'BD-T07-03O', {}),
      errorNotice({ code: 'frame_disabled' }, 'BR-L-5', {}),
      errorNotice({ code: 'bad_level', message: 'nope' }, 'BD-C08', {}),
    ];
    for (const notice of samples) {
      assert.ok(NOTICE_CODES.includes(notice.code), `${notice.code} must be declared`);
      assert.ok(!titles.has(notice.title), `title reused by ${notice.code}`);
      titles.set(notice.title, notice.code);
    }
    assert.equal(titles.size, samples.length);
  });
});

describe('a rejected address names the first problem and changes nothing else', () => {
  it('rejects before any geometry and returns ok:false with one notice', () => {
    for (const bad of ['BD-C08-03O', 'BD-L09-03O', 'BD-T07-03O-9', 'nonsense', 'BD']) {
      const model = selectAddress(bad, { templates: templates(), nameIndex: nameIndex() });
      assert.equal(model.ok, false, `${bad} must be rejected`);
      assert.equal(model.notices.length, 1, `${bad} must name one problem, not a cascade`);
      assert.equal(model.notices[0].code, 'rejected');
      // Nothing geometric or name-related was computed.
      assert.equal(model.cell, undefined);
      assert.equal(model.names, undefined);
      assert.equal(model.located, undefined);
    }
  });

  it('names the correction for C08 rather than treating it as an anomaly', () => {
    const model = selectAddress('BD-C08-03O', { templates: templates() });
    assert.match(model.notices[0].detail, /no eighth cervical vertebra/);
    assert.match(model.notices[0].detail, /C8 \*?nerve root/);
  });
});

describe('degrading visibly', () => {
  it('explains no_template and offers the coarsest resolvable ancestor', () => {
    const notice = errorNotice({ code: 'no_template' }, 'BD-T07-03O-531', {});
    assert.equal(notice.code, 'no-template');
    assert.match(notice.detail, /names still resolve/);
    // With no template at all there is honestly nothing to offer, and the
    // field says so rather than being quietly omitted.
    assert.equal(notice.offer, null);
  });

  it('offers a real ancestor when one is resolvable', () => {
    const t = templates();
    // S03 is absent, so it has no millimetres; its frame root does.
    assert.equal(coarsestResolvable('BD-T07-03O-531', t), 'BD-T07');
    assert.equal(coarsestResolvable('BV-L-471', t), 'BV-L');
  });

  it('explains frame_disabled for BR and offers nothing, because nothing can be', () => {
    const t = templates();
    const model = selectAddress('BR-L-5', { templates: t, nameIndex: nameIndex() });
    assert.ok(model.ok, 'a BR address parses; it just cannot be placed');
    const notice = model.notices.find((n) => n.code === 'frame-disabled');
    assert.ok(notice);
    assert.equal(notice.offer, null, 'every BR ancestor is also BR, so there is no offer');
    assert.equal(model.cell, null);
  });

  it('resolves names with no templates at all — an atlas can be unavailable', () => {
    const model = selectAddress('BD-T07-03O', { templates: {}, nameIndex: nameIndex() });
    assert.ok(model.ok);
    assert.ok(model.names, 'names must not depend on geometry');
    assert.ok(model.names.matches.length > 0);
    assert.equal(model.cell, null);
    assert.ok(codesOf(model).includes('no-template'));
  });
});

describe('names are a ranked list with fractions and a version', () => {
  it('never collapses to a single name, and always carries the index version', () => {
    const model = selectAddress('BD-T07-03O', {
      templates: templates(),
      nameIndex: nameIndex(),
    });
    assert.ok(model.names.matches.length > 1, 'a cell straddling structures gets them all');
    assert.match(model.names.indexVersion, /fixture.*synthetic/);
    assert.equal(model.names.measure, 'frame');
  });

  it('ranks by fraction descending, with fractions in (0,1]', () => {
    const model = selectAddress('BD-T07-03O', {
      templates: templates(),
      nameIndex: nameIndex(),
    });
    const fractions = model.names.matches.map((m) => m.fraction);
    for (const f of fractions) assert.ok(f > 0 && f <= 1, `fraction ${f} out of range`);
    for (let i = 1; i < fractions.length; i += 1) {
      assert.ok(fractions[i] <= fractions[i - 1], 'matches must be ranked');
    }
  });

  it('reports partial containment as partial, not as a winner', () => {
    const model = selectAddress('BD-T07-03O', {
      templates: templates(),
      nameIndex: nameIndex(),
    });
    const partial = model.names.matches.filter((m) => m.fraction < 1);
    assert.ok(partial.length >= 2, 'the fixture must exercise genuinely partial fractions');
    const sum = partial.reduce((n, m) => n + m.fraction, 0);
    assert.ok(sum <= 1.0000001, 'partial fractions cannot exceed the cell');
  });

  it('gives the containment hierarchy coarsest first', () => {
    const model = selectAddress('BD-T07-03O-531', {
      templates: templates(),
      nameIndex: nameIndex(),
    });
    const names = model.names.containing.map((s) => s.name);
    assert.ok(names.length >= 2);
    assert.equal(names[0], 'T07 vertebral level');
  });
});
