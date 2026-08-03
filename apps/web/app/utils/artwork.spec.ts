import { describe, expect, it } from 'vitest'

import { collectionBanner, collectionPoster, videoBanner, videoPoster } from './artwork'

/**
 * These used to be about *not* asking: the routes 404'd for absent artwork, so
 * the helpers read the key out of the payload and returned null rather than
 * spending a request to be told nothing was there.
 *
 * The routes resolve now — to the first episode's picture, or to the stock image
 * — so that whole question is gone, and with it the `null` every call site had
 * to handle. What is left worth pinning is that each helper asks for its own
 * shape, because a poster served into a 16:9 slot is a silent design bug rather
 * than an error anything would report.
 */
describe('the artwork helpers', () => {
  it('give a collection both shapes, from different routes', () => {
    expect(collectionPoster({ id: 'col_1' })).toBe('/api/collections/col_1/poster')
    expect(collectionBanner({ id: 'col_1' })).toBe('/api/collections/col_1/banner')
  })

  it('give a video both shapes, from different routes', () => {
    expect(videoPoster({ id: 'vid_1' })).toBe('/api/videos/vid_1/poster')
    expect(videoBanner({ id: 'vid_1' })).toBe('/api/videos/vid_1/banner')
  })

  it('never confuses one shape for the other', () => {
    expect(videoPoster({ id: 'vid_1' })).not.toBe(videoBanner({ id: 'vid_1' }))
    expect(collectionPoster({ id: 'col_1' })).not.toBe(collectionBanner({ id: 'col_1' }))
  })

  /**
   * The key is no longer consulted. A collection's `posterKey` is the admin's
   * *override*, and null means nobody has set one — the collection then inherits
   * its first video's picture. Reading that null as "no artwork" would blank
   * exactly the collections the inheritance exists for.
   */
  it('asks even when the payload carries no key at all', () => {
    expect(collectionPoster({ id: 'col_1' })).toBe('/api/collections/col_1/poster')
    expect(videoPoster({ id: 'vid_1' })).toBe('/api/videos/vid_1/poster')
  })

  it('has nothing to offer for nothing', () => {
    for (const helper of [collectionPoster, collectionBanner, videoPoster, videoBanner]) {
      expect(helper(null)).toBeNull()
      expect(helper(undefined)).toBeNull()
    }
  })
})
