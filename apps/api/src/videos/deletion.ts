/**
 * Which files a deleted video takes with it.
 *
 * Pure, and separated from the service, because the list has to be built from
 * the row *before* `video.delete` runs: every key lives either on the row or on
 * a `Subtitle` row, and both vanish with the cascade. Once the delete has
 * happened there is nothing left to say what to clean up.
 *
 * The three lists are governed differently and that is the whole point.
 * Everything under `DERIVED_ROOT` is regenerable output of a row that no longer
 * exists, so it always goes — nothing sweeps it otherwise and it would sit
 * there forever. The source under `MEDIA_ROOT` is the archival copy and only
 * goes when asked, because reconcile can rebuild a row from it and the default
 * has to be the recoverable mistake. The converted file is in `MEDIA_ROOT` too
 * but is not archival, and has a reason of its own to go unconditionally —
 * see `playbackKeysToDelete`.
 *
 * The one exception is a *reclaimed* video, whose converted file is its only
 * remaining copy. That is not this module's decision — `VideosService` refuses
 * the recoverable delete outright in that case rather than quietly reclassifying
 * an archive as derived output.
 */

interface DerivedSource {
  id: string;
  posterKey: string | null;
  bannerKey: string | null;
  playbackKey: string | null;
  subtitles: { storageKey: string }[];
}

interface MediaSource {
  storageKey: string;
  sourceDeletedAt: Date | null;
  subtitles: { sourceKey: string | null }[];
}

/** Keys under `DERIVED_ROOT`, in the order they should be removed. */
export function derivedKeysToDelete(video: DerivedSource): string[] {
  return [
    video.posterKey,
    video.bannerKey,
    ...video.subtitles.map((subtitle) => subtitle.storageKey),
  ].filter((key): key is string => key !== null);
}

/**
 * The converted file — generated output that lives in `MEDIA_ROOT`.
 *
 * Its own list because it obeys neither of the rules above. It is not derived
 * output any more, since it sits beside its source on the archival disk; and it
 * is not the archival copy either, so it does **not** wait for `deleteFiles`.
 *
 * It always goes, and that is load-bearing rather than tidy. Ingest skips a
 * converted file only because some row claims it as `playbackKey`; delete the
 * row and leave the file, and the next scan finds an unclaimed `.mp4` in a
 * watched folder and builds a brand-new video from it — the entry the admin
 * just removed, back under a different id with none of its history.
 *
 * The one case where the converted file is the last copy — a reclaimed source —
 * is not this module's decision: `VideosService` refuses the recoverable delete
 * outright rather than quietly reclassifying an archive as output.
 */
export function playbackKeysToDelete(video: { playbackKey: string | null }): string[] {
  return video.playbackKey === null ? [] : [video.playbackKey];
}

/**
 * The directory both subtitle writers share, removed after its contents.
 *
 * After rather than instead: a track written under some earlier layout would
 * otherwise survive a delete that looked like it had swept everything.
 */
export function subtitleDirectoryKey(videoId: string): string {
  return `subtitles/${videoId}`;
}

/**
 * Keys under `MEDIA_ROOT` — only ever used when the caller asked for the files.
 *
 * The sidecars matter as much as the video. Leaving a `.srt` beside a video
 * that no longer exists is how the next scan raises an orphaned-subtitle issue
 * for something nobody can look at.
 */
export function mediaKeysToDelete(video: MediaSource): string[] {
  return [
    // A reclaimed source is already gone; asking for it again would make the
    // count of what is about to be destroyed untrue.
    ...(video.sourceDeletedAt === null ? [video.storageKey] : []),
    ...video.subtitles.map((subtitle) => subtitle.sourceKey),
  ].filter((key): key is string => key !== null);
}
