import { describe, expect, it } from 'vitest'

import { libraryQuery } from './admin-library'
import { ANY } from './browse-filters'

describe('libraryQuery', () => {
  it('asks each half of the library at its own endpoint', () => {
    expect(libraryQuery('videos', '', ANY, 0, 100)).toBe('/videos?limit=100')
    expect(libraryQuery('collections', '', ANY, 0, 100)).toBe('/collections?limit=100')
  })

  /**
   * **The bug.** There was no second request at all — one `limit=100`, which is
   * the API's ceiling, and stop. `total` and `hasMore` both arrived in that
   * response, `total` was printed in the section heading, and `hasMore` was
   * never read — so the heading claimed a number the page could not show and
   * the only way to open record 101 was to already know its title.
   */
  it('asks for the window after the first', () => {
    expect(libraryQuery('videos', '', ANY, 100, 100)).toBe('/videos?limit=100&offset=100')
  })

  it("leaves the first window's offset out rather than writing a zero", () => {
    expect(libraryQuery('videos', 'blade', 'DRAFT', 0, 100)).not.toContain('offset')
  })

  it('carries both narrowings into the later windows too', () => {
    expect(libraryQuery('collections', 'blade', 'PUBLISHED', 100, 50))
      .toBe('/collections?limit=50&q=blade&state=PUBLISHED&offset=100')
  })

  /** `ANY` is the page's "no filter", not a state the API knows about. */
  it('does not send the no-filter sentinel as a state', () => {
    expect(libraryQuery('videos', '', ANY, 0, 100)).not.toContain('state')
  })

  it('encodes a term that would otherwise read as another parameter', () => {
    expect(libraryQuery('videos', 'this & that', ANY, 0, 100)).toContain('q=this+%26+that')
  })
})
