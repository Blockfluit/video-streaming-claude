import { Injectable } from '@nestjs/common';
import {
  toPage,
  type GenreFacet,
  type LibraryCard,
  type ListLibraryQuery,
  type Page,
  type PageQuery,
  type PublishState,
} from '@video/shared';

import { COUNTS_HERE_SELECT, whereFilm } from '../common/films';
import { narrowToVisibleStates, whereVisible } from '../common/publishing';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';

import { searchCandidates, type SearchCandidates } from './candidates';
import { LIBRARY_SORTS, mergePage, perSideWindow, type LibraryEntry } from './merge';
import { prepareSearch, scoreEntry, scoreText, WEIGHTS, type Search } from './relevance';

/**
 * The catalogue, as one list.
 *
 * `/browse` asks one question — what is in here, and which of it do I want —
 * about the two things the library is made of: a **collection** is a shelf, and
 * a **film** is a video no season-holding shelf claims. They live in two tables
 * and Prisma cannot union them, so this queries each and merges in `merge.ts`.
 *
 * It used to be the *browser* stitching two capped requests together, which
 * cannot page or sort across the join: each half was cut at 100 and the order
 * was only ever right inside whichever window had loaded. Moving the merge here
 * is what makes paging and sorting mean anything.
 *
 * Every filter is composed from rules the two halves already carry —
 * `whereFilm`, `whereVisible`, `narrowToVisibleStates`. Nothing here restates
 * what a film is or who may see what, because a second definition of either is
 * how one of them quietly stops being true.
 */

/** Enough to draw a tile, and no more: a picture, a title, a chip. */
const COLLECTION_CARD = {
  id: true,
  slug: true,
  title: true,
  year: true,
  tags: true,
  genres: true,
  state: true,
  // The home hero features whatever was added last and plays its trailer, and
  // it reads this endpoint when no `RECENTLY_ADDED` row exists to read instead.
  trailerYoutubeId: true,
  // Sort keys, stripped before the response. `normalisedTitle` is a comparison
  // key — it answers "is this the same title" and no client has a use for it.
  normalisedTitle: true,
  createdAt: true,
  ...COUNTS_HERE_SELECT,
} as const;

const FILM_CARD = {
  id: true,
  slug: true,
  title: true,
  year: true,
  tags: true,
  genres: true,
  state: true,
  durationSec: true,
  trailerYoutubeId: true,
  normalisedTitle: true,
  createdAt: true,
} as const;

/** A card with the columns the merge sorts on still attached. */
type SortableCard = LibraryCard & LibraryEntry;

/** The rows the two selects above produce, named so the mappers need no casts. */
interface CollectionRow {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  tags: string[];
  genres: string[];
  state: PublishState;
  trailerYoutubeId: string | null;
  normalisedTitle: string;
  createdAt: Date;
  _count: { seasons: number; videos: number };
}

interface FilmRow extends Omit<CollectionRow, '_count'> {
  durationSec: number | null;
}

/** What `candidates.ts` found, carried together because they are always used together. */
interface Found {
  candidates: SearchCandidates;
  personIds: string[];
}

/** How many credits and videos are worth reading to explain one card's score. */
const EVIDENCE_CREDITS = 10;
const EVIDENCE_VIDEOS = 20;

/**
 * The extra columns a search needs, and only a search.
 *
 * Read conditionally rather than always: a synopsis on every card of every page
 * is a great deal of text nobody renders, and browsing does not score anything.
 *
 * The nested `videos` carries `whereVisible(role)` for the same reason the
 * `where` does — this is the read that decides how a shelf scores, and scoring
 * it on a draft episode a viewer cannot see would put that episode's title back
 * into their results through the shelf.
 */
