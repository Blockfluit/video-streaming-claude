/**
 * The Prisma queries behind the match score: turning a viewer's own watch
 * history and My List into `EngagementEvidence`, and turning a candidate
 * title into the same shape so it can be scored against a profile.
 *
 * Bounded to that one viewer's own rows — small by construction on a private
 * library — except the candidate batch, which is bounded by whatever pool
 * `computed.ts` already applies `POOL_LIMIT` to.
 */

import type { PrismaService } from '../../prisma/prisma.service';
import {
  EVIDENCE_MAX_BILLING_POSITION,
  type CandidateFeatures,
  type EngagementEvidence,
  type EvidenceCredit,
  type EvidenceTarget,
} from './taste-profile';

/** Same shape as a candidate — a title reduced to what scoring needs. */
export type TargetFeatures = CandidateFeatures;

/**
 * One user's watch history and My List, reduced to `EngagementEvidence`.
 *
 * A row whose target has since been deleted (progress survives its video only
 * through `onDelete: Cascade`, so this is defensive rather than expected) is
 * silently dropped rather than scored against nothing.
 */
export async function fetchEngagementEvidence(
  prisma: PrismaService,
  userId: string,
): Promise<EngagementEvidence[]> {
  const [progressRows, watchlistRows] = await Promise.all([
    prisma.watchProgress.findMany({
      where: { userId },
      select: {
        videoId: true,
        completed: true,
        maxPositionSec: true,
        video: { select: { durationSec: true } },
      },
    }),
    prisma.watchlistItem.findMany({
      where: { userId },
      select: { videoId: true, collectionId: true },
    }),
  ]);

  const videoIds = new Set<string>();
  for (const row of progressRows) videoIds.add(row.videoId);
  for (const row of watchlistRows) if (row.videoId) videoIds.add(row.videoId);

  const collectionIds = new Set<string>();
  for (const row of watchlistRows) if (row.collectionId) collectionIds.add(row.collectionId);

  const [videoFeatures, collectionFeatures] = await Promise.all([
    videoFeaturesBatch(prisma, [...videoIds]),
    collectionFeaturesBatch(prisma, [...collectionIds]),
  ]);

  interface Merging {
    target: EvidenceTarget;
    completed: boolean;
    onWatchlist: boolean;
    watchedFraction: number | null;
  }

  const byKey = new Map<string, Merging>();

  for (const row of progressRows) {
    const durationSec = row.video.durationSec;
    const watchedFraction =
      durationSec !== null && durationSec > 0
        ? Math.min(Math.max(row.maxPositionSec / durationSec, 0), 1)
        : null;

    byKey.set(`video:${row.videoId}`, {
      target: { videoId: row.videoId },
      completed: row.completed,
      onWatchlist: false,
      watchedFraction,
    });
  }

  for (const row of watchlistRows) {
    if (row.videoId) {
      const key = `video:${row.videoId}`;
      const existing = byKey.get(key);
      if (existing) existing.onWatchlist = true;
      else {
        byKey.set(key, {
          target: { videoId: row.videoId },
          completed: false,
          onWatchlist: true,
          watchedFraction: null,
        });
      }
    } else if (row.collectionId) {
      byKey.set(`collection:${row.collectionId}`, {
        target: { collectionId: row.collectionId },
        completed: false,
        onWatchlist: true,
        watchedFraction: null,
      });
    }
  }

  const evidence: EngagementEvidence[] = [];
  for (const entry of byKey.values()) {
    const features =
      'videoId' in entry.target
        ? videoFeatures.get(entry.target.videoId)
        : collectionFeatures.get(entry.target.collectionId);
    if (!features) continue;

    evidence.push({ ...entry, ...features });
  }

  return evidence;
}

/**
 * One target's genres, tags and merged credits — the shape both a candidate
 * and a single piece of evidence need. Used by the two detail-page badges,
 * where there is exactly one target to look up.
 */
export async function fetchTargetFeatures(
  prisma: PrismaService,
  target: EvidenceTarget,
): Promise<TargetFeatures | null> {
  if ('videoId' in target) {
    const features = await videoFeaturesBatch(prisma, [target.videoId]);
    return features.get(target.videoId) ?? null;
  }

  const features = await collectionFeaturesBatch(prisma, [target.collectionId]);
  return features.get(target.collectionId) ?? null;
}

