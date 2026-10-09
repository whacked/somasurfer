/** Shared fixture loading for the suites. No assertions here. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNameIndex, type NameIndex } from '../../alc/src/index.ts';
import { buildResearchIndex, loadDataset, type ResearchIndex } from '../src/index.ts';
import type { ResearchDataset } from '../src/types.ts';

export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(PKG_DIR, relPath), 'utf8'));
}

export function fixtureNames(): NameIndex {
  const raw = readJson('fixtures/names.fixture.json') as { version: string; structures: [] };
  return buildNameIndex({ version: raw.version, structures: raw.structures });
}

export function fixtureDataset(): ResearchDataset {
  return loadDataset(readJson('fixtures/research.fixture.json'));
}

export function seedDataset(): ResearchDataset {
  return loadDataset(readJson('data/research-seed.json'));
}

export function fixtureIndex(): ResearchIndex {
  return buildResearchIndex({ dataset: fixtureDataset(), names: fixtureNames() });
}

/**
 * Point one structure id somewhere else, keeping the dataset's own declarations
 * consistent with the change.
 *
 * For the must-pass cases, which need a dataset that is wrong in exactly one
 * way. Swapping a `structureId` by hand is wrong in three: the namespace
 * prefix stops matching `structureIdSource`, and `authoredAgainst.partitions`
 * stops accounting for the id. The loader would then refuse the dataset for
 * those reasons and the case would prove nothing about the thing it is named
 * after. So the namespace is kept and the partition entry is moved with it.
 */
export function renameStructure(raw: unknown, from: string, to: string): unknown {
  const d = structuredClone(raw) as {
    findings: { mappings: { structureId: string; structureIdSource: string }[] }[];
    authoredAgainst?: { partitions?: { structureIds: string[] }[] };
  };
  let hits = 0;
  for (const f of d.findings) {
    for (const m of f.mappings) {
      if (m.structureId !== from) continue;
      hits += 1;
      m.structureId = to;
      const colon = to.indexOf(':');
      if (colon > 0) m.structureIdSource = to.slice(0, colon);
    }
  }
  if (hits === 0) throw new Error(`renameStructure: nothing maps ${from}`);
  for (const part of d.authoredAgainst?.partitions ?? []) {
    const at = part.structureIds.indexOf(from);
    if (at >= 0) part.structureIds[at] = to;
  }
  return d;
}
