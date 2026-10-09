/**
 * Produces the numbers published in docs/alc-1-spec.md.
 *
 * Two things are being measured:
 *
 *  1. Cell size per refinement digit, so the UI can state precision honestly.
 *  2. How many digits survive a given cross-subject registration residual.
 *     This is the number that decides the default display precision. An
 *     address is only worth printing to the digit at which two registered
 *     subjects still agree.
 */

import { encodeBody, encodeBrainVolume, locate, cellAreaMm2 } from '../src/index.ts';
import { auditBodyTemplate, bodyLocalToMm } from '../src/frames/bodySpine.ts';
import { bvLocalToMm } from '../src/frames/brainVolume.ts';
import {
  ADULT_MALE,
  ADULT_TALL,
  BRAIN_ADULT,
  CHILD,
  buildBodyTemplate,
  buildBrainTemplate,
  rng,
} from '../src/testing/syntheticTemplates.ts';

const templates = {
  adult: buildBodyTemplate(ADULT_MALE),
  child: buildBodyTemplate(CHILD),
  tall: buildBodyTemplate(ADULT_TALL),
};
const brain = buildBrainTemplate(BRAIN_ADULT);

const line = (s) => console.log(s);
const fmt = (x, d = 2) => x.toFixed(d).padStart(7);

line('## Template admissibility (spine curvature vs body radius)\n');
line('| template | admissible | violating levels |');
line('| --- | --- | --- |');
for (const [name, t] of Object.entries(templates)) {
  const audit = auditBodyTemplate(t);
  const v = audit.violations
    .map((x) => `${x.level} (r=${x.maxRadiusMm.toFixed(0)}mm > R=${x.curvatureRadiusMm.toFixed(0)}mm)`)
    .join(', ');
  line(`| ${name} (${t.id}) | ${audit.locallyAdmissible ? 'yes' : 'NO'} | ${v || '-'} |`);
}

line('\n## BD cell size by refinement digits, adult template at T07 and L03\n');
line('| digits | axial mm | arc mm @ r=0.8 | radial mm | T07 cells in level | L03 axial mm |');
line('| --- | --- | --- | --- | --- | --- |');
for (let d = 0; d <= 7; d += 1) {
  const addrT = d === 0 ? 'BD-T07-03O' : `BD-T07-03O-${'5'.repeat(d)}`;
  const addrL = d === 0 ? 'BD-L03-03O' : `BD-L03-03O-${'5'.repeat(d)}`;
  const t = locate(addrT, { body: templates.adult });
  const l = locate(addrL, { body: templates.adult });
  line(
    `| ${d} | ${fmt(t.extentMm[0])} | ${fmt(t.extentMm[1])} | ${fmt(t.extentMm[2])} | ${24 * 8 ** d} | ${fmt(l.extentMm[0])} |`,
  );
}

line('\n## BV cell size by refinement digits, adult brain template\n');
line('| digits | lateral mm | ant-post mm | sup-inf mm | cells per hemisphere |');
line('| --- | --- | --- | --- | --- |');
for (let d = 0; d <= 8; d += 1) {
  const addr = d === 0 ? 'BV-L' : `BV-L-${'5'.repeat(d)}`;
  const r = locate(addr, { brainVolume: brain });
  line(`| ${d} | ${fmt(r.extentMm[0])} | ${fmt(r.extentMm[1])} | ${fmt(r.extentMm[2])} | ${8 ** d} |`);
}

line('\n## BR cortical cell size by refinement digits (mean over one hemisphere)\n');
line('| digits | cells per hemisphere | mean area mm2 | equivalent square mm |');
line('| --- | --- | --- | --- |');
for (let d = 1; d <= 6; d += 1) {
  const a = cellAreaMm2(d);
  line(`| ${d} | ${Math.round(90000 / a)} | ${a < 1 ? a.toFixed(4) : a.toFixed(2)} | ${Math.sqrt(a).toFixed(2)} |`);
}

/**
 * Perturb a point by a random vector of magnitude `delta` and report how often
 * the first k digits of the address survive. `delta` stands in for the residual
 * error left over after registering two different subjects to the template.
 */
function survival(encode, sample, deltas, maxDigits, trials) {
  const out = [];
  for (const delta of deltas) {
    const r = rng(1234);
    const agree = new Array(maxDigits + 1).fill(0);
    for (let i = 0; i < trials; i += 1) {
      const p = sample(r);
      // Uniform random direction.
      let x = r() * 2 - 1;
      let y = r() * 2 - 1;
      let z = r() * 2 - 1;
      const n = Math.hypot(x, y, z) || 1;
      x = (x / n) * delta;
      y = (y / n) * delta;
      z = (z / n) * delta;
      const a = encode(p, maxDigits);
      const b = encode([p[0] + x, p[1] + y, p[2] + z], maxDigits);
      for (let k = 0; k <= maxDigits; k += 1) {
        // Compare the address truncated to k refinement digits.
        const ta = a.slice(0, a.length - (maxDigits - k));
        const tb = b.slice(0, b.length - (maxDigits - k));
        if (ta === tb) agree[k] += 1;
      }
    }
    out.push({ delta, rates: agree.map((c) => c / trials) });
  }
  return out;
}

const DELTAS = [1, 2, 5, 10, 20];
const TRIALS = 20000;

