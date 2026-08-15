import { describe, expect, it } from 'vitest'

import { episodeSequence, groupBySeason, neighbours } from './episode-sequence'

/** A season, as `GET /collections/:slug` returns them. */
function season(id: string, number: number | null) {
  return { id, number }
}

/**
 * A membership, flattened the way the API already flattens it — the season and
 * the position sit on the video because they are facts about *this* collection.
 */
function episode(
  id: string,
  title: string,
  seasonId: string | null,
  orderIndex: number | null,
) {
  return { id, slug: id, title, seasonId, orderIndex }
}

const ids = (entries: { id: string }[]) => entries.map(entry => entry.id)

describe('episodeSequence', () => {
  /**
   * The reason this function exists at all.
   *
   * `MEMBERSHIP_ORDER` on the API sorts by `seasonId`, which is a **cuid** —
   * so the server groups the videos by season but leaves the seasons themselves
   * in an order nobody chose. That is invisible on the collection page, which
   * shows one season at a time, and is the whole of the job for a control that
   * steps between them. Season two is second because its *number* is two.
   */
  it('puts the seasons in number order, not in the order they arrive', () => {
    const seasons = [season('cuid-b', 2), season('cuid-a', 1)]
    const videos = [
      episode('s2e1', 'Later', 'cuid-b', 1),
      episode('s1e1', 'Earlier', 'cuid-a', 1),
    ]

    expect(ids(episodeSequence(videos, seasons))).toEqual(['s1e1', 's2e1'])
  })

  it('walks a season in order before starting the next one', () => {
    const seasons = [season('one', 1), season('two', 2)]
    const videos = [
      episode('s2e1', 'Three', 'two', 1),
      episode('s1e2', 'Two', 'one', 2),
      episode('s1e1', 'One', 'one', 1),
    ]

    expect(ids(episodeSequence(videos, seasons))).toEqual(['s1e1', 's1e2', 's2e1'])
  })

  /**
   * A null `orderIndex` means ingest could not read a number off the filename.
   * Treating that as episode zero offers an unnumbered extra ahead of a real
   * first episode, which is the same mistake the API's `nextEpisode` avoids.
   */
  it('sorts an episode with no position after the numbered ones', () => {
    const seasons = [season('one', 1)]
    const videos = [
      episode('extra', 'Unnumbered', 'one', null),
      episode('e2', 'Two', 'one', 2),
      episode('e1', 'One', 'one', 1),
    ]

    expect(ids(episodeSequence(videos, seasons))).toEqual(['e1', 'e2', 'extra'])
  })

  /** A folder name that did not parse. It is still a season, so it is not last. */
  it('sorts a season with no number after the numbered seasons', () => {
    const seasons = [season('specials', null), season('one', 1)]
    const videos = [
      episode('special', 'A special', 'specials', 1),
      episode('s1e1', 'One', 'one', 1),
    ]

    expect(ids(episodeSequence(videos, seasons))).toEqual(['s1e1', 'special'])
  })

  /**
   * `seasonId: null` is a real value meaning "directly in the collection" — it
   * is where films live. Inside a show it is the loose extra nobody filed, so it
   * comes after everything that was filed.
   */
  it('sorts a video that is in no season last of all', () => {
    const seasons = [season('one', 1), season('specials', null)]
    const videos = [
      episode('loose', 'Loose', null, 1),
      episode('special', 'Special', 'specials', 1),
      episode('s1e1', 'One', 'one', 1),
    ]

    expect(ids(episodeSequence(videos, seasons))).toEqual(['s1e1', 'special', 'loose'])
  })

  /** A collection of films: no seasons anywhere, and the order is still the order. */
  it('orders a collection that has no seasons at all', () => {
    const videos = [
      episode('second', 'Second', null, 2),
      episode('first', 'First', null, 1),
    ]

    expect(ids(episodeSequence(videos, []))).toEqual(['first', 'second'])
  })

  /**
   * `orderIndex` is deliberately not unique — a unique index collides during a
   * drag-reorder — so ties are ordinary rather than exceptional, and an order
   * that is not total reshuffles between two identical loads. That reads as a
   * rendering bug for weeks.
   */
  it('breaks a tied position on title, and a tied title on id', () => {
    const videos = [
      episode('b', 'Same', null, 1),
      episode('a', 'Same', null, 1),
      episode('c', 'Different', null, 1),
    ]

    expect(ids(episodeSequence(videos, []))).toEqual(['c', 'a', 'b'])
  })

  it('is stable across repeated calls', () => {
    const seasons = [season('one', 1)]
    const videos = [
      episode('b', 'Same', 'one', null),
      episode('a', 'Same', 'one', null),
    ]

    expect(ids(episodeSequence(videos, seasons))).toEqual(
      ids(episodeSequence([...videos].reverse(), seasons)),
    )
  })

  it('leaves the array it was given alone', () => {
    const videos = [episode('b', 'B', null, 2), episode('a', 'A', null, 1)]

    episodeSequence(videos, [])

    expect(ids(videos)).toEqual(['b', 'a'])
  })

  /**
   * The season list and the video list arrive from the same response, so this
   * should not happen — but ordering is the one thing this function promises,
   * and throwing away a real episode because its season went missing would
   * silently shorten the show.
   */
  it('keeps an episode whose season is not in the season list', () => {
    const videos = [episode('orphan', 'Orphan', 'gone', 1), episode('s1e1', 'One', 'one', 1)]

    expect(ids(episodeSequence(videos, [season('one', 1)]))).toEqual(['s1e1', 'orphan'])
  })

  it('has nothing to say about an empty collection', () => {
    expect(episodeSequence([], [])).toEqual([])
  })

  /** Generic over the video, so the caller's own fields survive the sort. */
  it('carries the caller\'s extra fields through', () => {
    const videos = [{ ...episode('a', 'A', null, 1), durationSec: 42 }]

    expect(episodeSequence(videos, [])[0]?.durationSec).toBe(42)
  })
})

