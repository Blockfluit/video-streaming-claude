/**
 * The "% Match" scoring math: how much a viewer's watch history says they'll
 * like a title they haven't seen.
 *
 * Pure, for the same reason `rank.ts` is — the rules only bite in combination
 * (a completed watch and a watchlist add for the same title must not add up,
 * a lead actor must outweigh someone billed 39th, a genre a viewer has never
 * touched must contribute nothing) and every one of those is the sort of
 * thing that is only wrong in a badge nobody double-checks. There is no
 * rating system in this app, so "liked" is inferred from what was actually
 * finished or explicitly saved, never from a stated opinion.
 */

import type { CreditRole } from '../../prisma/generated/enums';

export type EvidenceTarget = { videoId: string } | { collectionId: string };

export interface EvidenceCredit {
  personId: string;
  role: CreditRole;
  /** Billing order, as stored on `Credit.position`. */
  position: number;
}

/** One title from the viewer's own history, reduced to what scoring needs. */
export interface EngagementEvidence {
  target: EvidenceTarget;
  /** Only ever true for a video — a collection has no completion of its own. */
  completed: boolean;
  onWatchlist: boolean;
  /** Null when the duration is unknown, or the target is a collection. */
  watchedFraction: number | null;
  genres: string[];
  tags: string[];
  credits: EvidenceCredit[];
}

/** A not-yet-watched title being scored against a profile. */
export interface CandidateFeatures {
  genres: string[];
  tags: string[];
  credits: EvidenceCredit[];
}

/**
 * Whether a candidate carries anything at all to score it on.
 *
 * A title matched to nothing yet — no genres, no tags, no credits, common
 * for anything an admin hasn't run through TMDB import — always scores 0
 * against `scoreCandidate`, indistinguishable from a title that genuinely
 * shares nothing with the viewer's taste. Those are different claims: one
 * says "we checked, and this doesn't match you," the other says "there is
 * nothing here to check." `matchScoreFor` uses this to hide the badge for
 * the second case rather than display a misleading 0%.
 */
export const hasFeatures = (candidate: CandidateFeatures): boolean =>
  candidate.genres.length > 0 || candidate.tags.length > 0 || candidate.credits.length > 0;

export interface TasteProfile {
  genreWeights: Map<string, number>;
  tagWeights: Map<string, number>;
  personWeights: Map<string, number>;
  /** Distinct completed-or-watchlisted titles. What `hasEnoughSignal` gates on. */
  strongSignalCount: number;
}

/** Finishing something is the strongest signal available with no rating system. */
export const WEIGHT_COMPLETED = 1.0;
/** Deliberate, but not confirmed by actually watching. */
export const WEIGHT_WATCHLISTED = 0.6;
/**
 * The ceiling a partial watch can reach, scaled by how far the viewer got.
 * Capped below both other weights so a half-watched title can never outweigh
 * a completed one or a deliberate list add.
 */
export const WEIGHT_PARTIAL_MAX = 0.5;
/** Below 10% watched, a bare click is not evidence of anything. */
export const MIN_PARTIAL_FRACTION = 0.1;

/** Genre is broad and shared by most of the library — real signal, but noisy. */
export const GENRE_WEIGHT = 0.3;
/** Curator effort is optional, so tag coverage is inconsistent across a library. */
export const TAG_WEIGHT = 0.25;
/** Cast/crew is exact-name matching — rare, and highly informative when it fires. */
export const CAST_WEIGHT = 0.45;

/**
 * Reachable within a first weekend of real use, but rules out one afternoon of
 * bingeing a single show counting as "knowing someone's taste" — a profile
 * built from one show has no genre or cast diversity at all.
 */
export const MIN_STRONG_SIGNALS = 5;

/**
 * Below this, an "overlap" is one broad shared genre out of a big profile —
 * coincidence, not relevance. Keeps the Recommended row from padding itself
 * with filler once it's visible.
 */
export const MIN_ROW_ITEM_SCORE = 0.15;

/**
 * Billing past this is already worth ≈1/31 ≈ 0.03 of a lead credit's weight —
 * negligible, so evidence.ts trims it at the query rather than reading rows
 * this module would immediately discount to nothing.
 */
export const EVIDENCE_MAX_BILLING_POSITION = 30;

const ROLE_WEIGHT: Record<CreditRole, number> = {
  // The credits a viewer consciously follows.
  DIRECTOR: 1.0,
  ACTOR: 1.0,
  // Auteur screenwriters are the next most recognised credit.
  WRITER: 0.6,
  // Real signal, rarely a reason someone chose to watch something.
  PRODUCER: 0.4,
  COMPOSER: 0.4,
  CINEMATOGRAPHER: 0.4,
  EDITOR: 0.3,
  // Most TMDB jobs collapse here — see crew-role.ts.
  OTHER: 0.2,
};

const roleWeight = (role: CreditRole): number => ROLE_WEIGHT[role];

