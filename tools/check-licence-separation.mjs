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
 *   6. If dist/ exists, no asset payload bytes appear in any file the build
 *      writes outside dist/assets/ — bundle, prebuilt indexes, or anything
 *      else — raw or base64-encoded, and the asset subtree ships with its
 *      LICENSE and ATTRIBUTION.md beside it.
 *   7. Every shipped asset copy is byte-identical to its source. A build that
 *      re-encodes an asset has adapted it, which is what a share-alike
 *      licence attaches to most firmly; copying it verbatim is aggregation.
 *
 * Two more keep non-commercial content out of a default build (DOG-126):
 *
 *   8. Every attribution entry declares `licenceClass` as "asset" or
 *      "asset-nc". An asset-nc entry's files live only under the package's
 *      `atlas.ncPayloadDirs`, which the build never copies, so it is not
 *      reachable in a default build; it never shares a file, or its bytes, with
 *      a share-alike entry, because BY-SA promises downstream users the
 *      commercial use an NC licence withholds; and if dist/ exists, none of it
 *      is there.
 *   9. Every entry that is not first-party cites its upstream sources, and
 *      every source it cites is recorded in `upstreamSources` with a verdict
 *      from docs/asset-licensing.md. An entry cannot ship from a source that is
 *      not cleared, and it inherits the source's terms: a non-commercial source
 *      makes it asset-nc, a share-alike source makes it share-alike. Citing is
 *      mandatory, not opt-in: an entry that simply omits `sources` would
 *      otherwise skip every one of these checks.
 *
 * And one more makes rule 9's citations checkable rather than declared (DOG-127):
 *
 *  10. A file that holds brain structures (an ATLM mesh file, found by its
 *      magic bytes rather than its name, or a brain structures.json) is
 *      checked structure by structure against the provenance manifest that
 *      tools/build-meshes.mjs generates from the pinned glb. Every structure it
 *      actually contains must be cleared, and every source that structure
 *      derives from must be cited by the entry that ships the file. An entry
 *      citing only cleared sources while its file carries a held structure is
 *      exactly what rule 9 alone lets through. The manifest is re-derived
 *      first, from the inputs it records, so a hand-edited group or source
 *      fails here instead of clearing what it labels. No offline check can see
 *      whether those recorded inputs, or the geometry, really are the glb's:
 *      this checks what a structure is labelled, not what it is.
 *      A set extracted from a volume (the ICBM152 cortex, DOG-151) has no glb
 *      manifest, and its own structures.json is the record. That path is not
 *      the set's to choose: a file saying `source.kind: "volume"` only takes it
 *      when the upstream it names is itself recorded in upstreamSources with
 *      `kind: "volume"` (a reviewed edit to the cleared-source registry), it
 *      names no glb commit (a set that does is judged by its manifest,
 *      whatever it calls itself), and no generated manifest exists for its id. Every
 *      structure's sources must then be exactly that one upstream, whose
 *      verdict must ship. Without these, a glb-derived set could relabel itself
 *      a volume and ship a held structure green (DOG-165 F1).
 *
 *      Body files (DOG-128) are checked the same way, against the body's own
 *      structures.json: every structure an ATLM body file contains must be
 *      listed there, with the sources the entry cites, and an element the body
 *      excludes (the brain) must not ride along under its own id. The body has
 *      one source, BodyParts3D, and its manifest is the build's grouping of
 *      the archive's own element headers; the source is not in the repository,
 *      so that grouping is checked for consistency, not re-derived.
 *
 * CI tooling under tools/ is deliberately out of scope: validating assets is
 * exactly what a CI gate is for, and tools/ is not published or linked into
 * any code package. Rules 2, 3 and 6 are about the shipped artefact.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { REPO_ROOT, readPackages, sourceFiles, fail, pass, rel } from './lib/repo.mjs';
import { MAGIC as ATLM_MAGIC, readMeshBin } from './lib/meshbin.mjs';
import { GROUPS, verifyProvenance } from './lib/brain-provenance.mjs';
import { brainAssetPaths } from './lib/brain-asset-paths.mjs';

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

/**
 * Distinctive slices of a payload, for finding it inside something else.
 *
 * One slice from the middle was enough while every payload was JSON and the
 * failure being guarded was a mesh pasted whole into a bundle. A binary mesh
 * file changes both halves of that. A build can embed one structure's range of
 * it rather than the file, and the natural way to put binary in JavaScript is
 * base64, which a raw slice never matches. So: several windows spread across
 * the file, each also in all three base64 alignments (a window's encoding
 * depends on where it falls relative to the 3-byte groups of the whole).
 *
 * Eight windows across a whole file only land inside a handful of the
 * structures an ATLM file holds (6 of 248 in the low tier, measured), so for a
 * mesh file every structure's range in every section gets a window of its own
 * too: one structure's positions, normals or indices copied out is found.
 */
