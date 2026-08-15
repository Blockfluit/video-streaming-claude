import { MAX_LIBRARY_OFFSET, MAX_PAGE_LIMIT } from '@video/shared'
import { describe, expect, it } from 'vitest'

import {
  browsePlaceKey,
  nextBrowsePage,
  parseBrowsePlace,
  restoreTarget,
} from './browse-paging'

describe('nextBrowsePage', () => {
  it('asks for the window after what has loaded', () => {
    expect(nextBrowsePage(50, 312)).toEqual({ offset: 50, limit: MAX_PAGE_LIMIT })
  })

  it('starts at the beginning when nothing has loaded', () => {
    expect(nextBrowsePage(0, 312)).toEqual({ offset: 0, limit: MAX_PAGE_LIMIT })
  })

  it('stops once the whole library is on screen', () => {
    expect(nextBrowsePage(312, 312)).toBeNull()
    // Loaded more than the total: the count moved under us because something
    // was archived mid-scroll. Still nothing left to ask for.
    expect(nextBrowsePage(400, 312)).toBeNull()
  })

  it('stops on an empty library rather than asking for its first page', () => {
    expect(nextBrowsePage(0, 0)).toBeNull()
  })

  it('asks only for what is left rather than a round hundred', () => {
    expect(nextBrowsePage(300, 312)).toEqual({ offset: 300, limit: 12 })
  })

  it('never asks for more than the endpoint accepts', () => {
    // Asking for the remainder of a large library would be a 400: the limit is
    // capped at 100 and over-asking is refused rather than clamped.
    expect(nextBrowsePage(0, 10_000)).toEqual({ offset: 0, limit: MAX_PAGE_LIMIT })
  })

  /*
   * The one that is not a nicety. Past this offset the endpoint answers 400
   * rather than clamping, so a loader that keeps going turns a long scroll into
   * a failed request — and the e2e watchdog fails every test on the page for it.
   */
  it('stops at the offset the endpoint refuses to go past', () => {
    expect(nextBrowsePage(MAX_LIBRARY_OFFSET - 1, 20_000)).toEqual({
      offset: MAX_LIBRARY_OFFSET - 1,
      limit: MAX_PAGE_LIMIT,
    })
    expect(nextBrowsePage(MAX_LIBRARY_OFFSET, 20_000)).toBeNull()
    expect(nextBrowsePage(MAX_LIBRARY_OFFSET + 500, 20_000)).toBeNull()
  })
})

describe('browsePlaceKey', () => {
  it('gives each set of filters its own place', () => {
    expect(browsePlaceKey('limit=50&sort=title')).not.toBe(
      browsePlaceKey('limit=50&sort=title&genre=Drama'),
    )
  })

  it('gives the same list the same key', () => {
    expect(browsePlaceKey('limit=50&sort=title')).toBe(browsePlaceKey('limit=50&sort=title'))
  })
})

describe('parseBrowsePlace', () => {
  it('reads back what was stored', () => {
    expect(parseBrowsePlace('{"count":200,"scrollY":4821}')).toEqual({
      count: 200,
      scrollY: 4821,
    })
  })

  it('treats nothing stored as nowhere to go back to', () => {
    expect(parseBrowsePlace(null)).toBeNull()
    expect(parseBrowsePlace('')).toBeNull()
  })

  /*
   * Session storage holds whatever anyone wrote into it — an older version of
   * this app, another tab, a console. A restore that trusts it scrolls to NaN
   * or loops fetching a page count that is not a number.
   */
  it('refuses anything that is not a place', () => {
    expect(parseBrowsePlace('not json')).toBeNull()
    expect(parseBrowsePlace('null')).toBeNull()
    expect(parseBrowsePlace('[1,2]')).toBeNull()
    expect(parseBrowsePlace('{"count":"200","scrollY":10}')).toBeNull()
    expect(parseBrowsePlace('{"count":200}')).toBeNull()
    expect(parseBrowsePlace('{"count":-5,"scrollY":10}')).toBeNull()
    expect(parseBrowsePlace('{"count":null,"scrollY":null}')).toBeNull()
  })
})

describe('restoreTarget', () => {
  it('rebuilds as much as was loaded', () => {
    expect(restoreTarget({ count: 200, scrollY: 4821 }, 312)).toBe(200)
  })

  it('has nothing to rebuild without a place', () => {
    expect(restoreTarget(null, 312)).toBe(0)
  })

  it('never rebuilds past what the library now holds', () => {
    // Saved before a filter narrowed the list, or before half of it was
    // archived — asking for the old count is a run of requests returning
    // nothing.
    expect(restoreTarget({ count: 200, scrollY: 4821 }, 12)).toBe(12)
  })

  it('never rebuilds past the offset the endpoint refuses', () => {
    expect(restoreTarget({ count: 50_000, scrollY: 10 }, 60_000)).toBe(MAX_LIBRARY_OFFSET)
  })
})
