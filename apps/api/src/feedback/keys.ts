/**
 * Where a feedback screenshot lives under DERIVED_ROOT.
 *
 * Deterministic from the id alone — mirrors `artworkKey()` deriving
 * poster/banner keys from a video id — so nothing needs to be stored beyond
 * the `hasScreenshot` boolean on the row.
 */
export function feedbackScreenshotKey(id: string): string {
  return `feedback/${id}.png`;
}
