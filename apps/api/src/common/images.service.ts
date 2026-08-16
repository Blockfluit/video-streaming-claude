import { createReadStream } from 'node:fs';
import { extname } from 'node:path';

import { Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';

import { type ArtworkResolution, resolveArtwork } from './artwork-resolution';
import { whereVisible } from './publishing';
import { StorageService } from './storage.service';
import { MEMBERSHIP_ORDER } from '../collections/membership';
import { artworkKeyOf, type ArtworkShape } from '../media/artwork';
import { FALLBACK_CONTENT_TYPE, fallbackArtwork } from '../media/fallback-artwork';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Serving the artwork: a 2:3 poster and a 16:9 banner, for videos and for
 * collections.
 *
 * Every card in the app needs one of these, so it is the read side of what
 * step 10 only ever wrote. Kept apart from `StreamingService` because the
 * rules are genuinely different — an image is small, complete, and worth
 * caching, where a range response must never be cached at all.
 *
 * **These routes do not 404 for missing artwork.** They used to, and a library
 * holding one collection nobody had given a poster then failed pages that had
 * nothing wrong with them: the browser tests treat any 4xx as a failure, and
 * every card paid a round trip to learn there was nothing there. Absent artwork
 * is an ordinary state, so it gets an ordinary answer — the picture below it in
 * the chain, and the stock image at the end of it.
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

  /**
   * A video's poster or banner.
   *
   * The row not existing is still a 404 — that is a question about a video the
   * caller cannot see. Artwork *missing* is not: an unprobed video has none yet,
   * and answering with the stock picture is both true and useful.
   */
  async videoArtwork(
    id: string,
    shape: ArtworkShape,
    role: Role,
    response: Response,
  ): Promise<void> {
    const video = await this.prisma.video.findFirst({
      where: { id, ...whereVisible(role) },
      select: { posterKey: true, bannerKey: true },
    });
    if (!video) throw new NotFoundException('No such video');

    await this.sendResolved(
      resolveArtwork(artworkKeyOf(video, shape)),
      shape,
      response,
    );
  }

  /**
   * A collection's poster or banner, which it may not own.
   *
   * Its own key is the admin's override; without one the collection shows its
   * **first video's** artwork, by the same ordering every other collection read
   * uses. A shelf's picture follows what is on it until somebody chooses one.
   *
   * The candidate video is filtered by the caller's visibility for the same
   * reason the nested reads are: a published collection may hold draft episodes,
   * and a draft's poster is not published art.
   */
  async collectionArtwork(
    id: string,
    shape: ArtworkShape,
    role: Role,
    response: Response,
  ): Promise<void> {
    const collection = await this.prisma.collection.findFirst({
      where: { id, ...whereVisible(role) },
      select: { posterKey: true, bannerKey: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    const own = artworkKeyOf(collection, shape);

    // Only asked for when it would be used — the override is the common case
    // once a library has been curated, and this is a second query per card.
    let inherited: string | null = null;
    if (!own) {
      const first = await this.prisma.collectionVideo.findFirst({
        where: { collectionId: id, video: whereVisible(role) },
        orderBy: [...MEMBERSHIP_ORDER],
        select: { video: { select: { posterKey: true, bannerKey: true } } },
      });
      inherited = artworkKeyOf(first?.video, shape);
    }

    await this.sendResolved(resolveArtwork(own, inherited), shape, response);
  }

  /**
   * Sends a stored file, or the stock image in its place.
   *
   * The stock image is also what a *broken* key becomes: the row says there is a
   * picture and the file is gone, which used to be a 404 and a browser fallback
   * glyph. Serving something is better than serving nothing, and the admin
   * screens show the key so the underlying problem is still visible where it can
   * be acted on.
   */
  private async sendResolved(
    resolution: ArtworkResolution,
    shape: ArtworkShape,
    response: Response,
  ): Promise<void> {
    if (resolution.kind === 'stored') {
      const stat = await this.storage.statOf('derived', resolution.key);
      if (stat) {
        await this.send(resolution.key, response, stat);
        return;
      }
    }

    this.sendFallback(shape, response);
  }

  /** The generated placeholder. No disk read, so no failure path worth handling. */
  private sendFallback(shape: ArtworkShape, response: Response): void {
    const bytes = fallbackArtwork(shape);
    const etag = `W/"stock-${shape}-${bytes.length.toString(16)}"`;

    response.setHeader('Content-Type', FALLBACK_CONTENT_TYPE);
    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', 'private, no-cache');

    if (response.req.headers['if-none-match'] === etag) {
      response.status(304).end();
      return;
    }

    response.setHeader('Content-Length', bytes.length);
    response.end(bytes);
  }

  /**
   * Sends the file, with an ETag rather than a lifetime.
   *
   * The storage key is stable across replacements — a new poster overwrites
   * `banners/<id>.jpg` rather than taking a new name — so any `max-age`
   * above zero serves the old picture until it expires, and an admin who has
   * just fixed a poster sees the one they replaced. Revalidating every time
   * costs one conditional request and is always right; the 304 is what makes
   * it cheap.
   */
  private async send(
    key: string,
    response: Response,
    /** Already read by the caller, which needed it to know the file was there. */
    stat: { size: number; mtime: Date },
  ): Promise<void> {
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