function collectionEvidence(role: Role, videoIds: string[], personIds: string[]) {
  /*
   * Typed as `object` so that `whereVisible`'s optional `state` can be spread
   * into it. Prisma's nested relation filter is a union whose other branch
   * requires the key to be absent outright, which an optional property that may
   * be `undefined` does not satisfy — the same reason `collectionWhere` returns
   * `object` rather than a `CollectionWhereInput`.
   */
  const onThisShelf: object = {
    video: {
      ...whereVisible(role),
      OR: [{ id: { in: videoIds } }, { credits: { some: creditedTo(personIds) } }],
    },
  };

  return {
    description: true,
    credits: {
      where: creditedTo(personIds),
      select: { personId: true },
      take: EVIDENCE_CREDITS,
    },
    videos: {
      where: onThisShelf,
      // Deterministic, so that the cut at `EVIDENCE_VIDEOS` falls the same way
      // on every request and a shelf does not score differently between pages.
      orderBy: { video: { normalisedTitle: 'asc' as const } },
      select: {
        video: {
          select: {
            title: true,
            normalisedTitle: true,
            credits: {
              where: creditedTo(personIds),
              select: { personId: true },
              take: EVIDENCE_CREDITS,
            },
          },
        },
      },
      take: EVIDENCE_VIDEOS,
    },
  };
}

function filmEvidence(personIds: string[]) {
  return {
    description: true,
    credits: {
      where: creditedTo(personIds),
      select: { personId: true },
      take: EVIDENCE_CREDITS,
    },
  };
}

interface CreditRef {
  personId: string;
}

interface SearchedCollectionRow extends CollectionRow {
  description: string | null;
  credits: CreditRef[];
  videos: {
    video: { title: string; normalisedTitle: string; credits: CreditRef[] };
  }[];
}

interface SearchedFilmRow extends FilmRow {
  description: string | null;
  credits: CreditRef[];
}

/** The best any one of these names did. */
function bestOf(search: Search, names: string[]): number {
  return names.reduce((best, name) => Math.max(best, scoreText(search, name)), 0);
}

