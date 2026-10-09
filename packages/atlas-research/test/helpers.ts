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
