import { readdir, stat } from 'node:fs/promises';
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
 * three levels deep, so anything past that is already an issue.
 */
const MAX_WALK_DEPTH = 6;

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

    // Symlinks are not followed. A link pointing outside the media tree would
    // put a file in the library that the storage guard would then refuse to
    // serve, which is a confusing way to fail.
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

/** `path.relative` gives platform separators; storage keys are always `/`. */
function toRelPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}
