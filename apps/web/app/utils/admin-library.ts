/**
 * The admin library's request, for either half of it.
 *
 * The page lists collections and videos side by side and narrows both with one
 * search box and one state select, so the two requests differ only in which
 * endpoint they go to. One function builds both, because two that drifted apart
 * on how they spell a filter would show a search applied to one list and not
 * the other — which reads as records having gone missing rather than as a bug.
 *
 * Pure and specced: a page cannot easily be asked "what would you request in
 * this state", and a dropped `offset` serves the first window a second time,
 * which looks exactly like a library that has stopped growing.
 */

import { ANY } from './browse-filters'

/** Which half of the library, which is also the endpoint. */
export type LibraryResource = 'collections' | 'videos'

/**
 * The URL for one window of one half of the library.
 *
 * `limit` is passed rather than assumed: `MAX_PAGE_LIMIT` is the API's ceiling
 * and asking past it is a 400, not a silent clamp.
 */
export function libraryQuery(
  resource: LibraryResource,
  q: string,
  state: string,
  offset: number,
  limit: number,
): string {
  const params = new URLSearchParams({ limit: String(limit) })

  if (q) params.set('q', q)
  // `ANY` is "no filter" — the sentinel a `USelect` can hold, since Reka UI
  // reserves `''` for "cleared" and throws on an option carrying one.
  if (state && state !== ANY) params.set('state', state)
  // Left out at zero: `?offset=0` says the same thing and reads like a bug.
  if (offset > 0) params.set('offset', String(offset))

  return `/${resource}?${params.toString()}`
}
