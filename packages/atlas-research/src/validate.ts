/**
 * The loader. The only sanctioned way to turn parsed JSON into a
 * `ResearchDataset`.
 *
 * Why a loader rather than a type assertion: the research dataset is
 * curator-supplied, hand-edited, and read by a static site with no server in
 * front of it. Every field below is therefore validated, and every failure is
 * a refusal rather than a repair. A dataset that loads is one whose links,
 * addresses, dates and enums have all been checked; a dataset that does not
 * load fails the build with the list of what is wrong.
 *
 * Two deliberate choices about *how* it refuses:
 *
 *  - **Every problem is collected, not the first one.** Curation is a batch
 *    activity. A loader that dies on the first bad row makes a curator run the
 *    build thirty times; one that reports thirty problems makes them run it
 *    twice. The cost is that validation cannot early-return, so each rule has
 *    to tolerate upstream fields being absent.
 *  - **Nothing is coerced, normalised away, or defaulted.** A missing
 *    `locatorStatus` is not `'not-recorded'`; it is a problem. The whole point
 *    of the schema is that absent evidence is *stated*, and a loader that
 *    supplies the statement on the curator's behalf has invented provenance.
 *
 * The one normalisation performed is `covering()` on `spatial.cells`, which is
 * the library's own canonicalisation and is required before the cells can be
 * compared with anything. It is applied in `dataset.ts`, at resolution, not
 * here — here the cells are only *checked* to parse, so that the stored dataset
 * and the file on disk stay the same thing.
 */

import { AlcError, covering, parse } from '../../alc/src/index.ts';

import { isSafeUrl } from './links.ts';
import type {
  Confidence,
  EvidenceKind,
  Finding,
  IdentifierKind,
  Paper,
  ProvenanceBasis,
  RegionMapping,
  ResearchDataset,
  SpatialDetail,
} from './types.ts';

export interface ValidationProblem {
  /** JSON-ish path to the offending value, e.g. `findings[3].mappings[0].evidence`. */
  readonly path: string;
  readonly message: string;
}

export class ResearchDataError extends Error {
  readonly problems: readonly ValidationProblem[];
  constructor(problems: readonly ValidationProblem[]) {
    const head = `research dataset rejected: ${problems.length} problem${problems.length === 1 ? '' : 's'}`;
    super([head, ...problems.map((p) => `  ${p.path}: ${p.message}`)].join('\n'));
    this.name = 'ResearchDataError';
    this.problems = Object.freeze([...problems]);
  }
}

const SCHEMA_ID = 'research/1';

/** Longest string any text field may hold. Generous for a statement, finite for a parser. */
const MAX_TEXT = 2000;
const MAX_SHORT_TEXT = 300;

/** The global digit cap ALC enforces; a dataset may not claim finer. */
const MAX_DIGITS = 16;

const IDENTIFIER_KINDS: readonly IdentifierKind[] = ['doi', 'pmid', 'pmcid', 'isbn', 'url', 'none'];
const EVIDENCE_KINDS: readonly EvidenceKind[] = ['abstract', 'figure', 'table', 'section', 'page', 'supplementary'];
const BASES: readonly ProvenanceBasis[] = [
  'published-parcellation',
  'published-coordinates',
  'published-text',
  'curator-inference',
];
const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low'];

const ID_PATTERNS = {
  paper: /^paper:[a-z0-9]+(?:[-./][a-z0-9]+)*$/,
  finding: /^finding:[a-z0-9]+(?:[-./][a-z0-9]+)*$/,
  mapping: /^map:[a-z0-9]+(?:[-./:][a-z0-9]+)*$/i,
};

/** `10.1038/nature18933`. Registrant then anything non-blank; the registry's own shape. */
const DOI_RE = /^10\.\d{4,9}\/\S+$/;
const PMID_RE = /^\d{1,9}$/;
const PMCID_RE = /^PMC\d{1,9}$/;
const ISBN_RE = /^[\dX-]{10,17}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Control characters are rejected in every text field.
 *
 * Not because they break this parser — JSON already carried them fine — but
 * because they are invisible in every tool a reviewer would use to check the
 * data, and because a right-to-left override or a zero-width joiner inside a
 * citation is a way to make a rendered string say something other than what
 * the file says. A curated dataset has no legitimate use for one.
 */
// Written with escapes rather than literals so this file stays plain ASCII.
const CONTROL_RE = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\ufeff]');

