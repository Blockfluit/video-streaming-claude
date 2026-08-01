import { describe, expect, it } from 'vitest'

import { collectionHeroImage, videoHeroImage } from './hero'

const VIDEO_ID = 'vid1'
const COLLECTION_ID = 'col1'

describe('videoHeroImage', () => {
  const withBanner = { id: VIDEO_ID, bannerKey: 'banners/videos/vid1.jpg', thumbnailKey: 'thumbnails/vid1.jpg' }

  it("prefers the video's own banner", () => {
    expect(videoHeroImage(withBanner, { id: COLLECTION_ID, bannerKey: 'b', posterKey: 'p' })).toBe(
      `/api/videos/${VIDEO_ID}/banner`,
    )
  })

  /**
   * The collection's banner beats the video's thumbnail deliberately. A
   * thumbnail is a 640px auto-captured frame — fine on a card, soft and
   * arbitrary stretched across a full-bleed hero — whereas a collection banner
   * is artwork someone chose.
   */
  it("falls back to the collection's banner before the video's thumbnail", () => {
    expect(
      videoHeroImage(
        { id: VIDEO_ID, bannerKey: null, thumbnailKey: 'thumbnails/vid1.jpg' },
        { id: COLLECTION_ID, bannerKey: 'banners/collections/col1.jpg', posterKey: null },
      ),
    ).toBe(`/api/collections/${COLLECTION_ID}/banner`)
  })

  it("falls back to the video's thumbnail when no banner exists anywhere", () => {
    expect(
      videoHeroImage(
        { id: VIDEO_ID, bannerKey: null, thumbnailKey: 'thumbnails/vid1.jpg' },
        { id: COLLECTION_ID, bannerKey: null, posterKey: 'posters/col1.jpg' },
      ),
    ).toBe(`/api/videos/${VIDEO_ID}/thumbnail`)
  })

  it("falls back to the collection's poster last of all", () => {
    expect(
      videoHeroImage(
        { id: VIDEO_ID, bannerKey: null, thumbnailKey: null },
        { id: COLLECTION_ID, bannerKey: null, posterKey: 'posters/col1.jpg' },
      ),
    ).toBe(`/api/collections/${COLLECTION_ID}/poster`)
  })

  it('has nothing to show when no artwork exists at all', () => {
    expect(
      videoHeroImage({ id: VIDEO_ID, bannerKey: null, thumbnailKey: null }, null),
    ).toBeNull()
  })

  it('works without a collection', () => {
    expect(videoHeroImage(withBanner, null)).toBe(`/api/videos/${VIDEO_ID}/banner`)
  })

  /**
   * The endpoints 404 when the row has no key, and a 404 in an `<img>` is a
   * broken-image icon. So the key decides whether to ask at all — the browser
   * never sees a storage key, only whether one existed.
   */
  it('never puts a storage key in the URL', () => {
    const url = videoHeroImage(withBanner, null)

    expect(url).not.toContain('banners/')
    expect(url).not.toContain('.jpg')
  })
})

describe('collectionHeroImage', () => {
  it('prefers the banner', () => {
    expect(
      collectionHeroImage({ id: COLLECTION_ID, bannerKey: 'b', posterKey: 'p' }),
    ).toBe(`/api/collections/${COLLECTION_ID}/banner`)
  })

  it('falls back to the poster', () => {
    expect(
      collectionHeroImage({ id: COLLECTION_ID, bannerKey: null, posterKey: 'p' }),
    ).toBe(`/api/collections/${COLLECTION_ID}/poster`)
  })

  it('has nothing to show when the collection has no artwork', () => {
    expect(collectionHeroImage({ id: COLLECTION_ID, bannerKey: null, posterKey: null })).toBeNull()
    expect(collectionHeroImage(null)).toBeNull()
  })
})
