/**
 * The public entry points for "% Match": one per the two places it appears —
 * a single detail-page badge, and the Recommended row's many candidates.
 *
 * Both build the profile from the same evidence; the detail-page read
 * additionally excludes the thing being scored from its own evidence, so a
 * video never gets credit for matching itself.
 */

import { getMinTitlesForMatch } from '../settings';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  buildTasteProfile,
  evidenceTargetKey,
  hasEnoughSignal,
  hasFeatures,
  scoreCandidate,
} from './taste-profile';
import { fetchEngagementEvidence, fetchTargetFeatures, fetchTargetFeaturesForVideos } from './evidence';

/**
 * The badge on a video's or collection's own page, 0-100. `null` means
 * "hidden" — the viewer hasn't cleared the admin-configured minimum yet
 * (`common/settings.ts`), the target has no readable record, or (see
 * `hasFeatures`) the target has genres, tags and credits nowhere at all, so
 * there is nothing to have scored it *on* — common for anything not yet
 * matched to TMDB. That last case is not the same claim as a genuine 0%,
 * and showing one would be a lie about having checked.
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
  const evidence = await fetchEngagementEvidence(prisma, userId);
  const minTitles = await getMinTitlesForMatch(prisma);

  // The gate is a property of the viewer — "has this account watched enough
  // to have a taste profile at all" — not of which title happens to be on
  // screen. Checking it after self-exclusion would mean viewing one of your
  // own most-recently-watched titles could tip your total under the
  // threshold and hide the badge, even though your overall history clears it
  // easily; a show you've watched most of would lose its badge precisely
  // because you know it best.
  if (!hasEnoughSignal(buildTasteProfile(evidence), minTitles)) return null;

  const excluded = new Set<string>();
  if ('videoId' in target) {
    excluded.add(evidenceTargetKey({ videoId: target.videoId }));
  } else {
    excluded.add(evidenceTargetKey({ collectionId: target.collectionId }));
    for (const videoId of target.memberVideoIds ?? []) {
      excluded.add(evidenceTargetKey({ videoId }));
    }
  }

  // Self-exclusion still applies to the score itself, so a title never gets
  // credit for matching itself — only the gate above is exempt from it.
  const profile = buildTasteProfile(
    evidence.filter((item) => !excluded.has(evidenceTargetKey(item.target))),
  );

  const candidate =
    'videoId' in target
      ? await fetchTargetFeatures(prisma, { videoId: target.videoId })
      : await fetchTargetFeatures(prisma, { collectionId: target.collectionId });
  if (!candidate || !hasFeatures(candidate)) return null;

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
 * `null` means the viewer hasn't cleared the admin-configured minimum — the
 * row disappears entirely rather than showing a score built from too little.
 */
export async function matchScoresForVideos(
  prisma: PrismaService,
  userId: string,
  videoIds: string[],
): Promise<Map<string, number> | null> {
  if (videoIds.length === 0) return new Map();

  const evidence = await fetchEngagementEvidence(prisma, userId);
  const profile = buildTasteProfile(evidence);
  const minTitles = await getMinTitlesForMatch(prisma);
  if (!hasEnoughSignal(profile, minTitles)) return null;

  const features = await fetchTargetFeaturesForVideos(prisma, videoIds);

  const scores = new Map<string, number>();
  for (const videoId of videoIds) {
    const candidate = features.get(videoId);
    // No record, or nothing on it to score — either way, not a recommendation.
    if (!candidate || !hasFeatures(candidate)) continue;
    scores.set(videoId, scoreCandidate(profile, candidate));
  }
  return scores;
}