const PROBE_WINDOWS = 8;
const PROBE_BYTES = 96;
const MIN_PROBE_BYTES = 64;
function windowProbes(window, where) {
  const out = [{ needle: window, base64: false, where }];
  for (let phase = 0; phase < 3; phase += 1) {
    // Drop the first `phase` bytes so the encoded run starts on a group
    // boundary, and the last partial group, whose encoding depends on what
    // follows it.
    const aligned = window.subarray(phase, phase + Math.floor((window.length - phase) / 3) * 3);
    if (aligned.length >= 48) out.push({ needle: aligned.toString('base64'), base64: true, where });
  }
  return out;
}
function payloadProbes(bytes) {
  if (bytes.length < MIN_PROBE_BYTES) return [];
  const width = Math.min(PROBE_BYTES, bytes.length);
  const out = [];
  for (let k = 0; k < PROBE_WINDOWS; k += 1) {
    const at = Math.floor(((bytes.length - width) * (k + 0.5)) / PROBE_WINDOWS);
    out.push(...windowProbes(bytes.subarray(at, at + width), null));
  }
  if (bytes.subarray(0, 4).toString('latin1') === ATLM_MAGIC) {
    // A file that claims to be a mesh and does not parse is rule 10's to report;
    // here it keeps its whole-file windows.
    let mesh = null;
    try {
      mesh = readMeshBin(bytes);
    } catch {
      mesh = null;
    }
    for (const t of mesh?.table ?? []) {
      const isz = mesh.index32 ? 4 : 2;
      for (const [section, start, length] of [
        ['positions', mesh.positions.byteOffset + t.firstVertex * 6, t.vertexCount * 6],
        ['normals', mesh.normals.byteOffset + t.firstVertex * 2, t.vertexCount * 2],
        ['indices', mesh.indices.byteOffset + t.firstIndex * isz, t.indexCount * isz],
      ]) {
        const w = Math.min(PROBE_BYTES, length);
        if (w < MIN_PROBE_BYTES) continue;
        const at = start + Math.floor((length - w) / 2);
        out.push(...windowProbes(bytes.subarray(at, at + w), `structure id ${t.id}'s ${section}`));
      }
    }
  }
  return out;
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
  // JavaScript bundle that did. So is every other file, whatever its
  // extension: a mesh re-emitted as `app/brain.bin` is in the bundle too, and
  // the extension list this used to filter by would never have looked at it.
  const bundleFiles = [];
  const walkDist = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (relative(DIST, p) !== 'assets') walkDist(p);
      } else bundleFiles.push(p);
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

  for (const payload of payloads) payload.probes = payloadProbes(payload.bytes);
  const probeCount = payloads.reduce((n, p) => n + p.probes.length, 0);
  for (const bundle of bundleFiles) {
    const text = readFileSync(bundle);
    for (const payload of payloads) {
      const hit = payload.probes.find((probe) => text.includes(probe.needle));
      if (hit) {
        problems.push(
          `${rel(bundle)}: contains bytes from asset payload ${payload.file}${hit.base64 ? ', base64-encoded' : ''}${hit.where ? ` (${hit.where})` : ''}.`,
          `  The asset is embedded in the bundle, so the bundle is a derivative of it.`,
          `  Emit the asset as its own file under dist/assets/ and fetch it at runtime.`,
        );
      }
    }
  }
  report.push(
    `dist/: ${bundleFiles.length} file(s) outside assets/ checked against ${payloads.length} asset payload(s),` +
      ` ${PROBE_WINDOWS} windows each plus one per mesh structure per section, ${probeCount} probes raw and base64.`,
  );
} else {
  report.push(`dist/: not built, artefact rules skipped. Run \`npm run build\` first to check them.`);
}

// --- Rule 8: non-commercial content is segregated --------------------------
// "Reachable in a default build" is decided by where a file lives, because
// that is what the build decides by: it copies `payloadDirs` and nothing else.
const ENTRY_CLASSES = ['asset', 'asset-nc'];
const VERDICTS_THAT_SHIP = ['cleared', 'cleared-with-conditions'];

