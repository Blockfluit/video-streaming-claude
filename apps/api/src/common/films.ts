/**
 * What a *film* is here, in one place.
 *
 * **A film is a video that no season-holding collection claims.** Seasons are
 * the only thing in the model that says "this is an instalment of something":
 * `ingest/structure.ts` turns a folder of season folders into a collection
 * *with* seasons, and a folder of eight Harry Potter films into a collection
 * with none. So the eight films are films — each searchable, each with a page
 * of its own — while episode 3 of season 2 is not, because listing episodes
 * would bury four films under forty instalments of one show.
 *
 * It used to be "a video in no collection at all", which is why publishing a
 * saga made every film on it unfindable: the shelf was one card and the films
 * were on it, so they were nowhere. Reported as "browse does not show my films".
 *
 * Deliberately **not** "the membership has no `seasonId`". A special filed
 * straight under a show that has seasons is an extra of that show; a null
 * `seasonId` says only that nobody filed it.
 *
 * The season half is deliberately role-blind. A video that is an episode of a
 * show one caller cannot see *and* an item on a shelf they can is not a film
 * for anybody — narrowing that half per role could only ever leak.
 */

import { whereVisible } from './publishing';
import type { Role } from '../prisma/generated/enums';

/**
 * A video whose every collection is hidden from this caller, excluded.
 *
 * It is not a film — it is an instalment of something they cannot see — and
 * offering it as though it stood on its own is the leak the visibility rule
 * exists to prevent. A video with **no** memberships is the different, ordinary
 * case and is kept: that is a film on no shelf at all.
 *
 * An admin sees every state, so every membership is visible and the condition
 * is always true; emitting it would put a subquery on every admin query for
 * nothing.
 */
function notOrphanedClauses(role: Role): object[] {
  if (role === 'ADMIN') return [];

  return [
    {
      OR: [
        { collections: { none: {} } },
        { collections: { some: { collection: whereVisible(role) } } },
      ],
    },
  ];
}

/**
 * The videos this caller may see standing on their own.
 *
 * Returned under `AND` rather than as bare keys, and that is load-bearing:
 * this clause contains an `OR`, `GET /videos?q=` builds another one, and two
 * `OR` keys spread into one object leave only the last — which is how a search
 * filter or a visibility filter disappears without an error.
 */
export function whereFilm(role: Role): { AND: object[] } {
  return {
    AND: [
      // `some: {}` on the nested seasons is "holds at least one".
      { collections: { none: { collection: { seasons: { some: {} } } } } },
      ...notOrphanedClauses(role),
    ],
  };
}

/**
 * The other half: the videos a season-holding collection does claim.
 *
 * The honest opposite of the rule, not the set complement of `whereFilm`.
 * Complementing the orphan clause as well would make `?film=false` a way to
 * enumerate the episodes of shows the caller cannot see, which is the one thing
 * neither value of this filter may do. For an admin the two values partition
 * the library exactly; for a USER `film=true` is additionally narrowed.
 */
export function whereEpisode(): object {
  return { collections: { some: { collection: { seasons: { some: {} } } } } };
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
