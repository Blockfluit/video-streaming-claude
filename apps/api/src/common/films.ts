/**
 * What a *film* is here, in one place.
 *
 * **A film is a video that no collection claims.** A membership is the whole of
 * the answer: if something holds this video, that something is how you reach it,
 * and the video is not a card of its own beside it. Browse therefore lists
 * shelves and the videos on no shelf at all — which is what `lists/sources/rank.ts`
 * has always done for the home page ("Empty means standalone, which is what a
 * film is"), so the two now agree rather than disagreeing quietly.
 *
 * **This rule was once narrower, and the reason matters.** It read "no
 * *season-holding* collection claims it", so a folder of eight Harry Potter
 * films — a collection with no seasons — put nine cards on browse: the shelf and
 * every film on it. Before that it was this rule, and it was widened because
 * publishing a saga left every film on it unfindable: the shelf was one card
 * named something else, the films were no longer cards, so they were nowhere.
 * That was reported as "browse does not show my films".
 *
 * What makes this rule safe now, and did not exist then, is that a shelf is
 * findable by **the titles of the videos on it** — `collectionSearch` in
 * `library/library.service.ts`. Searching "Prisoner of Azkaban" answers "Harry
 * Potter". The films are reached through the shelf instead of being nowhere.
 * Narrowing this rule without that clause re-creates the old bug exactly, so the
 * two belong together; `catalogue.db-spec.ts` pins both halves.
 *
 * Deliberately **not** "the membership has no `seasonId`". A special filed
 * straight under a show is an extra of that show; a null `seasonId` says only
 * that nobody filed it.
 *
 * Role-blind, and now unavoidably so. A membership disqualifies a video whether
 * or not the caller can see what holds it, which is also what used to need a
 * separate orphan clause: a video whose every collection is hidden is an
 * instalment of something the caller cannot see, and it is excluded here by the
 * same condition that excludes every other shelved video.
 */

/**
 * The videos this caller may see standing on their own.
 *
 * Returned under `AND` rather than as bare keys, and that is still load-bearing
 * even though this clause no longer contains an `OR` of its own: callers spread
 * `.AND` into their own `AND` array, and `GET /videos?q=` and the catalogue's
 * search both build an `OR` beside it. Two `OR` keys spread into one object
 * leave only the last — which is how a search filter or a visibility filter
 * disappears without an error.
 */
export function whereFilm(): { AND: object[] } {
  return {
    AND: [{ collections: { none: {} } }],
  };
}

/**
 * The other half: the videos a collection does claim.
 *
 * The exact complement now, which it could not be before. The old rule needed
 * this to be the *honest opposite* rather than the set complement, because
 * complementing its orphan clause would have made `?film=false` a way to
 * enumerate the episodes of shows the caller cannot see. There is no orphan
 * clause left to complement: the two values partition the library on membership
 * alone, and each video is still filtered by `whereVisible` at the call site.
 */
export function whereEpisode(): object {
  return { collections: { some: {} } };
}

/**
 * How a collection says which of the two it is.
 *
 * `Collection.seasonCount` is TMDB's idea of the whole show and is routinely
 * larger than what we hold — "3 of 5 seasons here" is a sentence only because
 * they are two different numbers — so it cannot answer this. These count our
 * own rows, and the seasons half is the same fact `whereFilm` reads from the
 * other side.
 */
export const COUNTS_HERE_SELECT = {
  _count: { select: { seasons: true, videos: true } },
} as const;

/** `_count` is Prisma's shape, not the API's, so it never reaches a client. */
export function withCountsHere<T extends { _count: { seasons: number; videos: number } }>(
  row: T,
): Omit<T, '_count'> & { seasonsHere: number; videosHere: number } {
  const { _count, ...rest } = row;

  return { ...rest, seasonsHere: _count.seasons, videosHere: _count.videos };
}

/**
 * The same, where the collection hangs off a row that may point at a video
 * instead — a list item, a watchlist entry. Null stays null: "this entry is a
 * video" is an ordinary answer, not a missing collection.
 */
export function withNestedCountsHere<
  T extends { collection: { _count: { seasons: number; videos: number } } | null },
>(row: T) {
  return { ...row, collection: row.collection === null ? null : withCountsHere(row.collection) };
}