class Collector {
  readonly problems: ValidationProblem[] = [];
  add(path: string, message: string): void {
    this.problems.push({ path, message });
  }
  /** True when nothing was added since `mark`. Lets a rule skip dependent checks. */
  cleanSince(mark: number): boolean {
    return this.problems.length === mark;
  }
  get mark(): number {
    return this.problems.length;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A non-empty, control-free, length-capped string. The default shape of every text field. */
function text(c: Collector, path: string, v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== 'string') {
    c.add(path, `expected a string, got ${v === undefined ? 'nothing' : typeof v}`);
    return null;
  }
  if (v.trim() === '') {
    c.add(path, 'must not be empty or whitespace');
    return null;
  }
  if (v.length > max) {
    c.add(path, `longer than the ${max}-character cap (${v.length})`);
    return null;
  }
  if (CONTROL_RE.test(v)) {
    c.add(path, 'contains a control, bidi or zero-width character');
    return null;
  }
  return v;
}

function enumValue<T extends string>(c: Collector, path: string, v: unknown, allowed: readonly T[]): T | null {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  c.add(path, `must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}, got ${JSON.stringify(v)}`);
  return null;
}

function isoDate(c: Collector, path: string, v: unknown): string | null {
  const s = text(c, path, v, 10);
  if (s === null) return null;
  if (!DATE_RE.test(s)) {
    c.add(path, `must be an ISO date YYYY-MM-DD, got ${JSON.stringify(s)}`);
    return null;
  }
  // `2026-02-30` matches the pattern and is not a date. Round-trip to catch it.
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    c.add(path, `is not a real calendar date: ${JSON.stringify(s)}`);
    return null;
  }
  return s;
}

function integer(c: Collector, path: string, v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    c.add(path, `expected an integer, got ${JSON.stringify(v)}`);
    return null;
  }
  if (v < min || v > max) {
    c.add(path, `must be between ${min} and ${max}, got ${v}`);
    return null;
  }
  return v;
}

