import { Injectable, NotFoundException } from '@nestjs/common';
import {
  toPage,
  type HeartbeatInput,
  type ListHistoryQuery,
  type Page,
  type WatchTotals,
} from '@video/shared';

import { whereVisible } from '../common/publishing';
import { savedToList } from '../common/watchlist';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { applyBeat, creditedSeconds } from './progress';

/** Enough to render a continue-watching card and link to the player. */
const HISTORY_VIDEO_SELECT = {
  id: true,
  slug: true,
  title: true,
  durationSec: true,
  bannerKey: true,
  // The quality badge is rendered from these; without them it is dead code
  // on every card the row draws.
  width: true,
  height: true,
  state: true,
  // Where a video sits, per collection it belongs to. Continue Watching
  // shows which show an episode came from, and it may have come from more
  // than one.
  collections: {
    select: {
      orderIndex: true,
      collection: { select: { id: true, slug: true, title: true } },
      season: { select: { id: true, slug: true, number: true } },
    },
  },
} as const;

const PROGRESS_SELECT = {
  lastPositionSec: true,
  maxPositionSec: true,
  secondsWatched: true,
  viewCount: true,
  completed: true,
  lastWatchedAt: true,
} as const;

@Injectable()
export class WatchService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records one heartbeat: an event row, and the rollup the library reads.
   *
   * The event log and the rollup are written in one transaction because they
   * are two views of the same fact. A rollup that counted a beat the log does
   * not contain cannot be recomputed from the log afterwards, which is the one
   * thing keeping the log worth having.
   */
  async heartbeat(videoId: string, userId: string, role: Role, beat: HeartbeatInput) {
    // Visibility first: a USER heartbeating a draft must get the same 404 they
    // get reading it, or the endpoint confirms the video exists.
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...whereVisible(role) },
      select: { id: true, durationSec: true },
    });
    if (!video) throw new NotFoundException('No such video');

    return this.prisma.$transaction(async (tx) => {
      const [existing, seen] = await Promise.all([
        tx.watchProgress.findUnique({
          where: { userId_videoId: { userId, videoId } },
          select: PROGRESS_SELECT,
        }),
        // One page load is one view, however many beats it sends. This is what
        // `@@index([playSessionId])` on WatchEvent exists for.
        tx.watchEvent.findFirst({
          where: { playSessionId: beat.playSessionId },
          select: { id: true },
        }),
      ]);

      const next = applyBeat(existing, beat, {
        durationSec: video.durationSec,
        isNewPlaySession: seen === null,
      });

      await tx.watchEvent.create({
        data: {
          userId,
          videoId,
          playSessionId: beat.playSessionId,
          positionSec: next.lastPositionSec,
          // The credited figure, not what was claimed — so summing the log
          // still reproduces the rollup after a delta was capped.
          deltaSec: creditedSeconds(beat.deltaSec),
        },
      });

      return tx.watchProgress.upsert({
        where: { userId_videoId: { userId, videoId } },
        create: { userId, videoId, ...next },
        update: next,
        select: PROGRESS_SELECT,
      });
    });
  }

  /**
   * What the caller has been watching, most recent first.
   *
   * Filtered by visibility on the **video**, not just on the progress row: a
   * video that was unpublished after someone watched it must drop out of their
   * history rather than leak its title back to them.
   */
  async history(userId: string, role: Role, query: ListHistoryQuery): Promise<Page<unknown>> {
    const where = {
      userId,
      ...(query.completed === undefined ? {} : { completed: query.completed }),
      video: {
        // Narrowed through the membership — "is this video in that collection".
        ...(query.collectionId
          ? { collections: { some: { collectionId: query.collectionId } } }
          : {}),
        // Spread last: the visibility rule is what nothing else may overwrite,
        // so a history filtered by collection still cannot reach a draft.
        ...whereVisible(role),
      },
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.watchProgress.findMany({
        where,
        select: { ...PROGRESS_SELECT, video: { select: HISTORY_VIDEO_SELECT } },
        // `id` last makes the order total — two rows can share a timestamp, and
        // offset paging over a non-total order repeats and skips rows.
        orderBy: [{ lastWatchedAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.watchProgress.count({ where }),
    ]);

    const items = rows.map(({ video, ...progress }) => ({ video, progress }));

    return toPage(items, total, query);
  }

  /**
   * Figures for one video: the caller's own progress always, the aggregate only
   * for an admin. Nobody else's viewing is any of a viewer's business.
   */
  async videoStats(videoId: string, userId: string, role: Role) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...whereVisible(role) },
      select: { id: true, durationSec: true },
    });
    if (!video) throw new NotFoundException('No such video');

    const mine = await this.prisma.watchProgress.findUnique({
      where: { userId_videoId: { userId, videoId } },
      select: PROGRESS_SELECT,
    });

    // A sibling of `mine` rather than a field of it: `mine` is null for a video
    // nobody has started, and saving something is independent of watching it.
    // This is the only per-caller read a video's page makes, so it is what the
    // My List button has to learn its own state from.
    const inMyList = await savedToList(this.prisma, userId, { videoId });

    if (role !== 'ADMIN') return { mine, inMyList };

    return { mine, inMyList, totals: await this.totals({ videoId }, video.durationSec) };
  }

  /**
   * The same figures rolled up over a collection.
   *
   * `averageCompletion` is computed per video before averaging, because the
   * videos have different runtimes: summing positions and dividing by summed
   * durations would weight a feature film far above an episode.
   */
  async collectionStats(collectionId: string, role: Role) {
    const collection = await this.prisma.collection.findFirst({
      where: { id: collectionId, ...whereVisible(role) },
      select: { id: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    const videos = await this.prisma.video.findMany({
      // Membership, not a column: these are the videos in this collection.
      where: { collections: { some: { collectionId } }, ...whereVisible(role) },
      select: { id: true, durationSec: true },
    });

    const perVideo = await Promise.all(
      videos.map((video) => this.totals({ videoId: video.id }, video.durationSec)),
    );

    const completions = sum(perVideo.map((t) => t.completions));
    const rated = perVideo.filter((t) => t.averageCompletion !== null && t.viewers > 0);

    return {
      videoCount: videos.length,
      totals: {
        // Distinct across the whole collection, not the sum of per-video counts:
        // one person watching six episodes is one viewer.
        viewers: await this.distinctViewers(collectionId),
        views: sum(perVideo.map((t) => t.views)),
        secondsWatched: sum(perVideo.map((t) => t.secondsWatched)),
        completions,
        averageCompletion:
          rated.length === 0
            ? null
            : sum(rated.map((t) => t.averageCompletion as number)) / rated.length,
      } satisfies WatchTotals,
    };
  }

  private async totals(
    where: { videoId: string },
    durationSec: number | null,
  ): Promise<WatchTotals> {
    const [aggregate, completions] = await Promise.all([
      this.prisma.watchProgress.aggregate({
        where,
        _count: { _all: true },
        _sum: { secondsWatched: true, viewCount: true },
        _avg: { maxPositionSec: true },
      }),
      this.prisma.watchProgress.count({ where: { ...where, completed: true } }),
    ]);

    const averageReached = aggregate._avg.maxPositionSec;

    return {
      // One progress row per (user, video), so the row count is the viewer count.
      viewers: aggregate._count._all,
      views: aggregate._sum.viewCount ?? 0,
      secondsWatched: aggregate._sum.secondsWatched ?? 0,
      completions,
      averageCompletion:
        durationSec !== null && durationSec > 0 && averageReached !== null
          ? averageReached / durationSec
          : null,
    };
  }

  /** One person watching six episodes is one viewer, which a sum of per-video counts is not. */
  private async distinctViewers(collectionId: string): Promise<number> {
    const rows = await this.prisma.watchProgress.groupBy({
      by: ['userId'],
      where: { video: { collections: { some: { collectionId } } } },
    });
    return rows.length;
  }
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
