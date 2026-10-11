/**
 * The 40-structure brain QA sample (DOG-123, 17:02 hand-off): what W8a picks,
 * and what it expects each pick to return.
 *
 * The rule as handed off, and where the licence forced a change:
 *
 *   - N = 40, stratified over the 12 source categories, at least 2 per category.
 *     The 40 are drawn from the structures that SHIP. `white_matter` has none:
 *     all 9 are held under docs/asset-licensing.md 7.3. So the 40 cover the 11
 *     categories that ship, and `white_matter` contributes WITHHELD CONTROLS
 *     instead: two structures W8a must find absent, with the licence reason. A
 *     sample that put held structures among the 40 would have QA asserting that
 *     pickable things are pickable for 38 of them.
 *   - Both sides wherever a structure is paired: the sampling unit is a label,
 *     drawn with all its sides.
 *   - Always the subthalamic nucleus, the substantia nigra and the nucleus
 *     accumbens, the smallest nuclei and the ones decimation threatens most.
 *   - Drawn once, with a fixed seed. The gate checks the committed fixture
 *     against these rules and against what ships; it does not redraw it, so a
 *     later clearance does not silently change the sample QA has already run.
 */

export const SAMPLE_RULES = Object.freeze({
  size: 40,
  minPerCategory: 2,
  required: ['Subthalamic nucleus', 'Substantia nigra', 'Nucleus accumbens'],
  seed: 0x0d06127,
  withheldControlsPerUnshippableCategory: 2,
});

/** mulberry32: a small, well-known seeded generator, so the draw reproduces anywhere. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Units: one per label within a category, holding every side of it. */
function unitsOf(structures) {
  const byKey = new Map();
  for (const s of structures) {
    const key = `${s.category}\u0000${s.label}`;
    if (!byKey.has(key)) byKey.set(key, { category: s.category, label: s.label, members: [] });
    byKey.get(key).members.push(s);
  }
  for (const u of byKey.values()) u.members.sort((a, b) => a.name.localeCompare(b.name));
  return [...byKey.values()].sort((a, b) => (a.category + a.label).localeCompare(b.category + b.label));
}

/**
 * Draw the sample from a brain structures.json document. Deterministic for a
 * given document and seed.
 */
export function drawSample(doc, rules = SAMPLE_RULES) {
  const rand = mulberry32(rules.seed);
  const shipped = unitsOf(doc.structures);
  const categories = [...new Set([...doc.structures, ...doc.excluded].map((s) => s.category))].sort();
  const shippable = categories.filter((c) => shipped.some((u) => u.category === c));
  const unshippable = categories.filter((c) => !shippable.includes(c));

  // Quotas: the minimum everywhere, the rest in proportion to what ships.
  const counts = Object.fromEntries(shippable.map((c) => [c, doc.structures.filter((s) => s.category === c).length]));
  const total = Object.values(counts).reduce((n, x) => n + x, 0);
  const spare = rules.size - rules.minPerCategory * shippable.length;
  const raw = shippable.map((c) => ({ c, share: (spare * counts[c]) / total }));
  const quota = Object.fromEntries(raw.map(({ c, share }) => [c, rules.minPerCategory + Math.floor(share)]));
  let left = rules.size - Object.values(quota).reduce((n, x) => n + x, 0);
  for (const { c } of [...raw].sort((a, b) => (b.share % 1) - (a.share % 1) || a.c.localeCompare(b.c))) {
    if (left <= 0) break;
    quota[c] += 1;
    left -= 1;
  }
  for (const c of shippable) quota[c] = Math.min(quota[c], counts[c]);

  const picked = new Map(shippable.map((c) => [c, []]));
  const size = (c) => picked.get(c).reduce((n, u) => n + u.members.length, 0);
  for (const label of rules.required) {
    const u = shipped.find((x) => x.label === label);
    if (!u) throw new Error(`required structure ${label} does not ship`);
    picked.get(u.category).push(u);
  }
  // Seeded order within each category; take units while they fit the quota,
  // preferring an exact fit, so pairs are never split to land on a number.
  for (const c of shippable) {
    const pool = shipped.filter((u) => u.category === c && !picked.get(c).includes(u));
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const u of pool) {
      if (size(c) >= quota[c]) break;
      if (size(c) + u.members.length <= quota[c]) picked.get(c).push(u);
    }
    // A category whose only remaining units are pairs, one short: take a pair.
    if (size(c) < Math.max(rules.minPerCategory, quota[c])) {
      const u = pool.find((x) => !picked.get(c).includes(x));
      if (u) picked.get(c).push(u);
    }
  }
  // Trim back to exactly N from the largest categories, never below their
  // quota floor of minPerCategory, never removing a required unit.
  let n = shippable.reduce((k, c) => k + size(c), 0);
  for (const c of [...shippable].sort((a, b) => size(b) - size(a))) {
    while (n > rules.size) {
      const removable = [...picked.get(c)].reverse().find((u) =>
        !rules.required.includes(u.label) && size(c) - u.members.length >= rules.minPerCategory && n - u.members.length >= rules.size);
      if (!removable) break;
      picked.set(c, picked.get(c).filter((u) => u !== removable));
      n -= removable.members.length;
    }
  }

  const sample = shippable.flatMap((c) => picked.get(c).flatMap((u) => u.members.map((s) => ({
    id: s.id,
    name: s.name,
    label: s.label,
    category: s.category,
    side: s.side,
    expect: { pickable: true, name: s.label },
  }))));

  const withheldControls = unshippable.flatMap((c) => {
    const pool = unitsOf(doc.excluded.filter((s) => s.category === c).map((s) => ({ ...s, label: s.name.replace(/\.[lr]$/, '') })));
    const out = [];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const u of pool) {
      if (out.length >= rules.withheldControlsPerUnshippableCategory) break;
      if (out.length + u.members.length <= rules.withheldControlsPerUnshippableCategory) out.push(...u.members);
    }
    return out.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      side: s.side,
      expect: { pickable: false, reason: s.group, heldBecause: s.heldBecause },
    }));
  });

  return { categories, shippable, unshippable, quota, sample, withheldControls };
}

