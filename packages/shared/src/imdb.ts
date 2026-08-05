/**
 * Reading an IMDb id out of whatever somebody pasted.
 *
 * The sibling of `parseYoutubeId`, and for the same reason: an admin correcting
 * a bad match pastes what is in their address bar — a full
 * `https://www.imdb.com/title/tt1179933/?ref_=nv_sr_1` — and storing that
 * verbatim gives a link that goes nowhere, with nothing on the form to say why.
 * So the field *parses* rather than validates, and one definition serves both
 * the form and the endpoint.
 */

/**
 * Titles are `tt` and people are `nm`, and the two namespaces are not
 * interchangeable — `/title/nm0000158/` is somebody else's 404.
 */
export type ImdbKind = 'title' | 'name';

const PREFIX: Record<ImdbKind, string> = { title: 'tt', name: 'nm' };

/**
 * Anchored, and the digits are counted. IMDb ids are seven or more digits today
 * and were fewer historically, so the floor is low; what matters is that the
 * whole string is the id, or the match would accept an id-shaped fragment of
 * something else.
 */
const idPattern = (prefix: string): RegExp => new RegExp(`^${prefix}\\d{4,}$`);

/**
 * Returns the id, or null when there is not one of the right kind in there.
 *
 * Deliberately strict. Guessing at a malformed URL produces a link that is
 * wrong rather than absent, and a wrong link is worse than none: it looks
 * deliberate.
 */
export function parseImdbId(input: string | null | undefined, kind: ImdbKind = 'title'): string | null {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const prefix = PREFIX[kind];
  const bare = idPattern(prefix);

  // Already an id. Checked first so it never reaches the URL parser, which
  // would read it as a relative path.
  if (bare.test(trimmed)) return trimmed;

  let url: URL;
  try {
    // Tolerate a pasted `imdb.com/title/tt…` with no scheme, which is what a
    // browser shows and therefore what gets copied.
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'imdb.com' && !host.endsWith('.imdb.com')) return null;

  // `/title/tt1179933/` or `/name/nm0000158/`, with anything after it ignored.
  // The segment is matched against the kind asked for, so a person URL handed
  // to a title field is refused rather than silently accepted.
  const segments = url.pathname.split('/').filter(Boolean);
  const at = segments.indexOf(kind);
  const candidate = at === -1 ? undefined : segments[at + 1];

  return candidate !== undefined && bare.test(candidate) ? candidate : null;
}
