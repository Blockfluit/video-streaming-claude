import { librarySortSchema } from '@video/shared';

import {
  LIBRARY_SORTS,
  mergePage,
  perSideWindow,
  RELEVANCE_POOL,
  type LibraryEntry,
} from './merge';

/**
 * The two kinds, built so a test reads as the thing it is about. `createdAt`
 * defaults to a fixed instant so a test that is not about recency does not
 * accidentally depend on one.
 */
const EPOCH = new Date('2026-01-01T00:00:00.000Z');

const shelf = (
  id: string,
  normalisedTitle: string,
  extra: Partial<LibraryEntry> = {},
): LibraryEntry => ({
  kind: 'collection',
  id,
  normalisedTitle,
  year: null,
  createdAt: EPOCH,
  score: 0,
  ...extra,
});

const film = (
  id: string,
  normalisedTitle: string,
  extra: Partial<LibraryEntry> = {},
): LibraryEntry => ({
  kind: 'film',
  id,
  normalisedTitle,
  year: null,
  createdAt: EPOCH,
  score: 0,
  ...extra,
});

/** Every entry the merge produced, in order, as `id`s — the shape a failure reads best in. */
const ids = (entries: LibraryEntry[]): string[] => entries.map((entry) => entry.id);

describe('LIBRARY_SORTS', () => {
  describe('title', () => {
    const { compare } = LIBRARY_SORTS.title;

    it('orders on the normalised title, ascending', () => {
      expect(compare(shelf('a', 'alien'), film('b', 'brazil'))).toBeLessThan(0);
      expect(compare(film('b', 'brazil'), shelf('a', 'alien'))).toBeGreaterThan(0);
    });

    it('puts a collection before a film when the titles match', () => {
      // A saga and one of the films on it genuinely share a name. Both are
      // right answers, and the shelf is the more general one.
      expect(compare(shelf('c', 'dune'), film('v', 'dune'))).toBeLessThan(0);
    });

    it('breaks a remaining tie on id, so the order is total', () => {
      expect(compare(film('a', 'dune'), film('b', 'dune'))).toBeLessThan(0);
      expect(compare(film('b', 'dune'), film('a', 'dune'))).toBeGreaterThan(0);
    });

    it('never returns zero for two different entries', () => {
      // Offset paging over a non-total order repeats and skips rows between
      // pages, and here ties are the norm: the two tables number themselves
      // independently, so nothing but the id makes the order total.
      expect(compare(shelf('a', 'dune'), film('a', 'dune'))).not.toBe(0);
    });
  });

  describe('year', () => {
    const { compare } = LIBRARY_SORTS.year;

    it('orders newest first', () => {
      expect(compare(film('a', 'a', { year: 2024 }), film('b', 'b', { year: 1999 }))).toBeLessThan(
        0,
      );
    });

    it('sorts an unknown year last, in both directions', () => {
      // Null means nobody knows, which is not the same as being the oldest
      // film in the library.
      expect(compare(film('a', 'a', { year: 1920 }), film('b', 'b', { year: null }))).toBeLessThan(
        0,
      );
      expect(
        compare(film('b', 'b', { year: null }), film('a', 'a', { year: 1920 })),
      ).toBeGreaterThan(0);
    });

    it('falls back to the title when the years match', () => {
      expect(
        compare(film('z', 'alien', { year: 2000 }), film('a', 'brazil', { year: 2000 })),
      ).toBeLessThan(0);
    });

    it('is total when year and title both match', () => {
      const a = film('a', 'dune', { year: 2021 });
      const b = film('b', 'dune', { year: 2021 });

      expect(compare(a, b)).toBeLessThan(0);
      expect(compare(a, a)).toBe(0);
    });
  });

  describe('added', () => {
    const { compare } = LIBRARY_SORTS.added;

    it('orders most recently added first', () => {
      const older = film('a', 'a', { createdAt: new Date('2026-01-01T00:00:00.000Z') });
      const newer = film('b', 'b', { createdAt: new Date('2026-06-01T00:00:00.000Z') });

      expect(compare(newer, older)).toBeLessThan(0);
    });

    it('breaks a tie on id descending, matching its own SQL order', () => {
      expect(compare(film('b', 'b'), film('a', 'a'))).toBeLessThan(0);
    });
  });

  it('orders a single kind exactly as that kind was fetched', () => {
    // The merge slices at a boundary decided by the SQL order and this
    // comparator together, so restricted to one kind they have to agree. This
    // pins the comparator half; `library.db-spec.ts` pins that the two match.
    const films = [film('c', 'chef'), film('a', 'alien'), film('b', 'brazil')];

    expect(ids([...films].sort(LIBRARY_SORTS.title.compare))).toEqual(['a', 'b', 'c']);
  });

  it('names a Prisma order for every sort', () => {
    // Read off the schema rather than written out here. A hand-written list
    // stops guarding the moment a sort is added to the enum and not to this
    // array — silently, and while still passing, which is the one failure mode
    // a guard must not have.
    for (const sort of librarySortSchema.options) {
      expect(LIBRARY_SORTS[sort].orderBy.length).toBeGreaterThan(0);
    }
  });
});

