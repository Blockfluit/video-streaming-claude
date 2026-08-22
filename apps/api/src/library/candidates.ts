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
 *
 * They do decide *whether* a row is in the answer at all, though, which is a
 * heavier job than it sounds and now the only one of its kind: this is the one
 * place in a search where rows are ranked, so it is the one place a bound may
 * fall. Anything cut further downstream is cut in an order that has nothing to
 * do with what was typed. See `CANDIDATE_LIMIT`.
 */

import type { PrismaService } from '../prisma/prisma.service';

import { RELEVANCE_POOL } from './merge';

/**
 * How many rows one table may offer before the query stops looking.
 *
 * **This is the only cut a searched read makes, and that is the point.** It was
 * 2 000 — generous, on the reasoning that the filters after it (visibility,
 * genre, tag, kind) throw a great deal away — and downstream a second bound
 * trimmed what survived back to `RELEVANCE_POOL` in *title* order. Two bounds,
 * and only the first of them knew what the search was for: a film called
 * `Winter` sat behind five hundred rows whose whole claim was the word in their
 * synopsis, so it was found here, dropped there, and never scored. Searching a
 * title and not being shown it is the feature failing outright, and it failed on
 * nothing more legible than where the title fell in the alphabet.
 *
 * So there is one bound, it lives where the rows are ranked, and it is the size
 * of the pool that reads them. What it discards is the row that resembled the
 * query *least*, which is what a bound is for. The old number bought recall on a
 * heavily filtered library and paid for it in the answer to every ordinary
 * search; `library.service.ts` explains what reads this.
 */
const CANDIDATE_LIMIT = RELEVANCE_POOL;

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
     * **`UNION`, not `OR`, and that is the whole performance story.** The five
     * were one `OR` chain, which reads better and meant Postgres could use none
     * of the five GIN indexes the migration created: a disjunction is answerable
     * by an index only if *every* branch is, and `"description" ILIKE` had no
     * index at all while the `unnest("genres")` test can never have one. So each
     * keystroke scanned the table end to end and computed a trigram similarity
     * per row for the ORDER BY. Measured over 20 000 videos: 173 ms as an `OR`,
     * 8 ms as a `UNION` of the three title branches. Written apart, each branch
     * is planned on its own and takes the index that answers it.
     *
     * `description` is now indexed too (`gin_trgm_ops` answers `ILIKE '%x%'`,
     * 49 ms → 0.5 ms). `genres` is deliberately **not**: an expression index over
     * `array_to_string(genres, ' ')` is refused outright because that function is
     * STABLE rather than IMMUTABLE — the same trap `unaccent()` sprang on the
     * folded title — so this branch scans one narrow column, which is the cost
     * `LibraryService.genres` already decided was the cheaper thing to spend.
     *
     * The score is computed once, in the outer query, over rows the branches
     * already found. `id` last in the ORDER BY is not decoration: without it the
     * cut at `CANDIDATE_LIMIT` falls wherever Postgres feels like, and a card
     * that moves between requests is a card page two shows again after page one
     * already did.
     */
    const collections = await tx.$queryRaw<IdRow[]>`
      WITH hits AS (
              SELECT id FROM "Collection" WHERE ${q} <% "title"
        UNION SELECT id FROM "Collection" WHERE "normalisedTitle" % ${normalised}
        UNION SELECT id FROM "Collection" WHERE "title" ILIKE ${like}
        UNION SELECT id FROM "Collection" WHERE "description" ILIKE ${like}
        UNION SELECT id FROM "Collection"
               WHERE EXISTS (SELECT 1 FROM unnest("genres") AS g WHERE g ILIKE ${like})
      )
      SELECT c.id FROM "Collection" c JOIN hits ON hits.id = c.id
       ORDER BY GREATEST(word_similarity(${q}, c."title"),
                         similarity(c."normalisedTitle", ${normalised})) DESC, c.id ASC
       LIMIT ${CANDIDATE_LIMIT}
    `;

    const videos = await tx.$queryRaw<IdRow[]>`
      WITH hits AS (
              SELECT id FROM "Video" WHERE ${q} <% "title"
        UNION SELECT id FROM "Video" WHERE "normalisedTitle" % ${normalised}
        UNION SELECT id FROM "Video" WHERE "title" ILIKE ${like}
        UNION SELECT id FROM "Video" WHERE "description" ILIKE ${like}
        UNION SELECT id FROM "Video"
               WHERE EXISTS (SELECT 1 FROM unnest("genres") AS g WHERE g ILIKE ${like})
      )
      SELECT v.id FROM "Video" v JOIN hits ON hits.id = v.id
       ORDER BY GREATEST(word_similarity(${q}, v."title"),
                         similarity(v."normalisedTitle", ${normalised})) DESC, v.id ASC
       LIMIT ${CANDIDATE_LIMIT}
    `;

    // A person is searched by name and nothing else. Fuzzily, like a title —
    // half the point of a cast search is that nobody spells "Schwarzenegger".
    // Split for the same reason as the other two: both branches are answerable
    // by `Person_name_trgm_idx`, and neither is while they share an `OR`.
    const people = await tx.$queryRaw<PersonRow[]>`
      WITH hits AS (
              SELECT id FROM "Person" WHERE ${q} <% "name"
        UNION SELECT id FROM "Person" WHERE "name" ILIKE ${like}
      )
      SELECT p.id, p.name FROM "Person" p JOIN hits ON hits.id = p.id
       ORDER BY word_similarity(${q}, p."name") DESC, p.id ASC
       LIMIT ${CANDIDATE_LIMIT}
    `;

    return {
      collectionIds: collections.map((row) => row.id),
      videoIds: videos.map((row) => row.id),
      people,
    };
  });
}
