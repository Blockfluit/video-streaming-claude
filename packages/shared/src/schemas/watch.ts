import { z } from 'zod';

import { pageQuerySchema } from '../pagination';
import { booleanParam, idSchema } from '../primitives';

/**
 * Watch tracking — what the player reports and what the library reads back.
 */

/**
 * One heartbeat from a playing video.
 *
 * `deltaSec` is watched time since the last beat, not wall-clock: the player
 * accumulates it from `timeupdate` and discards jumps over 2s, so scrubbing
 * through a film does not report the film as watched. The server caps it
 * anyway — see `MAX_BEAT_SECONDS`.
 *
 * There is no upper bound on the two numbers here beyond "a number at all".
 * `positionSec` is clamped to the duration and `deltaSec` to the per-beat cap,
 * both server-side, because a bound that rejects would lose the viewer's
 * position along with the bad figure. zod already refuses `NaN` and `Infinity`.
 */
export const heartbeatSchema = z.object({
  /** One uuid per page load, which is what makes a view countable. */
  playSessionId: z.uuid(),
  positionSec: z.coerce.number().min(0),
  deltaSec: z.coerce.number().min(0).default(0),
});
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;

export const listHistorySchema = pageQuerySchema.extend({
  /** Narrows to one show, which is what a collection page's "continue watching" needs. */
  collectionId: idSchema.optional(),
  /** Omit for everything; `false` is the continue-watching row. */
  completed: booleanParam.optional(),
});
export type ListHistoryQuery = z.infer<typeof listHistorySchema>;

/** The caller's own progress. Present for any role — it is their own data. */
export interface WatchProgressView {
  lastPositionSec: number;
  maxPositionSec: number;
  secondsWatched: number;
  viewCount: number;
  completed: boolean;
  lastWatchedAt: string;
}

/** Aggregate figures. Admin-only: a viewer sees their own progress, not everyone's. */
export interface WatchTotals {
  /** Distinct people who have ever started it. */
  viewers: number;
  /** Play sessions, so a rewatch counts again. */
  views: number;
  secondsWatched: number;
  completions: number;
  /**
   * Mean fraction of the runtime reached, 0–1. `null` when no duration is known
   * to divide by, which is different from nobody having watched it.
   */
  averageCompletion: number | null;
}
