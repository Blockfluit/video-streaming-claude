/**
 * Where to pick a video back up.
 *
 * One rule, in one place, because it now decides where playback **starts**
 * rather than only whether a button appears: the player seeks here on load, and
 * `/v/:slug` names the same second on the button that gets you there. Two copies
 * of it would mean a button reading "Resume from 12:34" that opens at 0:00,
 * which is the bug this whole change exists to remove.
 */

/** Under this is the credits, the wrong episode, or a stream opened and closed. */
const FLOOR_SEC = 5

/** Past this is a rewatch, and it belongs at the top rather than in the titles. */
const FINISHED_FRACTION = 0.95

/**
 * The second to resume at, or `null` when starting from the beginning is the
 * right answer.
 *
 * A duration that is missing, zero or not finite returns `null` rather than
 * resuming anyway. A failed probe writes `0`, and that is the same trap
 * `completed` has — the comparison against it is false for every position, so
 * the guard has to be explicit or the reason a video never resumes is invisible.
 * `el.duration` is `NaN` before metadata arrives and `Infinity` for a stream of
 * unknown length; neither is a length to place a position inside.
 */
export function resumePoint(
  positionSec: number | null | undefined,
  durationSec: number | null | undefined,
): number | null {
  if (!positionSec || !Number.isFinite(positionSec) || positionSec <= FLOOR_SEC) return null
  if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) return null

  return positionSec < durationSec * FINISHED_FRACTION ? positionSec : null
}
