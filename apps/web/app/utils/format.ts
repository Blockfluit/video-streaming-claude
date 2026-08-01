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

/**
 * Dates, with the locale **and the time zone** pinned.
 *
 * Both matter, and the time zone is the one that bites. Every page here renders
 * once in Nitro and again in the browser; `toLocaleDateString()` reads whatever
 * the ambient locale and `TZ` happen to be in each. Differ by an hour and an
 * evening timestamp lands on two different days, which is a hydration mismatch —
 * and Vue's answer to one is to discard the server-rendered subtree.
 *
 * UTC is the right zone for an audit surface. It costs an admin two hours ahead
 * a near-midnight event showing on the previous day, and buys that two admins in
 * two zones reading the same row describe the same thing.
 *
 * Hoisted to module scope because building an `Intl.DateTimeFormat` is the
 * expensive part of `Intl`, and these render once per table cell.
 *
 * `en-GB` gives `1 Aug 2026` rather than `8/1/2026` — on a screen whose whole
 * job is *when did this happen*, a format that reads as either the 1st of August
 * or the 8th of January is worse than useless. A small-ICU Node build carries
 * only `en-US` and would quietly resolve `en-GB` to it; the unit tests pin the
 * exact output string, so that fails in CI rather than in someone's browser.
 */
const SHORT_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})

/** `null` rather than `Invalid Date`, so a caller can `?? '—'`. */
function parse(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null

  const date = value instanceof Date ? value : new Date(value)

  return Number.isNaN(date.getTime()) ? null : date
}

/** A day, for a table cell: `1 Aug 2026`. */
export function shortDate(value: string | Date | null | undefined): string | null {
  const date = parse(value)

  return date === null ? null : SHORT_DATE.format(date)
}

/** A day and a 24-hour clock: `1 Aug 2026, 14:32`. */
export function dateTime(value: string | Date | null | undefined): string | null {
  const date = parse(value)

  return date === null ? null : DATE_TIME.format(date)
}