describe('neighbours', () => {
  const seasons = [season('one', 1), season('two', 2)]
  const sequence = episodeSequence(
    [
      episode('s1e1', 'One', 'one', 1),
      episode('s1e2', 'Two', 'one', 2),
      episode('s2e1', 'Three', 'two', 1),
    ],
    seasons,
  )

  it('offers both ways from the middle', () => {
    const { previous, next } = neighbours(sequence, 's1e2')

    expect(previous?.id).toBe('s1e1')
    expect(next?.id).toBe('s2e1')
  })

  it('has no previous at the very start', () => {
    const { previous, next } = neighbours(sequence, 's1e1')

    expect(previous).toBeNull()
    expect(next?.id).toBe('s1e2')
  })

  it('has no next at the very end', () => {
    const { previous, next } = neighbours(sequence, 's2e1')

    expect(previous?.id).toBe('s1e2')
    expect(next).toBeNull()
  })

  /**
   * The point of crossing the boundary: the last episode of season one leads to
   * the first of season two, which is how somebody actually watches a show.
   */
  it('steps from the end of one season into the start of the next', () => {
    expect(neighbours(sequence, 's1e2').next?.id).toBe('s2e1')
    expect(neighbours(sequence, 's2e1').previous?.id).toBe('s1e2')
  })

  /**
   * The collection travels in the URL, where anybody can write it. A video that
   * is not in the collection it claims to be in gets no stepper rather than a
   * wrong one.
   */
  it('offers nothing for a video that is not in this collection', () => {
    const { previous, next } = neighbours(sequence, 'somewhere-else')

    expect(previous).toBeNull()
    expect(next).toBeNull()
  })

  it('offers nothing either way for the only video in a collection', () => {
    const only = episodeSequence([episode('a', 'A', null, 1)], [])
    const { previous, next } = neighbours(only, 'a')

    expect(previous).toBeNull()
    expect(next).toBeNull()
  })

  it('offers nothing out of an empty collection', () => {
    expect(neighbours([], 'a')).toEqual({ previous: null, next: null })
  })

  /**
   * Stepping forward and back is how somebody checks they took the right
   * button, and it has to return them exactly where they were.
   */
  it('is a mirror of itself', () => {
    const forward = neighbours(sequence, 's1e1').next

    expect(neighbours(sequence, forward!.id).previous?.id).toBe('s1e1')
  })
})

