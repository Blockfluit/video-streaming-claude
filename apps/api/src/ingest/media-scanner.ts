import { readdir, readlink, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { parseMediaPath, type MediaPath } from './path-parser';

/**
 * Walks `MEDIA_ROOT` and classifies everything it finds, using the pure parser
 * from step 6. Nothing here touches the database.
 */

export interface ScannedFile {
  /** Relative to the root, always `/`-separated so it matches a `storageKey`. */
  relPath: string;
  size: number;
  mtime: Date;
  parsed: MediaPath;
}

export interface ScanResult {
  videos: ScannedFile[];
  subtitles: ScannedFile[];
  /** Structural problems — a file at the root, or nested too deep. */
  issues: ScannedFile[];
  /** Directories that could not be read at all. */
  unreadable: { relPath: string; reason: string }[];
}

/** Directories never worth descending into. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '@eaDir', '.Trash', '$RECYCLE.BIN']);

export async function scanMediaRoot(root: string): Promise<ScanResult> {
  const result: ScanResult = { videos: [], subtitles: [], issues: [], unreadable: [] };

  await walk(root, root, result, 0);

  return result;
}

/**
 * Depth is bounded rather than trusted: a symlink loop inside the media tree
 * would otherwise recurse until the process dies. The convention only goes
 * four levels deep (drive/item/season/file), so anything past that is already
 * an issue.
 */
const MAX_WALK_DEPTH = 7;

async function walk(root: string, directory: string, result: ScanResult, depth: number): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    result.unreadable.push({
      relPath: toRelPath(root, directory),
      reason: (error as NodeJS.ErrnoException).code ?? 'unreadable',
    });
    return;
  }

  for (const entry of entries) {
    const absolute = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
      await walk(root, absolute, result, depth + 1);
      continue;
    }

    /**
     * A drive is allowed to be a symlink, and only a drive.
     *
     * In production every folder directly under MEDIA_ROOT is a link to a
     * different physical disk. `readdir` reports a symlinked directory as
     * neither `isDirectory()` nor `isFile()`, so without this the walk skips
     * the entire disk and returns an empty scan — which reads as an empty
     * library rather than as a failure.
     *
     * Depth 0 only. Deeper links are the ones that point somewhere unexpected,
     * and a link back up its own tree is how a walk that follows everything
     * spins until the process dies. `MAX_WALK_DEPTH` still bounds this one.
     */
    if (depth === 0 && entry.isSymbolicLink() && !entry.name.startsWith('.')) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;

      let target;
      try {
        // Follows the link, unlike the dirent above.
        target = await stat(absolute);
      } catch (error) {
        // A drive that is not mounted. Worth reporting, not worth crashing over.
        result.unreadable.push({
          relPath: toRelPath(root, absolute),
          reason: await describeBrokenDrive(absolute, error),
        });
        continue;
      }

      if (target.isDirectory()) {
        await walk(root, absolute, result, depth + 1);
        continue;
      }
    }

    // Any other symlink is left alone. A link pointing outside the media tree
    // would put a file in the library that the storage guard would then refuse
    // to serve, which is a confusing way to fail.
    if (!entry.isFile()) continue;

    const relPath = toRelPath(root, absolute);
    const parsed = parseMediaPath(relPath);

    if (parsed.kind === 'ignored') continue;

    let stats;
    try {
      stats = await stat(absolute);
    } catch (error) {
      result.unreadable.push({
        relPath,
        reason: (error as NodeJS.ErrnoException).code ?? 'unreadable',
      });
      continue;
    }

    const file: ScannedFile = { relPath, size: stats.size, mtime: stats.mtime, parsed };

    if (parsed.kind === 'video') result.videos.push(file);
    else if (parsed.kind === 'subtitle') result.subtitles.push(file);
    else result.issues.push(file);
  }
}

/**
 * Why a drive symlink could not be followed, in a sentence an admin can act on.
 *
 * The bare errno is true and useless: `ENOENT` on a drive that is plainly there
 * on the host reads as a bug in the library. It usually means the link's target
 * is not reachable from where the API is running — under Docker, a link naming
 * `/mnt/hdd1/videos` needs that path mounted into the container, because the
 * kernel resolves symlinks in the container's own mount namespace. Naming the
 * target is the difference between a diagnosis and a code.
 *
 * This prints an absolute server path on purpose. The rule about reducing those
 * to filenames is about ffmpeg output, where the path is incidental to the
 * error; here it *is* the error, and the ingest list is ADMIN-only.
 */
async function describeBrokenDrive(absolute: string, error: unknown): Promise<string> {
  const code = (error as NodeJS.ErrnoException).code ?? 'unreadable';

  try {
    return `${code}: links to ${await readlink(absolute)}, which is not there`;
  } catch {
    // Not a link after all, or unreadable itself. The code alone still beats nothing.
    return code;
  }
}

/** `path.relative` gives platform separators; storage keys are always `/`. */
function toRelPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}
