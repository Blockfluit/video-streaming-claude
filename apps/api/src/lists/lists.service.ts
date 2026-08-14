import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DEFAULT_TRENDING_WINDOW_DAYS,
  ROW_SOURCE_SPECS,
  toPage,
  unsupportedRowFields,
  type AddListItemInput,
  type CreateCuratedListInput,
  type ListCuratedListsQuery,
  type Page,
  type ReorderListItemsInput,
  type UpdateCuratedListInput,
} from '@video/shared';

import { withNestedCountsHere } from '../common/films';
import { isUniqueViolation } from '../common/prisma-errors';
import { whereVisible } from '../common/publishing';
import { slugify, uniqueSlug } from '../common/slug';
import type { Role, RowSource } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { WatchService } from '../watch/watch.service';
import { WatchlistService } from '../watchlist/watchlist.service';

import { computedItems, COLLECTION_CARD_SELECT, VIDEO_CARD_SELECT } from './sources/computed';

const LIST_SELECT = {
  id: true,
  slug: true,
  title: true,
  description: true,
  position: true,
  isVisible: true,
  source: true,
  kind: true,
  maxItems: true,
  windowDays: true,
  tags: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ITEM_SELECT = {
  id: true,
  position: true,
  // The shared shapes, not copies of them: a card on a hand-picked row and a
  // card on a computed one are the same card, and two literals is how one of
  // them silently stops carrying a field the other gained.
  //
  // The video half *was* such a copy — identical field for field, sitting under
  // this very comment — until the hero needed `trailerYoutubeId` and there were
  // two places to add it. Both selects are the imported ones now.
  collection: { select: COLLECTION_CARD_SELECT },
  video: { select: VIDEO_CARD_SELECT },
} as const;

/** A home-page row is a shelf, not a catalogue. Past this, it is a browse page. */
const MAX_ITEMS_PER_LIST = 200;

/**
 * The settings to write, keeping only what the source can actually read.
 *
 * A row that stops being TRENDING must not keep its window: an unread column is
 * a value that comes back the day someone switches the source back, and nobody
 * remembers setting it. `reset` clears the rest on a source change, where
 * leaving them would carry a tag filter across into a shelf that never showed
 * one.
 */
function settingsFor(
  source: RowSource,
  dto: Partial<Record<'kind' | 'maxItems' | 'windowDays' | 'tags', unknown>>,
  /** True when the row is new or has just changed source, and so may hold nothing usable. */
  fresh: boolean,
): Record<string, unknown> {
  const supported: readonly string[] = ROW_SOURCE_SPECS[source].fields;
  const cleared = { kind: 'AUTO', maxItems: 20, windowDays: null, tags: [] } as const;

  const settings: Record<string, unknown> = {};

  for (const field of ['kind', 'maxItems', 'windowDays', 'tags'] as const) {
    if (supported.includes(field)) {
      if (dto[field] !== undefined) settings[field] = dto[field];
    } else if (fresh) {
      settings[field] = cleared[field];
    }
  }

  // A trending row has to have a window. Defaulting here rather than in the
  // column keeps it with the rest of the rule, where it is visible.
  if (source === 'TRENDING' && fresh && settings['windowDays'] === undefined) {
    settings['windowDays'] = DEFAULT_TRENDING_WINDOW_DAYS;
  }

  return settings;
}

/** The row shape the resolvers need, which is most of what is selected anyway. */
type RowConfig = {
  id: string;
  source: RowSource;
  kind: 'AUTO' | 'COLLECTIONS' | 'VIDEOS';
  maxItems: number;
  windowDays: number | null;
  tags: string[];
};

@Injectable()
export class ListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly watch: WatchService,
    private readonly watchlist: WatchlistService,
  ) {}

  async list(userId: string, role: Role, query: ListCuratedListsQuery): Promise<Page<unknown>> {
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

    // In parallel: one slow shelf must not hold up the rest of the page, which
    // is what the home page used to get by firing its four fetches at once.
    const items = await Promise.all(
      lists.map(async (row) => ({ ...row, items: await this.entriesOf(row, userId, role) })),
    );

    return toPage(items, total, query);
  }

  async findBySlug(slug: string, userId: string, role: Role) {
    const row = await this.prisma.curatedList.findFirst({
      where: { slug, ...(role === 'ADMIN' ? {} : { isVisible: true }) },
      select: LIST_SELECT,
    });
    if (!row) throw new NotFoundException('No such list');

    return { ...row, items: await this.entriesOf(row, userId, role) };
  }

  /**
   * What a row actually contains, which depends entirely on where it says its
   * contents come from.
   *
   * The three branches return the same item shape — an id, a collection or a
   * video, and for the personal ones the extra a card needs — so the home page
   * renders every row the same way rather than special-casing two of them the
   * way it used to.
   */
  private async entriesOf(row: RowConfig, userId: string, role: Role): Promise<unknown[]> {
    if (row.source === 'MANUAL') return this.itemsOf(row.id, role);

    if (row.source === 'CONTINUE_WATCHING') {
      const page = await this.watch.history(userId, role, {
        completed: false,
        limit: row.maxItems,
        offset: 0,
      });

      return page.items.map((item) => {
        const entry = item as { video: { id: string }; progress: unknown };
        return {
          id: `progress:${entry.video.id}`,
          collection: null,
          video: entry.video,
          progress: entry.progress,
        };
      });
    }

    if (row.source === 'MY_LIST') {
      const page = await this.watchlist.list(userId, role, {
        limit: row.maxItems,
        offset: 0,
      });

      return page.items;
    }

    return computedItems(this.prisma, row, role);
  }

  async create(dto: CreateCuratedListInput) {
    const source = dto.source ?? 'MANUAL';

    try {
      return await this.prisma.curatedList.create({
        data: {
          title: dto.title,
          description: dto.description ?? null,
          position: dto.position ?? (await this.nextListPosition()),
          isVisible: dto.isVisible ?? true,
          slug: await this.freeSlug(slugify(dto.title)),
          source,
          ...settingsFor(source, dto, true),
        },
        select: LIST_SELECT,
      });
    } catch (error) {
      throw this.asDuplicatePersonalRow(error, source);
    }
  }

  async update(id: string, dto: UpdateCuratedListInput) {
    const row = await this.require(id);
    // A patch is judged against what the row will *be*, not against what it
    // says: `PATCH { windowDays }` names no source, and only the stored one can
    // say whether a window means anything here. Same reason a markers patch is
    // merged onto the stored pair before it is validated.
    const source = dto.source ?? row.source;

    const unsupported = unsupportedRowFields(source, dto);
    if (unsupported.length > 0) {
      throw new BadRequestException(
        `A ${ROW_SOURCE_SPECS[source].label} row has no ${unsupported.join(', ')}`,
      );
    }

    try {
      return await this.prisma.curatedList.update({
        where: { id },
        data: {
          title: dto.title,
          description: dto.description,
          position: dto.position,
          isVisible: dto.isVisible,
          slug: dto.regenerateSlug
            ? await this.freeSlug(slugify(dto.title ?? row.title), id)
            : undefined,
          ...(dto.source === undefined ? {} : { source }),
          // Changing source clears what the new one cannot read, rather than
          // leaving a window behind to reappear if it is ever switched back.
          ...settingsFor(source, dto, source !== row.source),
        },
        select: LIST_SELECT,
      });
    } catch (error) {
      throw this.asDuplicatePersonalRow(error, source);
    }
  }

  /**
   * The partial unique on the two personal sources, turned into an answer.
   *
   * A second Continue Watching row is the same shelf twice, so the index
   * refuses it; catching the violation rather than counting first is the same
   * reason as everywhere else — check-then-write has a gap and a double-click
   * lands inside it.
   */
  private asDuplicatePersonalRow(error: unknown, source: RowSource): unknown {
    // Scoped to the two sources that index can fire for. A slug collision is
    // also a unique violation, and reporting it as a duplicate shelf would send
    // whoever hit it looking for a row that is not there.
    const personal = source === 'CONTINUE_WATCHING' || source === 'MY_LIST';
    if (!personal || !isUniqueViolation(error)) return error;

    return new ConflictException(
      `There is already a ${ROW_SOURCE_SPECS[source].label} row`,
    );
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
    await this.requireHandPicked(listId);
    const target = await this.requireTarget(dto);

    const count = await this.prisma.listItem.count({ where: { listId } });
    if (count >= MAX_ITEMS_PER_LIST) {
      throw new BadRequestException(`A row holds at most ${MAX_ITEMS_PER_LIST} entries`);
    }

    try {
      const created = await this.prisma.listItem.create({
        data: { listId, ...target, position: await this.nextItemPosition(listId) },
        select: ITEM_SELECT,
      });

      return withNestedCountsHere(created);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existing = await this.prisma.listItem.findFirstOrThrow({
        where: { listId, ...target },
        select: ITEM_SELECT,
      });

      return withNestedCountsHere(existing);
    }
  }

  async removeItem(listId: string, itemId: string): Promise<void> {
    await this.requireHandPicked(listId);

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
    await this.requireHandPicked(listId);

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
    const items = await this.prisma.listItem.findMany({
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

    return items.map(withNestedCountsHere);
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
      select: { id: true, title: true, source: true },
    });
    if (!row) throw new NotFoundException('No such list');
    return row;
  }

  /**
   * The same lookup, refusing a row whose contents are not an admin's to arrange.
   *
   * A computed row has no `ListItem`s at all, so adding one would store an entry
   * that never appears and reordering would rewrite an empty table — both
   * succeeding while doing nothing, which is worse than being told no.
   */
  private async requireHandPicked(id: string) {
    const row = await this.require(id);

    if (row.source !== 'MANUAL') {
      throw new BadRequestException(
        `A ${ROW_SOURCE_SPECS[row.source].label} row works out its own entries`,
      );
    }

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
