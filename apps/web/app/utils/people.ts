/**
 * The person directory's request.
 *
 * Pure and specced, because a page cannot easily be asked "what would you
 * request in this state", and a dropped `offset` serves the first page a second
 * time — which looks exactly like a directory that has stopped growing.
 *
 * The offer to fetch the next window, and the appending of it, live in
 * `paging.ts`: neither was ever about people, and the admin library needs both.
 */

/**
 * The URL for one window of the directory.
 *
 * `limit` is passed rather than assumed: `MAX_PAGE_LIMIT` is the API's ceiling
 * and asking past it is a 400, not a silent clamp.
 */
export function peopleQuery(q: string, offset: number, limit: number): string {
  const params = new URLSearchParams({ limit: String(limit) })
  if (q) params.set('q', q)
  // Left out at zero: `?offset=0` says the same thing and reads like a bug.
  if (offset > 0) params.set('offset', String(offset))

  return `/people?${params.toString()}`
}
