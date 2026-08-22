/**
 * Turning two sorted halves of the library into one page of it.
 *
 * `GET /library` answers over two tables — a collection is a shelf, a film is a
 * video no season-holding shelf claims — and Prisma cannot union them. So each
 * side is queried on its own and the results are merged here.
 *
 * Pure, and tested on its own, because the correctness of every page depends on
 * two things agreeing that are written in different languages: the `orderBy`
 * Postgres applies and the comparator this file applies afterwards. They are
 * declared together in `LIBRARY_SORTS` for exactly that reason — one table, so
 * a sort cannot be changed in one place and not the other.
 */

import type { LibrarySort } from '@video/shared';

/** Which half of the library an entry came from. */
export type LibraryEntryKind = 'collection' | 'film';

/**
 * The columns every sort compares.
 *
 * All four exist on `Collection` and on `Video`, which is what lets one
 * `orderBy` serve both queries. A card carries far more than this; nothing here
 * needs to know about the rest.
 */
export interface LibraryEntry {
  kind: LibraryEntryKind;
  id: string;
  normalisedTitle: string;
  year: number | null;
  createdAt: Date;
  /**
   * How well this entry answered the search, from `relevance.ts`. Zero when
   * there was no search, which is every request that is not sorted by it.
   *
   * The one field here that is not a column. It is **required** rather than
   * optional for the same reason `trailerYoutubeId` is required on a card: an
   * optional one forgotten at a mapper is `undefined` at runtime with nothing to
   * fail, and `undefined` through this comparator is `NaN`, which compares false
   * against everything and reshuffles the page silently.
   */
  score: number;
}

/**
 * A collection sorts before a film when everything else is equal.
 *
 * Not arbitrary: a saga and one of the films standing on it genuinely share a
 * title, both are right answers to one search, and the shelf is the more
 * general of the two. Postgres cannot express this — each query sees one kind —
 * so it is the one comparison that exists only here.
 */
const KIND_ORDER: Record<LibraryEntryKind, number> = { collection: 0, film: 1 };

/**
 * How many rows one side may contribute to a relevance answer.
 *
 * The bound a scored sort needs instead of a window. It is not a page size:
 * every one of these rows is fetched, scored and ordered on every request, and
 * the page is then cut out of the result — so this is the most a search can
 * cost, not the most it can show.
 *
 * **Ordering by the metric before the cut is what keeps the bound from changing
 * the answer**, and that sentence was true of the design and false of the code.
 * This was a `take` on a read ordered by `normalisedTitle`, so what it cut by
 * was the alphabet: a film called `Winter` sitting behind five hundred rows
 * whose only claim was that word in a synopsis was fetched, dropped and never
 * scored. The search had found it and then thrown it away, which reads from the
 * outside as the search not working — sometimes, on some queries, for no reason
 * anybody can see.
 *
 * So the number moved to the two places that can honour that sentence:
 * `CANDIDATE_LIMIT` in `candidates.ts`, where rows arrive ranked by similarity
 * and this is the cut, and the indirect read in `LibraryService.searched`, whose
 * routes no SQL ranking reaches and which `relevance.ts` already weights below
 * one. Nothing caps the direct read any more, because nothing needs to: it can
 * only return what `candidates.ts` already bounded.
 *
 * Same argument, and the same escape hatch, as `POOL_LIMIT` in
 * `lists/sources/computed.ts` — if this ever needs raising past what one query
 * should return, the ranking belongs in SQL rather than in a bigger number.
 */
export const RELEVANCE_POOL = 500;

/**
 * Ascending order on a `normalisedTitle`, matching Postgres.
 *
 * Deliberately `<`/`>` rather than `localeCompare`. A page boundary is decided
 * by the SQL order and this comparator **together** — the database picks which
 * rows are candidates, this picks where the cut falls — so the two have to
 * agree, and `localeCompare` applies ICU rules that no Postgres collation
 * shares. `normaliseTitle` folds accents, drops case and strips everything that
 * is not a letter or a digit, so a normalised title is lowercase ASCII
 * alphanumerics, where the two orders coincide.
 *
 * Checked rather than assumed, because the database is `en_US.utf8` rather than
 * `C` and the agreement is not obvious: sorting titles shaped like real ones
 * (`10things`, `2001aspaceodyssey`, `a1`, `ab`, `se7en`, `seven`) gives byte-for
 * -byte the same order in Postgres and in JavaScript. So does the fallback case
 * `normaliseTitle` produces for a name with no Latin alphanumerics at all —
 * another script, or pure punctuation — because glibc drops to code-point order
 * for characters its table does not cover.
 *
 * The one real divergence left is **astral-plane** characters. Postgres orders
 * by code point; JavaScript compares UTF-16 code units, so a surrogate pair
 * (`U+1F600`, lead unit `0xD83D`) sorts before `U+FF00` here and after it
 * there. A title normalising to one of those, landing exactly on a page
 * boundary, could show up on the wrong side of it. Fixing that would mean
 * teaching this file the database's collation, which is a far larger promise
 * than an emoji-titled film at row 50 deserves.
 */
