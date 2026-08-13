import { ref } from 'vue'
import { describe, expect, it } from 'vitest'

import { useArtworkBust } from './useArtworkBust'

/**
 * The whole job here is that the URL *changes* when a picture is replaced. Nothing
 * downstream can compensate for it not changing: the storage key is stable, so an `<img>`
 * whose `src` is byte-for-byte what it was never asks the server anything, and the screen
 * keeps showing a picture that is no longer there while reporting success.
 *
 * The other half is that it changes for the right shape only — a banner upload that
 * quietly reloads the poster hides whether the upload worked.
 */
describe('the artwork cache-buster', () => {
  it('serves each shape from its own route, per entity', () => {
    const video = useArtworkBust('videos', 'vid_1')
    const collection = useArtworkBust('collections', 'col_1')

    expect(video.url('poster')).toBe('/api/videos/vid_1/poster?v=0')
    expect(video.url('banner')).toBe('/api/videos/vid_1/banner?v=0')
    expect(collection.url('poster')).toBe('/api/collections/col_1/poster?v=0')
    expect(collection.url('banner')).toBe('/api/collections/col_1/banner?v=0')
  })

  it('changes the URL of a replaced shape, and leaves the other alone', () => {
    const artwork = useArtworkBust('videos', 'vid_1')
    const banner = artwork.url('banner')

    artwork.replaced('poster')

    expect(artwork.url('poster')).not.toBe('/api/videos/vid_1/poster?v=0')
    expect(artwork.url('banner')).toBe(banner)
  })

  it('changes both when both were replaced', () => {
    const artwork = useArtworkBust('videos', 'vid_1')
    const [poster, banner] = [artwork.url('poster'), artwork.url('banner')]

    artwork.replaced('poster', 'banner')

    expect(artwork.url('poster')).not.toBe(poster)
    expect(artwork.url('banner')).not.toBe(banner)
  })

  /** What an import that took no artwork passes. It must not claim a picture moved. */
  it('changes nothing when nothing was replaced', () => {
    const artwork = useArtworkBust('videos', 'vid_1')
    const [poster, banner] = [artwork.url('poster'), artwork.url('banner')]

    artwork.replaced()

    expect(artwork.url('poster')).toBe(poster)
    expect(artwork.url('banner')).toBe(banner)
  })

  /**
   * Why the version counts rather than reads the clock: two replacements inside one
   * millisecond share a `Date.now()` and would produce the same URL twice — which is
   * precisely the moment a cache-buster is there for.
   */
  it('gives a different URL every time, however fast the replacements come', () => {
    const artwork = useArtworkBust('videos', 'vid_1')
    const seen = new Set<string>([artwork.url('poster')])

    for (let i = 0; i < 5; i += 1) {
      artwork.replaced('poster')
      seen.add(artwork.url('poster'))
    }

    expect(seen.size).toBe(6)
  })

  /**
   * A collection page has no id until its fetch resolves, so the id is read when the URL
   * is built rather than captured when the buster is made.
   */
  it('reads a getter id at call time', () => {
    const id = ref<string | undefined>(undefined)
    const artwork = useArtworkBust('collections', () => id.value)

    id.value = 'col_1'

    expect(artwork.url('poster')).toBe('/api/collections/col_1/poster?v=0')
  })
})
