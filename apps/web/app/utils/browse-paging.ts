/**
 * What the browse page asks for next, and where it left off.
 *
 * `/browse` loads as you scroll rather than a page at a time, which turns two
 * questions into arithmetic worth testing on its own: whether there is another
 * request to make at all, and how much of the list to rebuild when someone
 * comes back to it.
 *
 * Pure, and specced separately, because the alternative is proving it through
 * a scroll gesture in a browser. `vitest.config.ts` deliberately mounts
 * nothing, so anything a component decides is untested by construction — which
 * is the reason to keep the decisions out of the component.
 *
 * Concatenating offset pages is only sound because the endpoint sorts on a
 * total order — `apps/api/src/library/merge.ts` ends every sort with `id` and
 * breaks collection/film ties by kind, precisely so a window cannot repeat or
 * skip a row. Change that and this file starts producing duplicate cards.
 *
 * `relevance` is total too, on score then title then kind then id — and ties are
 * the *norm* under it rather than the exception, because a tiered score hands
 * whole groups of entries the same number. It also rests on something the other
 * three do not need: the same query must produce the same pool every time, which
 * is why the candidate query in `library/candidates.ts` ends its own `ORDER BY`
 * with `id`. A pool that is cut differently between two requests repeats a card
 * here, and this file is where somebody will come looking when it does.
 */

import { MAX_LIBRARY_OFFSET, MAX_PAGE_LIMIT } from '@video/shared'

/** One request: where to start, and how much to ask for. */
export interface BrowsePageRequest {
  offset: number
  limit: number
}

/**
 * The next window to fetch, or `null` when there is nothing left to ask for.
 *
 * Two stopping conditions, and the second is the one that matters. `offset` is
 * capped at `MAX_LIBRARY_OFFSET` by `listLibrarySchema`, and asking past it is
 * a **400 rather than a clamp** — the endpoint reads `offset + limit` rows from
 * both halves of the library on every request, so the ceiling is what stops a
 * deep page costing the whole table twice. A loader that scrolls into it does
 * not degrade, it fails: the browser logs an error and the e2e suite's
 * watchdog, which fails a test on any response of 400 or worse, goes red on
 * every test that so much as visits the page.
 *
 * A library that large wants a filter rather than a deeper scroll, which is the
 * same judgement the cap itself was set on.
 */
export function nextBrowsePage(loaded: number, total: number): BrowsePageRequest | null {
  if (loaded >= total) return null
  if (loaded >= MAX_LIBRARY_OFFSET) return null

  // Never more than the endpoint accepts, and never more than is left — the
  // last request of a list asks for the remainder rather than a round hundred.
  return { offset: loaded, limit: Math.min(MAX_PAGE_LIMIT, total - loaded) }
}

/**
 * Where someone was in a list: how much of it had loaded, and how far down.
 *
 * Both halves are needed and neither is enough. Restoring the scroll offset
 * onto a list that has not been rebuilt lands at the bottom of the first fifty
 * cards; rebuilding the list without the offset leaves you at the top of it.
 */
export interface BrowsePlace {
  count: number
  scrollY: number
}

/**
 * Keyed by the filters, so a place belongs to the list it was in.
 *
 * The query string is already the canonical form of the filters — one order,
 * defaults omitted — so two URLs describing the same list share a key, and
 * narrowing to a genre gets its own rather than restoring a position that
 * meant something in a list ten times longer.
 */
export function browsePlaceKey(query: string): string {
  return `browse-place:${query}`
}

/**
 * A stored place, or `null` if it is not one.
 *
 * Everything in `sessionStorage` is a string someone else wrote: a previous
 * version of this app, another tab, or a person with a console open. Parsing it
 * as trusted is how a restore turns into `scrollTo(NaN)` or a fetch loop with
 * no end, so the shape is checked rather than assumed.
 */
export function parseBrowsePlace(raw: string | null): BrowsePlace | null {
  if (!raw) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null

    const { count, scrollY } = parsed as Record<string, unknown>
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null
    if (typeof scrollY !== 'number' || !Number.isFinite(scrollY) || scrollY < 0) return null

    return { count, scrollY }
  } catch {
    return null
  }
}

/**
 * How many cards to rebuild to before restoring the scroll position.
 *
 * Bounded by what the library actually holds and by the offset ceiling, so a
 * stale place — saved before a filter emptied the library, or carried over from
 * a session where far more existed — asks for a handful of pages rather than a
 * hundred of them, and never for one the endpoint would refuse.
 */
export function restoreTarget(place: BrowsePlace | null, total: number): number {
  if (!place) return 0

  return Math.min(place.count, total, MAX_LIBRARY_OFFSET)
}
