import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { BadRequestException, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { StoragePathError, resolveWithinRoot } from './storage-path';

/**
 * Every file the library owns, behind one interface over two roots.
 *
 * `MEDIA_ROOT` holds archival sources and is watched by the ingest watcher.
 * `DERIVED_ROOT` holds everything generated — thumbnails, posters, converted
 * MP4s and VTTs — and is deliberately **not** inside the media tree, because
 * generated output landing in a watched directory feeds the watcher its own
 * work forever.
 *
 * S3 can slot in behind this later; nothing outside should join paths itself.
 */

export type StorageRoot = 'media' | 'derived';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly roots: Record<StorageRoot, string>;

  constructor(config: ConfigService) {
    // Relative paths resolve from apps/api, matching how the .env is written.
    this.roots = {
      media: resolve(process.cwd(), config.get<string>('MEDIA_ROOT') ?? '../../media'),
      derived: resolve(process.cwd(), config.get<string>('DERIVED_ROOT') ?? '../../derived'),
    };
  }

  async onModuleInit(): Promise<void> {
    // Fail at boot rather than on the first upload.
    await mkdir(this.roots.media, { recursive: true });
    await mkdir(this.roots.derived, { recursive: true });

    // The invariant that stops the watcher feedback loop. Checked rather than
    // assumed, because it is configuration and configuration drifts.
    const derivedInsideMedia = !relative(this.roots.media, this.roots.derived).startsWith('..');
    if (derivedInsideMedia) {
      throw new Error(
        `DERIVED_ROOT (${this.roots.derived}) is inside MEDIA_ROOT (${this.roots.media}). ` +
          'Generated files would land in the watched tree and feed the ingest watcher its own output.',
      );
    }

    this.logger.log(`media: ${this.roots.media}`);
    this.logger.log(`derived: ${this.roots.derived}`);
  }

  rootPath(root: StorageRoot): string {
    return this.roots[root];
  }

  /**
   * Absolute path for a key, guaranteed to be inside its root.
   *
   * Translates the pure resolver's error into a 400: a bad key is a bad
   * request, and the message must not echo the resolved absolute path back to
   * the caller.
   */
  resolvePath(root: StorageRoot, key: string): string {
    try {
      return resolveWithinRoot(this.roots[root], key);
    } catch (cause) {
      if (cause instanceof StoragePathError) {
        throw new BadRequestException('Invalid storage key');
      }
      throw cause;
    }
  }

  /**
   * Like `resolvePath`, but `''` means the root directory itself.
   *
   * `resolveWithinRoot` rejects the root deliberately — a *storage key* is a
   * file or folder inside a root, never the root, and letting one resolve there
   * would make an empty key a way to address the whole tree. Listing is the one
   * operation that legitimately starts at the top, so it says so here rather
   * than by loosening the containment rule for everything.
   */
  private listingPath(root: StorageRoot, key: string): string {
    return key === '' ? this.roots[root] : this.resolvePath(root, key);
  }

  /** Relative key for an absolute path inside a root — the inverse of `resolvePath`. */
  toKey(root: StorageRoot, absolutePath: string): string {
    const key = relative(this.roots[root], absolutePath);
    // Re-check rather than trust the caller's path.
    this.resolvePath(root, key);
    return key;
  }

  async exists(root: StorageRoot, key: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(root, key));
      return true;
    } catch {
      return false;
    }
  }

  async statOf(root: StorageRoot, key: string): Promise<{ size: number; mtime: Date } | null> {
    try {
      const stats = await stat(this.resolvePath(root, key));
      return { size: stats.size, mtime: stats.mtime };
    } catch {
      return null;
    }
  }

  /**
   * The directory names directly inside `key`, sorted.
   *
   * A symlinked directory counts, because that is what a drive is: `readdir`
   * reports one as neither a file nor a directory, so the dirent alone would
   * hide every disk in production. Dotfiles are left out — they are staging and
   * housekeeping, never content.
   */
  async listDirectories(root: StorageRoot, key: string): Promise<string[]> {
    const path = this.listingPath(root, key);

    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return [];
    }

    const directories = await Promise.all(
      entries.map(async (entry) => {
        if (entry.name.startsWith('.')) return null;
        if (entry.isDirectory()) return entry.name;
        if (!entry.isSymbolicLink()) return null;

        try {
          return (await stat(join(path, entry.name))).isDirectory() ? entry.name : null;
        } catch {
          // A drive that is not mounted. It exists, but there is nothing behind
          // it to upload into.
          return null;
        }
      }),
    );

    return directories.filter((name): name is string => name !== null).sort();
  }

  /** The file names directly inside `key`, sorted. Dotfiles are never content. */
  async listFiles(root: StorageRoot, key: string): Promise<string[]> {
    const path = this.listingPath(root, key);

    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** Creates a directory (and its parents) at `key`. */
  async ensureDirectory(root: StorageRoot, key: string): Promise<string> {
    const path = this.resolvePath(root, key);
    await mkdir(path, { recursive: true });
    return path;
  }

  /**
   * Streams `data` to `key`, creating parent directories.
   *
   * Writes to a temporary neighbour and renames into place. The rename is
   * atomic within a filesystem, so a crash mid-write cannot leave a truncated
   * file that looks complete — which matters most in `media`, where the
   * watcher would happily ingest the wreckage.
   */
  async save(root: StorageRoot, key: string, data: Readable | Buffer): Promise<string> {
    const path = this.resolvePath(root, key);
    await mkdir(dirname(path), { recursive: true });

    const temporary = `${path}.incoming`;
    try {
      const source = Buffer.isBuffer(data) ? Readable.from(data) : data;
      await pipeline(source, createWriteStream(temporary));
      await rename(temporary, path);
    } catch (cause) {
      await rm(temporary, { force: true });
      throw cause;
    }

    return path;
  }

  /**
   * Renames within a root.
   *
   * The reason transcodes write to `tmp/` first: a rename is atomic inside a
   * filesystem, so a file appears under its final name only once it is
   * complete. A partial file under its final name would be served to viewers
   * and read by the next probe as though it were finished.
   */
  async move(root: StorageRoot, fromKey: string, toKey: string): Promise<void> {
    await this.relocate(this.resolvePath(root, fromKey), this.resolvePath(root, toKey));
  }

  /**
   * The same move, between the two roots.
   *
   * Its one caller relocates converted files out of `derived/converted/` and in
   * beside their sources. Almost always a copy rather than a rename in
   * practice: the roots are separate mounts in production, and `derived` is
   * scratch space while the drives under `MEDIA_ROOT` are the real disks.
   */
  async moveBetweenRoots(
    fromRoot: StorageRoot,
    fromKey: string,
    toRoot: StorageRoot,
    toKey: string,
  ): Promise<void> {
    await this.relocate(this.resolvePath(fromRoot, fromKey), this.resolvePath(toRoot, toKey));
  }

  private async relocate(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true });

    try {
      await rename(from, to);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    }

    /**
     * Two different filesystems, which is the normal case once each drive under
     * `MEDIA_ROOT` is a symlink to its own physical disk. `rename` cannot cross
     * that boundary, so the bytes have to be copied.
     *
     * Copied to a dot-prefixed neighbour first and renamed into place, never
     * written straight to `to`: a copy is not atomic, and a half-written file
     * under its final name is exactly what the scanner would ingest as a
     * truncated video. Both the scanner and the watcher skip dotfiles, so the
     * neighbour is invisible until the rename — which is within one filesystem,
     * and therefore atomic.
     */
    const staged = join(dirname(to), `.incoming-${basename(to)}`);

    try {
      await copyFile(from, staged);
      await rename(staged, to);
      await rm(from, { force: true });
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
  }

  /** Deletes a file or directory. Already-gone is success, not an error. */
  async delete(root: StorageRoot, key: string): Promise<void> {
    await rm(this.resolvePath(root, key), { recursive: true, force: true });
  }

  /**
   * Removes a directory only when there is nothing in it.
   *
   * The distinction matters: `delete` on a season folder takes the films inside
   * it with it. An empty directory holds nothing anyone can lose, but leaving
   * one behind is what makes a deleted season reappear on the next scan —
   * reconcile rebuilds rows from the tree, so an orphaned folder is a season
   * that comes back.
   *
   * Returns whether it went, so the caller can tell the difference between
   * "cleaned up" and "left alone because it still holds something".
   */
  async deleteIfEmpty(root: StorageRoot, key: string): Promise<boolean> {
    const path = this.resolvePath(root, key);

    try {
      // rmdir refuses a non-empty directory, which is the check and the action
      // in one syscall — no race between looking and removing.
      await rmdir(path);
      return true;
    } catch {
      // ENOTEMPTY, or it was never there. Either way nothing was removed and
      // nothing was lost.
      return false;
    }
  }
}
