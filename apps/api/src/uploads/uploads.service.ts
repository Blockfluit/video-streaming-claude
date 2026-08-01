import { rm } from 'node:fs/promises';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { StorageService } from '../common/storage.service';
import { ReconcileService } from '../ingest/reconcile.service';
import { VIDEO_EXTENSIONS } from '../ingest/path-parser';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeFilename, splitUploadName } from './filename';

/**
 * Browser uploads, which **place files and nothing else**.
 *
 * An upload used to create the video row itself, and so had its own opinion
 * about which collection the result belonged to. That is the one thing it must
 * not have: the folder layout decides shape, and there is no reason for a file
 * to mean something different because it arrived through a browser rather than
 * being copied onto a disk. So this writes the bytes into the shape the
 * convention expects and stops. Reconcile creates the rows, applies the
 * proposal, and is idempotent on `storageKey` — which is exactly what it was
 * built for.
 *
 * The layout it writes:
 *
 *   one file            → `<drive>/<name without extension>/<file>`
 *   a folder of files   → `<drive>/<folder>/…`, as given
 *
 * A single file gets a folder of its own because a bare file in a drive root is
 * a triage issue, and a folder holding one video is a standalone video. Upload
 * therefore never produces something an admin has to place by hand.
 *
 * Staging still happens in a dot-directory both the scanner and the watcher
 * skip, so a partial or abandoned transfer is never a candidate for ingestion.
 * The move into place crosses filesystems now — each drive is its own disk — and
 * `StorageService.move` copies to a dot-prefixed neighbour and renames when it
 * has to, so the file still appears under its final name only once complete.
 */

/**
 * The extension decides, and it decides alone.
 *
 * There used to be a second gate here: an allow-list of MIME types, ANDed with
 * this one. Its own comment said browsers are inconsistent about container
 * types — and it was right, which is exactly why gating on it was wrong. The
 * type attached to a `<input type=file>` comes from the operating system's
 * registry, not from the file: Windows reports `.mkv` as `video/x-matroska`,
 * or `video/mkv`, or nothing at all, depending on what has claimed the
 * extension. A real MKV was refused with "Unsupported video type" for no reason
 * a person could act on.
 *
 * The extension is what the library keys everything else off, and ffprobe is
 * the only thing that can actually say whether a file is playable — it runs on
 * the next pass and records `probeError` if not. A mislabelled upload becomes a
 * draft with a diagnosis, which is far better than a 400 the uploader cannot
 * explain.
 */
const ALLOWED_EXTENSIONS = new Set<string>(VIDEO_EXTENSIONS);

export const UPLOAD_STAGING_DIRECTORY = '.uploads';

export interface UploadedVideoFile {
  /** Where multer put it — inside the staging directory. */
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
  /**
   * `webkitRelativePath` for a directory upload, sent as its own field.
   *
   * multer strips both slash and backslash from `originalname`, so the shape of
   * an uploaded folder cannot survive in the filename — it has to travel beside
   * it or be lost.
   */
  relativePath?: string;
}

