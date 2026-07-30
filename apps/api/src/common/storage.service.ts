import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
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
    const from = this.resolvePath(root, fromKey);
    const to = this.resolvePath(root, toKey);

    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }

  /** Deletes a file or directory. Already-gone is success, not an error. */
  async delete(root: StorageRoot, key: string): Promise<void> {
    await rm(this.resolvePath(root, key), { recursive: true, force: true });
  }
}
