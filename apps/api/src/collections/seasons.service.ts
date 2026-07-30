import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { seasonSlug, slugify, uniqueSlug } from '../common/slug';
import { StorageService } from '../common/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateSeasonDto, UpdateSeasonDto } from './dto/season.dto';

const SEASON_SELECT = {
  id: true,
  collectionId: true,
  number: true,
  slug: true,
  title: true,
  description: true,
  posterKey: true,
  folderKey: true,
} as const;

@Injectable()
export class SeasonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async create(dto: CreateSeasonDto) {
    const collection = await this.prisma.collection.findUnique({
      where: { id: dto.collectionId },
      select: { id: true, folderKey: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    // Postgres treats NULLs as distinct, so @@unique([collectionId, number])
    // does not stop two unnumbered seasons. Enforced here instead — but only
    // for real numbers, since several unnumbered seasons are legitimate.
    if (dto.number !== undefined) {
      const clash = await this.prisma.season.findFirst({
        where: { collectionId: collection.id, number: dto.number },
        select: { id: true },
      });
      if (clash) {
        throw new BadRequestException(`This collection already has a season ${dto.number}`);
      }
    }

    const title = dto.title ?? (dto.number !== undefined ? `Season ${dto.number}` : 'Season');
    const slug = await this.freeSlug(collection.id, seasonSlug(dto.number ?? null, title));
    const folderKey = dto.folderKey ?? `${collection.folderKey}/${slugify(title)}`;

    await this.storage.ensureDirectory('media', folderKey);

    return this.prisma.season.create({
      data: {
        collectionId: collection.id,
        number: dto.number ?? null,
        slug,
        title,
        description: dto.description ?? null,
        folderKey,
      },
      select: SEASON_SELECT,
    });
  }

  async update(id: string, dto: UpdateSeasonDto) {
    const season = await this.prisma.season.findUnique({
      where: { id },
      select: { id: true, collectionId: true, number: true, title: true },
    });
    if (!season) throw new NotFoundException('No such season');

    if (dto.number !== undefined && dto.number !== season.number) {
      const clash = await this.prisma.season.findFirst({
        where: { collectionId: season.collectionId, number: dto.number, NOT: { id } },
        select: { id: true },
      });
      if (clash) {
        throw new BadRequestException(`This collection already has a season ${dto.number}`);
      }
    }

    const slug = dto.regenerateSlug
      ? await this.freeSlug(
          season.collectionId,
          seasonSlug(dto.number ?? season.number, dto.title ?? season.title),
          id,
        )
      : undefined;

    return this.prisma.season.update({
      where: { id },
      data: {
        number: dto.number,
        title: dto.title,
        description: dto.description,
        posterKey: dto.posterKey,
        slug,
      },
      select: SEASON_SELECT,
    });
  }

  /**
   * Deleting a season leaves its videos in the collection rather than taking
   * them with it — the schema's `onDelete: SetNull` on `Video.seasonId` says
   * the same thing. Losing a season folder should not lose the episodes.
   */
  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const season = await this.prisma.season.findUnique({
      where: { id },
      select: { id: true, folderKey: true },
    });
    if (!season) throw new NotFoundException('No such season');

    await this.prisma.season.delete({ where: { id } });

    if (deleteFiles) {
      await this.storage.delete('media', season.folderKey);
    }
  }

  /** Season slugs are unique within their collection, not library-wide. */
  private async freeSlug(collectionId: string, base: string, exceptId?: string): Promise<string> {
    const taken = await this.prisma.season.findMany({
      where: { collectionId, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { slug: true },
    });

    return uniqueSlug(
      base,
      taken.map((row) => row.slug),
    );
  }
}