line('\n## Digits that survive a cross-subject registration residual\n');
line('Share of points whose address is unchanged after displacing it by the residual.');
line('The right-most column at or above 0.95 is the deepest digit worth displaying.\n');

{
  const maxDigits = 6;
  const rows = survival(
    (p, d) => encodeBody(templates.adult, p, d).address,
    (r) => {
      const slab = templates.adult.slabs[7 + Math.floor(r() * 12)]; // thoracic and lumbar
      return bodyLocalToMm(templates.adult, { level: slab.label, u: r(), t: r(), r: 0.2 + r() * 0.75 });
    },
    DELTAS,
    maxDigits,
    TRIALS,
  );
  line('### BD, adult template, thoracolumbar trunk\n');
  line(`| residual mm | ${Array.from({ length: maxDigits + 1 }, (_, k) => `${k}d`).join(' | ')} |`);
  line(`| --- | ${Array(maxDigits + 1).fill('---').join(' | ')} |`);
  for (const row of rows) {
    line(`| ${row.delta} | ${row.rates.map((x) => x.toFixed(2)).join(' | ')} |`);
  }
}

{
  const maxDigits = 8;
  const rows = survival(
    (p, d) => encodeBrainVolume(brain, p, d).address,
    (r) => bvLocalToMm(brain, r() < 0.5 ? 'L' : 'R', { a: r() * 0.95, b: 0.1 + r() * 0.8, c: 0.1 + r() * 0.8 }),
    DELTAS,
    maxDigits,
    TRIALS,
  );
  line('\n### BV, adult brain template\n');
  line(`| residual mm | ${Array.from({ length: maxDigits + 1 }, (_, k) => `${k}d`).join(' | ')} |`);
  line(`| --- | ${Array(maxDigits + 1).fill('---').join(' | ')} |`);
  for (const row of rows) {
    line(`| ${row.delta} | ${row.rates.map((x) => x.toFixed(2)).join(' | ')} |`);
  }
}

/**
 * The metric that actually matters.
 *
 * The tables above measure exact string agreement, which is dominated by
 * cell-boundary flipping rather than by registration error: any discrete grid
 * splits some neighbouring points into different cells no matter how small the
 * displacement. Open Location Code has the same property.
 *
 * What a caller actually needs to know is how far apart the two addresses
 * place the point. So: displace by the residual, encode both, decode both back
 * to cell centres, and measure that distance.
 */
line('\n## Localisation error vs exact-string agreement\n');
line('Encode a point and a copy displaced by the residual, then measure the distance');
line('between the two decoded cell centres. This is what "the same place" should mean.\n');
line('| frame | digits | residual mm | string agreement | median centre gap mm | p95 centre gap mm |');
line('| --- | --- | --- | --- | --- | --- |');

function localisation(encode, decode, sample, digits, delta, trials) {
  const r = rng(99);
  const gaps = [];
  let same = 0;
  for (let i = 0; i < trials; i += 1) {
    const p = sample(r);
    let x = r() * 2 - 1;
    let y = r() * 2 - 1;
    let z = r() * 2 - 1;
    const n = Math.hypot(x, y, z) || 1;
    const q = [p[0] + (x / n) * delta, p[1] + (y / n) * delta, p[2] + (z / n) * delta];
    const a = encode(p, digits);
    const b = encode(q, digits);
    if (a === b) same += 1;
    const ca = decode(a);
    const cb = decode(b);
    gaps.push(Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]));
  }
  gaps.sort((m, n2) => m - n2);
  return {
    agreement: same / trials,
    median: gaps[Math.floor(gaps.length * 0.5)],
    p95: gaps[Math.floor(gaps.length * 0.95)],
  };
}

const bodySample = (r) => {
  const slab = templates.adult.slabs[7 + Math.floor(r() * 12)];
  return bodyLocalToMm(templates.adult, { level: slab.label, u: r(), t: r(), r: 0.2 + r() * 0.75 });
};
const brainSample = (r) =>
  bvLocalToMm(brain, r() < 0.5 ? 'L' : 'R', { a: r() * 0.95, b: 0.1 + r() * 0.8, c: 0.1 + r() * 0.8 });

for (const [digits, delta] of [
  [2, 2],
  [2, 5],
  [3, 2],
  [3, 5],
]) {
  const m = localisation(
    (p, d) => encodeBody(templates.adult, p, d).address,
    (a) => locate(a, { body: templates.adult }).pointMm,
    bodySample,
    digits,
    delta,
    8000,
  );
  line(`| BD | ${digits} | ${delta} | ${m.agreement.toFixed(2)} | ${m.median.toFixed(1)} | ${m.p95.toFixed(1)} |`);
}
for (const [digits, delta] of [
  [4, 2],
  [4, 5],
  [5, 2],
  [5, 5],
]) {
  const m = localisation(
    (p, d) => encodeBrainVolume(brain, p, d).address,
    (a) => locate(a, { brainVolume: brain }).pointMm,
    brainSample,
    digits,
    delta,
    8000,
  );
  line(`| BV | ${digits} | ${delta} | ${m.agreement.toFixed(2)} | ${m.median.toFixed(1)} | ${m.p95.toFixed(1)} |`);
}

line('\n## Address lengths at the recommended precision\n');
for (const a of ['BD-T07-03O-531', 'BV-L-471025', 'BR-L-7A3F']) {
  line(`- \`${a}\` — ${a.length} characters`);
}
