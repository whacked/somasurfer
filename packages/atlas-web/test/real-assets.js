/**
 * The real asset payloads, read as data, for the stage-B suite.
 *
 * ## Why this is not a licence edge
 *
 * `tools/check-licence-separation.mjs` forbids a code package from *importing*
 * or *depending on* an asset package, and forbids asset bytes appearing in the
 * shipped bundle. It does not forbid reading an asset as data at runtime —
 * that is the pattern it explicitly points at ("Load assets as data over HTTP
 * at runtime instead"), and `readFileSync` is what that sentence means in
 * Node. There is no import specifier here, nothing in `test/` is published or
 * linked into any code package, and nothing read here reaches `dist/`.
 *
 * The line that matters is the one inside `src/`: no module the browser loads
 * may know an asset path, because the paths belong in the catalogue, which is
 * data. `real-assets.test.js` asserts that, so the boundary this file leans on
 * is checked rather than assumed.
 *
 * ## Through the validators, exactly like the browser
 *
 * Templates are parsed from the bytes on disk and then passed through
 * `validateBodyTemplate` / `validateBrainVolumeTemplate`, and the name index
 * through `joinNameIndex` and `buildNameIndex`. That is the whole point of
 * stage B: not "does the viewer work" but "does the viewer work on the objects
 * the asset pipeline actually emits", including every field the fixtures never
 * had.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNameIndex } from '../src/alc.js';
import { joinNameIndex, nameIndexSourceTemplate } from '../src/viewer/nameindex.js';
import { validateBodyTemplate, validateBrainVolumeTemplate } from '../src/viewer/template.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');
export const ASSETS = join(REPO_ROOT, 'packages', 'atlas-assets');

export const BODY_TEMPLATE_FILE = 'templates/bp3d-4.0-adult-body-centroid.body.json';
export const BRAIN_TEMPLATE_FILE = 'templates/icbm152-2009c-asym.brain-volume.json';
export const NAMES_FILE = 'labels/names.json';
export const COVERINGS_FILE = 'labels/coverings.json';

/** An asset document, as the browser would receive it over `fetch`. */
export const assetJson = (file) => JSON.parse(readFileSync(join(ASSETS, file), 'utf8'));

let cache = null;

/**
 * The real template set and name index, validated once.
 *
 * Memoised because `buildNameIndex` normalises 3,478 cells across 57
 * structures and the suite builds it in a dozen tests. The object is treated
 * as read-only by every caller.
 */
export function realAssets() {
  if (cache) return cache;
  const bodyDoc = assetJson(BODY_TEMPLATE_FILE);
  const brainDoc = assetJson(BRAIN_TEMPLATE_FILE);
  const namesDoc = assetJson(NAMES_FILE);
  const coveringsDoc = assetJson(COVERINGS_FILE);
  cache = {
    bodyDoc,
    brainDoc,
    namesDoc,
    coveringsDoc,
    body: validateBodyTemplate(bodyDoc),
    brainVolume: validateBrainVolumeTemplate(brainDoc),
    nameIndex: buildNameIndex(joinNameIndex(namesDoc, coveringsDoc)),
    nameIndexSource: nameIndexSourceTemplate(coveringsDoc),
  };
  return cache;
}

/** The template set in the shape `locate()` and the viewer want. */
export function realTemplates() {
  const { body, brainVolume } = realAssets();
  return { body, brainVolume };
}
