import { describe, expect, it } from 'vitest'

import { compareValues } from './sort'

describe('compareValues', () => {
  it('orders strings both ways', () => {
    expect(compareValues('ada', 'grace', 'asc')).toBeLessThan(0)
    expect(compareValues('ada', 'grace', 'desc')).toBeGreaterThan(0)
  })

  it('orders numbers by value, not by their digits', () => {
    // The bug this rules out: `10` sorting before `2` because "1" < "2".
    expect(compareValues(2, 10, 'asc')).toBeLessThan(0)
    expect(compareValues(10, 2, 'asc')).toBeGreaterThan(0)
  })

  it('ignores case, so a lowercase username does not sort below every capital', () => {
    expect(compareValues('ada', 'Bob', 'asc')).toBeLessThan(0)
  })

  it('calls equal values equal', () => {
    expect(compareValues('ada', 'ada', 'asc')).toBe(0)
    expect(compareValues(7, 7, 'desc')).toBe(0)
  })

  /**
   * The assertion this function exists for.
   *
   * A comparator that is simply negated for a descending sort drags every empty
   * cell to the top — so reversing "Redeemed" fills the screen with the invites
   * that were never redeemed at all, which is the one thing that sort is not
   * asking about. Missing stays at the bottom in both directions.
   */
  it('keeps missing values last in both directions', () => {
    for (const direction of ['asc', 'desc'] as const) {
      expect(compareValues(null, 'ada', direction)).toBeGreaterThan(0)
      expect(compareValues('ada', null, direction)).toBeLessThan(0)
      expect(compareValues(undefined, 5, direction)).toBeGreaterThan(0)
    }
  })

  it('treats an empty string as missing, not as the smallest string', () => {
    expect(compareValues('', 'ada', 'asc')).toBeGreaterThan(0)
    expect(compareValues('', 'ada', 'desc')).toBeGreaterThan(0)
  })

  it('leaves two missing values tied, so the caller decides', () => {
    expect(compareValues(null, undefined, 'asc')).toBe(0)
    expect(compareValues(null, '', 'desc')).toBe(0)
  })
})
