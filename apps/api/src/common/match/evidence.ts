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
          onWatchlist: true,
          watchedFraction: null,
        });
      }
    } else if (row.collectionId) {
      byKey.set(`collection:${row.collectionId}`, {
        target: { collectionId: row.collectionId },
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
 * A video's genres/tags/credits, merged with its collection(s)' — the same
 * "episode's own wins, the show's fills in the rest" rule `credits/merge.ts`
 * uses for display, applied here to signal instead.
 *
 * Genres in particular are not optional to merge: TMDB's per-episode import
 * (`mapEpisodes`) never sets them at all, only `mapTitle` does — and that
 * lands on the **show**, not the episode. Reading a video's own `genres` in
 * isolation means a real, properly-imported TV episode's `genres` is always
 * `[]`, which would make watching one contribute nothing to a taste profile
 * and an unwatched one unscorable on genre, however clearly the show
 * matches. Tags get the same treatment for the same structural reason: an
 * episode with none of its own should still carry whatever the show does.
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

  const [credits, collections] = await Promise.all([
    prisma.credit.findMany({
      where: {
        OR: [{ videoId: { in: videoIds } }, { collectionId: { in: [...collectionIds] } }],
        // Billing past this is already negligible — see EVIDENCE_MAX_BILLING_POSITION.
        position: { lt: EVIDENCE_MAX_BILLING_POSITION },
      },
      select: { videoId: true, collectionId: true, personId: true, role: true, position: true },
    }),
    prisma.collection.findMany({
      where: { id: { in: [...collectionIds] } },
      select: { id: true, genres: true, tags: true },
    }),
  ]);

  const creditsByVideo = new Map<string, EvidenceCredit[]>();
  const creditsByCollection = new Map<string, EvidenceCredit[]>();
  for (const credit of credits) {
    const entry = { personId: credit.personId, role: credit.role, position: credit.position };
    if (credit.videoId) push(creditsByVideo, credit.videoId, entry);
    else if (credit.collectionId) push(creditsByCollection, credit.collectionId, entry);
  }
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));

  const result = new Map<string, TargetFeatures>();
  for (const video of videos) {
    const own = creditsByVideo.get(video.id) ?? [];
    const inheritedCredits = video.collections.flatMap(
      (membership) => creditsByCollection.get(membership.collectionId) ?? [],
    );
    const parentGenres = video.collections.flatMap(
      (membership) => collectionById.get(membership.collectionId)?.genres ?? [],
    );
    const parentTags = video.collections.flatMap(
      (membership) => collectionById.get(membership.collectionId)?.tags ?? [],
    );

    result.set(video.id, {
      genres: dedupe([...video.genres, ...parentGenres]),
      tags: dedupe([...video.tags, ...parentTags]),
      credits: mergeOwnFirst(own, inheritedCredits),
    });
  }
  return result;
}

/**
 * A collection's genres/tags/credits, merged with the union of its member
 * videos' — the reverse direction of the same rule. A hand-made grouping
 * (a saga collecting individually-matched films, say) is often never itself
 * matched to anything in TMDB and so carries no genres of its own, even
 * though every film inside it obviously does.
 */
async function collectionFeaturesBatch(
  prisma: PrismaService,
  collectionIds: string[],
): Promise<Map<string, TargetFeatures>> {
  if (collectionIds.length === 0) return new Map();

  const [collections, credits, memberships] = await Promise.all([
    prisma.collection.findMany({
      where: { id: { in: collectionIds } },
      select: { id: true, genres: true, tags: true },
    }),
    prisma.credit.findMany({
      where: { collectionId: { in: collectionIds }, position: { lt: EVIDENCE_MAX_BILLING_POSITION } },
      select: { collectionId: true, personId: true, role: true, position: true },
    }),
    prisma.collectionVideo.findMany({
      where: { collectionId: { in: collectionIds } },
      select: { collectionId: true, video: { select: { genres: true, tags: true } } },
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

  const memberGenres = new Map<string, string[]>();
  const memberTags = new Map<string, string[]>();
  for (const membership of memberships) {
    push(memberGenres, membership.collectionId, ...membership.video.genres);
    push(memberTags, membership.collectionId, ...membership.video.tags);
  }

  const result = new Map<string, TargetFeatures>();
  for (const collection of collections) {
    result.set(collection.id, {
      genres: dedupe([...collection.genres, ...(memberGenres.get(collection.id) ?? [])]),
      tags: dedupe([...collection.tags, ...(memberTags.get(collection.id) ?? [])]),
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

const dedupe = (values: string[]): string[] => [...new Set(values)];

function push<K, V>(map: Map<K, V[]>, key: K, ...values: V[]): void {
  const list = map.get(key);
  if (list) list.push(...values);
  else map.set(key, [...values]);
}
