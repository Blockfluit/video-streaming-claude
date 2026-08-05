import type { Stats } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

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

  // Seeded with the root so a link pointing back at MEDIA_ROOT stops immediately.
  const visited = new Set<string>([await realPathOr(root)]);

  await walk(root, root, result, 0, visited);

  return result;
}

/**
 * Depth is bounded rather than trusted. `visited` below is what actually stops a
 * symlink loop; this is the backstop for the case it cannot see, and it doubles
 * as the structural limit — the convention only goes four levels deep
 * (drive/item/season/file), so anything past that is already an issue.
 */
const MAX_WALK_DEPTH = 7;

/**
 * Walks one directory.
 *
 * `visited` holds the resolved path of every directory already descended into,
 * and is what makes following symlinks safe. Without it a link pointing at its
 * own ancestor is an infinite tree, which was the reason only the drive level
 * was followed at first.
 */
async function walk(
  root: string,
  directory: string,
  result: ScanResult,
  depth: number,
  visited: Set<string>,
): Promise<void> {
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
      await descend(root, absolute, result, depth, visited);
      continue;
    }

    /**
     * A symlink, at any depth.
     *
     * In production every folder directly under MEDIA_ROOT is a link to a
     * different physical disk, and single titles get linked in from elsewhere
     * the same way. `readdir` reports a symlinked directory as neither
     * `isDirectory()` nor `isFile()`, so leaving these alone skips the entire
     * disk and returns an empty scan — which reads as an empty library rather
     * than as a failure.
     *
     * Following them at every depth is what keeps the scan and the watcher
     * agreeing: chokidar follows symlinks wherever it finds them, so a link the
     * scan passes over still fires events, and every one of them starts a
     * reconcile that finds nothing.
     */
    if (entry.isSymbolicLink()) {
      if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;

      let target;
      try {
        // Follows the link, unlike the dirent above.
        target = await stat(absolute);
      } catch (error) {
        // A disk that is not mounted, or a target since deleted. Reported
        // whatever it is named: somebody made this link on purpose, so a
        // dangling one is a fact rather than clutter.
        result.unreadable.push({
          relPath: toRelPath(root, absolute),
          reason: (error as NodeJS.ErrnoException).code ?? 'unreadable',
        });
        continue;
      }

      if (target.isDirectory()) {
        await descend(root, absolute, result, depth, visited);
      } else if (target.isFile()) {
        // `stat` already followed the link, so this is the target's size and
        // mtime — which is what the row should record.
        record(root, absolute, target, result);
      }

      continue;
    }

    if (!entry.isFile()) continue;

    const relPath = toRelPath(root, absolute);
    if (parseMediaPath(relPath).kind === 'ignored') continue;

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

    record(root, absolute, stats, result);
  }
}

/**
 * Descends into a directory, real or linked, unless it has been walked already.
 *
 * Two names for one disk is one library: scanning the target twice would put the
 * same physical file under two storage keys and reconcile would build a row for
 * each. The same check is what makes a link pointing at its own ancestor stop.
 */
async function descend(
  root: string,
  absolute: string,
  result: ScanResult,
  depth: number,
  visited: Set<string>,
): Promise<void> {
  const key = await realPathOr(absolute);

  if (visited.has(key)) return;
  visited.add(key);

  await walk(root, absolute, result, depth + 1, visited);
}

/** Classifies one file and files it under the right heading. */
function record(root: string, absolute: string, stats: Stats, result: ScanResult): void {
  const relPath = toRelPath(root, absolute);
  const parsed = parseMediaPath(relPath);

  if (parsed.kind === 'ignored') return;

  const file: ScannedFile = { relPath, size: stats.size, mtime: stats.mtime, parsed };

  if (parsed.kind === 'video') result.videos.push(file);
  else if (parsed.kind === 'subtitle') result.subtitles.push(file);
  else result.issues.push(file);
}

/**
 * The resolved path, or the lexical one when it cannot be resolved.
 *
 * A directory that vanishes mid-walk should not take the scan with it, and the
 * lexical path is still a usable key — two links to a target that no longer
 * exists are not going to be walked either way.
 */
async function realPathOr(directory: string): Promise<string> {
  return realpath(directory).catch(() => resolve(directory));
}

/** `path.relative` gives platform separators; storage keys are always `/`. */
function toRelPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}
