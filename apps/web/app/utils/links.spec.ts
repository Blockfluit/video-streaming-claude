import { describe, expect, it } from 'vitest'

import { collectionPath, overviewPath, playPath } from './links'

describe('collectionPath', () => {
  it('points at the collection page', () => {
    expect(collectionPath({ slug: 'the-big-sky' })).toBe('/c/the-big-sky')
  })
})

describe('overviewPath', () => {
  it('includes the season when there is one', () => {
    expect(
      overviewPath({ slug: 'pilot', collection: { slug: 'the-show' }, season: { slug: 'season-1' } }),
    ).toBe('/c/the-show/season-1/pilot')
  })

  // A film sits directly in its collection, with no season in between.
  it('omits the season when there is none', () => {
    expect(overviewPath({ slug: 'the-film', collection: { slug: 'films' }, season: null })).toBe(
      '/c/films/the-film',
    )
  })

  /**
   * The failure this exists to prevent: an absent season interpolated as an
   * empty segment gives `/c/films//the-film`, which is a different route and a
   * 404.
   */
  it('never leaves an empty segment behind', () => {
    expect(overviewPath({ slug: 'the-film', collection: { slug: 'films' } })).not.toContain('//')
  })

  it('has no link to offer when the collection did not come along', () => {
    expect(overviewPath({ slug: 'orphan' })).toBeNull()
    expect(overviewPath({ slug: 'orphan', collection: null })).toBeNull()
  })

  /** The overview is the bare URL — sharing one must not drop someone into the player. */
  it('carries no play query', () => {
    expect(overviewPath({ slug: 'pilot', collection: { slug: 'the-show' } })).toBe(
      '/c/the-show/pilot',
    )
  })
})

describe('playPath', () => {
  it('is the overview with the player open', () => {
    expect(
      playPath({ slug: 'pilot', collection: { slug: 'the-show' }, season: { slug: 'season-1' } }),
    ).toBe('/c/the-show/season-1/pilot?play=1')
  })

  it('keeps the season, like the overview does', () => {
    expect(playPath({ slug: 'the-film', collection: { slug: 'films' }, season: null })).toBe(
      '/c/films/the-film?play=1',
    )
  })

  it('appends the query exactly once', () => {
    const path = playPath({ slug: 'pilot', collection: { slug: 'the-show' } })

    expect(path?.match(/play=1/g)).toHaveLength(1)
    expect(path?.match(/\?/g)).toHaveLength(1)
  })

  it('has no link to offer when the overview has none', () => {
    expect(playPath({ slug: 'orphan' })).toBeNull()
  })
})
