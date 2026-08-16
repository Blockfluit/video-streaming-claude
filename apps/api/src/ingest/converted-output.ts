import type { ScanResult } from './media-scanner';

/**
 * Hiding the library's own converted files from the scan that reads the library.
 *
 * A converted MP4 lives beside its source inside `MEDIA_ROOT` — the one piece
 * of generated output that does. Nothing about its *name* says so, and nothing
 * should: a rule that skipped `Heat.mp4` because `Heat.mkv` sits next to it
 * would silently swallow a real second file an admin dropped there, forever and
 * with no issue raised. Silent non-ingestion is the failure this codebase has
 * already been bitten by once.
 *
 * So the filter is on **stored keys only** — a path is skipped when some row
 * claims it as its `playbackKey`, or when a job currently writing one is going
 * to. That is sound only because of its partner invariant, in
 * `transcode/jobs.service.ts`:
 *
 *   the column is written **before** the file appears at that path.
 *
 * Reconcile therefore reads the rows *after* it has scanned, and cannot miss a
 * file the scan saw. Reverse either half and the library grows a duplicate row
 * for every conversion.
 */
export function withoutConvertedOutput(
  scan: ScanResult,
  playbackKeys: Iterable<string | null>,
): ScanResult {
  const generated = new Set<string>();
  for (const key of playbackKeys) {
    if (key !== null && key !== '') generated.add(key);
  }

  if (generated.size === 0) return scan;

  return {
    ...scan,
    videos: scan.videos.filter((file) => !generated.has(file.relPath)),
    /**
     * `issues` as well as `videos`, which is not belt and braces.
     *
     * A file's bucket is decided by where it sits, not by what it is: a source
     * loose in a drive root parses as a structural issue rather than a video,
     * and so does the converted file written beside it. Filtering only `videos`
     * would leave that one raising a fresh "loose in a drive root" complaint on
     * every scan, about a file the admin did not put there.
     */
    issues: scan.issues.filter((file) => !generated.has(file.relPath)),
  };
}
