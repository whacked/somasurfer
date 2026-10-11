/**
 * Source links: the one place a curator-supplied URL becomes an `href`.
 *
 * Research data is curated by hand and committed as JSON. It is therefore
 * exactly as trustworthy as a pasted address — which is to say, it is input.
 * The dangerous shape is not an obviously hostile dataset; it is one malformed
 * link in two hundred good ones, in a field nobody looks at, rendered straight
 * into an anchor.
 *
 * Three decisions, all of them narrowing:
 *
 *  1. **Allow-list, not deny-list.** Only absolute `http:` and `https:` pass.
 *     Enumerating what to block (`javascript:`, `data:`, `vbscript:`, `blob:`,
 *     ...) loses to the next scheme someone invents, and loses today to
 *     `java<TAB>script:` — browsers strip control characters from a scheme
 *     before dispatching it, so a deny-list that compares strings has already
 *     been bypassed. `new URL()` plus a two-entry protocol check cannot be.
 *  2. **Rejected at load, not at render.** `validate.ts` calls this on every
 *     URL field, so a bad link fails the build rather than becoming a `null`
 *     href at runtime that nobody notices. This function is still called again
 *     at render: defence in depth is cheap here, and the renderer is the place
 *     the mistake would actually land.
 *  3. **Rendered, never fetched.** Nothing in this package imports a network
 *     client, and `test/trust.test.ts` scans the source to keep it that way.
 *     Resolving a DOI would mean the atlas makes a request per curated row on
 *     behalf of whoever opens the page, to a host chosen by whoever edited the
 *     dataset.
 */

/** A link ready to render. `href` is `null` when there is nothing safe to link to. */
export interface SourceLink {
  /** Human-readable label. Always present, even when `href` is `null`. */
  readonly text: string;
  readonly href: string | null;
  /**
   * Why there is no href. `null` when there is one. Shown, not swallowed: a
   * citation whose link was rejected is a curation defect worth seeing.
   */
  readonly unlinkedReason: string | null;
  /** Always `noopener noreferrer`. A renderer that drops this hands over the opener. */
  readonly rel: 'noopener noreferrer';
  readonly target: '_blank';
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * C0 controls and space, DEL, and C1 controls — matched on purpose, written as
 * escapes so the source file stays plain ASCII text.
 */
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u009f]/;

/**
 * `null` for anything that is not an absolute `http(s)` URL, otherwise the URL
 * normalised by the URL parser.
 *
 * Control characters are rejected before parsing. `new URL()` tolerates and
 * strips tabs and newlines inside a scheme, which is the behaviour that makes
 * `java<TAB>script:alert(1)` navigate in a browser; we would rather refuse the
 * string than reason about which parser strips what.
 */
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (CONTROL_OR_SPACE.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  return url.href;
}

/** True for a string `safeHref` would accept. The predicate `validate.ts` gates on. */
export function isSafeUrl(raw: unknown): boolean {
  return safeHref(raw) !== null;
}

/**
 * Build the link for a paper.
 *
 * The text is the citation, so the link is still useful — and still traceable —
 * when there is no href: a reader can search the citation. That is the whole
 * point of refusing to render a bad URL rather than rendering it defanged.
 */
export function sourceLink(citation: string, rawUrl: string | null): SourceLink {
  const href = safeHref(rawUrl);
  const unlinkedReason =
    href !== null
      ? null
      : rawUrl === null || rawUrl === ''
        ? 'no source URL recorded'
        : 'source URL rejected: not an absolute http(s) URL';
  return Object.freeze({
    text: citation,
    href,
    unlinkedReason,
    rel: 'noopener noreferrer' as const,
    target: '_blank' as const,
  });
}

/**
 * The canonical display citation for a paper-shaped record.
 *
 * Plain text, assembled here so every surface shows the same string and no
 * surface has to decide how to punctuate one.
 */
export function formatCitation(p: {
  authors: readonly string[];
  year: number;
  title: string;
  venue: string;
  identifier: { kind: string; value: string | null };
}): string {
  const authors =
    p.authors.length === 0
      ? '[no author recorded]'
      : p.authors.length <= 2
        ? p.authors.join(' & ')
        : `${p.authors[0]} et al.`;
  const id =
    p.identifier.kind === 'none' || p.identifier.value === null
      ? 'no persistent identifier recorded'
      : `${p.identifier.kind.toUpperCase()} ${p.identifier.value}`;
  return `${authors} (${p.year}). ${p.title}. ${p.venue}. ${id}.`;
}
