/**
 * Validating the four skip markers.
 *
 * The player watches `currentTime` against these: inside the intro range it
 * offers **Skip Intro** and seeks to `introEndSec`; inside the outro range it
 * offers **Skip Outro**, or **Next Episode** when there is one.
 *
 * Pure, because the rules have more corners than they look like they do — and
 * because a marker past the end of a video produces a button that seeks into
 * nothing, which is the sort of thing nobody tests by hand.
 */

export interface Markers {
  introStartSec: number | null;
  introEndSec: number | null;
  outroStartSec: number | null;
  outroEndSec: number | null;
}

export interface MarkerIssue {
  field: keyof Markers;
  message: string;
}

export function validateMarkers(markers: Markers, durationSec: number | null): MarkerIssue[] {
  const issues: MarkerIssue[] = [];

  for (const [field, value] of Object.entries(markers) as [keyof Markers, number | null][]) {
    if (value === null) continue;

    if (!Number.isFinite(value) || value < 0) {
      issues.push({ field, message: 'Must be a position in seconds, zero or greater.' });
      continue;
    }

    // Only checkable once the video has been probed. An unprobed video still
    // gets the ordering rules — refusing markers outright would mean a probe
    // failure also blocks curation.
    if (durationSec !== null && durationSec > 0 && value > durationSec) {
      issues.push({
        field,
        message: `Must be within the video, which is ${Math.round(durationSec)} seconds long.`,
      });
    }
  }

  /**
   * Ordering is checked only when **both** ends are set.
   *
   * Half a range is a legitimate intermediate state: the editor works by
   * scrubbing to a position and clicking "Set intro start", so a start exists
   * on its own until the end is set. The player ignores a range it cannot use.
   */
  check('intro', markers.introStartSec, markers.introEndSec, 'introEndSec');
  check('outro', markers.outroStartSec, markers.outroEndSec, 'outroEndSec');

  function check(
    name: string,
    start: number | null,
    end: number | null,
    endField: keyof Markers,
  ): void {
    if (start === null || end === null) return;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;

    // Strictly after: a zero-length range shows a button that seeks nowhere.
    if (end <= start) {
      issues.push({ field: endField, message: `The ${name} must end after it starts.` });
    }
  }

  return issues;
}
