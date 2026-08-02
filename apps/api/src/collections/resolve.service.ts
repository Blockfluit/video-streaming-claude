import { Injectable, NotFoundException } from '@nestjs/common';

import { whereVisible } from '../common/publishing';
import { VIDEO_DETAIL } from '../common/video-detail';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Backs `GET /collections/:slug/resolve?path=…`, the single endpoint behind the
 * catch-all route `/c/[collection]/[...path]`.
 *
 * `/c/south-park/pilot` is ambiguous — `pilot` could be a season slug or a
 * video slug. Rather than have the router guess (and guess differently from the
 * API), the rule lives here where it is one round trip and can be tested:
 * **season slugs are checked before video slugs.**
 */

export type ResolveResult =
  | { type: 'collection'; data: unknown }
  | { type: 'season'; data: unknown }
  | { type: 'video'; data: unknown };

@Injectable()
export class ResolveService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(collectionSlug: string, path: string, role: Role): Promise<ResolveResult> {
    const collection = await this.prisma.collection.findFirst({
      where: { slug: collectionSlug, ...whereVisible(role) },
      select: { id: true, slug: true, title: true, description: true, posterKey: true, state: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    const segments = path
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    if (segments.length === 0) {
      return { type: 'collection', data: collection };
    }

    if (segments.length > 2) {
      // /c/<collection>/<season>/<video> is as deep as the URL space goes.
      throw new NotFoundException('No such path in this collection');
    }

    const [first, second] = segments;

    // Season before video: the deliberate precedence. A season named the same
    // as a video resolves to the season, and because the rule lives here the
    // frontend never has to encode it.
    const season = await this.prisma.season.findFirst({
      where: { collectionId: collection.id, slug: first },
      select: { id: true, number: true, slug: true, title: true, description: true, posterKey: true },
    });

    if (season) {
      if (second === undefined) {
        return { type: 'season', data: { ...season, collection } };
      }

      const video = await this.prisma.video.findFirst({
        where: { collectionId: collection.id, seasonId: season.id, slug: second, ...whereVisible(role) },
        select: VIDEO_DETAIL,
      });
      if (!video) throw new NotFoundException('No such video in this season');

      return { type: 'video', data: { ...video, collection, season } };
    }

    // Not a season, so `first` must be a video sitting directly in the
    // collection — and then there cannot be a second segment.
    if (second !== undefined) {
      throw new NotFoundException('No such season in this collection');
    }

    const video = await this.prisma.video.findFirst({
      where: { collectionId: collection.id, slug: first, ...whereVisible(role) },
      select: VIDEO_DETAIL,
    });
    if (!video) throw new NotFoundException('No such path in this collection');

    return { type: 'video', data: { ...video, collection } };
  }
}
