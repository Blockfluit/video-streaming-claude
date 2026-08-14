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

import { LIBRARY_SORTS, mergePage, perSideWindow, type LibraryEntry } from './merge';

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

@Injectable()
export class LibraryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListLibraryQuery, role: Role): Promise<Page<LibraryCard>> {
    const { skip, take } = perSideWindow(query.offset, query.limit);
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
        where: { ...whereFilm(role), ...whereVisible(role) },
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

  private collectionWhere(query: ListLibraryQuery, role: Role): object {
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
      ...(query.q ? { OR: this.collectionSearch(query.q, role) } : {}),
      // Last, so nothing above can overwrite the visibility constraint.
      ...narrowToVisibleStates(role, query.state),
    };
  }

  private filmWhere(query: ListLibraryQuery, role: Role): object {
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
        ...whereFilm(role).AND,
        ...(query.q ? [{ OR: this.filmSearch(query.q, role) }] : []),
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
   * What a search matches on a shelf: its own words, and the people in it.
   *
   * The cast is searchable because every one of them is a `Person` row, created
   * on import precisely so a name can be looked up. The nested read gets the
   * visibility filter like any other — a draft episode's credit must not become
   * a way to learn who is in something the caller cannot see.
   */
  private collectionSearch(q: string, role: Role): object[] {
    return [
      ...textClauses(q),
      { credits: { some: personNamed(q) } },
      { videos: { some: { video: { ...whereVisible(role), credits: { some: personNamed(q) } } } } },
    ];
  }

  /**
   * The same for a film, including the credits of any shelf it stands on.
   *
   * That last clause is not over-reach: `credits/merge.ts` shows a video its
   * collection's credits merged with its own, so a name credited on the shelf
   * *is* one of this film's credits as far as anyone reading the page is
   * concerned. Searching less than the panel displays would mean a cast member
   * you can plainly see is one you cannot find.
   */
  private filmSearch(q: string, role: Role): object[] {
    return [
      ...textClauses(q),
      { credits: { some: personNamed(q) } },
      {
        collections: {
          some: { collection: { ...whereVisible(role), credits: { some: personNamed(q) } } },
        },
      },
    ];
  }
}

const insensitive = (q: string) => ({ contains: q, mode: 'insensitive' as const });

/** The words on the record itself. Identical on both models. */
function textClauses(q: string): object[] {
  return [{ title: insensitive(q) }, { description: insensitive(q) }];
}

function personNamed(q: string): object {
  return { person: { name: insensitive(q) } };
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
