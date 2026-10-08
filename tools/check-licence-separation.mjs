/**
 * Keeps an asset licence from reaching our Apache-2.0 code.
 *
 * The risk is concrete. If the atlas meshes arrive under CC-BY-SA, the
 * share-alike obligation attaches to the assets and to anything that counts as
 * an adaptation of them. Shipping an asset file verbatim, next to its own
 * licence and attribution, is mere aggregation and keeps the obligation where
 * it belongs. Compiling asset bytes into our bundle, or making our packages
 * depend on the asset package, is the thing that puts our code at risk — and
 * it is also the thing that happens by accident, in one line, months after
 * anyone was thinking about licences.
 *
 * So the boundary is checked structurally, in seven rules:
 *
 *   1. Every package declares `atlas.licenceClass` as "code" or "asset".
 *      Not declared is a failure, never a default.
 *   2. No code package names an asset package in any dependency field.
 *   3. No code package's source imports or requires an asset package.
 *   4. Asset packages are absent from the root workspace list, so npm never
 *      links them into node_modules where rule 3 could be defeated by a
 *      bare specifier that happens to resolve.
 *   5. Every asset package carries its own LICENSE and ATTRIBUTION.md, and
 *      every payload file in it is covered by exactly one attribution entry
 *      that names a licence, a holder and a source.
 *   6. If dist/ exists, no asset payload bytes appear in the shipped
 *      JavaScript, CSS, HTML or prebuilt JSON indexes, and the asset subtree
 *      ships with its LICENSE and ATTRIBUTION.md beside it.
 *   7. Every shipped asset copy is byte-identical to its source. A build that
 *      re-encodes an asset has adapted it, which is what a share-alike
 *      licence attaches to most firmly; copying it verbatim is aggregation.
 *
 * CI tooling under tools/ is deliberately out of scope: validating assets is
 * exactly what a CI gate is for, and tools/ is not published or linked into
 * any code package. Rules 2, 3 and 6 are about the shipped artefact.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, readPackages, sourceFiles, fail, pass, rel } from './lib/repo.mjs';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const DIST = join(REPO_ROOT, 'packages', 'atlas-web', 'dist');

const problems = [];
const report = [];

const packages = readPackages();

// --- Rule 1: every package declares its licence class ----------------------
for (const p of packages) {
  if (p.licenceClass !== 'code' && p.licenceClass !== 'asset') {
    problems.push(
      `${rel(p.dir)}/package.json: \`atlas.licenceClass\` is ${JSON.stringify(p.licenceClass)};` +
        ` must be "code" or "asset".`,
      `  It is not inferred. A package that forgets to declare one is not quietly treated as code.`,
    );
  }
}
if (problems.length > 0) fail('licence separation', problems);

const assets = packages.filter((p) => p.licenceClass === 'asset');
const code = packages.filter((p) => p.licenceClass === 'code');
const assetNames = new Set(assets.map((p) => p.name));

// --- Rule 2: no code package depends on an asset package -------------------
for (const p of code) {
  for (const field of DEP_FIELDS) {
    for (const dep of Object.keys(p.manifest[field] ?? {})) {
      if (assetNames.has(dep)) {
        problems.push(
          `${rel(p.dir)}/package.json: code package declares \`${field}.${dep}\`.`,
          `  A dependency edge from code to assets is a build-time dependency on the asset licence.`,
          `  Load assets as data over HTTP at runtime instead.`,
        );
      }
    }
  }
}

// --- Rule 3: no code package imports an asset package ----------------------
// Matches static imports, dynamic imports, re-exports and require(), by
// package name and by relative path into an asset package directory.
const IMPORTISH = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

for (const p of code) {
  for (const file of sourceFiles(p.dir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORTISH)) {
      const spec = m[1];
      const named = assets.find((a) => spec === a.name || spec.startsWith(`${a.name}/`));
      const viaPath = spec.startsWith('.')
        ? assets.find((a) => !relative(a.dir, join(file, '..', spec)).startsWith('..'))
        : undefined;
      const hit = named ?? viaPath;
      if (hit) {
        const lineNo = text.slice(0, m.index).split('\n').length;
        problems.push(
          `${rel(file)}:${lineNo}: code package imports ${JSON.stringify(spec)} from asset package ${hit.name}.`,
          `  An import links the asset into our bundle. Fetch it as data at runtime instead.`,
        );
      }
    }
  }
}

// --- Rule 4: asset packages are outside the workspace list -----------------
const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const workspaces = rootManifest.workspaces ?? [];
for (const a of assets) {
  const slug = `packages/${a.slug}`;
  if (workspaces.includes(slug) || workspaces.includes('packages/*')) {
    problems.push(
      `root package.json: workspaces includes ${JSON.stringify(
        workspaces.includes(slug) ? slug : 'packages/*',
      )}, which covers asset package ${a.name}.`,
      `  npm would link it into node_modules, where a bare import of ${a.name} resolves`,
      `  and rule 3's intent is defeated by a specifier that looks like any other.`,
    );
  }
}

// --- Rule 5: asset packages carry their own licence and attribution --------
for (const a of assets) {
  for (const required of ['LICENSE', 'ATTRIBUTION.md', 'attribution.json']) {
    if (!existsSync(join(a.dir, required))) {
      problems.push(`${rel(a.dir)}: asset package is missing ${required}.`);
    }
  }
  if (!existsSync(join(a.dir, 'attribution.json'))) continue;

  const attribution = JSON.parse(readFileSync(join(a.dir, 'attribution.json'), 'utf8'));
  const covered = new Map();
  for (const e of attribution.entries ?? []) {
    for (const key of ['id', 'title', 'licence', 'holder', 'source']) {
      if (!e[key]) problems.push(`${rel(a.dir)}/attribution.json: entry ${e.id ?? '(no id)'} is missing \`${key}\`.`);
    }
    if (typeof e.shareAlike !== 'boolean') {
      problems.push(`${rel(a.dir)}/attribution.json: entry ${e.id} must state \`shareAlike\` explicitly.`);
    }
    for (const f of e.files ?? []) {
      if (covered.has(f)) {
        problems.push(`${rel(a.dir)}/attribution.json: ${f} is claimed by both ${covered.get(f)} and ${e.id}.`);
      }
      covered.set(f, e.id);
    }
  }

  // Every payload file must be covered. An unattributed asset is the failure
  // mode that matters: it ships without anyone knowing what it obliges us to.
  for (const dir of a.manifest.atlas?.payloadDirs ?? []) {
    const abs = join(a.dir, dir);
    if (!existsSync(abs)) continue;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (!covered.has(relative(a.dir, p))) {
          problems.push(
            `${rel(p)}: asset payload file has no entry in attribution.json.`,
            `  Add one naming its licence, holder and source, then regenerate ATTRIBUTION.md.`,
          );
        }
      }
    };
    walk(abs);
  }
  for (const [file, id] of covered) {
    if (!existsSync(join(a.dir, file))) {
      problems.push(`${rel(a.dir)}/attribution.json: entry ${id} lists ${file}, which does not exist.`);
    }
  }
}

// --- Rule 6: the built artefact keeps the boundary -------------------------
if (existsSync(DIST)) {
  const distAssets = join(DIST, 'assets');
  for (const required of ['LICENSE', 'ATTRIBUTION.md']) {
    if (!existsSync(join(distAssets, required))) {
      problems.push(
        `dist/assets/${required} is missing.`,
        `  Assets must ship beside their own licence, or serving them stops being mere aggregation.`,
      );
    }
  }

  // Asset payloads must not be inlined into code. Compare by content: a build
  // step that base64s or stringifies a mesh into the bundle would pass any
  // check that only looked at import statements.
  const payloads = [];
  for (const a of assets) {
    for (const dir of a.manifest.atlas?.payloadDirs ?? []) {
      const abs = join(a.dir, dir);
      if (!existsSync(abs)) continue;
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else payloads.push({ file: relative(a.dir, p), bytes: readFileSync(p) });
        }
      };
      walk(abs);
    }
  }

  // Everything outside dist/assets/ is our own output and must contain none of
  // the above. The prebuilt JSON indexes are in scope: an index that inlined
  // mesh vertices would be a derivative of the mesh just as surely as a
  // JavaScript bundle that did.
  const bundleFiles = [];
  const walkDist = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (relative(DIST, p) !== 'assets') walkDist(p);
      } else if (/\.(m?js|cjs|css|html|json)$/.test(e.name)) bundleFiles.push(p);
    }
  };
  walkDist(DIST);

  // Shipped asset copies must be byte-identical to their sources. A build that
  // re-encodes, minifies or re-quantises an asset has adapted it, and an
  // adaptation is what a share-alike licence attaches to most firmly.
  for (const payload of payloads) {
    const shipped = join(distAssets, payload.file);
    if (!existsSync(shipped)) {
      problems.push(
        `dist/assets/${payload.file} is missing, but the asset exists in the package.`,
        `  Every payload must either ship verbatim or not ship at all.`,
      );
      continue;
    }
    if (!readFileSync(shipped).equals(payload.bytes)) {
      problems.push(
        `dist/assets/${payload.file} differs from its source in the asset package.`,
        `  The build transformed the asset instead of copying it, which makes the`,
        `  output an adaptation rather than mere aggregation. Byte-copy it.`,
      );
    }
  }

  for (const bundle of bundleFiles) {
    const text = readFileSync(bundle);
    for (const payload of payloads) {
      // A distinctive interior slice: long enough that a collision is not
      // plausible, short enough to survive reformatting of the surrounding file.
      const probe = payload.bytes.subarray(
        Math.floor(payload.bytes.length / 2),
        Math.floor(payload.bytes.length / 2) + 160,
      );
      if (probe.length >= 64 && text.includes(probe)) {
        problems.push(
          `${rel(bundle)}: contains bytes from asset payload ${payload.file}.`,
          `  The asset is embedded in the bundle, so the bundle is a derivative of it.`,
          `  Emit the asset as its own file under dist/assets/ and fetch it at runtime.`,
        );
      }
    }
  }
  report.push(`dist/: ${bundleFiles.length} bundle file(s) checked against ${payloads.length} asset payload(s).`);
} else {
  report.push(`dist/: not built, artefact rules skipped. Run \`npm run build\` first to check them.`);
}

if (problems.length > 0) fail('licence separation', problems);

pass('licence separation', [
  `${code.length} code package(s): ${code.map((p) => p.name).join(', ')}`,
  `${assets.length} asset package(s): ${assets.map((p) => p.name).join(', ')}`,
  `No dependency, import or workspace edge from code to assets.`,
  ...report,
]);
