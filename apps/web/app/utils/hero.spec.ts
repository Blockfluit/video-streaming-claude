import { describe, expect, it } from 'vitest'

import { heroEntries, HERO_LIMIT, ROTATE_MS, type RowEntry, tickRotation } from './hero'

/**
 * What the home page leads with.
 *
 * Pure, and worth testing on its own because the rules only bite in
 * combination: the hero has two sources that produce different shapes, either
 * of them can be empty, and the fallback is only correct when the *row* is the
 * thing that is missing rather than the library.
 *
 * Both branches are covered here deliberately. No migration seeds a
 * `RECENTLY_ADDED` row, so a browser test run against a fresh database only
 * ever exercises the fallback — this is the only place the row branch is
 * proven at all.
 */

function shelf(source: string, items: RowEntry[]) {
  return { id: `row-${source}`, slug: source.toLowerCase(), title: source, source, items }
}

function video(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    slug: 'brazil',
    title: 'Brazil',
    durationSec: 7800,
    trailerYoutubeId: 'aaaaaaaaaaa',
    collections: [],
    ...overrides,
  }
}

function collection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    slug: 'alien',
    title: 'Alien',
    year: 1979,
    seasonsHere: 1,
    videosHere: 4,
    trailerYoutubeId: 'dQw4w9WgXcQ',
    ...overrides,
  }
}

function film(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'film',
    id: 'v9',
    slug: 'the-thing',
    title: 'The Thing',
    year: 1982,
    durationSec: 6540,
    tags: [],
    genres: [],
    state: 'PUBLISHED',
    trailerYoutubeId: 'bbbbbbbbbbb',
    ...overrides,
  }
}

describe('heroEntries', () => {
  describe('choosing a source', () => {
    it('prefers the recently added row over the library', () => {
      const rows = [shelf('RECENTLY_ADDED', [{ id: 'i1', video: video(), collection: null }])]

      const entries = heroEntries(rows, [film()])

      expect(entries.map(entry => entry.title)).toEqual(['Brazil'])
    })

    /**
     * The row is admin-made and may not exist — no migration creates one — so
     * the library's own recency answer is what the hero falls back to. Without
     * this the feature does nothing at all on a fresh install.
     */
    it('falls back to the library when there is no such row', () => {
      const rows = [shelf('CONTINUE_WATCHING', [{ id: 'i1', video: video(), collection: null }])]

      const entries = heroEntries(rows, [film()])

      expect(entries.map(entry => entry.title)).toEqual(['The Thing'])
    })

    /**
     * The caller passes rows that have already been filtered to those holding
     * something, so a row reaching here is a row with entries. A row that
     * resolved to nothing must not shadow the fallback — that renders an empty
     * hero on a library that has plenty to show.
     */
    it('falls back when the row is present but empty', () => {
      const entries = heroEntries([shelf('RECENTLY_ADDED', [])], [film()])

      expect(entries.map(entry => entry.title)).toEqual(['The Thing'])
    })

    it('returns nothing when both are empty, so the page can say so itself', () => {
      expect(heroEntries([], [])).toEqual([])
    })

    it('caps what it returns, keeping the order it was given', () => {
      const items = Array.from({ length: HERO_LIMIT + 3 }, (_, index) => ({
        id: `i${index}`,
        video: video({ id: `v${index}`, slug: `s${index}`, title: `Title ${index}` }),
        collection: null,
      }))

      const entries = heroEntries([shelf('RECENTLY_ADDED', items)], [])

      expect(entries).toHaveLength(HERO_LIMIT)
      expect(entries[0]?.title).toBe('Title 0')
      expect(entries.at(-1)?.title).toBe(`Title ${HERO_LIMIT - 1}`)
    })
  })

  describe('a row entry', () => {
    it('describes a collection, and says what it holds', () => {
      const rows = [shelf('RECENTLY_ADDED', [{ id: 'i1', video: null, collection: collection() }])]

      expect(heroEntries(rows, [])[0]).toEqual({
        id: 'i1',
        title: 'Alien',
        meta: '1 season',
        to: '/c/alien',
        image: '/api/collections/c1/banner',
        trailerId: 'dQw4w9WgXcQ',
      })
    })

    /**
     * A wide slot takes a banner, never a poster. A 2:3 poster stretched across
     * a hero fills its box and merely looks badly framed, which is why this
     * asserts the URL rather than trusting the call site.
     */
    it('describes a video with a banner and the collection it came from', () => {
      const item = {
        id: 'i1',
        video: video({ collections: [{ collection: { title: 'Terry Gilliam' } }] }),
        collection: null,
      }

      expect(heroEntries([shelf('RECENTLY_ADDED', [item])], [])[0]).toEqual({
        id: 'i1',
        title: 'Brazil',
        meta: 'Terry Gilliam',
        to: '/v/brazil',
        image: '/api/videos/v1/banner',
        trailerId: 'aaaaaaaaaaa',
      })
    })

    /** A standalone film has no collection to name, which is ordinary, not missing. */
    it('leaves a standalone video without a meta line', () => {
      const item = { id: 'i1', video: video(), collection: null }

      expect(heroEntries([shelf('RECENTLY_ADDED', [item])], [])[0]?.meta).toBeNull()
    })

    /** An entry that is neither is not something to render half of. */
    it('skips an entry holding neither a video nor a collection', () => {
      const items = [
        { id: 'i1', video: null, collection: null },
        { id: 'i2', video: video(), collection: null },
      ]

      expect(heroEntries([shelf('RECENTLY_ADDED', items)], []).map(e => e.id)).toEqual(['i2'])
    })
  })

  describe('a library entry', () => {
    it('describes a film by its year', () => {
      expect(heroEntries([], [film()])[0]).toEqual({
        id: 'v9',
        title: 'The Thing',
        meta: '1982',
        to: '/v/the-thing',
        image: '/api/videos/v9/banner',
        trailerId: 'bbbbbbbbbbb',
      })
    })

    it('describes a shelf by what it holds', () => {
      const shelfCard = {
        kind: 'collection',
        id: 'c1',
        slug: 'alien',
        title: 'Alien',
        year: 1979,
        tags: [],
        genres: [],
        state: 'PUBLISHED',
        seasonsHere: 2,
        videosHere: 9,
        trailerYoutubeId: 'dQw4w9WgXcQ',
      }

      expect(heroEntries([], [shelfCard])[0]).toEqual({
        id: 'c1',
        title: 'Alien',
        meta: '2 seasons',
        to: '/c/alien',
        image: '/api/collections/c1/banner',
        trailerId: 'dQw4w9WgXcQ',
      })
    })

    it('leaves a film with no year without a meta line', () => {
      expect(heroEntries([], [film({ year: null })])[0]?.meta).toBeNull()
    })
  })

  /**
   * Absent is the ordinary state — most of a library has no trailer — and the
   * hero has to render as a plain banner rather than not at all.
   */
  it('carries a null trailer through rather than dropping the entry', () => {
    const item = { id: 'i1', video: video({ trailerYoutubeId: null }), collection: null }

    const entries = heroEntries([shelf('RECENTLY_ADDED', [item])], [])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.trailerId).toBeNull()
  })

  /** An older API that has not been redeployed simply omits the field. */
  it('treats a missing trailer field as no trailer', () => {
    const { trailerYoutubeId: _omitted, ...withoutTrailer } = video()
    const item = { id: 'i1', video: withoutTrailer, collection: null }

    expect(heroEntries([shelf('RECENTLY_ADDED', [item])], [])[0]?.trailerId).toBeNull()
  })
})

