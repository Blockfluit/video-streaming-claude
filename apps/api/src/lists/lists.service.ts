import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  toPage,
  type AddListItemInput,
  type CreateCuratedListInput,
  type ListCuratedListsQuery,
  type Page,
  type ReorderListItemsInput,
  type UpdateCuratedListInput,
} from '@video/shared';

import { isUniqueViolation } from '../common/prisma-errors';
import { whereVisible } from '../common/publishing';
import { slugify, uniqueSlug } from '../common/slug';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';

const LIST_SELECT = {
  id: true,
  slug: true,
  title: true,
  description: true,
  position: true,
  isVisible: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ITEM_SELECT = {
  id: true,
  position: true,
  collection: {
    select: { id: true, slug: true, title: true, year: true, posterKey: true, state: true },
  },
  video: {
    select: {
      id: true,
      slug: true,
      title: true,
      durationSec: true,
      thumbnailKey: true,
      width: true,
      height: true,
      state: true,
      // Through the membership: a video may be in several collections, or
      // none, so a card names them rather than assuming one parent.
      collections: {
        select: { collection: { select: { id: true, slug: true, title: true } } },
      },
    },
  },
} as const;

/** A home-page row is a shelf, not a catalogue. Past this, it is a browse page. */
const MAX_ITEMS_PER_LIST = 200;

@Injectable()
export class ListsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(role: Role, query: ListCuratedListsQuery): Promise<Page<unknown>> {
    // A hidden row is invisible to a viewer whatever they ask for; the flag only
    // opens anything up for an admin.
    const where =
      role === 'ADMIN' && query.includeHidden === true ? {} : { isVisible: true };

    const [lists, total] = await this.prisma.$transaction([
      this.prisma.curatedList.findMany({
        where,
        select: LIST_SELECT,
        // `id` last makes the order total — `position` is deliberately not unique.
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.curatedList.count({ where }),
    ]);

    const items = await Promise.all(
      lists.map(async (row) => ({ ...row, items: await this.itemsOf(row.id, role) })),
    );

    return toPage(items, total, query);
  }

  async findBySlug(slug: string, role: Role) {
    const row = await this.prisma.curatedList.findFirst({
      where: { slug, ...(role === 'ADMIN' ? {} : { isVisible: true }) },
      select: LIST_SELECT,
    });
    if (!row) throw new NotFoundException('No such list');

    return { ...row, items: await this.itemsOf(row.id, role) };
  }

  async create(dto: CreateCuratedListInput) {
    return this.prisma.curatedList.create({
      data: {
        title: dto.title,
        description: dto.description ?? null,
        position: dto.position ?? (await this.nextListPosition()),
        isVisible: dto.isVisible ?? true,
        slug: await this.freeSlug(slugify(dto.title)),
      },
      select: LIST_SELECT,
    });
  }

  async update(id: string, dto: UpdateCuratedListInput) {
    const row = await this.require(id);

    return this.prisma.curatedList.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        position: dto.position,
        isVisible: dto.isVisible,
        slug: dto.regenerateSlug
          ? await this.freeSlug(slugify(dto.title ?? row.title), id)
          : undefined,
      },
      select: LIST_SELECT,
    });
  }

  /** Deleting a row takes its items and nothing else — the library is untouched. */
  async remove(id: string): Promise<void> {
    await this.require(id);
    await this.prisma.curatedList.delete({ where: { id } });
  }

  /**
   * Adds one entry. Idempotent, like the watchlist: the two partial uniques on
   * `ListItem` mean a double-click cannot produce a duplicate, and the
   * collision is caught rather than checked for.
   */
  async addItem(listId: string, dto: AddListItemInput) {
    await this.require(listId);
    const target = await this.requireTarget(dto);

    const count = await this.prisma.listItem.count({ where: { listId } });
    if (count >= MAX_ITEMS_PER_LIST) {
      throw new BadRequestException(`A row holds at most ${MAX_ITEMS_PER_LIST} entries`);
    }

    try {
      return await this.prisma.listItem.create({
        data: { listId, ...target, position: await this.nextItemPosition(listId) },
        select: ITEM_SELECT,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      return this.prisma.listItem.findFirstOrThrow({
        where: { listId, ...target },
        select: ITEM_SELECT,
      });
    }
  }

  async removeItem(listId: string, itemId: string): Promise<void> {
    const item = await this.prisma.listItem.findFirst({
      // Scoped to the list in the URL, so an item id alone cannot reach into
      // another row.
      where: { id: itemId, listId },
      select: { id: true },
    });
    if (!item) throw new NotFoundException('No such item');

    await this.prisma.listItem.delete({ where: { id: itemId } });
  }

  /**
   * Rewrites the whole row order in one transaction.
   *
   * `ListItem.position` is deliberately not unique — a unique index collides
   * mid drag-reorder, when two items momentarily hold the same number. The
   * price is that nothing stops a partial rewrite from leaving a mess, so every
   * item has to be listed exactly once.
   */
  async reorder(listId: string, dto: ReorderListItemsInput) {
    await this.require(listId);

    const unique = new Set(dto.itemIds);
    if (unique.size !== dto.itemIds.length) {
      throw new BadRequestException('The same item is listed twice');
    }

    const existing = await this.prisma.listItem.findMany({
      where: { listId },
      select: { id: true },
    });

    if (existing.length !== dto.itemIds.length || !existing.every((row) => unique.has(row.id))) {
      throw new BadRequestException('List every item in this row exactly once');
    }

    await this.prisma.$transaction(
      dto.itemIds.map((id, position) =>
        this.prisma.listItem.update({ where: { id }, data: { position } }),
      ),
    );

    return this.itemsOf(listId, 'ADMIN');
  }

  /**
   * A row's entries, filtered by what the caller may see.
   *
   * A curated row is admin-made and can hold anything, so this is the only
   * thing stopping a home-page shelf from advertising a draft.
   */
  private async itemsOf(listId: string, role: Role) {
    return this.prisma.listItem.findMany({
      where: {
        listId,
        OR: [
          { collection: { is: whereVisible(role) } },
          { video: { is: whereVisible(role) } },
        ],
      },
      select: ITEM_SELECT,
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      take: MAX_ITEMS_PER_LIST,
    });
  }

  private async requireTarget(
    dto: AddListItemInput,
  ): Promise<{ collectionId: string } | { videoId: string }> {
    if (dto.collectionId !== undefined) {
      const collection = await this.prisma.collection.findUnique({
        where: { id: dto.collectionId },
        select: { id: true },
      });
      if (!collection) throw new NotFoundException('No such collection');
      return { collectionId: collection.id };
    }

    const video = await this.prisma.video.findUnique({
      where: { id: dto.videoId },
      select: { id: true },
    });
    if (!video) throw new NotFoundException('No such video');
    return { videoId: video.id };
  }

  private async require(id: string) {
    const row = await this.prisma.curatedList.findUnique({
      where: { id },
      select: { id: true, title: true },
    });
    if (!row) throw new NotFoundException('No such list');
    return row;
  }

  private async nextListPosition(): Promise<number> {
    const last = await this.prisma.curatedList.aggregate({ _max: { position: true } });
    return last._max.position === null ? 0 : last._max.position + 1;
  }

  private async nextItemPosition(listId: string): Promise<number> {
    const last = await this.prisma.listItem.aggregate({
      where: { listId },
      _max: { position: true },
    });
    return last._max.position === null ? 0 : last._max.position + 1;
  }

  private async freeSlug(base: string, exceptId?: string): Promise<string> {
    const taken = await this.prisma.curatedList.findMany({
      where: exceptId ? { NOT: { id: exceptId } } : {},
      select: { slug: true },
    });

    return uniqueSlug(
      base,
      taken.map((row) => row.slug),
    );
  }
}
