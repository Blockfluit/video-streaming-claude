import { describe, expect, it } from 'vitest'

import { collectionPoster, videoThumbnail } from './artwork'

describe('collectionPoster', () => {
  it('points at the poster route when there is one', () => {
    expect(collectionPoster({ id: 'col_1', posterKey: 'posters/a.jpg' })).toBe(
      '/api/collections/col_1/poster',
    )
  })

  /**
   * The whole point. The endpoint 404s for a collection with no poster, and
   * asking anyway costs a failed request per card and shows the fallback only
   * once it comes back.
   */
  it('does not ask when the API has said there is none', () => {
    expect(collectionPoster({ id: 'col_1', posterKey: null })).toBeNull()
  })

  /**
   * `undefined` is a payload that does not carry the key, not a statement that
   * the artwork is missing. Conflating the two would blank the poster on every
   * screen whose response shape happens to omit it.
   */
  it('still asks when the payload does not say', () => {
    expect(collectionPoster({ id: 'col_1' })).toBe('/api/collections/col_1/poster')
  })

  it('has nothing to offer for nothing', () => {
    expect(collectionPoster(null)).toBeNull()
    expect(collectionPoster(undefined)).toBeNull()
  })
})

describe('videoThumbnail', () => {
  it('points at the thumbnail route when there is one', () => {
    expect(videoThumbnail({ id: 'vid_1', bannerKey: 'thumbs/a.jpg' })).toBe(
      '/api/videos/vid_1/thumbnail',
    )
  })

  it('does not ask when the API has said there is none', () => {
    expect(videoThumbnail({ id: 'vid_1', bannerKey: null })).toBeNull()
  })

  it('still asks when the payload does not say', () => {
    expect(videoThumbnail({ id: 'vid_1' })).toBe('/api/videos/vid_1/thumbnail')
  })

  it('has nothing to offer for nothing', () => {
    expect(videoThumbnail(null)).toBeNull()
    expect(videoThumbnail(undefined)).toBeNull()
  })
})