describe('LIBRARY_SORTS.relevance', () => {
  const { compare } = LIBRARY_SORTS.relevance;

  it('puts the better match first', () => {
    expect(compare(film('a', 'matrix', { score: 1 }), film('b', 'thematrix', { score: 0.8 }))).toBeLessThan(0);
  });

  it('falls back to the title when two entries matched equally well', () => {
    // Ties are the norm here rather than the exception — a tier-based score
    // gives whole groups of entries the same number — so what happens next is
    // most of the order a reader actually sees.
    expect(compare(film('b', 'alien', { score: 0.8 }), film('a', 'brazil', { score: 0.8 }))).toBeLessThan(0);
  });

  it('still puts a collection before a film they tie with', () => {
    // The rule `relevance.ts` weights every indirect route below one to protect:
    // a shelf must not be able to accumulate its way past the film it shares a
    // name with, because this is what decides that pair.
    expect(compare(shelf('c', 'dune', { score: 1 }), film('v', 'dune', { score: 1 }))).toBeLessThan(0);
  });

  it('never returns zero for two different entries', () => {
    // Offset paging over a non-total order repeats and skips rows, and
    // `browse-paging.ts` concatenates pages on exactly this promise.
    expect(compare(shelf('a', 'dune', { score: 1 }), film('a', 'dune', { score: 1 }))).not.toBe(0);
    expect(compare(film('a', 'dune', { score: 1 }), film('b', 'dune', { score: 1 }))).not.toBe(0);
  });
});

describe('perSideWindow', () => {
  it('takes offset + limit from each side, starting at nothing', () => {
    // Page 3 of the union can contain a row that is only row 1 of its own
    // table, so neither side may skip. The first `offset + limit` rows of the
    // union can only come from the first `offset + limit` rows of each side,
    // which is what makes taking that many exact rather than approximate.
    expect(perSideWindow(100, 50, false)).toEqual({ skip: 0, take: 150 });
  });

  it('asks for the page itself when there is no offset', () => {
    expect(perSideWindow(0, 50, false)).toEqual({ skip: 0, take: 50 });
  });

  it('reads the whole pool while searching, because a window would be wrong', () => {
    /*
     * The argument the other two cases rest on — that the first `offset + limit`
     * rows of the union came from the first that many of each side — assumes the
     * per-side SQL order is the merged order. Under a score Postgres never
     * computed it is not, so there is no window to take and the pool is read
     * whole.
     */
    expect(perSideWindow(100, 50, true)).toEqual({ skip: 0, take: RELEVANCE_POOL });
    expect(perSideWindow(0, 50, true)).toEqual({ skip: 0, take: RELEVANCE_POOL });
  });
});

describe('mergePage', () => {
  const shelves = [shelf('c1', 'alien'), shelf('c2', 'dune'), shelf('c3', 'solaris')];
  const films = [film('v1', 'brazil'), film('v2', 'chef'), film('v3', 'tenet')];

  it('interleaves the two sides into one order', () => {
    expect(ids(mergePage([shelves, films], 'title', 0, 10))).toEqual([
      'c1',
      'v1',
      'v2',
      'c2',
      'c3',
      'v3',
    ]);
  });

  it('returns exactly the requested window', () => {
    expect(ids(mergePage([shelves, films], 'title', 2, 2))).toEqual(['v2', 'c2']);
  });

  it('pages without repeating or skipping a row', () => {
    const all = [
      ...ids(mergePage([shelves, films], 'title', 0, 2)),
      ...ids(mergePage([shelves, films], 'title', 2, 2)),
      ...ids(mergePage([shelves, films], 'title', 4, 2)),
    ];

    expect(all).toEqual(['c1', 'v1', 'v2', 'c2', 'c3', 'v3']);
    expect(new Set(all).size).toBe(all.length);
  });

  it('runs off the end rather than padding', () => {
    expect(ids(mergePage([shelves, films], 'title', 5, 10))).toEqual(['v3']);
    expect(mergePage([shelves, films], 'title', 99, 10)).toEqual([]);
  });

  it('copes with one side being empty', () => {
    expect(ids(mergePage([[], films], 'title', 0, 10))).toEqual(['v1', 'v2', 'v3']);
    expect(ids(mergePage([shelves, []], 'title', 1, 1))).toEqual(['c2']);
  });

  it('merges on the sort it is given, not on the one the sides arrived in', () => {
    const byYear = [
      [shelf('c1', 'alien', { year: 1979 })],
      [film('v1', 'brazil', { year: 2024 }), film('v2', 'chef', { year: 1999 })],
    ];

    // 2024, then 1999, then 1979 — the shelf lands last despite arriving first.
    expect(ids(mergePage(byYear, 'year', 0, 10))).toEqual(['v1', 'v2', 'c1']);
  });
});