@Injectable()
export class LibraryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Two honest reads rather than one clever one.
   *
   * A search is a different question from browsing, and pretending otherwise is
   * what would make this hard: browsing takes a window of an order Postgres
   * produced, while a search scores a bounded pool in memory and cannot. They
   * share every filter and neither shares the other's arithmetic.
   *
   * `byColumn` is what this method has always been, unchanged — which is what
   * keeps the home page's `?sort=added&limit=5` hero exactly as it was.
   */
  async list(query: ListLibraryQuery, role: Role): Promise<Page<LibraryCard>> {
    return query.q === undefined || query.q.length === 0
      ? this.byColumn(query, role)
      : this.searched(query, query.q, role);
  }

  private async byColumn(query: ListLibraryQuery, role: Role): Promise<Page<LibraryCard>> {
    const { skip, take } = perSideWindow(query.offset, query.limit, false);
    const { orderBy } = LIBRARY_SORTS[query.sort];

    const collectionWhere = this.collectionWhere(query, role);
    const filmWhere = this.filmWhere(query, role);

    const [collections, collectionTotal, films, filmTotal] = await this.prisma.$transaction([
      this.prisma.collection.findMany({
        where: collectionWhere,
        select: COLLECTION_CARD,
        orderBy,
        skip,
        take,
      }),
      this.prisma.collection.count({ where: collectionWhere }),
      this.prisma.video.findMany({ where: filmWhere, select: FILM_CARD, orderBy, skip, take }),
      this.prisma.video.count({ where: filmWhere }),
    ]);

    const merged = mergePage<SortableCard>(
      [(collections as CollectionRow[]).map(toCollectionCard), (films as FilmRow[]).map(toFilmCard)],
      query.sort,
      query.offset,
      query.limit,
    );

    return toPage(merged.map(withoutSortKeys), collectionTotal + filmTotal, query);
  }

  /**
   * The same library, ordered by how well each entry answers `q`.
   *
   * Three steps, and the split between the first two is the safety property:
   * `candidates.ts` asks Postgres which rows *resemble* the text and knows
   * nothing else — not what a film is, not who may see a draft. Prisma then
   * applies every rule it always did, with the candidate ids standing exactly
   * where the `contains` clauses used to stand. Only then is anything scored.
   *
   * The whole pool is read rather than a window of it. `perSideWindow` explains
   * why; the short version is that a score is not a column, so no prefix of one
   * side is a prefix of the answer.
   */
  private async searched(
    query: ListLibraryQuery,
    q: string,
    role: Role,
  ): Promise<Page<LibraryCard>> {
    const search = prepareSearch(q);
    const candidates = await searchCandidates(this.prisma, q, search.normalised);

    const personIds = candidates.people.map((person) => person.id);
    const names = new Map(candidates.people.map((person) => [person.id, person.name]));

    const { skip, take } = perSideWindow(query.offset, query.limit, true);
    const { orderBy } = LIBRARY_SORTS[query.sort];

    const [collections, films] = await this.prisma.$transaction([
      this.prisma.collection.findMany({
        where: this.collectionWhere(query, role, { candidates, personIds }),
        select: { ...COLLECTION_CARD, ...collectionEvidence(role, candidates.videoIds, personIds) },
        orderBy,
        skip,
        take,
      }),
      this.prisma.video.findMany({
        where: this.filmWhere(query, role, { candidates, personIds }),
        select: { ...FILM_CARD, ...filmEvidence(personIds) },
        orderBy,
        skip,
        take,
      }),
    ]);

    const cast = (credits: { personId: string }[]): string[] =>
      credits.map((credit) => names.get(credit.personId)).filter((name): name is string => !!name);

    const scored: SortableCard[] = [
      ...(collections as SearchedCollectionRow[]).map((row) => ({
        ...toCollectionCard(row),
        score: scoreEntry(search, {
          title: row.title,
          normalisedTitle: row.normalisedTitle,
          description: row.description,
          castNames: cast(row.credits),
          genres: row.genres,
          /*
           * The best any video standing on this shelf did.
           *
           * `collectionEvidence` already restricted these to what the caller may
           * see, so a draft episode cannot raise its shelf into a viewer's
           * results — the same rule the `where` enforces, applied to the same
           * relation, because scoring on rows the filter excluded would put the
           * shelf back by the side door.
           */
          viaVideo: row.videos.reduce(
            (best, on) =>
              Math.max(
                best,
                scoreText(search, on.video.title, on.video.normalisedTitle),
                WEIGHTS.cast * bestOf(search, cast(on.video.credits)),
              ),
            0,
          ),
        }),
      })),
      ...(films as SearchedFilmRow[]).map((row) => ({
        ...toFilmCard(row),
        score: scoreEntry(search, {
          title: row.title,
          normalisedTitle: row.normalisedTitle,
          description: row.description,
          castNames: cast(row.credits),
          genres: row.genres,
        }),
      })),
    ];

    /*
     * Anything the scorer found no reason for is dropped, and the total is what
     * survives rather than a `count()`.
     *
     * Both halves of that are one decision. Postgres was asked a generous
     * question on purpose, so some of what it offered is a row whose only
     * connection to the query is a trigram — and a count taken from the database
     * would then promise more cards than paging can ever reach, which is not a
     * cosmetic wrong number: `nextBrowsePage` walks until `loaded >= total`, so
     * the browse page would scroll for a page that never arrives.
     */
    const pool = scored.filter((entry) => entry.score > 0);

    return toPage(
      mergePage<SortableCard>([pool], query.sort, query.offset, query.limit).map(withoutSortKeys),
      pool.length,
      query,
    );
  }

  /**
   * The genres the library actually holds, with how many visible entries carry
   * each.
   *
   * `genres` is free text as far as Postgres is concerned, so a control that
   * asks you to type one is a control that mostly returns nothing. This is what
   * lets the filter offer the vocabulary that exists.
   *
   * Tallied in memory rather than in SQL. Unnesting an array column needs raw
   * SQL, and raw SQL here would mean restating `whereFilm` — the rule deciding
   * whether a video belongs to anybody's search at all — in a second language.
   * One narrow column off a private library is the cheaper thing to spend. If
   * that stops being true this is the single place to swap in `unnest`, and the
   * endpoint's shape does not change.
   */
  async genres(query: PageQuery, role: Role): Promise<Page<GenreFacet>> {
    const [collections, films] = await this.prisma.$transaction([
      this.prisma.collection.findMany({ where: whereVisible(role), select: { genres: true } }),
      this.prisma.video.findMany({
        where: { ...whereFilm(), ...whereVisible(role) },
        select: { genres: true },
      }),
    ]);

    const counts = new Map<string, number>();
    for (const row of [...collections, ...films]) {
      for (const genre of row.genres) counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }

    // Commonest first, which is the order somebody scanning a filter wants;
    // alphabetical within a count, so the list does not reshuffle between calls.
    const facets = [...counts.entries()]
      .map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count || compareText(a.genre, b.genre));

    return toPage(facets.slice(query.offset, query.offset + query.limit), facets.length, query);
  }

  private collectionWhere(query: ListLibraryQuery, role: Role, found?: Found): object {
    return {
      ...this.sharedFilters(query),
      /*
       * `kind` partitions the grid rather than filtering half of it away.
       *
       * FILM asks for the films *and* the shelves holding no seasons — a saga
       * of eight films is films, and its chip already says so. SHOW asks for
       * the shelves that do hold seasons. Between them they cover everything,
       * so nothing becomes unreachable the moment a type filter is on. Seasons
       * are the whole of the distinction, read here from the side `whereFilm`
       * reads from the other.
       */
      ...(query.kind === 'SHOW' ? { seasons: { some: {} } } : {}),
      ...(query.kind === 'FILM' ? { seasons: { none: {} } } : {}),
      ...(found ? { OR: this.collectionSearch(found, role) } : {}),
      // Last, so nothing above can overwrite the visibility constraint.
      ...narrowToVisibleStates(role, query.state),
    };
  }

  private filmWhere(query: ListLibraryQuery, role: Role, found?: Found): object {
    return {
      ...this.sharedFilters(query),
      /*
       * The search goes *inside* `whereFilm`'s `AND`, never beside it.
       *
       * `whereFilm` is `{ AND: [...] }` and a search is an `OR`; two `OR` keys
       * spread into one object leave only the last, which is how a search or a
       * visibility filter vanishes with no error at all. The same trap
       * `films.ts` documents, approached from the other side.
       *
       * `SHOW` excludes films outright. An impossible clause rather than a
       * skipped query keeps the transaction one fixed shape, and Postgres
       * answers `IN ()` without reading a row.
       */
      AND: [
        ...whereFilm().AND,
        ...(found ? [{ OR: this.filmSearch(found) }] : []),
        ...(query.kind === 'SHOW' ? [{ id: { in: [] as string[] } }] : []),
      ],
      ...narrowToVisibleStates(role, query.state),
    };
  }

  /** The filters that mean the same thing on either side of the union. */
  private sharedFilters(query: ListLibraryQuery): object {
    return {
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      // Several genres narrow rather than widen, like every other control on
      // the bar. Case-sensitive by `hasEvery`, which is safe because the filter
      // only ever sends values the facet endpoint handed it.
      ...(query.genre?.length ? { genres: { hasEvery: query.genre } } : {}),
    };
  }

  /**
   * What a search matches on a shelf: its own words, and the videos on it.
   *
   * The videos half is what keeps the film rule honest. A video a collection
   * claims is not a card of its own (`common/films.ts`), so if a shelf could
   * only be found by its own title, publishing a saga would put every film on it
   * out of reach of search — the shelf is one card named something else and the
   * films are no longer cards at all. That was a real report. Matching a shelf
   * on its videos' titles is what makes "the shelf is how you reach them" true
   * rather than merely stated.
   *
   * The **title** but not the description, deliberately: a shelf should surface
   * because something on it is actually called that, not because a word turned
   * up in one synopsis.
   *
   * The cast is searchable because every one of them is a `Person` row, created
   * on import precisely so a name can be looked up. Both live in one `some` —
   * one `EXISTS` rather than two — and the nested read gets the visibility
   * filter like any other: a draft video's title or credit must not become a way
   * to learn what is in something the caller cannot see. That `OR` is the only
   * one inside the nested `video`, so it collides with nothing.
   */
  private collectionSearch({ candidates, personIds }: Found, role: Role): object[] {
    return [
      { id: { in: candidates.collectionIds } },
      { credits: { some: creditedTo(personIds) } },
      {
        videos: {
          some: {
            video: {
              ...whereVisible(role),
              OR: [
                { id: { in: candidates.videoIds } },
                { credits: { some: creditedTo(personIds) } },
              ],
            },
          },
        },
      },
    ];
  }

  /**
   * The same for a film: its own words and its own people.
   *
   * There was a third clause here — matching a film by the credits of a shelf it
   * stands on, justified by `credits/merge.ts` showing a video its collection's
   * credits merged with its own. It is gone because it can no longer fire: this
   * is only ever ANDed with `whereFilm`, and a film is now a video no collection
   * claims, so there is no shelf whose credits could match. The case it served
   * is answered by `collectionSearch` returning the shelf instead.
   */
  private filmSearch({ candidates, personIds }: Found): object[] {
    return [{ id: { in: candidates.videoIds } }, { credits: { some: creditedTo(personIds) } }];
  }
}

