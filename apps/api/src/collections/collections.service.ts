import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  toPage,
  type CreateCollectionInput,
  type ListCollectionsQuery,
  type Page,
  type ReorderCollectionVideosInput,
  type UpdateCollectionInput,
} from '@video/shared';

import { COUNTS_HERE_SELECT, withCountsHere } from '../common/films';
import {
  collectionMissingFields,
  narrowToVisibleStates,
  publishableVideoCount,
  videoMissingFields,
  whereVisible,
} from '../common/publishing';
import { isUniqueViolation } from '../common/prisma-errors';
import { slugify, uniqueSlug } from '../common/slug';
import { StorageService } from '../common/storage.service';
import { titleData, titleUpdate } from '../common/title';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { nextEpisode, type EpisodeProgress } from '../watchlist/next-episode';
import { MEMBERSHIP_ORDER, MEMBERSHIP_SELECT, toMemberVideo } from './membership';

/**
 * A collection page shows every episode grouped by season, so the videos are
 * embedded rather than paged. Bounded anyway: a show with thousands of episodes
 * would otherwise make one response unbounded in size. Past this, the client
 * uses `GET /videos?collectionId=…`, which pages properly.
 */
const MAX_EMBEDDED_VIDEOS = 500;

/** Enough to render a row in a grid. */
const COLLECTION_SUMMARY = {
  id: true,
  slug: true,
  title: true,
  description: true,
  year: true,
  tags: true,
  // Imported metadata. `tmdbId`/`tmdbType` come back so the admin screen can show
  // a title as already matched rather than offering to match it again.
  tmdbId: true,
  tmdbType: true,
  imdbId: true,
  genres: true,
  tagline: true,
  originalTitle: true,
  originalLanguage: true,
  releaseDate: true,
  certification: true,
  tmdbRating: true,
  tmdbVoteCount: true,
  seriesStatus: true,
  seasonCount: true,
  episodeCount: true,
  metadataUpdatedAt: true,
  posterKey: true,
  bannerKey: true,
  trailerYoutubeId: true,
  state: true,
  origin: true,
  folderKey: true,
  createdAt: true,
  updatedAt: true,
  // What we hold, which is not what TMDB says the whole show has. The seasons
  // half is also the fact `whereFilm` reads from the other side: a shelf with
  // one is a series, a shelf without one is a shelf of films.
  ...COUNTS_HERE_SELECT,
} as const;

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async list(query: ListCollectionsQuery, role: Role): Promise<Page<unknown>> {
    const where = {
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' as const } },
              { description: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      // Last, so nothing above can overwrite the visibility constraint.
      ...narrowToVisibleStates(role, query.state),
    };

    const [collections, total] = await this.prisma.$transaction([
      this.prisma.collection.findMany({
        where,
        select: COLLECTION_SUMMARY,
        // `id` breaks ties: titles are not unique, and offset paging over a
        // non-total order silently repeats and skips rows between pages.
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.collection.count({ where }),
    ]);

    return toPage(collections.map(withCountsHere), total, query);
  }

  /**
   * One collection with its seasons and videos.
   *
   * The visibility filter is applied to the nested videos too, not only the
   * collection — a published collection can hold draft videos, and a USER must
   * not see them.
   */
  async findBySlug(slug: string, role: Role) {
    const collection = await this.prisma.collection.findFirst({
      where: { slug, ...whereVisible(role) },
      select: {
        ...COLLECTION_SUMMARY,
        seasons: {
          select: {
            id: true,
            number: true,
            slug: true,
            title: true,
            description: true,
            posterKey: true,
          },
          orderBy: [{ number: 'asc' }, { slug: 'asc' }],
        },
        videos: {
          // Filtered on the *video*, not the membership: a published collection
          // may hold draft videos, and the join is not what has a state.
          where: { video: whereVisible(role) },
          select: MEMBERSHIP_SELECT,
          orderBy: [...MEMBERSHIP_ORDER],
          // One more than the cap, so truncation can be detected rather than
          // guessed at from a suspiciously round number.
          take: MAX_EMBEDDED_VIDEOS + 1,
        },
      },
    });

    if (!collection) throw new NotFoundException('No such collection');

    const members = collection.videos.map(toMemberVideo);
    const videosTruncated = members.length > MAX_EMBEDDED_VIDEOS;

    return this.withChecklist(
      {
        ...withCountsHere(collection),
        videos: videosTruncated ? members.slice(0, MAX_EMBEDDED_VIDEOS) : members,
        // Says so out loud rather than quietly returning a partial list: the UI
        // can point at `GET /videos?collectionId=…` for the rest.
        videosTruncated,
      },
      role,
    );
  }

  /**
   * This viewer's progress through one collection: which video to offer next,
   * and how far they got in each.
   *
   * One call rather than two because the title page needs both at once — the
   * hero's "Resume" button and the resume bar under every episode row are the
   * same data read twice. Split, the page would render a button naming one
   * episode while the rows below it disagreed for a moment.
   *
   * `next` comes from the same `nextEpisode()` the watchlist uses, so "which
   * episode is next" has exactly one definition. Reimplementing the rule here is
   * how the home page and the title page start disagreeing about it.
   *
   * Order comes through the **membership**, not the video: where a video sits is
   * a fact about this collection, and the same episode may sit somewhere else
   * entirely in another. That is also why `orderIndex` is read off the join.
   *
   * Per-caller, never aggregate: these are the figures every viewer may see
   * about themselves. Totals across users stay ADMIN-only.
   */
  async progress(slug: string, userId: string, role: Role) {
    const collection = await this.prisma.collection.findFirst({
      where: { slug, ...whereVisible(role) },
      select: { id: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    // Filtered on the video, not the membership — the join has no state.
    const memberships = await this.prisma.collectionVideo.findMany({
      where: { collectionId: collection.id, video: whereVisible(role) },
      select: {
        orderIndex: true,
        season: { select: { slug: true, number: true } },
        video: { select: { id: true, slug: true, title: true } },
      },
      orderBy: [...MEMBERSHIP_ORDER],
      // The same bound as the embedded list, so the two cannot describe
      // different sets of episodes for one collection.
      take: MAX_EMBEDDED_VIDEOS,
    });

    const rows = await this.prisma.watchProgress.findMany({
      where: { userId, videoId: { in: memberships.map((m) => m.video.id) } },
      select: {
        videoId: true,
        lastPositionSec: true,
        maxPositionSec: true,
        completed: true,
      },
    });

    const progress = new Map<string, EpisodeProgress>(
      rows.map((row) => [
        row.videoId,
        { completed: row.completed, lastPositionSec: row.lastPositionSec },
      ]),
    );

    // `nextEpisode` orders by `orderIndex` and needs an `id`, so it is given the
    // membership flattened onto the video it points at.
    const ordered = memberships.map((m) => ({
      id: m.video.id,
      orderIndex: m.orderIndex,
      slug: m.video.slug,
      title: m.video.title,
      seasonSlug: m.season?.slug ?? null,
      seasonNumber: m.season?.number ?? null,
    }));

    const next = nextEpisode(ordered, progress);

    return {
      next:
        next === null
          ? null
          : {
              videoId: next.video.id,
              slug: next.video.slug,
              title: next.video.title,
              seasonSlug: next.video.seasonSlug,
              seasonNumber: next.video.seasonNumber,
              orderIndex: next.video.orderIndex,
              // Zero when never started, which is what makes the button read
              // "Play" rather than "Resume".
              lastPositionSec: next.progress?.lastPositionSec ?? 0,
            },
      // Only the videos actually started have a row, so this stays short even
      // for a long-running show.
      items: rows,
    };
  }

  async create(dto: CreateCollectionInput) {
    const slug = await this.freeCollectionSlug(slugify(dto.title));
    const folderKey = dto.folderKey ?? slug;

    const clash = await this.prisma.collection.findUnique({
      where: { folderKey },
      select: { id: true },
    });
    if (clash) {
      throw new BadRequestException(`Another collection already uses the folder "${folderKey}"`);
    }

    // Created before the row: a collection whose folder does not exist has
    // nowhere for an upload or an ingest to land.
    await this.storage.ensureDirectory('media', folderKey);

    const created = await this.prisma.collection.create({
      data: {
        slug,
        ...titleData(dto.title),
        description: dto.description ?? null,
        year: dto.year ?? null,
        tags: dto.tags ?? [],
        folderKey,
        origin: 'UPLOAD',
      },
      select: COLLECTION_SUMMARY,
    });

    return withCountsHere(created);
  }

  async update(id: string, dto: UpdateCollectionInput) {
    const existing = await this.prisma.collection.findUnique({
      where: { id },
      select: { id: true, title: true },
    });
    if (!existing) throw new NotFoundException('No such collection');

    const slug = dto.regenerateSlug
      ? await this.freeCollectionSlug(slugify(dto.title ?? existing.title), id)
      : undefined;

    const updated = await this.prisma.collection.update({
      where: { id },
      data: {
        ...titleUpdate(dto.title),
        description: dto.description,
        year: dto.year,
        tags: dto.tags,
        // Imported metadata, editable by hand. Each name has to appear here as
        // well as in the schema: `data` is built field by field, so a field
        // added only to the schema is silently dropped and the PATCH still
        // answers 200 with a response that looks right. That is what happened
        // with `trailerYoutubeId`, which is why the db-spec asserts the round
        // trip rather than the status code.
        tagline: dto.tagline,
        genres: dto.genres,
        certification: dto.certification,
        originalTitle: dto.originalTitle,
        originalLanguage: dto.originalLanguage,
        releaseDate: dto.releaseDate,
        imdbId: dto.imdbId,
        posterKey: dto.posterKey,
        trailerYoutubeId: dto.trailerYoutubeId,
        slug,
      },
      select: COLLECTION_SUMMARY,
    });

    return withCountsHere(updated);
  }

  /**
   * Removes the collection row, and its folder only when asked.
   *
   * Without `deleteFiles`, reconcile will find the folder on the next scan and
   * recreate everything — so the default is explicitly the reversible one, and
   * the caller has to mean it to lose data.
   */
  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      select: { id: true, folderKey: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    await this.prisma.collection.delete({ where: { id } });

    // A collection made by hand has no folder behind it, so there is nothing on
    // disk to take with it.
    if (deleteFiles && collection.folderKey !== null) {
      await this.storage.delete('media', collection.folderKey);
    }
  }

  /**
   * Publishes the collection, optionally taking its ready videos with it.
   *
   * Rejects with the checklist rather than a bare error, so the admin UI can
   * show what is still missing without a second request.
   */
  async publish(id: string, cascade: boolean) {
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        description: true,
        posterKey: true,
        videos: {
          select: {
            video: {
              select: {
                id: true,
                state: true,
                title: true,
                description: true,
                durationSec: true,
                bannerKey: true,
              },
            },
          },
        },
      },
    });
    if (!collection) throw new NotFoundException('No such collection');

    const members = collection.videos.map((row) => row.video);

    const readyVideoIds = members
      .filter((video) => videoMissingFields(video).length === 0)
      .map((video) => video.id);

    const missingFields = collectionMissingFields({
      ...collection,
      publishableVideoCount: publishableVideoCount(members),
    });
    if (missingFields.length > 0) {
      throw new BadRequestException({
        message: 'This collection is not ready to publish',
        missingFields,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      if (cascade && readyVideoIds.length > 0) {
        await tx.video.updateMany({
          where: { id: { in: readyVideoIds }, state: 'DRAFT' },
          data: { state: 'PUBLISHED' },
        });
      }

      const published = await tx.collection.update({
        where: { id },
        data: { state: 'PUBLISHED' },
        select: COLLECTION_SUMMARY,
      });

      return withCountsHere(published);
    });
  }

  /**
   * Archiving hides the collection without touching its videos' own states, so
   * un-archiving restores exactly what was there before.
   */
  async archive(id: string) {
    await this.mustExist(id);

    const archived = await this.prisma.collection.update({
      where: { id },
      data: { state: 'ARCHIVED' },
      select: COLLECTION_SUMMARY,
    });

    return withCountsHere(archived);
  }

  /**
   * Rewrites which season a set of videos is in, and their order within it.
   *
   * One transaction rather than a PATCH per video: a drag touches every row
   * after the drop point, and a dozen requests that can half-fail leave an
   * order nobody chose. `orderIndex` is not unique — a unique index collides
   * mid-drag — so the sequence is rewritten wholesale.
   *
   * Both parents are checked. The videos must already belong to *this*
   * collection and the season must be one of its own; without that a reorder
   * would be a way to pull episodes out of a show the caller never named.
   */
  async reorderVideos(collectionId: string, dto: ReorderCollectionVideosInput) {
    await this.mustExist(collectionId);

    const unique = new Set(dto.videoIds);
    if (unique.size !== dto.videoIds.length) {
      throw new BadRequestException('The same video is listed twice');
    }

    if (dto.seasonId !== null) {
      const season = await this.prisma.season.findFirst({
        where: { id: dto.seasonId, collectionId },
        select: { id: true },
      });
      if (!season) throw new BadRequestException('That season is not in this collection');
    }

    if (dto.videoIds.length > 0) {
      // Named parents, checked rather than trusted: without this a reorder is a
      // way to renumber — or reseason — videos in a collection nobody mentioned.
      const owned = await this.prisma.collectionVideo.count({
        where: { videoId: { in: dto.videoIds }, collectionId },
      });
      if (owned !== dto.videoIds.length) {
        throw new BadRequestException('Every video must already be in this collection');
      }
    }

    /**
     * The whole sequence in one transaction, on the membership rows.
     *
     * Position is deliberately not unique — a unique index collides halfway
     * through a drag — so the sequence is rewritten rather than swapped in
     * pairs. Season and order are set together because dragging an episode into
     * a season changes both at once.
     */
    await this.prisma.$transaction(
      dto.videoIds.map((videoId, orderIndex) =>
        this.prisma.collectionVideo.update({
          where: { collectionId_videoId: { collectionId, videoId } },
          data: { seasonId: dto.seasonId, orderIndex },
        }),
      ),
    );

    return { moved: dto.videoIds.length };
  }

  /**
   * Puts an existing video into a collection.
   *
   * Idempotent by catching the unique violation rather than checking first:
   * check-then-write is not atomic and a double-click lands inside the gap.
   */
  async addVideo(collectionId: string, videoId: string, seasonId?: string | null) {
    await this.mustExist(collectionId);

    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true },
    });
    if (!video) throw new NotFoundException('No such video');

    if (seasonId) await this.mustOwnSeason(collectionId, seasonId);

    try {
      return await this.prisma.collectionVideo.create({
        data: { collectionId, videoId, seasonId: seasonId ?? null },
        select: { id: true, collectionId: true, videoId: true, seasonId: true, orderIndex: true },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      return this.prisma.collectionVideo.findUniqueOrThrow({
        where: { collectionId_videoId: { collectionId, videoId } },
        select: { id: true, collectionId: true, videoId: true, seasonId: true, orderIndex: true },
      });
    }
  }

  /**
   * Takes a video out of a collection, leaving the video itself alone.
   *
   * That distinction is the point of memberships: the video may be in other
   * collections, carries its own watch history and comments, and removing it
   * from a shelf is not a reason to lose any of that.
   */
  async removeVideo(collectionId: string, videoId: string) {
    await this.mustExist(collectionId);

    const { count } = await this.prisma.collectionVideo.deleteMany({
      where: { collectionId, videoId },
    });

    return { removed: count };
  }

  /** A membership's season has to belong to the collection holding it. */
  private async mustOwnSeason(collectionId: string, seasonId: string): Promise<void> {
    const season = await this.prisma.season.findUnique({
      where: { id: seasonId },
      select: { collectionId: true },
    });

    if (!season) throw new NotFoundException('No such season');
    if (season.collectionId !== collectionId) {
      throw new BadRequestException('That season belongs to a different collection');
    }
  }

  private async mustExist(id: string): Promise<void> {
    const found = await this.prisma.collection.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException('No such collection');
  }

  /** Collection slugs are unique library-wide, unlike season and video slugs. */
  private async freeCollectionSlug(base: string, exceptId?: string): Promise<string> {
    const taken = await this.prisma.collection.findMany({
      where: exceptId ? { NOT: { id: exceptId } } : undefined,
      select: { slug: true },
    });

    return uniqueSlug(
      base,
      taken.map((row) => row.slug),
    );
  }

  /**
   * Admins get the publish checklist; a USER has no use for it and should not
   * see draft internals.
   *
   * The count comes from `publishableVideoCount`, the same helper `publish()`
   * uses. This used to pass `videos.length` — the total — so the checklist
   * reported a collection ready that the publish button then refused.
   */
  private withChecklist<T extends { state: string; title: string | null }>(
    collection: T & {
      videos: {
        state: string;
        title: string | null;
        durationSec: number | null;
        bannerKey: string | null;
      }[];
    },
    role: Role,
  ) {
    if (role !== 'ADMIN') return collection;

    return {
      ...collection,
      missingFields: collectionMissingFields({
        title: collection.title,
        publishableVideoCount: publishableVideoCount(collection.videos),
      }),
      /*
       * What a cascade publish would take with it, so the confirmation can name
       * the number instead of asking "are you sure?". Same count, so the dialog
       * cannot promise something different from what happens.
       */
      publishableVideoCount: publishableVideoCount(collection.videos),
    };
  }
}
