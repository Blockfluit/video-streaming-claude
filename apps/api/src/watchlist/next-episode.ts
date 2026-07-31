/**
 * Which episode a saved collection offers to play.
 *
 * A saved *collection* on the home page renders as one card, and the card has
 * to name an episode. Pure, because the rule has an edge at each end — nothing
 * watched, everything watched — and because getting it subtly wrong shows up
 * as a card that quietly offers the wrong episode rather than as an error.
 */

export interface OrderedVideo {
  id: string;
  /** Null when ingest could not number it, or the collection is a flat shelf of films. */
  orderIndex: number | null;
}

export interface EpisodeProgress {
  completed: boolean;
  lastPositionSec: number;
}

export interface NextEpisode<T extends OrderedVideo> {
  id: string;
  video: T;
  /** Null when it has never been started, which is what a fresh card shows. */
  progress: EpisodeProgress | null;
}

export function nextEpisode<T extends OrderedVideo>(
  videos: T[],
  progress: Map<string, EpisodeProgress>,
): NextEpisode<T> | null {
  if (videos.length === 0) return null;

  // Unnumbered videos sort after numbered ones rather than before: a null is
  // "ingest could not tell", and guessing it means episode zero would offer it
  // ahead of a real episode one. `id` last so the answer is stable — a flat
  // shelf of films leaves every orderIndex null, and without it the card would
  // name a different title on each request.
  const ordered = [...videos].sort(
    (a, b) => rank(a.orderIndex) - rank(b.orderIndex) || a.id.localeCompare(b.id),
  );

  // The first unfinished one — which also covers resuming, since an episode
  // left half-watched is not completed. Watching ahead does not skip what was
  // missed: someone who jumped to the finale still has episode two waiting.
  const next =
    ordered.find((video) => progress.get(video.id)?.completed !== true) ??
    // Nothing left to continue, so the card offers a rewatch from the start.
    ordered[0];

  return { id: next.id, video: next, progress: progress.get(next.id) ?? null };
}

/** Nulls last. `Infinity` rather than a large number, which a real orderIndex could reach. */
const rank = (orderIndex: number | null): number =>
  orderIndex === null ? Number.POSITIVE_INFINITY : orderIndex;
