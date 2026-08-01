/**
 * Grouping a collection's videos under their seasons.
 *
 * Lifted out of the admin collection editor when the viewer's collection
 * overview needed the same arrangement. Two copies of "which episode belongs
 * where, and in what order" is how one screen ends up numbering episodes
 * differently from the other.
 */

export interface SeasonLike {
  id: string
  number: number | null
  slug: string
  title?: string | null
}

export interface EpisodeLike {
  id: string
  seasonId: string | null
  orderIndex: number | null
  title: string
}

export interface SeasonGroup<S extends SeasonLike, V extends EpisodeLike> {
  /** Null for videos that sit directly in the collection — that is where films live. */
  season: S | null
  videos: V[]
}

export interface GroupOptions {
  /**
   * Keep the "not in a season" group even when it is empty.
   *
   * The admin editor drags episodes between groups and needs it present as a
   * drop target — you cannot drop onto something that is not rendered. The
   * viewer's overview wants the opposite: a heading over an empty list is a
   * rendering bug as far as anyone reading the page is concerned.
   */
  includeEmptyLoose?: boolean
}

/**
 * Seasons in the order given, each with its videos; loose videos last.
 *
 * A season with no videos is kept — it exists, and hiding it makes a show look
 * like it has fewer seasons than it does. A video whose `seasonId` matches no
 * season we were handed falls into the loose group rather than vanishing; the
 * alternative is a page that quietly shows fewer episodes than the collection
 * has.
 */
export function groupVideosBySeason<S extends SeasonLike, V extends EpisodeLike>(
  seasons: S[],
  videos: V[],
  options: GroupOptions = {},
): SeasonGroup<S, V>[] {
  const known = new Set(seasons.map(season => season.id))

  const groups: SeasonGroup<S, V>[] = seasons.map(season => ({
    season,
    videos: ordered(videos.filter(video => video.seasonId === season.id)),
  }))

  const loose = ordered(
    videos.filter(video => video.seasonId === null || !known.has(video.seasonId)),
  )

  if (loose.length > 0 || options.includeEmptyLoose) {
    groups.push({ season: null, videos: loose })
  }

  return groups
}

/**
 * What to print above a group.
 *
 * An unrecognised season folder is accepted and flagged rather than refused, so
 * `number` really can be null — and "Season null" is worse than using the slug.
 */
export function seasonLabel(season: SeasonLike | null): string {
  if (season === null) return 'Not in a season'
  if (season.title) return season.title
  if (season.number !== null) return `Season ${season.number}`

  return titleCase(season.slug)
}

/**
 * Sorted copy, never in place — the admin editor holds its groups in a ref and
 * re-sorting the source array under it makes a drag jump.
 */
function ordered<V extends EpisodeLike>(videos: V[]): V[] {
  return [...videos].sort(
    (a, b) =>
      // A null orderIndex means "ingest could not tell" and sorts last; treating
      // it as zero puts an unnumbered extra ahead of a real episode one.
      (a.orderIndex ?? Number.POSITIVE_INFINITY) - (b.orderIndex ?? Number.POSITIVE_INFINITY)
      // Ties are normal, so the tie-break has to be total or the list reshuffles
      // between renders and reads as a rendering bug.
      || a.title.localeCompare(b.title)
      || a.id.localeCompare(b.id),
  )
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