describe('groupBySeason', () => {
  const seasons = [season('one', 1), season('two', 2)]

  /**
   * The rail's whole reason for grouping: sixty rows with nothing marking where
   * one season ends and the next begins is a list nobody can navigate.
   */
  it('cuts the sequence into one group per season, in sequence order', () => {
    const sequence = episodeSequence(
      [
        episode('s2e1', 'Three', 'two', 1),
        episode('s1e1', 'One', 'one', 1),
        episode('s1e2', 'Two', 'one', 2),
      ],
      seasons,
    )

    const groups = groupBySeason(sequence, seasons)

    expect(groups.map(group => group.season?.id)).toEqual(['one', 'two'])
    expect(groups.map(group => ids(group.videos))).toEqual([['s1e1', 's1e2'], ['s2e1']])
  })

  /**
   * It partitions what it is given and never re-sorts it. `episodeSequence` is
   * the one place the order is decided, and a second opinion here is how the
   * rail and the stepper would start disagreeing about the same show.
   */
  it('preserves the order it was handed, without sorting', () => {
    const backwards = [
      episode('s2e1', 'Three', 'two', 1),
      episode('s1e1', 'One', 'one', 1),
    ]

    expect(groupBySeason(backwards, seasons).map(group => group.season?.id)).toEqual([
      'two',
      'one',
    ])
  })

  /**
   * `seasonId: null` is a real value meaning "directly in the collection" —
   * where films live, and inside a show the loose extra nobody filed. It is a
   * group of its own rather than being dropped or folded into the last season.
   */
  it('gives videos with no season a group of their own', () => {
    const sequence = episodeSequence(
      [episode('s1e1', 'One', 'one', 1), episode('extra', 'Extra', null, 1)],
      seasons,
    )

    const groups = groupBySeason(sequence, seasons)

    expect(groups).toHaveLength(2)
    expect(groups[1]?.season).toBeNull()
    expect(ids(groups[1]!.videos)).toEqual(['extra'])
  })

  /** A collection of films has no seasons at all, and is one unlabelled group. */
  it('returns a single null-season group for a collection with no seasons', () => {
    const sequence = episodeSequence(
      [episode('a', 'A', null, 1), episode('b', 'B', null, 2)],
      [],
    )

    const groups = groupBySeason(sequence, [])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.season).toBeNull()
    expect(ids(groups[0]!.videos)).toEqual(['a', 'b'])
  })

  /**
   * Both halves come from one response, so this should not happen — but losing
   * a real episode would silently shorten the show, which is the worse failure.
   * It keeps its place, in a group labelled with nothing it cannot vouch for.
   */
  it('keeps a video whose season is not in the list', () => {
    const sequence = [episode('orphan', 'Orphan', 'gone', 1)]

    const groups = groupBySeason(sequence, seasons)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.season).toBeNull()
    expect(ids(groups[0]!.videos)).toEqual(['orphan'])
  })

  /**
   * Two runs of the same season cannot come out of `episodeSequence`, but the
   * function is given an array and must not silently merge across a gap — that
   * would reorder the caller's list while claiming to preserve it.
   */
  it('starts a new group each time the season changes', () => {
    const interleaved = [
      episode('a', 'A', 'one', 1),
      episode('b', 'B', 'two', 1),
      episode('c', 'C', 'one', 2),
    ]

    expect(groupBySeason(interleaved, seasons).map(group => group.season?.id)).toEqual([
      'one',
      'two',
      'one',
    ])
  })

  it('returns nothing for an empty sequence', () => {
    expect(groupBySeason([], seasons)).toEqual([])
  })

  /** Generic like the sort, so the rail still has runtimes and artwork. */
  it('carries the caller\'s extra fields through', () => {
    const videos = [{ ...episode('a', 'A', null, 1), durationSec: 42 }]

    expect(groupBySeason(videos, [])[0]?.videos[0]?.durationSec).toBe(42)
  })
})
