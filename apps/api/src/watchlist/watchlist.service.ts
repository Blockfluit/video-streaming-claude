import { Injectable, NotFoundException } from '@nestjs/common';
import { toPage, type ListWatchlistQuery, type Page, type WatchlistRefInput } from '@video/shared';

import { whereVisible } from '../common/publishing';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { nextEpisode, type EpisodeProgress } from './next-episode';

const COLLECTION_SELECT = {
  id: true,
  slug: true,
  title: true,
  year: true,
  posterKey: true,
  state: true,
} as const;

const VIDEO_SELECT = {
  id: true,
  slug: true,
  title: true,
  durationSec: true,
  thumbnailKey: true,
  width: true,
  height: true,
  state: true,
  orderIndex: true,
  collection: { select: { id: true, slug: true, title: true } },
} as const;

@Injectable()
export class WatchlistService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * My List: explicit and user-curated, as against Continue Watching, which is
   * derived from `WatchProgress`. Both are on the home page and they are
   * deliberately different things.
   *
   * A saved *collection* renders with the episode it would play next, resolved
   * against the caller's progress.
   */
  async list(userId: string, role: Role, query: ListWatchlistQuery): Promise<Page<unknown>> {
    // Visibility on the referenced row, not just the item: a video archived
    // after it was saved drops out rather than showing a viewer its title.
    const where = {
      userId,
      OR: [
        { collection: { is: whereVisible(role) } },
        { video: { is: whereVisible(role) } },
      ],
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.watchlistItem.findMany({
        where,
        select: {
          id: true,
          createdAt: true,
          collection: { select: COLLECTION_SELECT },
          video: { select: VIDEO_SELECT },
        },
        // `id` last makes the order total.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.watchlistItem.count({ where }),
    ]);

    return toPage(await this.withNextEpisodes(items, userId, role), total, query);
  }

  /**
   * Idempotent by design — a double-click must not produce two entries.
   *
   * The two partial uniques on the table are what actually enforce it; this
   * catches the collision rather than checking first, because a check followed
   * by a write is not atomic and two taps can land inside the gap.
   */
  async add(userId: string, role: Role, ref: WatchlistRefInput) {
    const target = await this.requireTarget(role, ref);

    try {
      return await this.prisma.watchlistItem.create({
        data: { userId, ...target },
        select: { id: true, createdAt: true, collectionId: true, videoId: true },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Already saved, which is the outcome the caller wanted.
      return this.prisma.watchlistItem.findFirstOrThrow({
        where: { userId, ...target },
        select: { id: true, createdAt: true, collectionId: true, videoId: true },
      });
    }
  }

  /** Also idempotent: removing something already gone leaves it gone. */
  async remove(userId: string, ref: WatchlistRefInput): Promise<void> {
    await this.prisma.watchlistItem.deleteMany({
      where: {
        userId,
        ...(ref.collectionId !== undefined
          ? { collectionId: ref.collectionId }
          : { videoId: ref.videoId }),
      },
    });
  }

  /**
   * Resolves the next episode for every saved collection on the page in two
   * queries rather than two per collection.
   */
  private async withNextEpisodes(
    items: { collection: { id: string } | null; video: unknown }[],
    userId: string,
    role: Role,
  ) {
    const collectionIds = items
      .map((item) => item.collection?.id)
      .filter((id): id is string => id !== undefined);

    if (collectionIds.length === 0) {
      return items.map((item) => ({ ...item, next: null }));
    }

    const videos = await this.prisma.video.findMany({
      where: { collectionId: { in: collectionIds }, ...whereVisible(role) },
      select: { ...VIDEO_SELECT, collectionId: true },
    });

    const progressRows = await this.prisma.watchProgress.findMany({
      where: { userId, videoId: { in: videos.map((video) => video.id) } },
      select: { videoId: true, completed: true, lastPositionSec: true },
    });

    const progress = new Map<string, EpisodeProgress>(
      progressRows.map((row) => [
        row.videoId,
        { completed: row.completed, lastPositionSec: row.lastPositionSec },
      ]),
    );

    const byCollection = new Map<string, typeof videos>();
    for (const video of videos) {
      const bucket = byCollection.get(video.collectionId);
      if (bucket) bucket.push(video);
      else byCollection.set(video.collectionId, [video]);
    }

    return items.map((item) => ({
      ...item,
      next:
        item.collection === null
          ? null
          : nextEpisode(byCollection.get(item.collection.id) ?? [], progress),
    }));
  }

  /** Refuses a reference the caller cannot see, so saving is not a way to probe. */
  private async requireTarget(
    role: Role,
    ref: WatchlistRefInput,
  ): Promise<{ collectionId: string } | { videoId: string }> {
    if (ref.collectionId !== undefined) {
      const collection = await this.prisma.collection.findFirst({
        where: { id: ref.collectionId, ...whereVisible(role) },
        select: { id: true },
      });
      if (!collection) throw new NotFoundException('No such collection');
      return { collectionId: collection.id };
    }

    const video = await this.prisma.video.findFirst({
      where: { id: ref.videoId, ...whereVisible(role) },
      select: { id: true },
    });
    if (!video) throw new NotFoundException('No such video');
    return { videoId: video.id };
  }
}

/** Prisma's unique-constraint failure. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}