function byText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;

  return 0;
}

/** The tie-break that makes every order total. Ids are unique across a table, kind across the two. */
function byIdentity(a: LibraryEntry, b: LibraryEntry, direction: 1 | -1): number {
  const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kind !== 0) return kind;

  return byText(a.id, b.id) * direction;
}

/**
 * Every sort the endpoint offers, as the pair that has to agree.
 *
 * `orderBy` is handed to both Prisma queries unchanged — every column named is
 * on both models — and `compare` re-establishes the same order across the two
 * results. Restricted to a single kind the two are identical, which is what
 * makes taking `offset + limit` from each side and slicing exact.
 *
 * Each order ends in `id`, because offset paging over a non-total order
 * silently repeats and skips rows between pages, and titles, years and
 * timestamps all repeat.
 */
export const LIBRARY_SORTS: Record<
  LibrarySort,
  { orderBy: object[]; compare: (a: LibraryEntry, b: LibraryEntry) => number }
> = {
  title: {
    orderBy: [{ normalisedTitle: 'asc' }, { id: 'asc' }],
    compare: (a, b) => byText(a.normalisedTitle, b.normalisedTitle) || byIdentity(a, b, 1),
  },

  year: {
    // `nulls: 'last'` rather than Postgres's default: a null year means nobody
    // knows, and a descending sort would otherwise open the list with every
    // unknown one.
    orderBy: [
      { year: { sort: 'desc', nulls: 'last' } },
      { normalisedTitle: 'asc' },
      { id: 'asc' },
    ],
    compare: (a, b) =>
      byYear(a.year, b.year) || byText(a.normalisedTitle, b.normalisedTitle) || byIdentity(a, b, 1),
  },

  added: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    compare: (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || byIdentity(a, b, -1),
  },

  relevance: {
    /*
     * The **pool** order, not the merged order — the one row in this table where
     * those are different things, and the difference is the whole safety
     * argument.
     *
     * Every other sort here names a column Postgres ordered by, which is what
     * lets a page be a window onto a query. A score is computed in memory from
     * text, so Postgres cannot order by it and no prefix of one side is a prefix
     * of the answer. `perSideWindow` therefore reads the whole pool for this
     * sort rather than a window of it, and this `orderBy` exists only so that
     * when the pool is cut at `RELEVANCE_POOL` it is cut the same way on every
     * request. A nondeterministic cut is how page two repeats a card page one
     * already showed.
     */
    orderBy: [{ normalisedTitle: 'asc' }, { id: 'asc' }],
    // Ends in `byIdentity` like the rest, so the order is still total and the
    // collection-before-film rule still decides an exact tie.
    compare: (a, b) =>
      b.score - a.score || byText(a.normalisedTitle, b.normalisedTitle) || byIdentity(a, b, 1),
  },
};

/** Descending, with an unknown year after every known one. */
function byYear(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  return b - a;
}

/**
 * What to ask each side for, to be able to answer for the union.
 *
 * Neither side may `skip`. Row 1 of one table can be row 300 of the union or
 * row 1 of it, and nothing short of looking says which — so the offset is
 * applied *after* merging, never by the database. Taking `offset + limit` from
 * each side is exactly enough and no more: the first `offset + limit` rows of a
 * merged order can only have come from the first `offset + limit` rows of each
 * of its sources.
 *
 * The cost is real and worth naming — page 40 reads 2 000 rows from each table
 * to return 50. That is what `MAX_LIBRARY_OFFSET` bounds; a library nobody can
 * find anything in past page 200 wants a filter, not a deeper page.
 *
 * **A search cannot window at all**, and the argument above is exactly why: it
 * assumes the per-side SQL order *is* the merged order, and a searching request
 * is ordered by a score Postgres never computed.
 *
 * So this answers browsing only. A search does not take a window of a larger
 * read; it reads exactly the rows something upstream already bounded, which is
 * a stricter thing and the reason for it is in `RELEVANCE_POOL`. This function
 * took a `searching` flag and answered `{ skip: 0, take: RELEVANCE_POOL }` for
 * it — a cap on a read ordered by title, which is where the search lost the
 * answers it had already found.
 */
export function perSideWindow(offset: number, limit: number): { skip: number; take: number } {
  return { skip: 0, take: offset + limit };
}

/**
 * One page of the union.
 *
 * Each side must already be sorted by `LIBRARY_SORTS[sort].orderBy` and hold
 * `perSideWindow`'s window. Sorting the concatenation rather than walking two
 * cursors is deliberate: the comparator is a total order, so the result is the
 * same, and the input is bounded by the window that was just fetched.
 */
export function mergePage<T extends LibraryEntry>(
  sides: T[][],
  sort: LibrarySort,
  offset: number,
  limit: number,
): T[] {
  return sides
    .flat()
    .sort(LIBRARY_SORTS[sort].compare)
    .slice(offset, offset + limit);
}
