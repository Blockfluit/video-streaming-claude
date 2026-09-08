/**
 * The public entry points for "% Match": one per the two places it appears —
 * a single detail-page badge, and the Recommended row's many candidates.
 *
 * Both build the profile from the same evidence; the detail-page read
 * additionally excludes the thing being scored from its own evidence, so a
 * video never gets credit for matching itself.
 */

import type { PrismaService } from '../../prisma/prisma.service';
import {
  buildTasteProfile,
  evidenceTargetKey,
  hasEnoughSignal,
  scoreCandidate,
} from './taste-profile';
import { fetchEngagementEvidence, fetchTargetFeatures, fetchTargetFeaturesForVideos } from './evidence';

/**
 * The badge on a video's or collection's own page, 0-100. `null` means
 * "hidden" — either the viewer hasn't cleared `MIN_STRONG_SIGNALS` yet, or
 * (defensively) the target has no readable features.
 *
 * For a collection, `memberVideoIds` are its own episodes — the same ones
 * `progress()` already reads for its watch-progress rollup — excluded here so
 * a show doesn't get credit for matching its own episodes.
 */
export async function matchScoreFor(
  prisma: PrismaService,
  userId: string,
  target: { videoId: string } | { collectionId: string; memberVideoIds?: string[] },
): Promise<number | null> {
  const excluded = new Set<string>();
  if ('videoId' in target) {
    excluded.add(evidenceTargetKey({ videoId: target.videoId }));
  } else {
    excluded.add(evidenceTargetKey({ collectionId: target.collectionId }));
    for (const videoId of target.memberVideoIds ?? []) {
      excluded.add(evidenceTargetKey({ videoId }));
    }
  }

  const evidence = await fetchEngagementEvidence(prisma, userId);
  const profile = buildTasteProfile(
    evidence.filter((item) => !excluded.has(evidenceTargetKey(item.target))),
  );
  if (!hasEnoughSignal(profile)) return null;

  const candidate =
    'videoId' in target
      ? await fetchTargetFeatures(prisma, { videoId: target.videoId })
      : await fetchTargetFeatures(prisma, { collectionId: target.collectionId });
  if (!candidate) return null;

  return Math.round(scoreCandidate(profile, candidate) * 100);
}

/**
 * Raw 0-1 scores for the Recommended row's candidate pool — one profile, many
 * candidates, no self-exclusion (the caller already excludes anything the
 * viewer has completed or watchlisted from the pool before calling this).
 *
 * Left unrounded because `computed.ts` both ranks on this and filters it
 * against `MIN_ROW_ITEM_SCORE`; the rounded percentage is a display concern
 * of `matchScoreFor` alone.
 *
 * `null` means the viewer hasn't cleared `MIN_STRONG_SIGNALS` — the row
 * disappears entirely rather than showing a score built from too little.
 */
export async function matchScoresForVideos(
  prisma: PrismaService,
  userId: string,
  videoIds: string[],
): Promise<Map<string, number> | null> {
  if (videoIds.length === 0) return new Map();

  const evidence = await fetchEngagementEvidence(prisma, userId);
  const profile = buildTasteProfile(evidence);
  if (!hasEnoughSignal(profile)) return null;

  const features = await fetchTargetFeaturesForVideos(prisma, videoIds);

  const scores = new Map<string, number>();
  for (const videoId of videoIds) {
    const candidate = features.get(videoId);
    if (!candidate) continue;
    scores.set(videoId, scoreCandidate(profile, candidate));
  }
  return scores;
}
