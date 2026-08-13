import { DEFAULT_TRENDING_WINDOW_DAYS } from '@video/shared';

import { COUNTS_HERE_SELECT, withCountsHere } from '../../common/films';
import { visibleStates, whereVisible } from '../../common/publishing';
import type { PublishState, Role, RowKind, RowSource } from '../../prisma/generated/enums';
import type { PrismaService } from '../../prisma/prisma.service';

import { latest, rollUpAndRank, total, type RankedEntry, type ScoredVideo } from './rank';

/**
 * The queries behind a computed row, and the hydration that turns a ranking
 * back into cards.
 *
 * Each source differs only in what it scores a video on — when it arrived, how
 * many views it has, how long it was watched lately. The roll-up and the
 * ordering are `rank.ts`, which is pure and tested on its own; this file is the
 * IO around it.
 */

export interface ComputedRow {
  source: RowSource;
  kind: RowKind;
  maxItems: number;
  windowDays: number | null;
  tags: string[];
}

/**
 * How many videos a ranking looks at.
 *
 * The view-based sources group over watched videos only, which in a private
 * library is a fraction of it; "recently added" reads the newest videos, and
 * ordering by the metric first means the bound cannot change the answer for any
 * realistic library. If this ever needs raising past what one query should
 * return, the ranking belongs in SQL rather than in a bigger number here.
 */
const POOL_LIMIT = 2000;

/**
 * One shared shape, because a collection card is a collection card wherever it
 * is rendered. It was hand-copied into `lists.service` and `watchlist.service`,
 * so a field added here reached a computed row's cards and neither of theirs —
 * which is how a shelf ends up rendering a chip its neighbour cannot.
 */
export const COLLECTION_CARD_SELECT = {
  id: true,
  slug: true,
  title: true,
  year: true,
  posterKey: true,
  state: true,
  ...COUNTS_HERE_SELECT,
} as const;

export const VIDEO_CARD_SELECT = {
  id: true,
  slug: true,
  title: true,
  durationSec: true,
  bannerKey: true,
  width: true,
  height: true,
  state: true,
  collections: {
    select: { collection: { select: { id: true, slug: true, title: true } } },
  },
} as const;

/** One resolved entry, shaped like a hand-picked one so the home page asks the same questions. */
export interface ResolvedItem {
  id: string;
  collection: unknown | null;
  video: unknown | null;
}

export async function computedItems(
  prisma: PrismaService,
  row: ComputedRow,
  role: Role,
): Promise<ResolvedItem[]> {
  const scored = await score(prisma, row, role);
  const combine = row.source === 'RECENTLY_ADDED' ? latest : total;

  return hydrate(prisma, rollUpAndRank(scored, row.kind, row.maxItems, combine), role);
}

/** What each source ranks on, reduced to one number per video. */
async function score(
  prisma: PrismaService,
  row: ComputedRow,
  role: Role,
): Promise<ScoredVideo[]> {
  const videoFilter = {
    ...(row.tags.length > 0 ? { tags: { hasSome: row.tags } } : {}),
    // Spread last: the visibility rule is what nothing else may overwrite.
    ...whereVisible(role),
  };

  if (row.source === 'RECENTLY_ADDED') {
    const videos = await prisma.video.findMany({
      where: videoFilter,
      select: { id: true, createdAt: true, collections: MEMBERSHIP_SELECT },
      // `id` last makes the order total; two videos ingested in the same folder
      // drop share a timestamp to the millisecond more often than not.
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: POOL_LIMIT,
    });

    return videos
      .filter((video) => !isOrphaned(video.collections, role))
      .map((video) => ({
        videoId: video.id,
        collectionIds: visibleCollectionIds(video.collections, role),
        score: video.createdAt.getTime(),
      }));
  }

  const totals =
    row.source === 'TRENDING'
      ? await trendingTotals(prisma, row, videoFilter)
      : await viewTotals(prisma, videoFilter);

  if (totals.length === 0) return [];

  // The aggregate cannot carry the memberships, so they are read back for the
  // videos that actually scored — a much smaller set than the library.
  const videos = await prisma.video.findMany({
    where: { id: { in: totals.map((entry) => entry.videoId) } },
    select: { id: true, collections: MEMBERSHIP_SELECT },
  });
  const memberships = new Map(videos.map((video) => [video.id, video.collections]));

  return totals
    .filter((entry) => !isOrphaned(memberships.get(entry.videoId) ?? [], role))
    .map((entry) => ({
      videoId: entry.videoId,
      collectionIds: visibleCollectionIds(memberships.get(entry.videoId) ?? [], role),
      score: entry.score,
    }));
}

