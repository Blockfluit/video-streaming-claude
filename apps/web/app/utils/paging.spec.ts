import { describe, expect, it } from 'vitest'

import { appendWindow, loadMoreLabel } from './paging'

describe('loadMoreLabel', () => {
  it('offers a whole window while there is one', () => {
    expect(loadMoreLabel(100, 412, 100)).toBe('Load 100 more (of 412)')
  })

  /** The last press is a partial window; promising a whole one loses eighty-eight. */
  it('offers only what is left on the last press', () => {
    expect(loadMoreLabel(400, 412, 100)).toBe('Load 12 more (of 412)')
  })

  it('offers nothing once everything is on screen', () => {
    expect(loadMoreLabel(412, 412, 100)).toBeNull()
    expect(loadMoreLabel(0, 0, 100)).toBeNull()
  })

  /** A list that shrank under a loaded window must not offer negative records. */
  it('offers nothing when more is loaded than the count admits', () => {
    expect(loadMoreLabel(120, 100, 100)).toBeNull()
  })
})

describe('appendWindow', () => {
  const row = (id: string) => ({ id })

  it('adds the next window after the ones already loaded', () => {
    expect(appendWindow([row('b')], [row('c')], [row('a'), row('b')]))
      .toEqual([row('b'), row('c')])
  })

  /**
   * Offset paging over a list that moved. A record deleted from the first
   * window shifts every later one up by one, so the next request hands back a
   * row that is already on screen — and `v-for` keyed on the id renders two of
   * them.
   */
  it('does not repeat a row the shifted window returned twice', () => {
    expect(appendWindow([], [row('b'), row('c')], [row('a'), row('b')]))
      .toEqual([row('c')])
  })

  it('leaves what is already accumulated alone', () => {
    expect(appendWindow([row('x')], [], [row('x')])).toEqual([row('x')])
  })
})
