/** Shared helpers for the CI gate scripts. No dependencies, on purpose. */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const PACKAGES_DIR = join(REPO_ROOT, 'packages');

/**
 * Every package in `packages/`, with its manifest and its declared licence
 * class. `licenceClass` is mandatory and deliberately not inferred: a new
 * package that forgets to declare one fails the licence separation check
 * rather than being silently treated as code.
 */
export function readPackages() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(PACKAGES_DIR, e.name, 'package.json')))
    .map((e) => {
      const dir = join(PACKAGES_DIR, e.name);
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      return {
        slug: e.name,
        dir,
        manifest,
        name: manifest.name ?? e.name,
        licenceClass: manifest.atlas?.licenceClass ?? null,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Source files under `dir`, skipping build output and dependencies. */
export function sourceFiles(dir, exts = ['.ts', '.mts', '.js', '.mjs', '.cjs', '.jsx', '.tsx']) {
  const skip = new Set(['node_modules', 'dist', '.git']);
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function rel(p) {
  return p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
}

/** Print a failure block and exit non-zero. One shape for every gate. */
export function fail(gate, lines) {
  console.error(`\n✗ ${gate}\n`);
  for (const l of lines) console.error(`  ${l}`);
  console.error('');
  process.exit(1);
}

export function pass(gate, lines = []) {
  console.log(`✓ ${gate}`);
  for (const l of lines) console.log(`  ${l}`);
}
