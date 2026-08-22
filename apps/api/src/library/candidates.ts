/**
 * Which rows resemble what somebody typed — and nothing else about them.
 *
 * The recall half of search. `relevance.ts` decides what a match is *worth*;
 * this decides what Postgres is even willing to offer, which is the one part
 * that cannot be done in JavaScript: a typo is not a substring, and no `OR` of
 * `contains` recovers `intersteller`. Trigram similarity is why `pg_trgm` is
 * installed.
 *
 * **This is the only raw SQL in the catalogue, and the rule that keeps it safe
 * is that it never crosses a relation.** Each query asks one table one question
 * about its own text and answers with ids. It does not know what a film is, who
 * may see a draft, or that a shelf can be found through a video standing on it
 * — every one of those rules stays in `library.service.ts`, in Prisma, in the
 * shape it already had.
 *
 * That rule is not stylistic. `LibraryService.genres` refuses raw SQL because it
 * "would mean restating `whereFilm` … in a second language", and it is right.
 * The version of this file that returned "collection X matches, because a video
 * on it is called that" would have restated exactly that — and worse, it would
 * have leaked: the shelf's own `state` passes the visibility filter while the
 * draft video's never gets asked, so a viewer learns an unpublished title
 * exists. Ids from one table, joined by Prisma afterwards, cannot do that.
 *
 * The scores Postgres computes are deliberately **thrown away**. They exist only
 * to decide which rows survive `CANDIDATE_LIMIT`, never what order the answer is
 * in. Making SQL's idea of similarity and the scorer's agree would recreate the
 * seam `merge.ts` spends forty lines warning about, for no benefit.
 */

import type { PrismaService } from '../prisma/prisma.service';

/**
 * How many rows one table may offer before the query stops looking.
 *
 * Ordered by similarity before the cut, so the bound only ever discards rows
 * that already resembled the query least. Generous next to `RELEVANCE_POOL`,
 * because the filters that come after this — visibility, genre, tag, kind — can
 * throw a great deal of it away.
 */
const CANDIDATE_LIMIT = 2000;

/**
 * How alike two strings must be to be worth offering.
 *
 * 0.3, which is also Postgres's own default for both settings — so pinning it
 * below is belt and braces rather than load-bearing, and a failure to pin
 * degrades to identical behaviour rather than to a silent change of meaning.
 *
 * Measured, not guessed. Across titles shaped like real ones, every query that
 * ought to match scored at least 0.4 ("amelie" against "Amélie" by word
 * similarity, its weakest true positive) while the worst false positive —
 * "lord of the rigns" against "Harry Potter and the Prisoner of Azkaban" —
 * scored 0.259. The gap is wide and 0.3 sits in it.
 */
const THRESHOLD = '0.3';

/** Ids only. Nothing here has been filtered for who may see it. */
export interface SearchCandidates {
  collectionIds: string[];
  videoIds: string[];
  /** Names come back because `relevance.ts` scores them; the ids do the joining. */
  people: { id: string; name: string }[];
}

interface IdRow {
  id: string;
}

interface PersonRow {
  id: string;
  name: string;
}

/**
 * `%` and `_` are wildcards to `LIKE`, and `q` is whatever was typed into a
 * search box. Escaped rather than trusted: a query of `%%%%` is otherwise a
 * request to scan the library several times over, and a literal per cent sign
 * should match a literal per cent sign.
 */
function contains(q: string): string {
  return `%${q.replace(/([\\%_])/g, '\\$1')}%`;
}

/**
 * Everything that resembles `q`, per table.
 *
 * One interactive transaction, because `set_config(…, true)` is `SET LOCAL` in a
 * form that takes a bind parameter and a local setting needs a transaction to be
 * local to. The `%` and `<%` operators read those settings, and they are the
 * indexable spellings — writing the comparison out as `word_similarity(…) >= x`
 * would be threshold-explicit and would not touch the GIN indexes at all.
 */
export async function searchCandidates(
  prisma: PrismaService,
  q: string,
  normalised: string,
): Promise<SearchCandidates> {
  const like = contains(q);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('pg_trgm.similarity_threshold', ${THRESHOLD}, true),
             set_config('pg_trgm.word_similarity_threshold', ${THRESHOLD}, true)
    `;

    /*
     * Five ways in, and each earns its place:
     *
     *   `<% "title"`            the typed text as a run of words inside the
     *                           title — word order and partial words.
     *   `"normalisedTitle" %`   the accent- and punctuation-folded form —
     *                           misspellings, and "amelie" for "Amélie".
     *   `"title" ILIKE`         what the search did before this change, kept so
     *                           the new one is a strict superset of the old.
     *   `"description" ILIKE`   likewise.
     *   `genres`                the search box has said "titles, genres and
     *                           cast" all along while never once reading a
     *                           genre; the chips on a collection page link here.
     *
     * `id` last in the ORDER BY is not decoration. Without it the cut at
     * `CANDIDATE_LIMIT` falls wherever Postgres feels like, and a card that
     * moves between requests is a card page two shows again after page one
     * already did.
     */
    const collections = await tx.$queryRaw<IdRow[]>`
      SELECT id FROM "Collection"
       WHERE ${q} <% "title"
          OR "normalisedTitle" % ${normalised}
          OR "title" ILIKE ${like}
          OR "description" ILIKE ${like}
          OR EXISTS (SELECT 1 FROM unnest("genres") AS g WHERE g ILIKE ${like})
       ORDER BY GREATEST(word_similarity(${q}, "title"),
                         similarity("normalisedTitle", ${normalised})) DESC, id ASC
       LIMIT ${CANDIDATE_LIMIT}
    `;

    const videos = await tx.$queryRaw<IdRow[]>`
      SELECT id FROM "Video"
       WHERE ${q} <% "title"
          OR "normalisedTitle" % ${normalised}
          OR "title" ILIKE ${like}
          OR "description" ILIKE ${like}
          OR EXISTS (SELECT 1 FROM unnest("genres") AS g WHERE g ILIKE ${like})
       ORDER BY GREATEST(word_similarity(${q}, "title"),
                         similarity("normalisedTitle", ${normalised})) DESC, id ASC
       LIMIT ${CANDIDATE_LIMIT}
    `;

    // A person is searched by name and nothing else. Fuzzily, like a title —
    // half the point of a cast search is that nobody spells "Schwarzenegger".
    const people = await tx.$queryRaw<PersonRow[]>`
      SELECT id, name FROM "Person"
       WHERE ${q} <% "name"
          OR "name" ILIKE ${like}
       ORDER BY word_similarity(${q}, "name") DESC, id ASC
       LIMIT ${CANDIDATE_LIMIT}
    `;

    return {
      collectionIds: collections.map((row) => row.id),
      videoIds: videos.map((row) => row.id),
      people,
    };
  });
}
