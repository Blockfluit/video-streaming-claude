/**
 * Comparing one cell against another, for a table the user can reorder.
 *
 * Pure and direction-aware on purpose. The obvious shape — one ascending
 * comparator, negated when the arrow flips — gets the missing values wrong:
 * negation drags every empty cell to the top, so reversing "Redeemed" answers
 * with the invites that were never redeemed. Missing is not a value that sorts,
 * it is the absence of one, and it belongs at the bottom either way.
 */

export type SortValue = string | number | null | undefined
export type SortDirection = 'asc' | 'desc'

/** Nothing to compare: no value, or a string with nothing in it. */
function isMissing(value: SortValue): boolean {
  return value === null || value === undefined || value === ''
}

/**
 * Ascending or descending, with missing values pinned last in both.
 *
 * Returns 0 for a tie — including two missing values — so the caller can add a
 * tie-break of its own. It needs one: a sort that is not a *total* order lets
 * equal rows swap places between renders, which reads as a rendering bug long
 * before anyone suspects the sort.
 */
export function compareValues(a: SortValue, b: SortValue, direction: SortDirection): number {
  const aMissing = isMissing(a)
  const bMissing = isMissing(b)

  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1

  const order
    = typeof a === 'number' && typeof b === 'number'
      // Numerically — `10` is not smaller than `2` for having a smaller first digit.
      ? a - b
      // An explicit locale: the default follows the environment, and a sort
      // that depends on the machine it renders on is not a sort.
      : String(a).localeCompare(String(b), 'en', { sensitivity: 'base' })

  // Returned before the flip, because negating a tie yields `-0`. Harmless to
  // `Array.sort`, but a comparator that answers "equal" with a signed zero is
  // one a later reader has to stop and think about.
  if (order === 0) return 0

  return direction === 'asc' ? order : -order
}