function stringArray(c: Collector, path: string, v: unknown, { minLength = 0, max = MAX_SHORT_TEXT } = {}): string[] | null {
  if (!Array.isArray(v)) {
    c.add(path, `expected an array, got ${v === undefined ? 'nothing' : typeof v}`);
    return null;
  }
  if (v.length < minLength) {
    c.add(path, `needs at least ${minLength} entr${minLength === 1 ? 'y' : 'ies'}, got ${v.length}`);
    return null;
  }
  const out: string[] = [];
  v.forEach((entry, i) => {
    const s = text(c, `${path}[${i}]`, entry, max);
    if (s !== null) out.push(s);
  });
  return out.length === v.length ? out : null;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function provenance(c: Collector, path: string, v: unknown) {
  if (!isObject(v)) {
    c.add(path, 'every paper, finding and mapping needs a provenance record');
    return null;
  }
  const assertedBy = text(c, `${path}.assertedBy`, v.assertedBy, MAX_SHORT_TEXT);
  const assertedOn = isoDate(c, `${path}.assertedOn`, v.assertedOn);
  const basis = enumValue(c, `${path}.basis`, v.basis, BASES);
  const confidence = enumValue(c, `${path}.confidence`, v.confidence, CONFIDENCES);

  let note: string | undefined;
  if (v.note !== undefined) {
    const s = text(c, `${path}.note`, v.note);
    if (s !== null) note = s;
  }
  // The rule the whole basis enum exists for: an inference must say what was
  // inferred, so the viewer can show a mapping the paper does not state as
  // something other than a reading of it.
  if (basis === 'curator-inference' && note === undefined) {
    c.add(`${path}.note`, 'required when basis is "curator-inference": say what was inferred and from what');
  }
  if (assertedBy === null || assertedOn === null || basis === null || confidence === null) return null;
  return { assertedBy, assertedOn, basis, confidence, ...(note === undefined ? {} : { note }) };
}

// ---------------------------------------------------------------------------
// Papers
// ---------------------------------------------------------------------------

function identifier(c: Collector, path: string, v: unknown) {
  if (!isObject(v)) {
    c.add(path, 'needs an identifier record; use { "kind": "none", "value": null } when there is none');
    return null;
  }
  const kind = enumValue(c, `${path}.kind`, v.kind, IDENTIFIER_KINDS);
  if (kind === null) return null;

  if (kind === 'none') {
    if (v.value !== null) {
      c.add(`${path}.value`, 'must be null when kind is "none"; an absent identifier is a stated fact, not a blank');
      return null;
    }
    return { kind, value: null as null };
  }
  const value = text(c, `${path}.value`, v.value, MAX_SHORT_TEXT);
  if (value === null) return null;

  // Shape checks only. Nothing here resolves an identifier: resolving would
  // mean fetching, and curated links are rendered, never fetched.
  const shaped: Record<string, RegExp | null> = {
    doi: DOI_RE,
    pmid: PMID_RE,
    pmcid: PMCID_RE,
    isbn: ISBN_RE,
    url: null,
  };
  const re = shaped[kind];
  if (re && !re.test(value)) {
    c.add(`${path}.value`, `does not look like a ${kind}: ${JSON.stringify(value)}`);
    return null;
  }
  if (kind === 'url' && !isSafeUrl(value)) {
    c.add(`${path}.value`, 'a url identifier must be an absolute http(s) URL');
    return null;
  }
  return { kind, value };
}

function paper(c: Collector, path: string, v: unknown): Paper | null {
  if (!isObject(v)) {
    c.add(path, 'expected a paper object');
    return null;
  }
  const mark = c.mark;
  const id = text(c, `${path}.id`, v.id, MAX_SHORT_TEXT);
  if (id !== null && !ID_PATTERNS.paper.test(id)) {
    c.add(`${path}.id`, `must match ${ID_PATTERNS.paper} (lower-case, "paper:" prefixed), got ${JSON.stringify(id)}`);
  }
  const title = text(c, `${path}.title`, v.title);
  const authors = stringArray(c, `${path}.authors`, v.authors, { minLength: 1 });
  // 1500 is before anatomy had journals; `+1` allows a paper in press.
  const year = integer(c, `${path}.year`, v.year, 1500, new Date().getUTCFullYear() + 1);
  const venue = text(c, `${path}.venue`, v.venue, MAX_SHORT_TEXT);
  const ident = identifier(c, `${path}.identifier`, v.identifier);
  const prov = provenance(c, `${path}.provenance`, v.provenance);

  let sourceUrl: string | null = null;
  if (v.sourceUrl === null || v.sourceUrl === undefined) {
    if (v.sourceUrl === undefined) c.add(`${path}.sourceUrl`, 'required; use null when there is no source URL');
  } else if (!isSafeUrl(v.sourceUrl)) {
    // Rejected, not defanged. A dataset that ships a `javascript:` link has a
    // curation problem that a null href at runtime would hide.
    c.add(
      `${path}.sourceUrl`,
      `must be an absolute http(s) URL, got ${JSON.stringify(String(v.sourceUrl).slice(0, 80))}`,
    );
  } else {
    sourceUrl = v.sourceUrl as string;
  }

  if (!c.cleanSince(mark)) return null;
  return Object.freeze({
    id: id!,
    title: title!,
    authors: Object.freeze(authors!),
    year: year!,
    venue: venue!,
    identifier: Object.freeze(ident!),
    sourceUrl,
    provenance: Object.freeze(prov!),
  });
}

// ---------------------------------------------------------------------------
// Findings and mappings
// ---------------------------------------------------------------------------

function spatial(c: Collector, path: string, v: unknown): SpatialDetail | null {
  if (!isObject(v)) {
    c.add(path, 'every mapping needs a spatial record; use { "kind": "region-level", "reason": ... } when there is no finer location');
    return null;
  }
  const mark = c.mark;
  const kind = enumValue(c, `${path}.kind`, v.kind, ['region-level', 'cells', 'coordinates'] as const);
  if (kind === null) return null;

  if (kind === 'region-level') {
    const reason = text(c, `${path}.reason`, v.reason);
    if (reason === null) return null;
    return Object.freeze({ kind, reason });
  }

  if (kind === 'cells') {
    const cells = stringArray(c, `${path}.cells`, v.cells, { minLength: 1, max: 64 });
    const method = text(c, `${path}.method`, v.method);
    const digits = integer(c, `${path}.digits`, v.digits, 0, MAX_DIGITS);
    if (cells !== null) {
      // Parsed here so a malformed address is a load failure naming the
      // mapping, not a throw from deep inside a highlight computation.
      cells.forEach((cell, i) => {
        try {
          const a = parse(cell);
          if (digits !== null && a.digits.length > digits) {
            // Over-precision in curated data is a claim the curator did not
            // make. The library flags over-precise *queries*; stored data
            // claiming more precision than its own `digits` is just wrong.
            c.add(
              `${path}.cells[${i}]`,
              `has ${a.digits.length} refinement digits but the mapping declares ${digits}`,
            );
          }
        } catch (e) {
          c.add(`${path}.cells[${i}]`, `not a valid ALC address: ${(e as AlcError).message}`);
        }
      });
      try {
        covering(cells);
      } catch (e) {
        c.add(`${path}.cells`, `does not form a covering: ${(e as AlcError).message}`);
      }
    }
    if (!c.cleanSince(mark)) return null;
    return Object.freeze({ kind, cells: Object.freeze(cells!), method: method!, digits: digits! });
  }

  const space = text(c, `${path}.space`, v.space, MAX_SHORT_TEXT);
  const frame = enumValue(c, `${path}.frame`, v.frame, ['BD', 'BV'] as const);
  const digits = integer(c, `${path}.digits`, v.digits, 0, MAX_DIGITS);
  let note: string | undefined;
  if (v.note !== undefined) {
    const s = text(c, `${path}.note`, v.note);
    if (s !== null) note = s;
  }
  const points: [number, number, number][] = [];
  if (!Array.isArray(v.pointsMm) || v.pointsMm.length === 0) {
    c.add(`${path}.pointsMm`, 'needs at least one [x, y, z] point in millimetres');
  } else {
    (v.pointsMm as unknown[]).forEach((p, i) => {
      if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        // NaN coordinates are how an unresolvable anomaly is reported by
        // `locate()`; they are never legitimate *input*.
        c.add(`${path}.pointsMm[${i}]`, 'must be three finite numbers');
      } else {
        points.push([p[0] as number, p[1] as number, p[2] as number]);
      }
    });
  }
  if (!c.cleanSince(mark)) return null;
  return Object.freeze({
    kind,
    space: space!,
    frame: frame!,
    pointsMm: Object.freeze(points.map((p) => Object.freeze(p) as readonly [number, number, number])),
    digits: digits!,
    ...(note === undefined ? {} : { note }),
  });
}

