/**
 * The watch-progress accounting rules.
 *
 * Pure, because "how far did they get" is decided by a handful of interacting
 * rules — a high-water mark that is not the playhead, a completion threshold
 * that must survive a rewind, a per-beat cap — and every one of them is the
 * sort of thing that is only wrong months later, in a statistic nobody can
 * reconstruct.
 */

export interface ProgressState {
  /** Where the viewer is. Goes backwards when they seek backwards; this is what resume restores. */
  lastPositionSec: number;
  /** How far they ever got. Monotonic, and what completion is judged on. */
  maxPositionSec: number;
  secondsWatched: number;
  viewCount: number;
  completed: boolean;
}

export interface Beat {
  positionSec: number;
  deltaSec: number;
}

export interface BeatContext {
  durationSec: number | null;
  /** True on the first beat carrying a given `playSessionId` — one page load, one view. */
  isNewPlaySession: boolean;
}

/**
 * The most watched time one beat may contribute.
 *
 * The client beats every 10s, so anything past this means beats were missed or
 * the delta was computed wrongly. Note what this does and does not do: it stops
 * a single bad number from rewriting a total, but it is not a rate limit — a
 * client that beats in a loop still accumulates. Rate limiting is `@nestjs/throttler`
 * in step 18, and that is the right place for it.
 */
export const MAX_BEAT_SECONDS = 30;

/** A video counts as watched at 90% — nobody sits through the credits. */
export const COMPLETION_FRACTION = 0.9;

/**
 * How much of a claimed delta actually counts.
 *
 * Capped, not rejected: a client that missed two beats still has a real
 * position to record, and refusing the beat outright would throw away the
 * viewer's resume point along with the excess seconds.
 */
export function creditedSeconds(deltaSec: number): number {
  return Math.min(Math.max(deltaSec, 0), MAX_BEAT_SECONDS);
}

export function applyBeat(
  existing: ProgressState | null,
  beat: Beat,
  context: BeatContext,
): ProgressState {
  const previous = existing ?? {
    lastPositionSec: 0,
    maxPositionSec: 0,
    secondsWatched: 0,
    viewCount: 0,
    completed: false,
  };

  const hasDuration = context.durationSec !== null && context.durationSec > 0;

  // Browsers report a `currentTime` a hair past `duration` at the end of
  // playback, and a container's declared duration is not always exact. Stored
  // verbatim, that becomes a resume that seeks past the end of the file.
  const position = hasDuration
    ? Math.min(Math.max(beat.positionSec, 0), context.durationSec as number)
    : Math.max(beat.positionSec, 0);

  const maxPositionSec = Math.max(previous.maxPositionSec, position);

  return {
    lastPositionSec: position,
    maxPositionSec,
    secondsWatched: previous.secondsWatched + creditedSeconds(beat.deltaSec),
    viewCount: previous.viewCount + (context.isNewPlaySession ? 1 : 0),
    // Judged on the high-water mark, so rewinding to rewatch a scene does not
    // un-finish a video. With no duration there is nothing to judge against, so
    // the existing answer stands rather than being reset to false.
    completed: hasDuration
      ? maxPositionSec >= (context.durationSec as number) * COMPLETION_FRACTION
      : previous.completed,
  };
}