/** Check a committed sample against the rules and the shipped document. Returns problems. */
export function checkSample(fixture, doc, rules = SAMPLE_RULES) {
  const problems = [];
  const shipped = new Map(doc.structures.map((s) => [s.id, s]));
  const excluded = new Map(doc.excluded.map((s) => [s.id, s]));
  const sample = fixture.sample ?? [];
  if (sample.length !== rules.size) problems.push(`the sample has ${sample.length} structures, not ${rules.size}.`);
  for (const s of sample) {
    const real = shipped.get(s.id);
    if (!real) problems.push(`sampled ${s.name} (id ${s.id}) does not ship.`);
    else if (real.name !== s.name || real.category !== s.category) problems.push(`sampled id ${s.id} is ${real.name} (${real.category}), not ${s.name}.`);
  }
  const categories = [...new Set([...doc.structures, ...doc.excluded].map((s) => s.category))];
  for (const c of categories) {
    const inSample = sample.filter((s) => s.category === c).length;
    const ships = doc.structures.some((s) => s.category === c);
    if (ships && inSample < rules.minPerCategory) problems.push(`category ${c} has ${inSample} sampled structure(s), under ${rules.minPerCategory}.`);
    if (!ships) {
      const controls = (fixture.withheldControls ?? []).filter((s) => s.category === c);
      if (controls.length < rules.withheldControlsPerUnshippableCategory) {
        problems.push(`category ${c} ships nothing, and has ${controls.length} withheld control(s), under ${rules.withheldControlsPerUnshippableCategory}.`);
      }
    }
  }
  for (const label of rules.required) {
    const sides = doc.structures.filter((s) => s.label === label);
    for (const s of sides) if (!sample.some((x) => x.id === s.id)) problems.push(`required ${s.name} is not in the sample.`);
  }
  // Both sides wherever paired.
  for (const s of sample) {
    const siblings = doc.structures.filter((x) => x.label === s.label && x.category === s.category);
    for (const x of siblings) if (!sample.some((y) => y.id === x.id)) problems.push(`${s.name} is sampled without ${x.name}.`);
  }
  for (const c of fixture.withheldControls ?? []) {
    if (shipped.has(c.id)) problems.push(`withheld control ${c.name} ships; a control must be absent.`);
    else if (!excluded.has(c.id)) problems.push(`withheld control ${c.name} (id ${c.id}) is not a held structure.`);
  }
  if (fixture.seed !== rules.seed) problems.push(`the sample records seed ${fixture.seed}, not ${rules.seed}.`);
  return problems;
}
