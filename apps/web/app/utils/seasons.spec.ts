import { describe, expect, it } from 'vitest'

import { groupVideosBySeason, seasonLabel } from './seasons'

const s1 = { id: 's1', number: 1, slug: 'season-1', title: 'Season 1' }
const s2 = { id: 's2', number: 2, slug: 'season-2', title: 'Season 2' }

const episode = (id: string, seasonId: string | null, orderIndex: number | null, title = id) => ({
  id,
  seasonId,
  orderIndex,
  title,
})

describe('groupVideosBySeason', () => {
  it('puts each video under its season, in season order', () => {
    const groups = groupVideosBySeason(
      [s1, s2],
      [episode('b', 's2', 1), episode('a', 's1', 1)],
    )

    expect(groups.map(g => g.season?.id)).toEqual(['s1', 's2'])
    expect(groups[0]!.videos.map(v => v.id)).toEqual(['a'])
    expect(groups[1]!.videos.map(v => v.id)).toEqual(['b'])
  })

  it('orders episodes within a season by orderIndex', () => {
    const groups = groupVideosBySeason(
      [s1],
      [episode('third', 's1', 3), episode('first', 's1', 1), episode('second', 's1', 2)],
    )

    expect(groups[0]!.videos.map(v => v.id)).toEqual(['first', 'second', 'third'])
  })

  /**
   * The rule `next-episode.ts` already encodes on the API side: a null
   * orderIndex means "ingest could not tell", and treating it as zero offers an
   * unnumbered extra ahead of a real episode one.
   */
  it('sorts a null orderIndex last, not first', () => {
    const groups = groupVideosBySeason(
      [s1],
      [episode('unknown', 's1', null), episode('one', 's1', 1)],
    )

    expect(groups[0]!.videos.map(v => v.id)).toEqual(['one', 'unknown'])
  })

  it('breaks an orderIndex tie on title, so the order never reshuffles between renders', () => {
    const groups = groupVideosBySeason(
      [s1],
      [episode('b', 's1', 1, 'Beta'), episode('a', 's1', 1, 'Alpha')],
    )

    expect(groups[0]!.videos.map(v => v.id)).toEqual(['a', 'b'])
  })

  /** Films live directly in a collection, with no season in between. */
  it('collects videos with no season into a trailing group', () => {
    const groups = groupVideosBySeason([s1], [episode('film', null, null), episode('ep', 's1', 1)])

    expect(groups.at(-1)!.season).toBeNull()
    expect(groups.at(-1)!.videos.map(v => v.id)).toEqual(['film'])
  })

  /**
   * The two callers want opposite things, which is the whole reason for the
   * flag. The admin editor drags episodes between groups and needs the loose
   * bucket present as a drop target even when it is empty; the viewer overview
   * must not render a heading over nothing.
   */
  it('omits an empty loose group by default', () => {
    const groups = groupVideosBySeason([s1], [episode('ep', 's1', 1)])

    expect(groups).toHaveLength(1)
    expect(groups.every(g => g.season !== null)).toBe(true)
  })

  it('keeps an empty loose group when asked, as a drop target', () => {
    const groups = groupVideosBySeason([s1], [episode('ep', 's1', 1)], { includeEmptyLoose: true })

    expect(groups).toHaveLength(2)
    expect(groups.at(-1)).toEqual({ season: null, videos: [] })
  })

  it('keeps an empty season, because a season that exists is a fact about the show', () => {
    const groups = groupVideosBySeason([s1, s2], [episode('ep', 's1', 1)])

    expect(groups.map(g => g.season?.id)).toEqual(['s1', 's2'])
    expect(groups[1]!.videos).toEqual([])
  })

  it('does not lose a video whose seasonId names no season we were given', () => {
    const groups = groupVideosBySeason([s1], [episode('orphan', 'gone', 1)])

    expect(groups.at(-1)!.season).toBeNull()
    expect(groups.at(-1)!.videos.map(v => v.id)).toEqual(['orphan'])
  })

  it('does not mutate what it was handed', () => {
    const videos = [episode('b', 's1', 2), episode('a', 's1', 1)]
    const before = videos.map(v => v.id)

    groupVideosBySeason([s1], videos)

    expect(videos.map(v => v.id)).toEqual(before)
  })
})

describe('seasonLabel', () => {
  it('uses the season title when it has one', () => {
    expect(seasonLabel({ id: 's', number: 1, slug: 'season-1', title: 'The First Year' })).toBe(
      'The First Year',
    )
  })

  it('falls back to the number', () => {
    expect(seasonLabel({ id: 's', number: 3, slug: 'season-3' })).toBe('Season 3')
  })

  /** An unrecognised folder name is accepted and flagged, never rejected — so this happens. */
  it('names an unnumbered season without pretending it is season zero', () => {
    expect(seasonLabel({ id: 's', number: null, slug: 'extras' })).toBe('Extras')
  })

  it('names the loose group for what it is', () => {
    expect(seasonLabel(null)).toBe('Not in a season')
  })
})