/**
 * A harmonic decay: position 0 -> 1.0, position 5 -> ~0.17, position 39 ->
 * ~0.025. Steep enough to separate a lead from support quickly, flat enough
 * that position 40 vs 41 — both noise — are indistinguishable.
 */
const billingFactor = (position: number): number => 1 / (1 + Math.max(position, 0));

/**
 * How much one watched/listed title counts as "liked".
 *
 * `max`, never sum: a title that is both completed and on My List must
 * contribute once, not twice.
 */
export function evidenceWeight(
  evidence: Pick<EngagementEvidence, 'completed' | 'onWatchlist' | 'watchedFraction'>,
): number {
  const partial =
    evidence.watchedFraction !== null && evidence.watchedFraction >= MIN_PARTIAL_FRACTION
      ? evidence.watchedFraction * WEIGHT_PARTIAL_MAX
      : 0;

  return Math.max(
    evidence.completed ? WEIGHT_COMPLETED : 0,
    evidence.onWatchlist ? WEIGHT_WATCHLISTED : 0,
    partial,
  );
}

/** Exported so `match.ts` can exclude a candidate's own evidence by the same key. */
export const evidenceTargetKey = (target: EvidenceTarget): string =>
  'videoId' in target ? `video:${target.videoId}` : `collection:${target.collectionId}`;

/** Each map scaled to sum to 1, bounding every category to [0,1] regardless of library size. */
function normalize(raw: Map<string, number>): Map<string, number> {
  const total = [...raw.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return new Map();

  return new Map([...raw].map(([key, value]) => [key, value / total]));
}

/**
 * Builds a viewer's taste profile from their watch history and My List.
 *
 * Evidence is grouped by target first — defensively, in case the IO layer
 * ever sends two rows for the same title (e.g. it is both completed and on
 * My List) — so a title contributes its single strongest weight once, never
 * once per row that happens to describe it.
 */
export function buildTasteProfile(evidenceList: EngagementEvidence[]): TasteProfile {
  const byTarget = new Map<string, EngagementEvidence[]>();
  for (const item of evidenceList) {
    const key = evidenceTargetKey(item.target);
    const group = byTarget.get(key);
    if (group) group.push(item);
    else byTarget.set(key, [item]);
  }

  const rawGenre = new Map<string, number>();
  const rawTag = new Map<string, number>();
  const rawPerson = new Map<string, number>();
  let strongSignalCount = 0;

  for (const group of byTarget.values()) {
    const weight = Math.max(...group.map(evidenceWeight));
    if (weight <= 0) continue;

    if (group.some((item) => item.completed || item.onWatchlist)) strongSignalCount += 1;

    // Every row in a group describes the same title, so any one of them
    // carries the genres/tags/credits that title's full weight applies to.
    const [sample] = group;
    if (!sample) continue;

    // A title's full weight goes to *each* of its genres/tags — loving an
    // Action+Comedy film is evidence for liking both, not half as much of
    // each, matching how the rest of the app treats genres/tags as set
    // membership rather than a distribution.
    for (const genre of sample.genres) rawGenre.set(genre, (rawGenre.get(genre) ?? 0) + weight);
    for (const tag of sample.tags) rawTag.set(tag, (rawTag.get(tag) ?? 0) + weight);

    for (const c of sample.credits) {
      const contribution = weight * roleWeight(c.role) * billingFactor(c.position);
      rawPerson.set(c.personId, (rawPerson.get(c.personId) ?? 0) + contribution);
    }
  }

  return {
    genreWeights: normalize(rawGenre),
    tagWeights: normalize(rawTag),
    personWeights: normalize(rawPerson),
    strongSignalCount,
  };
}

const sumWeights = (weights: Map<string, number>, keys: string[]): number =>
  keys.reduce((sum, key) => sum + (weights.get(key) ?? 0), 0);

/**
 * Scores one not-yet-watched title against a profile, in [0, 1].
 *
 * Cast/crew reads the *candidate's* own billing, not just the profile's
 * memory of the person: a loved lead actor reappearing as extra #38 is a
 * much weaker connection than reappearing as the lead again.
 */
export function scoreCandidate(profile: TasteProfile, candidate: CandidateFeatures): number {
  const genreScore = sumWeights(profile.genreWeights, candidate.genres);
  const tagScore = sumWeights(profile.tagWeights, candidate.tags);

  const castScore = candidate.credits.reduce((sum, c) => {
    const base = profile.personWeights.get(c.personId);
    if (!base) return sum;
    return sum + base * roleWeight(c.role) * billingFactor(c.position);
  }, 0);

  const score = GENRE_WEIGHT * genreScore + TAG_WEIGHT * tagScore + CAST_WEIGHT * castScore;
  return Math.min(Math.max(score, 0), 1);
}

export function hasEnoughSignal(profile: TasteProfile): boolean {
  return profile.strongSignalCount >= MIN_STRONG_SIGNALS;
}
