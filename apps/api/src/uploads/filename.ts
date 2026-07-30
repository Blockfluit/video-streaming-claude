/**
 * Turning a client-supplied filename into something safe to put on disk.
 *
 * `originalName` arrives from a browser, which means it arrives from whoever is
 * using the browser, and it is about to become part of a path. It is metadata:
 * useful for naming the file, never trusted as a location.
 *
 * The storage layer would refuse a traversal anyway — that check is the last
 * line, not the only one — but a name that has to be rejected downstream is a
 * name that should never have been built.
 */

/** Comfortably inside ext4's 255-byte limit, with room for a `-2` deduplication suffix. */
const MAX_LENGTH = 200;

const FALLBACK = 'upload';

export function sanitizeFilename(original: string): string {
  // Both separators: a Windows client sends backslashes, and Linux treats those
  // as ordinary characters rather than separators — so splitting on `/` alone
  // would leave `C:\Users\me\film.mp4` intact as a single "name".
  const lastSegment = original.split(/[/\\]/).pop() ?? '';

  const cleaned = lastSegment
    // Control characters, including the NUL that truncates a path in a syscall.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // A leading dot would hide the file from the ingest scanner, which skips
    // dotfiles — the upload would simply never appear.
    .replace(/^\.+/, '');

  if (cleaned.length === 0) return FALLBACK;

  return truncate(cleaned);
}

/**
 * Shortens a name without losing its extension, since the extension is what
 * decides whether the library treats it as a video at all.
 */
function truncate(name: string): string {
  if (name.length <= MAX_LENGTH) return name;

  const { basename, extension } = splitUploadName(name);
  if (extension === '') return name.slice(0, MAX_LENGTH);

  return `${basename.slice(0, MAX_LENGTH - extension.length - 1)}.${extension}`;
}

/** Splits on the final dot. The extension comes back lowercased; the stem is untouched. */
export function splitUploadName(filename: string): { basename: string; extension: string } {
  const dot = filename.lastIndexOf('.');

  // `<= 0` rather than `=== -1`: a leading dot is not an extension marker.
  if (dot <= 0) return { basename: filename, extension: '' };

  return { basename: filename.slice(0, dot), extension: filename.slice(dot + 1).toLowerCase() };
}
