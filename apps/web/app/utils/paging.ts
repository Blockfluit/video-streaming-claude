/**
 * Reading a paged endpoint one window at a time.
 *
 * Every list endpoint returns a `Page<T>` carrying `total` and `hasMore`, and
 * the recurring bug is a screen that asks for one window of `MAX_PAGE_LIMIT`,
 * prints `total` in a heading and then offers no way to reach the rest — a
 * count the page cannot honour, which reads as a library that has stopped
 * growing rather than as a missing control. The person directory shipped that
 * way and so did the admin library.
 *
 * Both helpers here are pure and specced because a page cannot easily be asked
 * "what would you do in this state", and both read as missing data when they
 * are wrong.
 *
 * These started life in `people.ts`, named for the one screen that had them.
 * They were generic in everything but the name, so they moved here rather than
 * being copied the first time a second screen wanted them.
 */

/**
 * What the button offers, or null when there is nothing left to offer.
 *
 * The last press is a partial window, so the number has to be what remains
 * rather than the page size — offering "Load 100 more" for the twelve that are
 * left is a promise the API will not keep, and the twelve that arrive then read
 * as eighty-eight records having gone missing.
 *
 * Clamped at zero rather than trusted: `total` is counted by a query the
 * appended windows were not, so a list that shrank underneath a loaded page can
 * genuinely have more on screen than the count admits.
 */
export function loadMoreLabel(loaded: number, total: number, pageSize: number): string | null {
  const remaining = Math.max(total - loaded, 0)
  if (remaining === 0) return null

  return `Load ${Math.min(pageSize, remaining)} more (of ${total})`
}

/**
 * The next window, appended without repeating anything.
 *
 * Offset paging over a list that moves under you can hand back a row that is
 * already on screen — deleting a record from an earlier window shifts every
 * later one up by exactly one. That is not cosmetic: `v-for` is keyed on the
 * id, and two rows with one key is a rendering bug rather than a duplicate.
 */
export function appendWindow<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  onScreen: readonly T[],
): T[] {
  const seen = new Set(onScreen.map(item => item.id))

  return [...existing, ...incoming.filter(item => !seen.has(item.id))]
}