/** Every file under `dirs` in `pkgDir`, relative to the package. */
function filesUnder(pkgDir, dirs) {
  const out = [];
  for (const dir of dirs) {
    const abs = join(pkgDir, dir);
    if (!existsSync(abs)) continue;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(relative(pkgDir, p).split('\\').join('/'));
      }
    };
    walk(abs);
  }
  return out;
}

const within = (file, dir) => file === dir || file.startsWith(`${dir.replace(/\/+$/, '')}/`);

/** An interior slice of a payload, as rule 6 takes it. Null if too short to be distinctive. */
function probeOf(bytes) {
  const mid = Math.floor(bytes.length / 2);
  const probe = bytes.subarray(Math.max(0, mid - 80), mid + 80);
  return probe.length >= 64 ? probe : null;
}

let ncEntryCount = 0;
let citingEntryCount = 0;
let brainFileCount = 0;
let brainSlotCount = 0;
let bodyFileCount = 0;
let bodySlotCount = 0;

/**
 * A body structures.json as rule 10's provenance: its structures are what may
 * ship, and every concept it excluded is held under its own FMA id, so a body
 * file that carries one is caught even though structures.json does not list it.
 */
function bodyProvenance(structuresDoc) {
  const provenance = new Map();
  for (const e of structuresDoc.excluded ?? []) {
    if (typeof e.fma === 'string') {
      provenance.set(Number(e.fma.replace(/^FMA/, '')), { name: e.name ?? e.fma, group: 'excluded-from-body', heldBecause: [e.reason], sources: [] });
    }
  }
  for (const s of structuresDoc.structures ?? []) {
    provenance.set(s.id, { name: s.name, group: GROUPS.cleared, sources: Array.isArray(s.sources) ? s.sources : [] });
  }
  return provenance;
}
let volumeFileCount = 0;
let volumeSlotCount = 0;

/**
 * The brain structure ids a file contains, read from the file itself, and the
 * provenance manifest to judge them by. `null` for a file that holds none.
 * The manifest is found through the `source.commit` of the structures.json
 * that sits beside every mesh file; a mesh with no such sibling is an error,
 * never a pass.
 */
function brainStructuresIn(abs, upstream) {
  const bytes = readFileSync(abs);
  let ids;
  let structuresDoc;
  if (bytes.subarray(0, 4).toString('latin1') === ATLM_MAGIC) {
    try {
      ids = readMeshBin(bytes).table.map((t) => t.id);
    } catch (err) {
      return { error: `is an ATLM mesh file that does not parse (${err.message}).` };
    }
    const sibling = join(abs, '..', 'structures.json');
    if (!existsSync(sibling)) return { error: 'is an ATLM mesh file with no structures.json beside it to name its source.' };
    structuresDoc = JSON.parse(readFileSync(sibling, 'utf8'));
  } else if (abs.endsWith('.json')) {
    try {
      structuresDoc = JSON.parse(bytes.toString('utf8'));
    } catch {
      return null;
    }
    if (structuresDoc?.schema === 'atlas-body-structures/1') {
      return { kind: 'body', ids: structuresDoc.structures.map((s) => s.id), provenance: bodyProvenance(structuresDoc) };
    }
    if (structuresDoc?.schema !== 'atlas-brain-structures/1') return null;
    ids = structuresDoc.structures.map((s) => s.id);
  } else return null;
  if (structuresDoc?.schema === 'atlas-body-structures/1') {
    return { kind: 'body', ids, provenance: bodyProvenance(structuresDoc) };
  }

  const commit = structuresDoc?.source?.commit;
  // A set that names a glb commit is judged by its manifest, whatever `kind` says.
  if (structuresDoc?.source?.kind === 'volume' && commit === undefined) return volumeProvenance(structuresDoc, ids, upstream);
  if (typeof commit !== 'string') return { error: 'names no source commit, so its provenance cannot be found.' };
  const manifestPath = join(REPO_ROOT, brainAssetPaths(commit).provenance);
  if (!existsSync(manifestPath)) return { error: `has no provenance manifest at ${rel(manifestPath)}.` };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // The manifest is the judge here, so it is judged first: re-derived from the
  // inputs it records, under §7.3, the committed origin result and the decision
  // holds. A record hand-edited to `cleared` would otherwise clear its structure.
  const originPath = join(manifestPath, '..', 'origin-test-bodyparts3d.json');
  if (!existsSync(originPath)) return { error: `has no origin-test result at ${rel(originPath)} to re-derive its provenance with.` };
  const drift = verifyProvenance(manifest, JSON.parse(readFileSync(originPath, 'utf8')));
  if (drift.length > 0) return { error: `has a provenance manifest that does not re-derive:\n    ${drift.join('\n    ')}` };
  return { ids, provenance: new Map(manifest.structures.map((s) => [s.id, s])) };
}
/**
 * Provenance for a volume-derived set, from its own structures.json, after the
 * registry has vouched that its upstream is a volume. A structure is cleared
 * when its sources are exactly that upstream and the upstream's verdict ships.
 */
