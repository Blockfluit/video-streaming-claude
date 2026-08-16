import { createReadStream } from 'node:fs';

import {
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { whereVisible } from '../common/publishing';
import { StorageService, type StorageRoot } from '../common/storage.service';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { playbackRoot } from '../transcode/converted-key';
import { parseRangeHeader } from './range';

/**
 * Byte-range streaming — the thing the whole app exists to do.
 *
 * Deliberately **not** `StreamableFile`: it answers `200` with the whole body
 * and ignores `Range`, and a browser that cannot get a `206` cannot seek. The
 * scrubber does nothing and the duration never appears.
 */
@Injectable()
export class StreamingService {
  private readonly logger = new Logger(StreamingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async stream(id: string, role: Role, request: Request, response: Response): Promise<void> {
    const video = await this.load(id, role);
    const { root, key } = this.pickFile(video);

    const stats = await this.storage.statOf(root, key);
    if (!stats) {
      // The row says the file is there and it is not. Reconcile will mark this
      // MISSING on its next pass; until then, say so rather than 500.
      this.logger.warn(`Video ${id} points at a file that is gone: ${root}:${key}`);
      throw new NotFoundException('The file for this video is not on disk');
    }

    const size = stats.size;

    // Always, whatever the outcome — `Accept-Ranges` is how the client learns
    // it may seek at all.
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', video.playbackMime ?? video.mimeType);
    // Private media behind a session cookie: no shared cache should keep it,
    // and a range response cached as if it were the whole file corrupts playback.
    response.setHeader('Cache-Control', 'private, no-store');

    const path = this.storage.resolvePath(root, key);
    const range = parseRangeHeader(request.headers.range, size);

    if (range.kind === 'unsatisfiable') {
      // The `*` tells the client the size it should have asked within.
      response.setHeader('Content-Range', `bytes */${size}`);
      response.status(416).end();
      return;
    }

    if (range.kind === 'none') {
      response.setHeader('Content-Length', String(size));
      response.status(200);
      this.pipe(createReadStream(path), response);
      return;
    }

    response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    // Inclusive of both ends: an off-by-one truncates every response by a byte.
    response.setHeader('Content-Length', String(range.end - range.start + 1));
    response.status(206);
    this.pipe(createReadStream(path, { start: range.start, end: range.end }), response);
  }

  /**
   * Seeking aborts requests constantly — every scrub kills the in-flight
   * response — so the read stream has to be destroyed with it or the process
   * leaks a file descriptor per seek.
   */
  private pipe(stream: ReturnType<typeof createReadStream>, response: Response): void {
    response.on('close', () => stream.destroy());

    stream.on('error', (error) => {
      this.logger.warn(`Stream failed: ${error.message}`);
      // Headers are already sent by this point, so there is no status left to
      // set — destroying the socket is the only honest signal.
      response.destroy();
    });

    stream.pipe(response);
  }

  private async load(id: string, role: Role) {
    const video = await this.prisma.video.findFirst({
      // Visibility first: a USER must not be able to stream a draft, and the
      // filter is the same one the rest of the API uses.
      where: { id, ...whereVisible(role) },
      select: {
        id: true,
        state: true,
        storageKey: true,
        playbackKey: true,
        mimeType: true,
        playbackMime: true,
        sourceDeletedAt: true,
      },
    });

    // 404 rather than the plan's 403: a USER already gets 404 for a hidden
    // video everywhere else in the API, and 403 would confirm the id exists.
    if (!video) throw new NotFoundException('No such video');

    if (video.state === 'MISSING') {
      // Gone, not absent — the row is real and the file is expected back.
      throw new GoneException('The file for this video is missing');
    }

    if (video.state === 'ARCHIVED' && role !== 'ADMIN') {
      throw new ForbiddenException('This video is archived');
    }

    return video;
  }

  /**
   * The converted MP4 when there is one, the original otherwise.
   *
   * This is what lets the same URL keep working before and after conversion,
   * and why reclaiming a source (`sourceDeletedAt`) does not break playback.
   *
   * Both roots are `media` once an install has been relocated — the converted
   * file lives beside its source. `playbackRoot` is what keeps a row still
   * pointing at the old `derived/converted/` layout playable in the meantime.
   */
  private pickFile(video: { storageKey: string; playbackKey: string | null }): {
    root: StorageRoot;
    key: string;
  } {
    return video.playbackKey
      ? { root: playbackRoot(video.playbackKey), key: video.playbackKey }
      : { root: 'media', key: video.storageKey };
  }
}
