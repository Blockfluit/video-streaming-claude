/**
 * The person directory's request, and its offer to fetch the next window.
 *
 * Pure and specced, because a page cannot easily be asked "what would you
 * request in this state", and both rules here read as missing data when they
 * are wrong: an off-by-one in the offer promises people the API will not send,
 * and a dropped `offset` serves the first page a second time — which looks
 * exactly like a directory that has stopped growing.
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

/**
 * What the button offers, or null when there is nothing left to offer.
 *
 * The last press is a partial window, so the number has to be what remains
 * rather than the page size — offering "Load 100 more" for the twelve that are
 * left is a promise the API will not keep, and the twelve that arrive then read
 * as eighty-eight people having gone missing.
 *
 * Clamped at zero rather than trusted: `total` is counted by a query the
 * appended windows were not, so a directory that shrank underneath a loaded
 * page can genuinely have more on screen than the count admits.
 */
export function loadMoreLabel(loaded: number, total: number, pageSize: number): string | null {
  const remaining = Math.max(total - loaded, 0)
  if (remaining === 0) return null

  return `Load ${Math.min(pageSize, remaining)} more (of ${total})`
}

/**
 * The next window, appended without repeating anybody.
 *
 * Offset paging over a list that moves under you can hand back a row that is
 * already on screen — deleting somebody from an earlier window shifts every
 * later one up by exactly one. That is not cosmetic: `v-for` is keyed on the
 * id, and two rows with one key is a rendering bug rather than a duplicate.
 */
export function appendPeople<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  onScreen: readonly T[],
): T[] {
  const seen = new Set(onScreen.map(person => person.id))

  return [...existing, ...incoming.filter(person => !seen.has(person.id))]
}
