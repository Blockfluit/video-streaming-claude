import { describe, expect, it } from 'vitest'

import {
  collectionPath,
  detailsPath,
  imdbPersonUrl,
  imdbTitleUrl,
  personPath,
  playPath,
  videoPath,
} from './links'

describe('collectionPath', () => {
  it('points at the collection page', () => {
    expect(collectionPath({ slug: 'the-big-sky' })).toBe('/c/the-big-sky')
  })
})

/**
 * The route this builds did not exist for a long time: the page had been
 * committed one directory too deep, so every link here was a 404.
 */
describe('personPath', () => {
  it('points at the person page', () => {
    expect(personPath({ slug: 'ada-lovelace' })).toBe('/people/ada-lovelace')
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

  /**
   * Which collection the viewer came through, so the player can offer the next
   * and previous episode.
   *
   * It has to be carried rather than worked out at the far end: a video belongs
   * to any number of collections, and `seasonId` and `orderIndex` are facts
   * about *one* membership, so the same episode can be episode 3 of a show and
   * item 1 of a best-of row. There is no honest way to pick between them once
   * the link has been followed — the surface that built it is the one that knew.
   */
  it('carries the collection it was reached through', () => {
    expect(playPath({ slug: 'the-pilot' }, 'the-big-sky')).toBe(
      '/watch/the-pilot?from=the-big-sky',
    )
  })

  /**
   * The surfaces where the question is still what to watch pass nothing, and
   * neither do Continue Watching and History, which hold a video and a position
   * with no collection in hand. Every one of those call sites is untouched, so
   * the no-argument form has to stay exactly what it was.
   */
  it('is unchanged when there is no collection to name', () => {
    expect(playPath({ slug: 'the-film' })).toBe('/watch/the-film')
    expect(playPath({ slug: 'the-film' }, null)).toBe('/watch/the-film')
    expect(playPath({ slug: 'the-film' }, undefined)).toBe('/watch/the-film')
  })

  /** An empty slug names no collection, and an empty `?from=` is not a value. */
  it('does not append an empty parameter', () => {
    expect(playPath({ slug: 'the-film' }, '')).toBe('/watch/the-film')
  })

  it('encodes the collection slug', () => {
    expect(playPath({ slug: 'the-film' }, 'a&b')).toBe('/watch/the-film?from=a%26b')
  })
})

/**
 * Which of the two description pages the *player* sends you to.
 *
 * The whole distinction is `seasonId`. An episode is described by its series;
 * everything else is described by its own page, which is a real page and one a
 * collection does not repeat.
 */
describe('detailsPath', () => {
  const episode = {
    slug: 'pilot',
    collections: [{ seasonId: 'season-1', collection: { slug: 'the-big-sky' } }],
  }

  it('sends an episode to its series', () => {
    expect(detailsPath(episode)).toBe('/c/the-big-sky')
  })

  /**
   * A film in a saga keeps its own page. The collection holding it is a shelf of
   * films, not a season list, and none of the synopsis, cast or certification on
   * `/v/:slug` appears there — sending a film to it loses everything it was
   * pressed for.
   */
  it('leaves a film in a collection on its own page', () => {
    expect(detailsPath({
      slug: 'deathly-hallows',
      collections: [{ seasonId: null, collection: { slug: 'harry-potter' } }],
    })).toBe('/v/deathly-hallows')
  })

  it('leaves a standalone film on its own page', () => {
    expect(detailsPath({ slug: 'arrival', collections: [] })).toBe('/v/arrival')
  })

  /**
   * The field is optional on every shape that predates memberships, and a page
   * whose button throws is worse than one pointing somewhere defensible.
   */
  it('survives a video that arrived without its memberships', () => {
    expect(detailsPath({ slug: 'arrival' })).toBe('/v/arrival')
    expect(detailsPath({ slug: 'arrival', collections: null })).toBe('/v/arrival')
  })

  /**
   * The reason this looks for the season-bearing membership rather than taking
   * the first one: a video can be an episode of one collection and an extra in
   * another, and only one of those two is a series. Picking `collections[0]`
   * the way the "from ..." subtitle does would answer this case wrongly.
   */
  it('finds the series behind a membership that is not a season', () => {
    expect(detailsPath({
      slug: 'pilot',
      collections: [
        { seasonId: null, collection: { slug: 'staff-picks' } },
        { seasonId: 'season-1', collection: { slug: 'the-big-sky' } },
      ],
    })).toBe('/c/the-big-sky')
  })

  it('never sends the player to another player', () => {
    expect(detailsPath(episode)).not.toContain('/watch/')
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