export interface PlacedFile {
  storageKey: string;
  originalName: string;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly reconcile: ReconcileService,
  ) {}

  /** True when the extension is one the library ingests. Called by the multer filter. */
  static isAcceptable(originalName: string): boolean {
    const { extension } = splitUploadName(sanitizeFilename(originalName));

    return ALLOWED_EXTENSIONS.has(extension);
  }

  /** The drives an upload may target: the top-level folders of MEDIA_ROOT. */
  async listDrives(): Promise<{ name: string }[]> {
    return (await this.storage.listDirectories('media', '')).map((name) => ({ name }));
  }

  async placeUpload(
    files: UploadedVideoFile[],
    input: { drive: string },
    uploadedById: string,
  ): Promise<{ placed: PlacedFile[] }> {
    try {
      return await this.place(files, input, uploadedById);
    } finally {
      // Whatever happened, nothing stays in staging. On success these have
      // already been moved away and this is a no-op.
      await Promise.all(files.map((file) => rm(file.path, { force: true })));
    }
  }

  private async place(
    files: UploadedVideoFile[],
    input: { drive: string },
    uploadedById: string,
  ): Promise<{ placed: PlacedFile[] }> {
    if (files.length === 0) throw new BadRequestException('No files were uploaded');

    const drive = await this.requireDrive(input.drive);
    const placed: PlacedFile[] = [];

    for (const file of files) {
      const relative = this.targetPath(file);
      const { basename, extension } = splitUploadName(relative.slice(relative.lastIndexOf('/') + 1));

      if (!ALLOWED_EXTENSIONS.has(extension)) {
        throw new BadRequestException(`Unsupported video type: .${extension || 'none'}`);
      }

      const folderKey = `${drive}/${relative.slice(0, relative.lastIndexOf('/'))}`;
      const storageKey = await this.freeStorageKey(folderKey, basename, extension);

      await this.storage.ensureDirectory('media', folderKey);
      await this.storage.move('media', this.storage.toKey('media', file.path), storageKey);

      placed.push({ storageKey, originalName: file.originalname });
    }

    /**
     * The rows come from the scan, not from here.
     *
     * Awaited so the caller is told what the upload became rather than being
     * left to poll for it, and because the proposal for a folder can only be
     * made once every file in it is on disk.
     */
    await this.reconcile.run();

    /**
     * Attribution, applied after the fact.
     *
     * Reconcile creates every row the same way, so without this an upload would
     * be indistinguishable from a file someone copied onto the disk — the
     * uploader's name lost and the origin reading INGEST. Matched on
     * `storageKey`, which is what the whole pipeline is keyed on anyway.
     */
    await this.prisma.video.updateMany({
      where: { storageKey: { in: placed.map((file) => file.storageKey) } },
      data: { origin: 'UPLOAD', uploadedById },
    });

    this.logger.log(`Placed ${placed.length} file(s) on ${drive}`);

    return { placed };
  }

  /**
   * Where a file goes inside its drive, as a relative path with at least one
   * folder in it.
   *
   * Every segment is sanitised, not just the filename: a directory upload
   * carries a client-supplied path, and `..` or a leading dot in the middle of
   * it would either escape the drive or create a folder the scanner skips
   * forever.
   */
  private targetPath(file: UploadedVideoFile): string {
    const name = sanitizeFilename(file.originalname);

    if (!file.relativePath) {
      // A file of its own gets a folder named after it, which is what makes it
      // a standalone video rather than a loose file in a drive root.
      const { basename } = splitUploadName(name);
      return `${basename}/${name}`;
    }

    const segments = file.relativePath
      .split('/')
      .map((segment) => sanitizeFilename(segment.trim()))
      .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');

    if (segments.length < 2) {
      // A folder upload whose path collapsed to a bare filename is still a file
      // that needs a folder around it.
      const { basename } = splitUploadName(name);
      return `${basename}/${name}`;
    }

    return segments.join('/');
  }

  /**
   * The drive an upload targets: a directory directly under MEDIA_ROOT.
   *
   * Checked rather than trusted — the name arrives in a request body, and
   * `StorageService` is the only thing that joins paths. A drive that is a
   * symlink to another disk is the normal case in production and passes here,
   * because the containment check is lexical.
   */
  private async requireDrive(name: string): Promise<string> {
    const drive = sanitizeFilename(name.trim());

    if (drive.length === 0 || drive.startsWith('.') || drive.includes('/')) {
      throw new BadRequestException('Choose a drive to upload to');
    }

    const drives = await this.storage.listDirectories('media', '');
    if (!drives.includes(drive)) throw new NotFoundException('No such drive');

    return drive;
  }

  /**
   * A free path in the target folder.
   *
   * Checks the filesystem as well as the database: a file can be on disk
   * without a row yet — dropped in seconds ago and not scanned — and
   * overwriting it would destroy something nobody asked to replace. The folder
   * itself is deliberately *not* made unique: uploading `Avatar/` when the drive
   * already has one adds to it, which is how a second season arrives.
   */
  private async freeStorageKey(
    folderKey: string,
    basename: string,
    extension: string,
  ): Promise<string> {
    for (let suffix = 0; ; suffix += 1) {
      const candidate = `${folderKey}/${suffix === 0 ? basename : `${basename}-${suffix + 1}`}.${extension}`;

      const taken =
        (await this.storage.exists('media', candidate)) ||
        (await this.prisma.video.findUnique({
          where: { storageKey: candidate },
          select: { id: true },
        })) !== null;

      if (!taken) return candidate;
    }
  }
}
