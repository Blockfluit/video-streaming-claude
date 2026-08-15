import { describe, expect, it } from 'vitest'

import { appendPeople, loadMoreLabel, peopleQuery } from './people'

describe('peopleQuery', () => {
  it('asks for a window the API will serve', () => {
    expect(peopleQuery('', 0, 100)).toBe('/people?limit=100')
  })

  /**
   * **The bug.** There was no second request at all — one `limit=100`, which is
   * the API's ceiling, and stop. `total` and `hasMore` both arrived in that
   * response and neither was ever read, so the only way to reach person 101 was
   * to already know their name.
   */
  it('asks for the window after the first', () => {
    expect(peopleQuery('', 100, 100)).toBe('/people?limit=100&offset=100')
  })

  it("leaves the first window's offset out rather than writing a zero", () => {
    expect(peopleQuery('ada', 0, 100)).not.toContain('offset')
  })

  it('carries the search term into the later windows too', () => {
    expect(peopleQuery('ada', 100, 50)).toBe('/people?limit=50&q=ada&offset=100')
  })

  it('encodes a term that would otherwise read as another parameter', () => {
    expect(peopleQuery('ada & grace', 0, 100)).toContain('q=ada+%26+grace')
  })
})

describe('loadMoreLabel', () => {
  it('offers a whole window while there is one', () => {
    expect(loadMoreLabel(100, 412, 100)).toBe('Load 100 more (of 412)')
  })

  /** The last press is a partial window; promising a whole one loses eighty-eight. */
  it('offers only what is left on the last press', () => {
    expect(loadMoreLabel(400, 412, 100)).toBe('Load 12 more (of 412)')
  })

  it('offers nothing once everybody is on screen', () => {
    expect(loadMoreLabel(412, 412, 100)).toBeNull()
    expect(loadMoreLabel(0, 0, 100)).toBeNull()
  })

  /** A directory that shrank under a loaded window must not offer negative people. */
  it('offers nothing when more is loaded than the count admits', () => {
    expect(loadMoreLabel(120, 100, 100)).toBeNull()
  })
})

describe('appendPeople', () => {
  const person = (id: string) => ({ id })

  it('adds the next window after the ones already loaded', () => {
    expect(appendPeople([person('b')], [person('c')], [person('a'), person('b')]))
      .toEqual([person('b'), person('c')])
  })

  /**
   * Offset paging over a list that moved. Somebody deleted from the first
   * window shifts every later one up by one, so the next request hands back a
   * row that is already on screen — and `v-for` keyed on the id renders two of
   * them.
   */
  it('does not repeat somebody the shifted window returned twice', () => {
    expect(appendPeople([], [person('b'), person('c')], [person('a'), person('b')]))
      .toEqual([person('c')])
  })

  it('leaves what is already accumulated alone', () => {
    expect(appendPeople([person('x')], [], [person('x')])).toEqual([person('x')])
  })
})
