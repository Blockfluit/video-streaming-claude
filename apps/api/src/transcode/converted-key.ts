import type { StorageRoot } from '../common/storage.service';

/**
 * Where a converted file goes, given the source it was made from.
 *
 * Pure, and tested before anything called it, because two of the answers are
 * destructive if they are wrong: returning the source key would have ffmpeg
 * truncate the archive copy the instant it opened the output, and returning a
 * name another row already owns would have two videos share one file.
 *
 * The converted file lives **beside its source, inside `MEDIA_ROOT`** — the one
 * piece of generated output that does. That is deliberate: a transcode is hours
 * of CPU rather than something regenerated on demand, and for a video whose
 * source has been reclaimed it is the only copy, so it belongs on the archival
 * disk next to everything else worth keeping.
 *
 * What stops the ingest watcher feeding on it is not where it is but the
 * column: reconcile drops from its scan any path that is some row's
 * `playbackKey`. See `ingest/converted-output.ts`.
 */

/** Only `/` separates segments — a backslash is a legal Linux filename character. */
function split(storageKey: string): { directory: string; stem: string; extension: string } {
  const slash = storageKey.lastIndexOf('/');
  const directory = slash === -1 ? '' : storageKey.slice(0, slash);
  const filename = storageKey.slice(slash + 1);

  const dot = filename.lastIndexOf('.');
  // A leading dot is a hidden file rather than an extension, so `dot > 0`.
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';

  return { directory, stem, extension };
}

function join(directory: string, filename: string): string {
  return directory === '' ? filename : `${directory}/${filename}`;
}

/**
 * The base name a converted file takes, before any collision suffix.
 *
 * An `.mp4` source is the case that matters. The obvious answer — same folder,
 * same stem, `.mp4` — *is* the source, and ffmpeg opens its output for writing
 * before it reads anything, so the film would be gone before the encode began.
 * `.converted` is an ugly name and the correct price for that not happening.
 */
function baseFor(storageKey: string): { directory: string; base: string } {
  const { directory, stem, extension } = split(storageKey);
  return { directory, base: extension === 'mp4' ? `${stem}.converted` : stem };
}

/** Where the converted file goes when nothing is in the way. */
export function convertedKeyFor(storageKey: string): string {
  return convertedKeyVariant(storageKey, 0);
}

/**
 * The `index`th candidate name, for the caller's free-name loop.
 *
 * Numbered from two, matching the convention uploads already use when a name in
 * the target folder is taken.
 */
export function convertedKeyVariant(storageKey: string, index: number): string {
  const { directory, base } = baseFor(storageKey);
  const suffix = index === 0 ? '' : `-${index + 1}`;

  return join(directory, `${base}${suffix}.mp4`);
}

/**
 * Where the encode writes until it has finished.
 *
 * Two properties, and the change does not work without either. It is
 * **dot-prefixed**, so both the scanner and the watcher pass over it — the file
 * is being written inside the watched tree, and a half-written encode that
 * ingest could see would become a truncated video. And it is in the
 * **destination's own directory**, so the rename into place is within one
 * filesystem and therefore atomic and instant; staging under `derived/` would
 * make it a cross-root copy of the whole file.
 */
export function convertingTemporaryKey(storageKey: string, jobId: string): string {
  const { directory, stem } = split(storageKey);
  return join(directory, `.${stem}.converting-${jobId}.mp4`);
}

/** Exported so the `startsWith` in a Prisma filter is the same string as this one. */
export const LEGACY_CONVERTED_PREFIX = 'converted/';

/**
 * Which root a `playbackKey` is relative to.
 *
 * **Temporary.** Converted files used to live at `derived/converted/<id>.mp4`
 * and now live beside their source under `MEDIA_ROOT`, and the rows are moved
 * by `POST /admin/jobs/relocate-conversions` rather than by a migration —
 * files that cost hours of CPU cannot be abandoned the way regenerable artwork
 * was. Until that has run, both shapes exist, and treating a legacy key as a
 * media key would 404 every already-converted video.
 *
 * Once no rows are left under the old prefix this collapses to `'media'` and
 * goes away.
 */
export function playbackRoot(playbackKey: string): StorageRoot {
  return playbackKey.startsWith(LEGACY_CONVERTED_PREFIX) ? 'derived' : 'media';
}

/** Whether a row still points at the pre-relocation layout. */
export function isLegacyConvertedKey(playbackKey: string): boolean {
  return playbackKey.startsWith(LEGACY_CONVERTED_PREFIX);
}
