import { describe, expect, it } from 'vitest'

import { collectionPath, playPath, videoPath } from './links'

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