function evidence(c: Collector, path: string, v: unknown) {
  if (!isObject(v)) {
    c.add(path, 'every mapping needs an evidence record');
    return null;
  }
  const mark = c.mark;
  const summary = text(c, `${path}.summary`, v.summary);
  const kind = enumValue(c, `${path}.kind`, v.kind, EVIDENCE_KINDS);
  const locatorStatus = enumValue(c, `${path}.locatorStatus`, v.locatorStatus, ['recorded', 'not-recorded'] as const);

  let locator: string | null = null;
  if (v.locator === undefined) {
    c.add(`${path}.locator`, 'required; use null with locatorStatus "not-recorded"');
  } else if (v.locator === null) {
    if (locatorStatus === 'recorded') {
      c.add(`${path}.locator`, 'is null but locatorStatus says "recorded"');
    }
  } else {
    const s = text(c, `${path}.locator`, v.locator, MAX_SHORT_TEXT);
    if (s !== null) {
      if (locatorStatus === 'not-recorded') {
        // The asymmetric half of the rule. Without it, a locator could be
        // present and simultaneously disclaimed, and the gate's
        // "not-recorded" count would understate what was actually checked.
        c.add(`${path}.locator`, 'is present but locatorStatus says "not-recorded"');
      }
      locator = s;
    }
  }
  if (!c.cleanSince(mark)) return null;
  return Object.freeze({ summary: summary!, kind: kind!, locator, locatorStatus: locatorStatus! });
}

function mapping(c: Collector, path: string, v: unknown): RegionMapping | null {
  if (!isObject(v)) {
    c.add(path, 'expected a region mapping object');
    return null;
  }
  const mark = c.mark;
  const id = text(c, `${path}.id`, v.id, MAX_SHORT_TEXT);
  if (id !== null && !ID_PATTERNS.mapping.test(id)) {
    c.add(`${path}.id`, `must match ${ID_PATTERNS.mapping} ("map:" prefixed), got ${JSON.stringify(id)}`);
  }
  const structureId = text(c, `${path}.structureId`, v.structureId, MAX_SHORT_TEXT);
  const structureIdSource = text(c, `${path}.structureIdSource`, v.structureIdSource, MAX_SHORT_TEXT);
  const structureLabel = text(c, `${path}.structureLabel`, v.structureLabel, MAX_SHORT_TEXT);
  const sp = spatial(c, `${path}.spatial`, v.spatial);
  const ev = evidence(c, `${path}.evidence`, v.evidence);
  const prov = provenance(c, `${path}.provenance`, v.provenance);

  if (!c.cleanSince(mark)) return null;
  return Object.freeze({
    id: id!,
    structureId: structureId!,
    structureIdSource: structureIdSource!,
    structureLabel: structureLabel!,
    spatial: sp!,
    evidence: ev!,
    provenance: prov!,
  });
}