/**
 * The rotation's clock.
 *
 * Pure and tested on its own because it is now *visible*: the active bullet is
 * a pill that fills as the entry's turn runs out, so an off-by-a-frame is no
 * longer invisible — it reads as a bar that jumps, or one that finishes early
 * and sits full while the hero refuses to move on.
 *
 * The page drives it from `requestAnimationFrame`, which is what makes the
 * delta something worth defending against: frames do not arrive on a schedule,
 * and a tab that has been in the background hands back one enormous gap.
 */
describe('tickRotation', () => {
  const start = { index: 0, elapsedMs: 0 }

  it('accumulates a partial frame without moving on', () => {
    expect(tickRotation(start, 16, 5)).toEqual({ index: 0, elapsedMs: 16 })
  })

  it('carries elapsed time forward across frames', () => {
    const after = tickRotation(tickRotation(start, 16, 5), 34, 5)

    expect(after).toEqual({ index: 0, elapsedMs: 50 })
  })

  it('advances and starts the next entry from zero once the period is up', () => {
    expect(tickRotation({ index: 0, elapsedMs: ROTATE_MS - 10 }, 20, 5))
      .toEqual({ index: 1, elapsedMs: 0 })
  })

  /**
   * The remainder is deliberately dropped rather than carried. The cap below
   * already bounds a step to one entry, and carrying it would leave the first
   * frame of a new entry with its pill already partly filled.
   */
  it('returns to the first entry after the last', () => {
    expect(tickRotation({ index: 4, elapsedMs: ROTATE_MS }, 1, 5))
      .toEqual({ index: 0, elapsedMs: 0 })
  })

  /**
   * A backgrounded tab produces no frames at all, so its first frame back
   * reports the whole absence as one delta. Capping it advances one entry, the
   * way sitting there for one period would have; taking it at face value skips
   * however many entries the viewer was away for and lands somewhere arbitrary.
   *
   * The same "cap it, do not reject it" rule the watch heartbeat follows.
   */
  it('advances exactly one entry however long the tab was away', () => {
    expect(tickRotation(start, 10 * ROTATE_MS, 5)).toEqual({ index: 1, elapsedMs: 0 })
  })

  /** A clock that goes backwards must not un-fill the pill. */
  it('ignores a negative delta', () => {
    expect(tickRotation({ index: 2, elapsedMs: 400 }, -5000, 5))
      .toEqual({ index: 2, elapsedMs: 400 })
  })

  /**
   * The controls are hidden below two entries, so there is nothing to count
   * down *to* — a pill filling towards a change that cannot happen is a lie.
   */
  it('holds still when there is nothing to rotate through', () => {
    expect(tickRotation(start, ROTATE_MS, 1)).toEqual(start)
    expect(tickRotation(start, ROTATE_MS, 0)).toEqual(start)
  })

  /**
   * `entries` can shrink under a refetch. The page reads the hero through the
   * same modulo, so the index must not be left pointing past the end.
   */
  it('wraps an index left past the end by a shrinking library', () => {
    // Seven of three is showing entry 1, so the next one is entry 2.
    expect(tickRotation({ index: 7, elapsedMs: ROTATE_MS }, 1, 3))
      .toEqual({ index: 2, elapsedMs: 0 })
  })
})
