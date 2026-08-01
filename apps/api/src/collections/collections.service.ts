import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  toPage,
  type CreateCollectionInput,
  type ListCollectionsQuery,
  type Page,
  type ReorderCollectionVideosInput,
  type UpdateCollectionInput,
} from '@video/shared';

import {
  collectionMissingFields,
  narrowToVisibleStates,
  videoMissingFields,
  whereVisible,
} from '../common/publishing';
import { slugify, uniqueSlug } from '../common/slug';
import { StorageService } from '../common/storage.service';
import type { Role } from '../prisma/generated/enums';
import { bannerKeyFor } from '../common/image-uploads';
import { PrismaService } from '../prisma/prisma.service';

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
  posterKey: true,
  bannerKey: true,
  trailerYoutubeId: true,
  state: true,
  origin: true,
  folderKey: true,
  createdAt: true,
  updatedAt: true,
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

    return toPage(collections, total, query);
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
          where: whereVisible(role),
          select: {
            id: true,
            slug: true,
            title: true,
            description: true,
            seasonId: true,
            orderIndex: true,
            state: true,
            durationSec: true,
            width: true,
            height: true,
            thumbnailKey: true,
          },
          orderBy: [{ seasonId: 'asc' }, { orderIndex: 'asc' }, { title: 'asc' }, { id: 'asc' }],
          // One more than the cap, so truncation can be detected rather than
          // guessed at from a suspiciously round number.
          take: MAX_EMBEDDED_VIDEOS + 1,
        },
      },
    });

    if (!collection) throw new NotFoundException('No such collection');

    const videosTruncated = collection.videos.length > MAX_EMBEDDED_VIDEOS;

    return this.withChecklist(
      {
        ...collection,
        videos: videosTruncated ? collection.videos.slice(0, MAX_EMBEDDED_VIDEOS) : collection.videos,
        // Says so out loud rather than quietly returning a partial list: the UI
        // can point at `GET /videos?collectionId=…` for the rest.
        videosTruncated,
      },
      role,
    );
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

    return this.prisma.collection.create({
      data: {
        slug,
        title: dto.title,
        description: dto.description ?? null,
        year: dto.year ?? null,
        tags: dto.tags ?? [],
        folderKey,
        origin: 'UPLOAD',
      },
      select: COLLECTION_SUMMARY,
    });
  }

  /**
   * Stores an uploaded image as the collection's wide backdrop.
   *
   * Upload only, with no capture twin: a collection has no file of its own to
   * grab a frame from. This is also the first thing anyone can upload *to* a
   * collection — the poster still arrives from the folder on disk and has no
   * endpoint.
   */
  async setBanner(id: string, image: Buffer, extension: string): Promise<string> {
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      select: { id: true, bannerKey: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    const key = bannerKeyFor('collections', collection.id, extension);
    await this.storage.save('derived', key, image);

    // The extension is part of the key, so replacing a png with a jpg orphans
    // the png unless it goes first.
    if (collection.bannerKey && collection.bannerKey !== key) {
      await this.storage.delete('derived', collection.bannerKey);
    }

    await this.prisma.collection.update({ where: { id: collection.id }, data: { bannerKey: key } });

    return key;
  }

  async clearBanner(id: string): Promise<void> {
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      select: { id: true, bannerKey: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    if (collection.bannerKey) await this.storage.delete('derived', collection.bannerKey);

    await this.prisma.collection.update({ where: { id: collection.id }, data: { bannerKey: null } });
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

    return this.prisma.collection.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        year: dto.year,
        tags: dto.tags,
        posterKey: dto.posterKey,
        trailerYoutubeId: dto.trailerYoutubeId,
        slug,
      },
      select: COLLECTION_SUMMARY,
    });
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

    if (deleteFiles) {
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
            id: true,
            state: true,
            title: true,
            description: true,
            durationSec: true,
            thumbnailKey: true,
          },
        },
      },
    });
    if (!collection) throw new NotFoundException('No such collection');

    const readyVideoIds = collection.videos
      .filter((video) => videoMissingFields(video).length === 0)
      .map((video) => video.id);

    const publishableVideoCount = collection.videos.filter(
      (video) => video.state === 'PUBLISHED' || readyVideoIds.includes(video.id),
    ).length;

    const missingFields = collectionMissingFields({ ...collection, publishableVideoCount });
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

      return tx.collection.update({
        where: { id },
        data: { state: 'PUBLISHED' },
        select: COLLECTION_SUMMARY,
      });
    });
  }

  /**
   * Archiving hides the collection without touching its videos' own states, so
   * un-archiving restores exactly what was there before.
   */
  async archive(id: string) {
    await this.mustExist(id);

    return this.prisma.collection.update({
      where: { id },
      data: { state: 'ARCHIVED' },
      select: COLLECTION_SUMMARY,
    });
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
      const owned = await this.prisma.video.count({
        where: { id: { in: dto.videoIds }, collectionId },
      });
      if (owned !== dto.videoIds.length) {
        throw new BadRequestException('Every video must already be in this collection');
      }
    }

    await this.prisma.$transaction(
      dto.videoIds.map((id, orderIndex) =>
        this.prisma.video.update({
          where: { id },
          data: { seasonId: dto.seasonId, orderIndex },
        }),
      ),
    );

    return { moved: dto.videoIds.length };
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

  /** Admins get the publish checklist; a USER has no use for it and should not see draft internals. */
  private withChecklist<T extends { state: string; title: string | null }>(
    collection: T & {
      description: string | null;
      posterKey: string | null;
      videos: { state: string }[];
    },
    role: Role,
  ) {
    if (role !== 'ADMIN') return collection;

    return {
      ...collection,
      missingFields: collectionMissingFields({
        title: collection.title,
        description: collection.description,
        posterKey: collection.posterKey,
        publishableVideoCount: collection.videos.length,
      }),
    };
  }
}
