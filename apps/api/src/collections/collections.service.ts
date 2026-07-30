import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import {
  collectionMissingFields,
  videoMissingFields,
  whereVisible,
} from '../common/publishing';
import { slugify, uniqueSlug } from '../common/slug';
import { StorageService } from '../common/storage.service';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateCollectionDto, UpdateCollectionDto } from './dto/collection.dto';

/** Enough to render a row in a grid. */
const COLLECTION_SUMMARY = {
  id: true,
  slug: true,
  title: true,
  description: true,
  year: true,
  tags: true,
  posterKey: true,
  state: true,
  origin: true,
  folderKey: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  list(role: Role) {
    return this.prisma.collection.findMany({
      where: whereVisible(role),
      select: COLLECTION_SUMMARY,
      orderBy: { title: 'asc' },
    });
  }

  /**
   * One collection with its seasons and videos.
   *
   * The visibility filter is applied to the nested videos too, not only the
   * collection — a published collection can hold draft videos, and a USER must
   * not see them.
   */
  async findBySlug(slug: string, role: Role) {
    const collection = await this.prisma.collection.findFirst({
      where: { slug, ...whereVisible(role) },
      select: {
        ...COLLECTION_SUMMARY,
        seasons: {
          select: {
            id: true,
            number: true,
            slug: true,
            title: true,
            description: true,
            posterKey: true,
          },
          orderBy: [{ number: 'asc' }, { slug: 'asc' }],
        },
        videos: {
          where: whereVisible(role),
          select: {
            id: true,
            slug: true,
            title: true,
            description: true,
            seasonId: true,
            orderIndex: true,
            state: true,
            durationSec: true,
            width: true,
            height: true,
            thumbnailKey: true,
          },
          orderBy: [{ seasonId: 'asc' }, { orderIndex: 'asc' }, { title: 'asc' }],
        },
      },
    });

    if (!collection) throw new NotFoundException('No such collection');

    return this.withChecklist(collection, role);
  }

  async create(dto: CreateCollectionDto) {
    const slug = await this.freeCollectionSlug(slugify(dto.title));
    const folderKey = dto.folderKey ?? slug;

    const clash = await this.prisma.collection.findUnique({
      where: { folderKey },
      select: { id: true },
    });
    if (clash) {
      throw new BadRequestException(`Another collection already uses the folder "${folderKey}"`);
    }

    // Created before the row: a collection whose folder does not exist has
    // nowhere for an upload or an ingest to land.
    await this.storage.ensureDirectory('media', folderKey);

    return this.prisma.collection.create({
      data: {
        slug,
        title: dto.title,
        description: dto.description ?? null,
        year: dto.year ?? null,
        tags: dto.tags ?? [],
        folderKey,
        origin: 'UPLOAD',
      },
      select: COLLECTION_SUMMARY,
    });
  }

  async update(id: string, dto: UpdateCollectionDto) {
    const existing = await this.prisma.collection.findUnique({
      where: { id },
      select: { id: true, title: true },
    });
    if (!existing) throw new NotFoundException('No such collection');

    const slug = dto.regenerateSlug
      ? await this.freeCollectionSlug(slugify(dto.title ?? existing.title), id)
      : undefined;

    return this.prisma.collection.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        year: dto.year,
        tags: dto.tags,
        posterKey: dto.posterKey,
        slug,
      },
      select: COLLECTION_SUMMARY,
    });
  }

  /**
   * Removes the collection row, and its folder only when asked.
   *
   * Without `deleteFiles`, reconcile will find the folder on the next scan and
   * recreate everything — so the default is explicitly the reversible one, and
   * the caller has to mean it to lose data.
   */
  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      select: { id: true, folderKey: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    await this.prisma.collection.delete({ where: { id } });

    if (deleteFiles) {
      await this.storage.delete('media', collection.folderKey);
    }
  }

  /**
   * Publishes the collection, optionally taking its ready videos with it.
   *
   * Rejects with the checklist rather than a bare error, so the admin UI can
   * show what is still missing without a second request.
   */
  async publish(id: string, cascade: boolean) {
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        description: true,
        posterKey: true,
        videos: {
          select: {
            id: true,
            state: true,
            title: true,
            description: true,
            durationSec: true,
            thumbnailKey: true,
          },
        },
      },
    });
    if (!collection) throw new NotFoundException('No such collection');

    const readyVideoIds = collection.videos
      .filter((video) => videoMissingFields(video).length === 0)
      .map((video) => video.id);

    const publishableVideoCount = collection.videos.filter(
      (video) => video.state === 'PUBLISHED' || readyVideoIds.includes(video.id),
    ).length;

    const missingFields = collectionMissingFields({ ...collection, publishableVideoCount });
    if (missingFields.length > 0) {
      throw new BadRequestException({
        message: 'This collection is not ready to publish',
        missingFields,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      if (cascade && readyVideoIds.length > 0) {
        await tx.video.updateMany({
          where: { id: { in: readyVideoIds }, state: 'DRAFT' },
          data: { state: 'PUBLISHED' },
        });
      }

      return tx.collection.update({
        where: { id },
        data: { state: 'PUBLISHED' },
        select: COLLECTION_SUMMARY,
      });
    });
  }

  /**
   * Archiving hides the collection without touching its videos' own states, so
   * un-archiving restores exactly what was there before.
   */
  async archive(id: string) {
    await this.mustExist(id);

    return this.prisma.collection.update({
      where: { id },
      data: { state: 'ARCHIVED' },
      select: COLLECTION_SUMMARY,
    });
  }

  private async mustExist(id: string): Promise<void> {
    const found = await this.prisma.collection.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException('No such collection');
  }

  /** Collection slugs are unique library-wide, unlike season and video slugs. */
  private async freeCollectionSlug(base: string, exceptId?: string): Promise<string> {
    const taken = await this.prisma.collection.findMany({
      where: exceptId ? { NOT: { id: exceptId } } : undefined,
      select: { slug: true },
    });

    return uniqueSlug(
      base,
      taken.map((row) => row.slug),
    );
  }

  /** Admins get the publish checklist; a USER has no use for it and should not see draft internals. */
  private withChecklist<T extends { state: string; title: string | null }>(
    collection: T & {
      description: string | null;
      posterKey: string | null;
      videos: { state: string }[];
    },
    role: Role,
  ) {
    if (role !== 'ADMIN') return collection;

    return {
      ...collection,
      missingFields: collectionMissingFields({
        title: collection.title,
        description: collection.description,
        posterKey: collection.posterKey,
        publishableVideoCount: collection.videos.length,
      }),
    };
  }
}