function finding(c: Collector, path: string, v: unknown): Finding | null {
  if (!isObject(v)) {
    c.add(path, 'expected a finding object');
    return null;
  }
  const mark = c.mark;
  const id = text(c, `${path}.id`, v.id, MAX_SHORT_TEXT);
  if (id !== null && !ID_PATTERNS.finding.test(id)) {
    c.add(`${path}.id`, `must match ${ID_PATTERNS.finding} ("finding:" prefixed), got ${JSON.stringify(id)}`);
  }
  const paperId = text(c, `${path}.paperId`, v.paperId, MAX_SHORT_TEXT);
  const statement = text(c, `${path}.statement`, v.statement);
  const topics = stringArray(c, `${path}.topics`, v.topics, { minLength: 1, max: 80 });
  const prov = provenance(c, `${path}.provenance`, v.provenance);

  const mappings: RegionMapping[] = [];
  if (!Array.isArray(v.mappings) || v.mappings.length === 0) {
    // A finding with no mapping is invisible in both browse modes while still
    // counting towards the dataset's size. It is a note, not a finding.
    c.add(`${path}.mappings`, 'needs at least one region mapping');
  } else {
    const seenStructure = new Map<string, number>();
    (v.mappings as unknown[]).forEach((m, i) => {
      const parsed = mapping(c, `${path}.mappings[${i}]`, m);
      if (parsed === null) return;
      const prior = seenStructure.get(parsed.structureId);
      if (prior !== undefined) {
        // Two mappings onto one structure inside one finding double-paint it
        // and double-count it in every per-structure total.
        c.add(
          `${path}.mappings[${i}].structureId`,
          `duplicates mappings[${prior}] (${parsed.structureId}); one finding maps a structure once`,
        );
        return;
      }
      seenStructure.set(parsed.structureId, i);
      mappings.push(parsed);
    });
  }

  if (!c.cleanSince(mark)) return null;
  return Object.freeze({
    id: id!,
    paperId: paperId!,
    statement: statement!,
    topics: Object.freeze(topics!),
    mappings: Object.freeze(mappings),
    provenance: prov!,
  });
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

function curation(c: Collector, path: string, v: unknown) {
  if (!isObject(v)) {
    c.add(path, 'a dataset must record how it was curated');
    return null;
  }
  const mark = c.mark;
  const curatedBy = text(c, `${path}.curatedBy`, v.curatedBy, MAX_SHORT_TEXT);
  const curatedOn = isoDate(c, `${path}.curatedOn`, v.curatedOn);
  const method = text(c, `${path}.method`, v.method);
  const citationCheck = text(c, `${path}.citationCheck`, v.citationCheck);
  const notRecorded = stringArray(c, `${path}.notRecorded`, v.notRecorded, { max: MAX_TEXT });
  if (!c.cleanSince(mark)) return null;
  return Object.freeze({
    curatedBy: curatedBy!,
    curatedOn: curatedOn!,
    method: method!,
    citationCheck: citationCheck!,
    notRecorded: Object.freeze(notRecorded!),
  });
}

/**
 * Validate without throwing. Returns the dataset, or `null` plus every problem.
 *
 * Used by `tools/check-research-dataset.mjs`, which wants to print all the
 * problems in all the datasets rather than stop at the first bad one.
 */
export function validateDataset(raw: unknown): {
  dataset: ResearchDataset | null;
  problems: readonly ValidationProblem[];
} {
  const c = new Collector();

  if (!isObject(raw)) {
    c.add('$', 'expected a JSON object');
    return { dataset: null, problems: c.problems };
  }
  // Checked first and by equality, for the reason `parse()` rejects an unknown
  // frame: a reader that guesses at an unknown version is a reader that will
  // one day silently mean something different by a field.
  if (raw.schema !== SCHEMA_ID) {
    c.add('$.schema', `must be exactly ${JSON.stringify(SCHEMA_ID)}, got ${JSON.stringify(raw.schema)}`);
    return { dataset: null, problems: c.problems };
  }

  const version = text(c, '$.version', raw.version, MAX_SHORT_TEXT);
  const structureIdSources = stringArray(c, '$.structureIdSources', raw.structureIdSources, { minLength: 1, max: 40 });
  const cur = curation(c, '$.curation', raw.curation);

  let authoredAgainst: { nameIndexVersion: string; status: 'fixture' | 'real' } | null = null;
  if (!isObject(raw.authoredAgainst)) {
    c.add('$.authoredAgainst', 'a dataset must say which name index its mappings were authored against');
  } else {
    const nameIndexVersion = text(c, '$.authoredAgainst.nameIndexVersion', raw.authoredAgainst.nameIndexVersion, MAX_SHORT_TEXT);
    const status = enumValue(c, '$.authoredAgainst.status', raw.authoredAgainst.status, ['fixture', 'real'] as const);
    if (nameIndexVersion !== null && status !== null) authoredAgainst = { nameIndexVersion, status };
  }

  const papers: Paper[] = [];
  const paperIds = new Set<string>();
  if (!Array.isArray(raw.papers)) {
    c.add('$.papers', 'expected an array of papers');
  } else {
    (raw.papers as unknown[]).forEach((p, i) => {
      const parsed = paper(c, `$.papers[${i}]`, p);
      if (parsed === null) return;
      if (paperIds.has(parsed.id)) {
        c.add(`$.papers[${i}].id`, `duplicate paper id ${JSON.stringify(parsed.id)}`);
        return;
      }
      paperIds.add(parsed.id);
      papers.push(parsed);
    });
  }

  const findings: Finding[] = [];
  const findingIds = new Set<string>();
  const mappingIds = new Set<string>();
  const papersWithFindings = new Set<string>();
  if (!Array.isArray(raw.findings)) {
    c.add('$.findings', 'expected an array of findings');
  } else {
    (raw.findings as unknown[]).forEach((f, i) => {
      const parsed = finding(c, `$.findings[${i}]`, f);
      if (parsed === null) return;
      if (findingIds.has(parsed.id)) {
        c.add(`$.findings[${i}].id`, `duplicate finding id ${JSON.stringify(parsed.id)}`);
        return;
      }
      // A dangling paperId is the one referential failure that would otherwise
      // produce a finding nothing can display: no citation, no link, no
      // provenance trail to a source.
      if (!paperIds.has(parsed.paperId)) {
        c.add(`$.findings[${i}].paperId`, `no paper with id ${JSON.stringify(parsed.paperId)}`);
        return;
      }
      let duplicateMapping = false;
      for (const m of parsed.mappings) {
        if (mappingIds.has(m.id)) {
          // Mapping ids are what a highlight traces back to. Two highlights
          // with one id means hover shows one of two different provenances.
          c.add(`$.findings[${i}]`, `duplicate mapping id ${JSON.stringify(m.id)}`);
          duplicateMapping = true;
        } else {
          mappingIds.add(m.id);
        }
      }
      if (duplicateMapping) return;
      findingIds.add(parsed.id);
      papersWithFindings.add(parsed.paperId);
      findings.push(parsed);
    });
  }

  for (const [i, p] of papers.entries()) {
    if (!papersWithFindings.has(p.id)) {
      // Browse-by-research would list it and show nothing on selection.
      c.add(`$.papers[${i}]`, `paper ${JSON.stringify(p.id)} has no findings`);
    }
  }

  if (c.problems.length > 0) return { dataset: null, problems: c.problems };

  return {
    dataset: Object.freeze({
      schema: SCHEMA_ID,
      version: version!,
      structureIdSources: Object.freeze(structureIdSources!),
      authoredAgainst: Object.freeze(authoredAgainst!),
      curation: cur!,
      papers: Object.freeze(papers),
      findings: Object.freeze(findings),
    }),
    problems: [],
  };
}

/** `validateDataset`, throwing `ResearchDataError` with every problem listed. */
export function loadDataset(raw: unknown): ResearchDataset {
  const { dataset, problems } = validateDataset(raw);
  if (dataset === null) throw new ResearchDataError(problems);
  return dataset;
}
