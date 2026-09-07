/**
 * Reading a TMDB id out of whatever somebody pasted.
 *
 * Sibling of `parseImdbId`/`parseYoutubeId`: when title search comes up
 * empty, an admin pastes what's in TMDB's own address bar —
 * `https://www.themoviedb.org/movie/27205-inception` — or just types the
 * bare id. Unlike those two, nothing stores this value; it's consumed
 * client-side only, to build the same `tmdbId` + `type` pair a search result
 * already produces.
 */
import type { TmdbType } from './schemas/metadata.js';

export interface TmdbRef {
  tmdbId: number;
  /** Known only when the input was a URL; a bare id doesn't say which. */
  type: TmdbType | null;
}

export function parseTmdbId(input: string | null | undefined): TmdbRef | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Already an id. Checked first so it never reaches the URL parser, which
  // would read it as a relative path.
  if (/^\d+$/.test(trimmed)) {
    const tmdbId = Number(trimmed);
    return tmdbId > 0 ? { tmdbId, type: null } : null;
  }

  let url: URL;
  try {
    // Tolerate a pasted `themoviedb.org/movie/…` with no scheme, which is
    // what a browser shows and therefore what gets copied.
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'themoviedb.org') return null;

  // `/movie/27205-inception` or `/tv/1399-game-of-thrones`; the slug (and
  // anything after it) is ignored.
  const match = url.pathname.match(/^\/(movie|tv)\/(\d+)/);
  if (!match) return null;

  const tmdbId = Number(match[2]);
  return tmdbId > 0 ? { tmdbId, type: match[1] as TmdbType } : null;
}
