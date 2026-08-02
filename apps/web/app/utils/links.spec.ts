import { describe, expect, it } from 'vitest'

import { collectionPath, playPath, watchPath } from './links'

describe('collectionPath', () => {
  it('points at the collection page', () => {
    expect(collectionPath({ slug: 'the-big-sky' })).toBe('/c/the-big-sky')
  })
})

describe('watchPath', () => {
  it('includes the season when there is one', () => {
    expect(
      watchPath({ slug: 'pilot', collection: { slug: 'the-show' }, season: { slug: 'season-1' } }),
    ).toBe('/c/the-show/season-1/pilot')
  })

  // A film sits directly in its collection, with no season in between.
  it('omits the season when there is none', () => {
    expect(watchPath({ slug: 'the-film', collection: { slug: 'films' }, season: null })).toBe(
      '/c/films/the-film',
    )
  })

  /**
   * The failure this exists to prevent: an absent season interpolated as an
   * empty segment gives `/c/films//the-film`, which is a different route and a
   * 404.
   */
  it('never leaves an empty segment behind', () => {
    expect(watchPath({ slug: 'the-film', collection: { slug: 'films' } })).not.toContain('//')
  })

  it('has no link to offer when the collection did not come along', () => {
    expect(watchPath({ slug: 'orphan' })).toBeNull()
    expect(watchPath({ slug: 'orphan', collection: null })).toBeNull()
  })
})

describe('playPath', () => {
  it('points at the player', () => {
    expect(playPath({ id: 'vid_123' })).toBe('/watch/vid_123')
  })

  /**
   * The reason it is keyed on the id at all. Every surface that offers to
   * resume something — a Continue Watching card, a history row, the player's
   * next-episode button — holds a video row, and several of them hold it
   * without its season. `watchPath` correctly refuses to guess a title-page URL
   * from that; playback must not be blocked by the same gap.
   */
  it('still has a link when the collection did not come along', () => {
    expect(watchPath({ slug: 'orphan' })).toBeNull()
    expect(playPath({ id: 'vid_orphan' })).toBe('/watch/vid_orphan')
  })

  // The two are different pages, and a surface picks one on purpose.
  it('is not the title page', () => {
    const video = { id: 'vid_1', slug: 'pilot', collection: { slug: 'the-show' } }

    expect(playPath(video)).not.toBe(watchPath(video))
  })
})
