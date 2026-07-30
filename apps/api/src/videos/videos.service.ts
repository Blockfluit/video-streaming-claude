import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  toPage,
  type ListVideosQuery,
  type Page,
  type UpdateVideoInput,
} from '@video/shared';

import { narrowToVisibleStates, videoMissingFields, whereVisible } from '../common/publishing';
import { slugify, uniqueSlug } from '../common/slug';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';

const VIDEO_SELECT = {
  id: true,
  slug: true,
  collectionId: true,
  seasonId: true,
  orderIndex: true,
  title: true,
  description: true,
  tags: true,
  state: true,
  origin: true,
  storageKey: true,
  playbackKey: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  durationSec: true,
  width: true,
  height: true,
  videoCodec: true,
  audioCodec: true,
  audioTracks: true,
  needsConversion: true,
  probedAt: true,
  probeError: true,
  missingSince: true,
  thumbnailKey: true,
  thumbnailSource: true,
  introStartSec: true,
  introEndSec: true,
  outroStartSec: true,
  outroEndSec: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class VideosService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * There is no `create` here on purpose. A video row exists because a file
   * exists — created by ingest (step 9) or upload (step 13), never conjured
   * from a request body.
   */
  async list(query: ListVideosQuery, role: Role): Promise<Page<unknown>> {
    const where = {
      ...(query.collectionId ? { collectionId: query.collectionId } : {}),
      ...(query.seasonId ? { seasonId: query.seasonId } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' as const } },
              { description: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      // Spread last: this is the constraint nothing else may overwrite.
      ...narrowToVisibleStates(role, query.state),
    };

    const [videos, total] = await this.prisma.$transaction([
      this.prisma.video.findMany({
        where,
        select: VIDEO_SELECT,
        // `id` last makes the order total. `orderIndex` and `title` both repeat,
        // and offset paging over a non-total order repeats and skips rows.
        orderBy: [
          { collectionId: 'asc' },
          { seasonId: 'asc' },
          { orderIndex: 'asc' },
          { title: 'asc' },
          { id: 'asc' },
        ],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.video.count({ where }),
    ]);

    return toPage(
      videos.map((video) => this.withChecklist(video, role)),
      total,
      query,
    );
  }

  async findOne(id: string, role: Role) {
    const video = await this.prisma.video.findFirst({
      where: { id, ...whereVisible(role) },
      select: VIDEO_SELECT,
    });
    if (!video) throw new NotFoundException('No such video');

    return this.withChecklist(video, role);
  }

  async update(id: string, dto: UpdateVideoInput) {
    const video = await this.prisma.video.findUnique({
      where: { id },
      select: { id: true, collectionId: true, title: true },
    });
    if (!video) throw new NotFoundException('No such video');

    if (dto.seasonId) {
      // A video may only belong to a season of its own collection — otherwise
      // it would appear under a show it is not part of.
      const season = await this.prisma.season.findUnique({
        where: { id: dto.seasonId },
        select: { collectionId: true },
      });
      if (!season) throw new NotFoundException('No such season');
      if (season.collectionId !== video.collectionId) {
        throw new BadRequestException('That season belongs to a different collection');
      }
    }

    const slug = dto.regenerateSlug
      ? await this.freeSlug(video.collectionId, slugify(dto.title ?? video.title), id)
      : undefined;

    return this.prisma.video.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        tags: dto.tags,
        orderIndex: dto.orderIndex,
        // Explicit null moves the video out of its season, which is different
        // from omitting the field.
        seasonId: dto.seasonId === undefined ? undefined : dto.seasonId,
        slug,
      },
      select: VIDEO_SELECT,
    });
  }

  /**
   * Removes the row only. The file stays, so this is not a way to free disk
   * space — and reconcile will recreate the row on the next scan unless the
   * file is removed too. Reclaiming source files is `DELETE /videos/:id/source`
   * in step 12, which is a different operation with different consequences.
   */
  async remove(id: string): Promise<void> {
    const video = await this.prisma.video.findUnique({ where: { id }, select: { id: true } });
    if (!video) throw new NotFoundException('No such video');

    await this.prisma.video.delete({ where: { id } });
  }

  async publish(id: string) {
    const video = await this.prisma.video.findUnique({
      where: { id },
      select: { id: true, title: true, description: true, durationSec: true, thumbnailKey: true },
    });
    if (!video) throw new NotFoundException('No such video');

    const missingFields = videoMissingFields(video);
    if (missingFields.length > 0) {
      // The checklist comes back with the rejection so the UI does not have to
      // ask a second time to find out what is wrong.
      throw new BadRequestException({
        message: 'This video is not ready to publish',
        missingFields,
      });
    }

    return this.prisma.video.update({
      where: { id },
      data: { state: 'PUBLISHED' },
      select: VIDEO_SELECT,
    });
  }

  async archive(id: string) {
    const video = await this.prisma.video.findUnique({ where: { id }, select: { id: true } });
    if (!video) throw new NotFoundException('No such video');

    return this.prisma.video.update({
      where: { id },
      data: { state: 'ARCHIVED' },
      select: VIDEO_SELECT,
    });
  }

  /** Video slugs are unique within their collection — two shows may both have a `pilot`. */
  private async freeSlug(collectionId: string, base: string, exceptId?: string): Promise<string> {
    const taken = await this.prisma.video.findMany({
      where: { collectionId, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { slug: true },
    });

    return uniqueSlug(
      base,
      taken.map((row) => row.slug),
    );
  }

  /** The publish checklist is admin-facing; a USER only ever sees published videos anyway. */
  private withChecklist<
    T extends {
      title: string;
      description: string | null;
      durationSec: number | null;
      thumbnailKey: string | null;
    },
  >(video: T, role: Role) {
    return role === 'ADMIN' ? { ...video, missingFields: videoMissingFields(video) } : video;
  }
}