/**
 * Credited to one of the people the search turned up.
 *
 * The name matching happened in `candidates.ts`; by here a person is an id, and
 * the join is the same `EXISTS` it always was.
 */
function creditedTo(personIds: string[]): object {
  return { personId: { in: personIds } };
}

/** Byte-ish order, matching `merge.ts` — see the note on `byText` there. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;

  return 0;
}

function toCollectionCard(row: CollectionRow): SortableCard {
  return {
    kind: 'collection',
    id: row.id,
    slug: row.slug,
    title: row.title,
    year: row.year,
    tags: row.tags,
    genres: row.genres,
    state: row.state,
    seasonsHere: row._count.seasons,
    videosHere: row._count.videos,
    trailerYoutubeId: row.trailerYoutubeId,
    normalisedTitle: row.normalisedTitle,
    createdAt: row.createdAt,
    // Browsing does not score anything; `searched` overwrites this.
    score: 0,
  };
}

function toFilmCard(row: FilmRow): SortableCard {
  return {
    kind: 'film',
    id: row.id,
    slug: row.slug,
    title: row.title,
    year: row.year,
    tags: row.tags,
    genres: row.genres,
    state: row.state,
    durationSec: row.durationSec,
    trailerYoutubeId: row.trailerYoutubeId,
    normalisedTitle: row.normalisedTitle,
    createdAt: row.createdAt,
    score: 0,
  };
}

/**
 * The sort keys come off before the response.
 *
 * Built field by field rather than by deleting two keys, for the reason
 * `toRequestView` is: a column added to either select later cannot then ride
 * along into a response nobody meant to widen.
 */
function withoutSortKeys(entry: SortableCard): LibraryCard {
  const base = {
    id: entry.id,
    slug: entry.slug,
    title: entry.title,
    year: entry.year,
    tags: entry.tags,
    genres: entry.genres,
    state: entry.state,
    trailerYoutubeId: entry.trailerYoutubeId,
  };

  return entry.kind === 'collection'
    ? { ...base, kind: 'collection', seasonsHere: entry.seasonsHere, videosHere: entry.videosHere }
    : { ...base, kind: 'film', durationSec: entry.durationSec };
}
