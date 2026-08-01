import { createReadStream } from 'node:fs';
import { extname } from 'node:path';

import { Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';

import { whereVisible } from './publishing';
import { StorageService } from './storage.service';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Serving the artwork: video thumbnails and collection posters.
 *
 * Every card in the app needs one of these, so it is the read side of what
 * step 10 only ever wrote. Kept apart from `StreamingService` because the
 * rules are genuinely different — an image is small, complete, and worth
 * caching, where a range response must never be cached at all.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

@Injectable()
export class ImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async videoThumbnail(id: string, role: Role, response: Response): Promise<void> {
    const video = await this.prisma.video.findFirst({
      where: { id, ...whereVisible(role) },
      select: { thumbnailKey: true },
    });
    if (!video?.thumbnailKey) throw new NotFoundException('No thumbnail');

    await this.send(video.thumbnailKey, response);
  }

  async collectionPoster(id: string, role: Role, response: Response): Promise<void> {
    const collection = await this.prisma.collection.findFirst({
      where: { id, ...whereVisible(role) },
      select: { posterKey: true },
    });
    if (!collection?.posterKey) throw new NotFoundException('No poster');

    await this.send(collection.posterKey, response);
  }

  /**
   * The wide backdrop behind an overview page.
   *
   * A separate picture rather than the thumbnail scaled up: a thumbnail is a
   * 640px frame ffmpeg picked on its own, which is fine on a card and soft and
   * arbitrary across a full-bleed hero.
   */
  async videoBanner(id: string, role: Role, response: Response): Promise<void> {
    const video = await this.prisma.video.findFirst({
      where: { id, ...whereVisible(role) },
      select: { bannerKey: true },
    });
    if (!video?.bannerKey) throw new NotFoundException('No banner');

    await this.send(video.bannerKey, response);
  }

  async collectionBanner(id: string, role: Role, response: Response): Promise<void> {
    const collection = await this.prisma.collection.findFirst({
      where: { id, ...whereVisible(role) },
      select: { bannerKey: true },
    });
    if (!collection?.bannerKey) throw new NotFoundException('No banner');

    await this.send(collection.bannerKey, response);
  }

  /**
   * Sends the file, with an ETag rather than a lifetime.
   *
   * The storage key is stable across replacements — a new poster overwrites
   * `thumbnails/<id>.jpg` rather than taking a new name — so any `max-age`
   * above zero serves the old picture until it expires, and an admin who has
   * just fixed a poster sees the one they replaced. Revalidating every time
   * costs one conditional request and is always right; the 304 is what makes
   * it cheap.
   */
  private async send(key: string, response: Response): Promise<void> {
    const stat = await this.storage.statOf('derived', key);
    // The row says there is a picture and there is not. That is a 404 to the
    // browser, which renders its fallback — not a 500.
    if (!stat) throw new NotFoundException('No image');

    const etag = `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;

    response.setHeader('Content-Type', CONTENT_TYPES[extname(key).toLowerCase()] ?? 'image/jpeg');
    response.setHeader('ETag', etag);
    // `private` because a shared cache must not hand one member's library
    // artwork to another; artwork on a draft is not published yet.
    response.setHeader('Cache-Control', 'private, no-cache');

    if (response.req.headers['if-none-match'] === etag) {
      response.status(304).end();
      return;
    }

    response.setHeader('Content-Length', stat.size);

    const stream = createReadStream(this.storage.resolvePath('derived', key));
    // Without this, an aborted image request leaks a file descriptor — the same
    // rule the range streaming follows, and images are requested in bulk.
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }
}
