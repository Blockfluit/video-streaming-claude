/**
 * The order a collection is *watched* in, and what sits either side of one video.
 *
 * This is not the order the API sends. `MEMBERSHIP_ORDER` sorts memberships by
 * `seasonId` — a cuid — so `GET /collections/:slug` arrives grouped by season
 * with the seasons themselves in an order nobody chose. That is invisible on the
 * collection page, which renders one season at a time and never compares two,
 * and it is the entire job of a control that steps from the end of one season
 * into the start of the next. Season numbers live on the response's separate
 * `seasons` list, which is why both halves are needed to build this.
 *
 * Nor is it `GET /videos?collectionId=…`, which the API sorts by title on
 * purpose: a video belongs to any number of collections, so a library-wide
 * listing has no single running order to offer. Reading a sequence off it is how
 * "next episode" came to mean "the alphabetically next title".
 *
 * **This is not a second `nextEpisode`.** The API has one definition of "next"
 * on purpose — `watchlist/next-episode.ts`, used by `GET /collections/:slug/
 * progress` and by the watchlist — and reimplementing it is exactly how the home
 * page and the title page start disagreeing. The two answer different questions
 * and both are needed:
 *
 * - `nextEpisode` is **where to resume**: the first episode you have not
 *   finished. It is what the Play/Resume button on a collection offers, and it
 *   is deliberately not adjacent to anything.
 * - This is **what physically follows**, which is the only thing a Previous and
 *   a Next button can mean. Pressing Next and then Previous has to return you
 *   where you were, and a resume point has no mirror.
 *
 * Keep it that way. If a surface wants "carry on watching this show", it wants
 * the API's answer, not this one.
 *
 * Pure, and unit-tested before it was written. Ordering is the one thing here
 * that can be quietly wrong for months — it renders perfectly either way.
 */

export interface SequenceSeason {
  id: string
  /** Null when the folder name did not parse into a number. */
  number: number | null
}

/**
 * What ordering needs, and nothing else.
 *
 * `seasonId` and `orderIndex` are facts about *one* membership rather than about
 * the video — the same episode can be episode 3 of a show and item 1 of a
 * best-of row — which is why the collection has to be decided before this is
 * called. Generic over the caller's own shape so a slug and a title survive.
 */
export interface SequenceVideo {
  id: string
  title: string
  seasonId: string | null
  orderIndex: number | null
}

/** Whatever could not be placed sorts after everything that could. */
const LAST = Number.POSITIVE_INFINITY

/**
 * Compared rather than subtracted: `Infinity - Infinity` is `NaN`, which is
 * falsy and would fall through to the next tiebreak by accident rather than by
 * intent. Two unplaceable entries are equal *here* and settled further down.
 */
function byRank(a: number, b: number): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Where a video sits among the seasons: a tier, a number within it, and the
 * season's own id to keep the comparison total.
 *
 * Three tiers rather than two. A numbered season comes first, in number order.
 * A season whose number did not parse is still a season, so it follows the
 * numbered ones rather than being cast out. A video with no season at all —
 * `seasonId: null`, which is a real value meaning "directly in the collection",
 * and is where films live — comes last of everything: inside a show that is the
 * loose extra nobody filed.
 *
 * A `seasonId` naming a season that is not in the list should not happen, since
 * both halves come from one response. It is treated as an unnumbered season
 * rather than dropped: losing a real episode would silently shorten the show,
 * and ordering it oddly is the smaller failure.
 */
function seasonRank(
  video: SequenceVideo,
  seasons: Map<string, SequenceSeason>,
): [number, number, string] {
  if (video.seasonId === null) return [2, LAST, '']

  const season = seasons.get(video.seasonId)
  if (!season || season.number === null) return [1, LAST, video.seasonId]

  return [0, season.number, video.seasonId]
}

/**
 * The collection in running order.
 *
 * The order is **total** — season, then position, then title, then id. Ties are
 * ordinary rather than exceptional here: `orderIndex` is deliberately not unique
 * (a unique index collides during a drag-reorder), so without the last two
 * comparisons the sequence could come back differently from one load to the
 * next, and a control that reshuffles between identical requests reads as a
 * rendering bug for weeks.
 *
 * A null `orderIndex` sorts last within its season. It means ingest could not
 * read a number off the filename, and treating it as position zero offers an
 * unnumbered extra ahead of a real first episode — the same reasoning the API's
 * own `nextEpisode` uses.
 *
 * Copies before sorting: the array belongs to whoever passed it, and sorting a
 * fetched payload in place mutates the cache everything else is reading.
 */
export function episodeSequence<T extends SequenceVideo>(
  videos: readonly T[],
  seasons: readonly SequenceSeason[],
): T[] {
  const byId = new Map(seasons.map(season => [season.id, season]))

  return [...videos].sort((a, b) => {
    const [aTier, aNumber, aSeason] = seasonRank(a, byId)
    const [bTier, bNumber, bSeason] = seasonRank(b, byId)

    return (
      byRank(aTier, bTier)
      || byRank(aNumber, bNumber)
      || aSeason.localeCompare(bSeason)
      || byRank(a.orderIndex ?? LAST, b.orderIndex ?? LAST)
      || a.title.localeCompare(b.title)
      || a.id.localeCompare(b.id)
    )
  })
}

/**
 * What sits either side of one video in that sequence.
 *
 * Null at each end rather than wrapping around: reaching the last episode of a
 * show is worth noticing, and a Next that silently returns to episode one is a
 * loop nobody asked to be in.
 *
 * A video that is not in the sequence gets nothing either way. The collection
 * travels in the URL, where anyone can write it, so "this video is not in that
 * collection" is an ordinary state and the honest answer is no stepper at all.
 */
export function neighbours<T extends SequenceVideo>(
  sequence: readonly T[],
  videoId: string,
): { previous: T | null, next: T | null } {
  const index = sequence.findIndex(entry => entry.id === videoId)
  if (index < 0) return { previous: null, next: null }

  return {
    previous: sequence[index - 1] ?? null,
    next: sequence[index + 1] ?? null,
  }
}
