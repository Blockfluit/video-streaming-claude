import { describe, expect, it } from 'vitest'

import { collectionPath, imdbPersonUrl, imdbTitleUrl, playPath, videoPath } from './links'

describe('collectionPath', () => {
  it('points at the collection page', () => {
    expect(collectionPath({ slug: 'the-big-sky' })).toBe('/c/the-big-sky')
  })
})

/**
 * A video is addressed on its own now.
 *
 * These used to be about assembling `/c/<collection>/<season>/<video>` without
 * dropping a segment — an absent season interpolated as an empty one gives
 * `/c/films//the-film`, a different route and a 404. That whole class of
 * mistake is gone with the shape: there is one segment, and it is the video's.
 */
describe('videoPath', () => {
  it('points at the video\'s own page', () => {
    expect(videoPath({ slug: 'the-film' })).toBe('/v/the-film')
  })

  it('never leaves an empty segment behind', () => {
    expect(videoPath({ slug: 'the-film' })).not.toContain('//')
  })

  /**
   * The reason the return type is no longer nullable. A video with no
   * collection used to have no link at all; it is now the ordinary case of a
   * standalone film, and it has a page like everything else.
   */
  it('has a link for a video that belongs to no collection', () => {
    expect(videoPath({ slug: 'orphan' })).toBe('/v/orphan')
  })

  /**
   * The reason for the rename. This was `watchPath`, which named the single
   * route it does not build — while `playPath`, sitting directly beside it,
   * does. Every "does this card play or describe" decision picks between the
   * two, so a name pointing at the other one's route is a standing trap.
   */
  it('does not go to the player, whatever it is called', () => {
    expect(videoPath({ slug: 'the-film' })).not.toContain('/watch/')
  })
})

describe('playPath', () => {
  it('points at the player', () => {
    expect(playPath({ slug: 'the-film' })).toBe('/watch/the-film')
  })

  /**
   * The distinction the two exist for: one page describes a video and the other
   * plays it, and a surface picks between them on purpose. A card that resumes
   * something goes to the player; one that offers something new goes to the
   * page that says what it is.
   */
  it('is not the page that describes the video', () => {
    expect(playPath({ slug: 'the-film' })).not.toBe(videoPath({ slug: 'the-film' }))
  })

  it('has a link for a video that belongs to no collection', () => {
    expect(playPath({ slug: 'orphan' })).toBe('/watch/orphan')
  })
})

/**
 * IMDb numbers titles and people in different namespaces, and the two paths are
 * not interchangeable. The ids arrive from a third party, so the prefix is
 * checked rather than trusted: a link to somebody else's 404 is not something
 * this app can explain, and no link at all is the more honest answer.
 */
describe('imdbTitleUrl', () => {
  it('points at the title', () => {
    expect(imdbTitleUrl('tt0133093')).toBe('https://www.imdb.com/title/tt0133093/')
  })

  it('tolerates surrounding whitespace', () => {
    expect(imdbTitleUrl('  tt0133093 ')).toBe('https://www.imdb.com/title/tt0133093/')
  })

  it('refuses a person id in a title field', () => {
    expect(imdbTitleUrl('nm0000158')).toBeNull()
  })

  it('has nothing to offer for a title nobody has matched', () => {
    expect(imdbTitleUrl(null)).toBeNull()
    expect(imdbTitleUrl(undefined)).toBeNull()
    expect(imdbTitleUrl('')).toBeNull()
  })

  it('refuses something merely containing an id', () => {
    expect(imdbTitleUrl('tt0133093/reviews')).toBeNull()
    expect(imdbTitleUrl('see tt0133093')).toBeNull()
    expect(imdbTitleUrl('tt')).toBeNull()
  })
})

describe('imdbPersonUrl', () => {
  it('points at the person', () => {
    expect(imdbPersonUrl('nm0000158')).toBe('https://www.imdb.com/name/nm0000158/')
  })

  it('refuses a title id in a person field', () => {
    expect(imdbPersonUrl('tt0133093')).toBeNull()
  })
})