/** The same lookup for many videos at once — what the Recommended row scores against. */
export const fetchTargetFeaturesForVideos = (
  prisma: PrismaService,
  videoIds: string[],
): Promise<Map<string, TargetFeatures>> => videoFeaturesBatch(prisma, videoIds);

/**
 * A video's own genres/tags, and its credits merged with its collection(s)' —
 * the same "episode's own credit wins, the show's fills in the rest" rule
 * `credits/merge.ts` uses for display, applied here to signal instead: an
 * episode with no credits of its own should still carry the show's cast.
 */
async function videoFeaturesBatch(
  prisma: PrismaService,
  videoIds: string[],
): Promise<Map<string, TargetFeatures>> {
  if (videoIds.length === 0) return new Map();

  const videos = await prisma.video.findMany({
    where: { id: { in: videoIds } },
    select: {
      id: true,
      genres: true,
      tags: true,
      collections: { select: { collectionId: true } },
    },
  });

  const collectionIds = new Set<string>();
  for (const video of videos) {
    for (const membership of video.collections) collectionIds.add(membership.collectionId);
  }

  const credits = await prisma.credit.findMany({
    where: {
      OR: [{ videoId: { in: videoIds } }, { collectionId: { in: [...collectionIds] } }],
      // Billing past this is already negligible — see EVIDENCE_MAX_BILLING_POSITION.
      position: { lt: EVIDENCE_MAX_BILLING_POSITION },
    },
    select: { videoId: true, collectionId: true, personId: true, role: true, position: true },
  });

  const creditsByVideo = new Map<string, EvidenceCredit[]>();
  const creditsByCollection = new Map<string, EvidenceCredit[]>();
  for (const credit of credits) {
    const entry = { personId: credit.personId, role: credit.role, position: credit.position };
    if (credit.videoId) push(creditsByVideo, credit.videoId, entry);
    else if (credit.collectionId) push(creditsByCollection, credit.collectionId, entry);
  }

  const result = new Map<string, TargetFeatures>();
  for (const video of videos) {
    const own = creditsByVideo.get(video.id) ?? [];
    const inherited = video.collections.flatMap(
      (membership) => creditsByCollection.get(membership.collectionId) ?? [],
    );
    result.set(video.id, { genres: video.genres, tags: video.tags, credits: mergeOwnFirst(own, inherited) });
  }
  return result;
}

/** A collection's own genres/tags/credits — no merge, unlike a video's. */
async function collectionFeaturesBatch(
  prisma: PrismaService,
  collectionIds: string[],
): Promise<Map<string, TargetFeatures>> {
  if (collectionIds.length === 0) return new Map();

  const [collections, credits] = await Promise.all([
    prisma.collection.findMany({
      where: { id: { in: collectionIds } },
      select: { id: true, genres: true, tags: true },
    }),
    prisma.credit.findMany({
      where: { collectionId: { in: collectionIds }, position: { lt: EVIDENCE_MAX_BILLING_POSITION } },
      select: { collectionId: true, personId: true, role: true, position: true },
    }),
  ]);

  const creditsByCollection = new Map<string, EvidenceCredit[]>();
  for (const credit of credits) {
    // Scoped to `collectionId: { in: collectionIds }` above, so this is always set.
    push(creditsByCollection, credit.collectionId as string, {
      personId: credit.personId,
      role: credit.role,
      position: credit.position,
    });
  }

  const result = new Map<string, TargetFeatures>();
  for (const collection of collections) {
    result.set(collection.id, {
      genres: collection.genres,
      tags: collection.tags,
      credits: creditsByCollection.get(collection.id) ?? [],
    });
  }
  return result;
}

/** The video's own credit for a person wins over the collection's, same as `credits/merge.ts`. */
function mergeOwnFirst(own: EvidenceCredit[], inherited: EvidenceCredit[]): EvidenceCredit[] {
  const ownPeople = new Set(own.map((credit) => credit.personId));
  return [...own, ...inherited.filter((credit) => !ownPeople.has(credit.personId))];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
