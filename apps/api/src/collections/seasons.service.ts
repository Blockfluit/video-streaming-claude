import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateSeasonInput, UpdateSeasonInput } from '@video/shared';

import { freeSlug, seasonSlug, slugify } from '../common/slug';
import { StorageService } from '../common/storage.service';
import { PrismaService } from '../prisma/prisma.service';

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

  async create(dto: CreateSeasonInput) {
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

  async update(id: string, dto: UpdateSeasonInput) {
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
  /**
   * Deletes a season, and tidies up the folder it left behind.
   *
   * `deleteFiles` still means what it always meant: take the directory and
   * everything in it, films included. That is the destructive option and stays
   * opt-in.
   *
   * What changed is the *default*. It used to leave the directory untouched,
   * which meant deleting a season through the UI did not stick — reconcile
   * rebuilds rows from the tree, so the next scan found the orphaned folder and
   * created the season again. The screen and the disk disagreed, and the disk
   * won a few minutes later.
   *
   * So an **empty** directory is now removed. Nothing in it can be lost, and
   * leaving it is the entire reason the season came back. A directory that
   * still holds something is left exactly as before: the caller has to say
   * `deleteFiles` to destroy media, and never gets there by accident.
   */
  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const season = await this.prisma.season.findUnique({
      where: { id },
      select: { id: true, folderKey: true },
    });
    if (!season) throw new NotFoundException('No such season');

    await this.prisma.season.delete({ where: { id } });

    // A season with no folder behind it has nothing on disk either way.
    if (season.folderKey === null) return;

    if (deleteFiles) {
      await this.storage.delete('media', season.folderKey);
      return;
    }

    await this.storage.deleteIfEmpty('media', season.folderKey);
  }

  /** Season slugs are unique within their collection, not library-wide. */
  private freeSlug(collectionId: string, base: string, exceptId?: string): Promise<string> {
    return freeSlug(this.prisma.season, base, { scope: { collectionId }, exceptId });
  }
}
