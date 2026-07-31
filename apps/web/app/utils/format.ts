/**
 * The small formatting decisions, in one place so the player, the cards and the
 * comment list cannot disagree about what `2:14` means.
 */

/**
 * Seconds as a playback timestamp: `2:14`, and `1:02:14` once it runs to an
 * hour. The hours field is omitted rather than shown as `0:02:14`, which is
 * what a `<video>` element does and what a comment pin has to match.
 */
export function timecode(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
    return '0:00'
  }

  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60

  const padded = (value: number) => value.toString().padStart(2, '0')

  return hours > 0 ? `${hours}:${padded(minutes)}:${padded(rest)}` : `${minutes}:${padded(rest)}`
}

/**
 * A runtime, for a card: `1h 47m`, `12m`, or `45s` under a minute.
 *
 * The seconds case is not hypothetical — a trailer, a clip, or a test file
 * rounds to `0m`, which reads as "we failed to probe this" rather than "this is
 * short".
 */
export function runtime(totalSeconds: number | null | undefined): string | null {
  if (totalSeconds === null || totalSeconds === undefined || totalSeconds <= 0) return null

  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`

  const minutes = Math.round(totalSeconds / 60)
  const hours = Math.floor(minutes / 60)

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/**
 * How far through a video someone is, 0–100.
 *
 * Clamped, because `lastPositionSec` can sit a hair past a duration the
 * container under-reports, and a progress bar rendered at 100.3% overflows its
 * track.
 */
export function progressPercent(
  positionSec: number | null | undefined,
  durationSec: number | null | undefined,
): number {
  if (!positionSec || !durationSec || durationSec <= 0) return 0

  return Math.min(100, Math.max(0, (positionSec / durationSec) * 100))
}
