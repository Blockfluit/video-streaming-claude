import { describe, expect, it } from 'vitest'

import { collectionPath, watchPath } from './links'

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