function volumeProvenance(doc, ids, upstream) {
  const upstreamId = doc.source?.upstream;
  const rec = upstream.get(upstreamId);
  if (!rec || rec.kind !== 'volume') {
    return { error: `says it is a volume-derived set, but its upstream ${JSON.stringify(upstreamId)} is not recorded in upstreamSources with kind "volume". The registry, not the set, decides which sets skip the generated manifest.` };
  }
  const manifestPath = join(REPO_ROOT, 'packages', 'atlas-assets', 'provenance', `brain-${doc.id}.json`);
  if (existsSync(manifestPath)) return { error: `says it is a volume-derived set, but a generated provenance manifest exists for it at ${rel(manifestPath)}; it is judged by that.` };
  const listed = new Set(doc.structures.map((s) => s.id));
  for (const id of ids) {
    if (!listed.has(id)) return { error: `holds structure id ${id}, which its structures.json does not list.` };
  }
  const provenance = new Map();
  for (const s of doc.structures) {
    const sources = Array.isArray(s.sources) ? s.sources : [];
    const heldBecause = [];
    if (sources.length !== 1 || sources[0] !== upstreamId) heldBecause.push(`its sources are ${JSON.stringify(sources)}, not exactly the set's one upstream, ${upstreamId}`);
    if (!VERDICTS_THAT_SHIP.includes(rec.verdict)) heldBecause.push(`its upstream ${upstreamId} has verdict ${JSON.stringify(rec.verdict)}`);
    provenance.set(s.id, { name: s.name, sources, group: heldBecause.length === 0 ? GROUPS.cleared : 'uncleared-source', heldBecause });
  }
  return { ids, provenance, volume: true };
}
for (const a of assets) {
  if (!existsSync(join(a.dir, 'attribution.json'))) continue;
  const attribution = JSON.parse(readFileSync(join(a.dir, 'attribution.json'), 'utf8'));
  const entries = attribution.entries ?? [];
  const where = `${rel(a.dir)}/attribution.json`;
  const payloadDirs = a.manifest.atlas?.payloadDirs ?? [];
  const ncDirs = a.manifest.atlas?.ncPayloadDirs ?? [];

  for (const e of entries) {
    // Rule 8 decides by directory, so a path must mean what it says.
    // `nc/../labels/x.json` sits in a shipped directory while looking like NC.
    for (const f of e.files ?? []) {
      const normal = posix.normalize(f);
      if (normal !== f || normal.startsWith('..') || posix.isAbsolute(normal)) {
        problems.push(
          `${where}: entry ${e.id} lists ${JSON.stringify(f)}, which is not a normalised path inside the package.`,
          `  Write it as ${JSON.stringify(normal)}: the directory checks compare paths literally.`,
        );
      }
    }
    if (!ENTRY_CLASSES.includes(e.licenceClass)) {
      problems.push(
        `${where}: entry ${e.id} has \`licenceClass\` ${JSON.stringify(e.licenceClass)}; must be "asset" or "asset-nc".`,
        `  It is not inferred. A non-commercial asset that forgets to say so must not read as an ordinary one.`,
      );
    }
  }

  for (const nc of ncDirs) {
    for (const d of payloadDirs) {
      if (within(nc, d) || within(d, nc)) {
        problems.push(
          `${rel(a.dir)}/package.json: ncPayloadDirs entry ${JSON.stringify(nc)} overlaps payloadDirs entry ${JSON.stringify(d)}.`,
          `  The build copies every payloadDir, so an overlapping NC directory ships in every default build.`,
        );
      }
    }
  }

  const ncEntries = entries.filter((e) => e.licenceClass === 'asset-nc');
  const byShareAlike = entries.filter((e) => e.licenceClass === 'asset' && e.shareAlike === true);
  ncEntryCount += ncEntries.length;

  for (const e of ncEntries) {
    for (const f of e.files ?? []) {
      if (payloadDirs.some((d) => within(f, d)) || !ncDirs.some((d) => within(f, d))) {
        problems.push(
          `${rel(a.dir)}/${f}: asset-nc entry ${e.id} is reachable in a default build.`,
          `  It is not under \`atlas.ncPayloadDirs\` (${JSON.stringify(ncDirs)}), and the build copies every`,
          `  payloadDir it is given. Non-commercial content lives in its own directory, off by default.`,
        );
      }
      const sharer = byShareAlike.find((s) => (s.files ?? []).includes(f));
      if (sharer) {
        problems.push(
          `${rel(a.dir)}/${f}: asset-nc entry ${e.id} shares a file with share-alike entry ${sharer.id}.`,
          `  BY-SA promises downstream users the commercial use an NC licence withholds, so`,
          `  non-commercial content can never be merged into a share-alike file.`,
        );
      }
    }
  }

  // Only asset-nc entries may live in an NC directory. Anything else there is
  // either misfiled or an NC payload nobody declared as one.
  const ncFiles = new Set(ncEntries.flatMap((e) => e.files ?? []));
  for (const f of filesUnder(a.dir, ncDirs)) {
    if (!ncFiles.has(f)) {
      problems.push(
        `${rel(a.dir)}/${f}: file in an ncPayloadDir is not claimed by an asset-nc entry.`,
        `  Declare it as asset-nc in attribution.json, or move it out of the non-commercial directory.`,
      );
    }
  }

  // The same merge, by content: an NC payload's bytes inside a share-alike file
  // is the merge whatever the attribution says about either file.
  const ncPayloads = [...ncFiles]
    .filter((f) => existsSync(join(a.dir, f)))
    .map((f) => ({ file: f, probe: probeOf(readFileSync(join(a.dir, f))) }))
    .filter((p) => p.probe);
  for (const s of byShareAlike) {
    for (const f of s.files ?? []) {
      if (!existsSync(join(a.dir, f))) continue;
      const bytes = readFileSync(join(a.dir, f));
      for (const nc of ncPayloads) {
        if (bytes.includes(nc.probe)) {
          problems.push(
            `${rel(a.dir)}/${f}: share-alike entry ${s.id} contains bytes from asset-nc payload ${nc.file}.`,
            `  Non-commercial content has been merged into a BY-SA file. Keep it in its own file.`,
          );
        }
      }
    }
  }

  if (existsSync(DIST)) {
    for (const nc of ncDirs) {
      if (existsSync(join(DIST, 'assets', nc))) {
        problems.push(
          `dist/assets/${nc}/ exists: the non-commercial directory reached a default build.`,
          `  CI builds the default configuration, and the default never ships asset-nc content.`,
        );
      }
    }
    const distFiles = [];
    const walkAll = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walkAll(p);
        else distFiles.push(p);
      }
    };
    walkAll(DIST);
    for (const p of distFiles) {
      const bytes = readFileSync(p);
      for (const nc of ncPayloads) {
        if (bytes.includes(nc.probe)) {
          problems.push(
            `${rel(p)}: contains bytes from asset-nc payload ${nc.file}.`,
            `  Non-commercial content is reachable in a default build.`,
          );
        }
      }
    }
  }

  // --- Rule 9: entries cite cleared upstream sources and inherit their terms --
  const sources = new Map((attribution.upstreamSources ?? []).map((s) => [s.id, s]));
  for (const s of sources.values()) {
    for (const key of ['id', 'title', 'licence', 'holder', 'source', 'verdict', 'verifiedAt']) {
      if (!s[key]) problems.push(`${where}: upstream source ${s.id ?? '(no id)'} is missing \`${key}\`.`);
    }
    for (const key of ['shareAlike', 'nonCommercial']) {
      if (typeof s[key] !== 'boolean') {
        problems.push(`${where}: upstream source ${s.id} must state \`${key}\` explicitly.`);
      }
    }
  }
  // First-party means our own work and nothing else: a GStack holder that is
  // also not share-alike. "Adaptation by GStack" of someone's mesh is not it.
  const firstParty = (e) => e.holder === 'GStack' && e.shareAlike !== true;
  for (const e of entries) {
    // A malformed `sources` is a mistake, never "cites nothing": `"sources": "x"`
    // for `["x"]` is a one-character slip, and read as absent it would wave a
    // first-party entry past every check below.
    if (
      e.sources !== undefined &&
      !(Array.isArray(e.sources) && e.sources.every((id) => typeof id === 'string' && id.length > 0))
    ) {
      problems.push(
        `${where}: entry ${e.id} has \`sources\` ${JSON.stringify(e.sources)}; \`sources\` must be an array of source ids.`,
        `  Write it as a list, even for one source. A malformed list is not read as citing nothing.`,
      );
      continue;
    }
    if (e.sources === undefined || e.sources.length === 0) {
      if (!firstParty(e)) {
        problems.push(
          `${where}: entry ${e.id} is not first-party (holder ${JSON.stringify(e.holder)}) but cites no upstream source.`,
          `  Name every source it derives from in \`sources\`. An entry that omits them would skip`,
          `  every check on what it inherits, including the refusal of uncleared sources.`,
        );
      }
      continue;
    }
    citingEntryCount += 1;
    for (const id of e.sources) {
      const s = sources.get(id);
      if (!s) {
        problems.push(`${where}: entry ${e.id} cites upstream source ${id}, which is not recorded in upstreamSources.`);
        continue;
      }
      if (!VERDICTS_THAT_SHIP.includes(s.verdict)) {
        problems.push(
          `${where}: entry ${e.id} ships from upstream source ${id}, whose verdict is ${JSON.stringify(s.verdict)}.`,
          `  An entry cannot ship from an uncleared source. See docs/asset-licensing.md for what clears it.`,
        );
      }
      if (s.nonCommercial && e.licenceClass !== 'asset-nc') {
        problems.push(
          `${where}: entry ${e.id} derives from non-commercial source ${id} but is not asset-nc.`,
          `  An NC licence travels with what is derived from it.`,
        );
      }
      if (s.shareAlike && e.shareAlike !== true) {
        problems.push(
          `${where}: entry ${e.id} derives from share-alike source ${id} but does not declare \`shareAlike: true\`.`,
        );
      }
    }
  }

  // --- Rule 10: what a brain file contains, against what its entry cites -----
  for (const e of entries) {
    for (const f of e.files ?? []) {
      const abs = join(a.dir, f);
      if (!existsSync(abs)) continue;
      const contained = brainStructuresIn(abs, sources);
      if (contained === null) continue;
      if (contained.kind === 'body') bodyFileCount += 1;
      else if (contained.volume) volumeFileCount += 1;
      else brainFileCount += 1;
      if (contained.error) {
        problems.push(`${rel(abs)}: ${contained.error}`, `  A mesh file whose contents cannot be checked against provenance is not shipped on trust.`);
        continue;
      }
      const cited = new Set(Array.isArray(e.sources) ? e.sources : []);
      for (const id of contained.ids) {
        if (contained.kind === 'body') bodySlotCount += 1;
        else if (contained.volume) volumeSlotCount += 1;
        else brainSlotCount += 1;
        const rec = contained.provenance.get(id);
        if (!rec) {
          problems.push(`${rel(abs)}: holds structure id ${id}, which the provenance manifest does not list.`);
          continue;
        }
        if (rec.group !== GROUPS.cleared) {
          problems.push(
            `${rel(abs)}: entry ${e.id} ships ${rec.name.trim()} (id ${id}), which is held as ${rec.group}.`,
            `  ${(rec.heldBecause ?? []).join('; ')}. A file's citations do not clear what is inside it.`,
          );
        }
        const uncited = rec.sources.filter((src) => !cited.has(src));
        if (uncited.length > 0) {
          problems.push(
            `${rel(abs)}: entry ${e.id} does not cite ${uncited.join(', ')}, which ${rec.name.trim()} (id ${id}) derives from.`,
          );
        }
      }
    }
  }
}
report.push(
  `rule 10: ${brainFileCount} brain file(s), ${brainSlotCount} structure slot(s), each checked against the generated provenance manifest;`
    + ` ${bodyFileCount} body file(s), ${bodySlotCount} structure slot(s), each checked against the body's structures.json;`
    + ` ${volumeFileCount} volume-derived file(s), ${volumeSlotCount} slot(s), each checked against its set's record and a volume source in the registry.`,
);
report.push(
  `${ncEntryCount} asset-nc entr${ncEntryCount === 1 ? 'y' : 'ies'}, none reachable in a default build;` +
    ` ${citingEntryCount} entr${citingEntryCount === 1 ? 'y' : 'ies'} citing upstream sources, all cleared.`,
);

if (problems.length > 0) fail('licence separation', problems);

pass('licence separation', [
  `${code.length} code package(s): ${code.map((p) => p.name).join(', ')}`,
  `${assets.length} asset package(s): ${assets.map((p) => p.name).join(', ')}`,
  `No dependency, import or workspace edge from code to assets.`,
  ...report,
]);