/** All-time views, summed per video across everyone who watched it. */
async function viewTotals(prisma: PrismaService, videoFilter: object) {
  const rows = await prisma.watchProgress.groupBy({
    by: ['videoId'],
    where: { video: videoFilter },
    _sum: { viewCount: true },
    orderBy: { _sum: { viewCount: 'desc' } },
    take: POOL_LIMIT,
  });

  return rows.map((row) => ({ videoId: row.videoId, score: row._sum.viewCount ?? 0 }));
}

/**
 * Seconds watched inside the window.
 *
 * Deliberately not a count of plays: opening something and leaving would then
 * rank it level with watching it through, and a row called "trending" would
 * fill up with whatever people bounced off. `WatchEvent` stores the *credited*
 * delta, so summing these reproduces the same total the rollup holds.
 */
async function trendingTotals(prisma: PrismaService, row: ComputedRow, videoFilter: object) {
  const days = row.windowDays ?? DEFAULT_TRENDING_WINDOW_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.watchEvent.groupBy({
    by: ['videoId'],
    where: { createdAt: { gte: since }, video: videoFilter },
    _sum: { deltaSec: true },
    orderBy: { _sum: { deltaSec: 'desc' } },
    take: POOL_LIMIT,
  });

  return rows.map((row) => ({ videoId: row.videoId, score: row._sum.deltaSec ?? 0 }));
}

const MEMBERSHIP_SELECT = {
  select: { collectionId: true, collection: { select: { state: true } } },
} as const;

type Memberships = { collectionId: string; collection: { state: PublishState } }[];

const visibleCollectionIds = (memberships: Memberships, role: Role): string[] => {
  const allowed = visibleStates(role);

  return memberships
    .filter((membership) => allowed.includes(membership.collection.state))
    .map((membership) => membership.collectionId);
};

/**
 * A video whose every collection is hidden from this caller.
 *
 * It is not standalone — it is an episode of a show they cannot see — so it is
 * dropped rather than offered as though it were a film. Without this, an
 * unpublished season would advertise its episodes one at a time on the home
 * page, which is the leak the visibility rule exists to prevent. A video with
 * no memberships at all is a different thing entirely, and is kept.
 */
const isOrphaned = (memberships: Memberships, role: Role): boolean =>
  memberships.length > 0 && visibleCollectionIds(memberships, role).length === 0;

/** Ranked ids back into cards, in the order the ranking put them. */
async function hydrate(
  prisma: PrismaService,
  ranked: RankedEntry[],
  role: Role,
): Promise<ResolvedItem[]> {
  const collectionIds = ranked.filter((e) => e.kind === 'collection').map((e) => e.id);
  const videoIds = ranked.filter((e) => e.kind === 'video').map((e) => e.id);

  const [collections, videos] = await Promise.all([
    collectionIds.length === 0
      ? []
      : prisma.collection.findMany({
          where: { id: { in: collectionIds }, ...whereVisible(role) },
          select: COLLECTION_CARD_SELECT,
        }),
    videoIds.length === 0
      ? []
      : prisma.video.findMany({
          where: { id: { in: videoIds }, ...whereVisible(role) },
          select: VIDEO_CARD_SELECT,
        }),
  ]);

  const byId = new Map<string, { collection?: unknown; video?: unknown }>();
  for (const collection of collections) {
    byId.set(collection.id, { collection: withCountsHere(collection) });
  }
  for (const video of videos) byId.set(video.id, { video });

  return ranked.flatMap((entry) => {
    const found = byId.get(entry.id);
    // A row that vanished between ranking and hydration is simply not shown.
    if (!found) return [];

    return [
      {
        // Stable across requests, and distinct from a ListItem id: a computed
        // row has no items table, so the entry's own id is the only identity
        // it has. The `v-for` key on the home page is this.
        id: `${entry.kind}:${entry.id}`,
        collection: found.collection ?? null,
        video: found.video ?? null,
      },
    ];
  });
}
