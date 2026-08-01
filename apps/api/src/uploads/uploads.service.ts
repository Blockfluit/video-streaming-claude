import { rm, stat } from 'node:fs/promises';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { slugify, uniqueSlug } from '../common/slug';
import { StorageService } from '../common/storage.service';
import { titleData } from '../common/title';
import { computeContentTag } from '../ingest/content-tag';
import { VIDEO_EXTENSIONS, parseOrderAndTitle } from '../ingest/path-parser';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeFilename, splitUploadName } from './filename';

/**
 * Browser uploads, landing in the same media tree the watcher scans.
 *
 * The interesting part is that this writes into a **watched** directory, so it
 * has to cooperate with ingest rather than race it:
 *
 * - multer streams to `MEDIA_ROOT/.uploads/`, a dot-directory both the ingest
 *   scanner and the watcher skip. A partial or abandoned upload is therefore
 *   never seen, and cannot be ingested as a truncated file.
 * - The finished file is **renamed** into its collection folder. Rename is
 *   atomic within a filesystem, and staging inside `MEDIA_ROOT` rather than
 *   under `DERIVED_ROOT` keeps it on the same one — across two mounts a rename
 *   fails with `EXDEV`.
 * - The row is created here, keyed on the same `storageKey` reconcile would
 *   use, so the scan that follows finds the file already known. That is what
 *   the plan means by uploads not double-creating.
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
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly media: MediaService,
  ) {}

  /** True when the extension and mime type are both acceptable. Called by the multer filter. */
  static isAcceptable(originalName: string): boolean {
    const { extension } = splitUploadName(sanitizeFilename(originalName));

    return ALLOWED_EXTENSIONS.has(extension);
  }

  async ingestUpload(
    file: UploadedVideoFile,
    input: { collectionId: string; seasonId?: string | null; title?: string },
    uploadedById: string,
  ) {
    try {
      return await this.place(file, input, uploadedById);
    } finally {
      // Whatever happened, the staged file does not stay. On success it has
      // already been renamed away and this is a no-op.
      await rm(file.path, { force: true });
    }
  }

  private async place(
    file: UploadedVideoFile,
    input: { collectionId: string; seasonId?: string | null; title?: string },
    uploadedById: string,
  ) {
    const collection = await this.prisma.collection.findUnique({
      where: { id: input.collectionId },
      select: { id: true, folderKey: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    let folderKey = collection.folderKey;
    let seasonId: string | null = null;

    if (input.seasonId) {
      const season = await this.prisma.season.findUnique({
        where: { id: input.seasonId },
        select: { id: true, collectionId: true, folderKey: true },
      });
      if (!season) throw new NotFoundException('No such season');
      // Otherwise the file would land under a show it is not part of.
      if (season.collectionId !== collection.id) {
        throw new BadRequestException('That season belongs to a different collection');
      }
      folderKey = season.folderKey;
      seasonId = season.id;
    }

    const filename = sanitizeFilename(input.title ? `${input.title}.${splitUploadName(sanitizeFilename(file.originalname)).extension}` : file.originalname);
    const { basename, extension } = splitUploadName(filename);

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new BadRequestException(`Unsupported video type: .${extension || 'none'}`);
    }

    const storageKey = await this.freeStorageKey(folderKey, basename, extension);

    await this.storage.ensureDirectory('media', folderKey);
    await this.storage.move('media', this.storage.toKey('media', file.path), storageKey);

    const stats = await stat(this.storage.resolvePath('media', storageKey));
    const contentTag = await computeContentTag(
      this.storage.resolvePath('media', storageKey),
      stats.size,
    );

    const parsed = parseOrderAndTitle(basename);
    const slug = await this.freeSlug(collection.id, slugify(input.title ?? parsed.title));

    const video = await this.prisma.video.create({
      data: {
        collectionId: collection.id,
        seasonId,
        slug,
        ...titleData(input.title ?? parsed.title),
        orderIndex: parsed.orderIndex,
        // The same key reconcile derives from the path, so the next scan
        // recognises this file rather than creating it again.
        storageKey,
        contentTag,
        // Kept as metadata, which is all it ever was.
        originalName: file.originalname,
        mimeType: file.mimetype || 'application/octet-stream',
        sizeBytes: BigInt(stats.size),
        fileMtime: stats.mtime,
        state: 'DRAFT',
        origin: 'UPLOAD',
        uploadedById,
      },
    });

    // Probing fills in duration, dimensions and the conversion verdict.
    this.media.enqueue(video.id);

    return video;
  }

  /**
   * A free path in the target folder.
   *
   * Checks the filesystem as well as the database: a file can be on disk
   * without a row yet — dropped in seconds ago and not scanned — and
   * overwriting it would destroy something nobody asked to replace.
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

  private async freeSlug(collectionId: string, base: string): Promise<string> {
    const taken = await this.prisma.video.findMany({
      where: { collectionId },
      select: { slug: true },
    });

    return uniqueSlug(
      base,
      taken.map((row) => row.slug),
    );
  }
}
