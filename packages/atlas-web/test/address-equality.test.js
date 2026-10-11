/**
 * The standing address-equality guard, extended over the viewer.
 *
 * `packages/alc` has had this guard since DOG-7, scanning its own `src/*.ts`.
 * The viewer is where the rule actually gets broken in practice — a UI is full
 * of "is this the thing that is already selected?" — and a guard that stops at
 * the library boundary does not cover the code most likely to violate it.
 *
 * So this suite reuses the library's scanner rather than writing a second one.
 * One scanner, two trees: a change to what counts as an address-value
 * comparison applies to both, and there is no chance of the viewer's copy
 * drifting into leniency.
 *
 * Why the rule exists, from spec §6: comparing addresses across subjects by
 * string equality agrees only 4% of the time at a 5 mm residual, while the two
 * decoded cells stay 5.9 mm apart — the residual itself. The strings disagree
 * and the addresses are right. Equality is still correct *within* one template,
 * which is why this is a reviewed-exception scheme and not a ban.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { scanSource } from '../../alc/test/guards/addressEquality.ts';
import { contains, coveringsOverlap, covering, overlaps, samePlace } from '../src/alc.js';
import { templates } from './support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');

/**
 * In-scope comparisons in the viewer that are reviewed and correct.
 *
 * Empty, and that is the intended steady state. The one place the viewer was
 * tempted — "did this address get demoted?" — records the fact where the
 * demotion happens instead of recovering it by comparing two address strings.
 * See the comment in `select.js`.
 *
 * To add an entry: state the reason, and if the reason is "both addresses come
 * from the same template", name the template.
 */
const REVIEWED = [];

/** Every `.js` file under a directory, as package-relative paths. */
function jsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d).sort()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.js')) out.push(relative(PACKAGE_ROOT, full).split('\\').join('/'));
    }
  };
  walk(dir);
  return out;
}

const normalise = (s) => s.replace(/\s+/g, ' ').replace(/[;{]+$/, '').trim();

describe('no string equality between addresses in the viewer', () => {
  const files = jsFiles(join(PACKAGE_ROOT, 'src'));

  it('scans a non-empty set of viewer sources', () => {
    // A glob that matches nothing is a silent green, which is the failure this
    // whole gate exists to prevent one layer down.
    assert.ok(files.length >= 7, `expected the viewer sources, found ${files.length}`);
    assert.ok(files.includes('src/viewer/select.js'));
    assert.ok(files.includes('src/viewer/state.js'));
  });

  it('finds no unsanctioned address-value comparison', () => {
    const unsanctioned = [];
    for (const file of files) {
      const sites = scanSource(file, readFileSync(join(PACKAGE_ROOT, file), 'utf8'));
      for (const site of sites) {
        const cleared = REVIEWED.some(
          (r) => r.file === site.file && normalise(r.code) === normalise(site.code),
        );
        if (!cleared) unsanctioned.push(site);
      }
    }
    assert.deepEqual(
      unsanctioned.map((s) => `${s.file}:${s.line} [${s.kind}] ${s.code}`),
      [],
      'each of these must either stop comparing addresses or gain a REVIEWED entry',
    );
  });

  it('is a real scanner: it still catches a planted violation', () => {
    // A guard never seen to fire is not evidence. This is the shape the viewer
    // would most plausibly regress into.
    const planted = `
      const selectedAddress = state.selection.address;
      if (selectedAddress === candidate.canonical) return true;
      const seen = new Set(addresses);
      if (seen.has(other.canonical)) return true;
    `;
    const sites = scanSource('src/viewer/planted.js', planted);
    assert.ok(sites.length >= 2, `expected the scanner to fire, got ${JSON.stringify(sites)}`);
    assert.ok(sites.some((s) => s.kind === 'equality'));
    assert.ok(sites.some((s) => s.kind === 'membership'));
  });
});

describe('the overlap primitives are what the viewer must use instead', () => {
  it('answers containment hierarchically, not by string prefix', () => {
    assert.equal(contains('BD-T07', 'BD-T07-03O-531'), true);
    assert.equal(contains('BD-T07-03O-531', 'BD-T07'), false);
    // Same frame, different anchors: disjoint, despite a shared string prefix.
    assert.equal(contains('BD-T07-03O', 'BD-T07-03I'), false);
    // A string-prefix test would say true here; the frames differ.
    assert.equal(contains('BV-L', 'BD-T07'), false);
  });

  it('decides overlap between coverings without comparing strings', () => {
    const a = covering(['BD-T07-03O-5']);
    const b = covering(['BD-T07-03O']);
    assert.equal(coveringsOverlap(a, b), true);
    assert.equal(coveringsOverlap(a, covering(['BD-T08-03O'])), false);
  });

  it('answers "same place?" with geometry, and refuses across frames', () => {
    const t = templates();
    const near = samePlace('BD-T07-03O-531', 'BD-T07-03O-531', t, { toleranceMm: 5 });
    assert.equal(near.same, true);
    assert.equal(overlaps('BD-T07-03O-531', 'BD-T07-03O'), true);

    // Across frames it THROWS rather than returning `same: false`. That is the
    // stronger behaviour and the viewer must not paper over it: a false would
    // be indistinguishable from "measured, and they are far apart", whereas
    // the error says the question has no answer because the two millimetres
    // are not in the same coordinate system.
    assert.throws(
      () => samePlace('BD-T07-03O', 'BV-L-471', t, { toleranceMm: 5 }),
      /different coordinate systems/,
    );
    // And it insists on being told the residual, rather than guessing one.
    assert.throws(() => samePlace('BD-T07-03O', 'BD-T07-03O', t, {}), /toleranceMm/);
  });
});
