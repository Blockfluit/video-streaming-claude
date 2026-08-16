import { describe, expect, it } from 'vitest'

import { peopleQuery } from './people'

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
