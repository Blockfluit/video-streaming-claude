import { z } from 'zod';

import { pageQuerySchema } from '../pagination.js';
import { booleanParam, idSchema, nonEmptyText, optionalText, tagsSchema } from '../primitives.js';

/**
 * The home page's rows.
 *
 * **My List** is explicit and per-user; a **row** is admin-made and the same
 * idea for everyone, though a personal one resolves to different entries per
 * caller. A row's contents come from its `source`: `MANUAL` is the original
 * hand-picked shelf, and everything else is computed from a rule so it keeps up
 * with the library without anyone maintaining it.
 */

/**
 * A reference to one library entry. Exactly one of the two, which is also a
 * CHECK constraint on every table that stores this shape — `.refine` here gives
 * the caller a message instead of a database error.
 */
const libraryRef = z
  .object({
    collectionId: idSchema.optional(),
    videoId: idSchema.optional(),
  })
  .refine((value) => (value.collectionId === undefined) !== (value.videoId === undefined), {
    message: 'Name exactly one of collectionId or videoId',
  });

export const watchlistRefSchema = libraryRef;
export type WatchlistRefInput = z.infer<typeof watchlistRefSchema>;

export const listWatchlistSchema = pageQuerySchema;
export type ListWatchlistQuery = z.infer<typeof listWatchlistSchema>;

/**
 * Where a row's contents come from. Ordered as an admin meets them: the one they
 * build by hand, the computed ones, then the two that resolve per viewer. The
 * admin UI renders its options from this, so a source added later appears
 * without anyone having to remember a second list.
 */
export const ROW_SOURCES = [
  'MANUAL',
  'RECENTLY_ADDED',
  'TRENDING',
  'MOST_VIEWED',
  'CONTINUE_WATCHING',
  'MY_LIST',
] as const;
export const rowSourceSchema = z.enum(ROW_SOURCES);
export type RowSource = z.infer<typeof rowSourceSchema>;

export const ROW_KINDS = ['AUTO', 'COLLECTIONS', 'VIDEOS'] as const;
export const rowKindSchema = z.enum(ROW_KINDS);
export type RowKind = z.infer<typeof rowKindSchema>;

/** The settings a row can carry beyond its title. Not every source reads all of them. */
export type RowSourceField = 'items' | 'kind' | 'maxItems' | 'windowDays' | 'tags';

export interface RowSourceSpec {
  label: string;
  /** One line an admin can act on — what the shelf will actually contain. */
  hint: string;
  /** Exactly the settings this source reads. Everything else is refused. */
  fields: readonly RowSourceField[];
}

/**
 * What each source is, and which settings it reads.
 *
 * One table, used by the create schema, by the service, and by the admin form,
 * because the way this rots is a form offering a field the endpoint ignores.
 * Storing a number nobody reads is how a column ends up meaning two things: a
 * `windowDays` left on a row that stopped being TRENDING silently comes back
 * the day someone switches it back.
 */
export const ROW_SOURCE_SPECS: Record<RowSource, RowSourceSpec> = {
  MANUAL: {
    label: 'Hand-picked',
    hint: 'Exactly the entries you add, in the order you put them.',
    fields: ['items'],
  },
  RECENTLY_ADDED: {
    label: 'Recently added',
    hint: 'Newest first. A show counts as recent as its newest episode, so a new season brings it back.',
    fields: ['kind', 'maxItems', 'tags'],
  },
  TRENDING: {
    label: 'Trending',
    hint: 'Watched most in the last few weeks. Ranks on time actually watched, not on how often something was opened.',
    fields: ['kind', 'maxItems', 'windowDays', 'tags'],
  },
  MOST_VIEWED: {
    label: 'Most viewed',
    hint: 'Most views since the library started. Steadier than trending, and slower to change.',
    fields: ['kind', 'maxItems', 'tags'],
  },
  CONTINUE_WATCHING: {
    label: 'Continue watching',
    hint: 'What each viewer has started and not finished. Different for everyone.',
    fields: ['maxItems'],
  },
  MY_LIST: {
    label: 'My list',
    hint: 'What each viewer has saved. Different for everyone.',
    fields: ['maxItems'],
  },
};

/** A quiet week should not empty the shelf; a quarter is not "trending". */
export const DEFAULT_TRENDING_WINDOW_DAYS = 14;

const rowSettings = {
  source: rowSourceSchema.optional(),
  kind: rowKindSchema.optional(),
  /**
   * How many cards a computed row resolves to. A shelf, not a catalogue —
   * past this it is the browse page.
   */
  maxItems: z.coerce.number().int().min(1).max(50).optional(),
  /** TRENDING's rolling window. A year is the longest that still means "lately". */
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
  tags: tagsSchema.optional(),
};

/**
 * The settings named here that the given source does not read.
 *
 * Exported because two callers need the same answer from different places: the
 * create schema knows the source it was handed, and the service knows the
 * source a PATCH leaves the row with, which is not always the one in the patch.
 * A row is validated against what it will *be*, the same way a markers patch is
 * merged onto the stored pair before it is checked.
 */
export function unsupportedRowFields(
  source: RowSource,
  settings: Partial<Record<RowSourceField, unknown>>,
): RowSourceField[] {
  const supported: readonly RowSourceField[] = ROW_SOURCE_SPECS[source].fields;

  // `undefined` is an untouched form field and says nothing; `null` is a value
  // someone chose, and choosing one a source cannot read is worth refusing.
  return (['kind', 'maxItems', 'windowDays', 'tags'] as const).filter(
    (field) => settings[field] !== undefined && !supported.includes(field),
  );
}

const refuseUnsupported = (
  value: { source?: RowSource } & Partial<Record<RowSourceField, unknown>>,
  ctx: z.RefinementCtx,
): void => {
  // A patch that does not name a source cannot be judged here — the row's
  // stored source decides, and only the service can see it.
  if (value.source === undefined) return;

  for (const field of unsupportedRowFields(value.source, value)) {
    ctx.addIssue({
      code: 'custom',
      path: [field],
      message: `A ${ROW_SOURCE_SPECS[value.source].label} row has no ${field}`,
    });
  }
};

export const createCuratedListSchema = z
  .object({
    title: nonEmptyText(200),
    description: optionalText(2000),
    /** Row order on the home page. Appended to the end when omitted. */
    position: z.coerce.number().int().min(0).max(9999).optional(),
    isVisible: z.boolean().optional(),
    ...rowSettings,
  })
  .superRefine(refuseUnsupported);
export type CreateCuratedListInput = z.infer<typeof createCuratedListSchema>;

export const updateCuratedListSchema = z
  .object({
    title: nonEmptyText(200).optional(),
    description: optionalText(2000),
    position: z.coerce.number().int().min(0).max(9999).optional(),
    isVisible: z.boolean().optional(),
    regenerateSlug: z.boolean().optional(),
    ...rowSettings,
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  })
  .superRefine(refuseUnsupported);
export type UpdateCuratedListInput = z.infer<typeof updateCuratedListSchema>;

export const listCuratedListsSchema = pageQuerySchema.extend({
  /** Admin-only; a viewer never sees a hidden row whatever they ask for. */
  includeHidden: booleanParam.optional(),
});
export type ListCuratedListsQuery = z.infer<typeof listCuratedListsSchema>;

export const addListItemSchema = libraryRef;
export type AddListItemInput = z.infer<typeof addListItemSchema>;

/**
 * A whole row order in one request. `ListItem.position` is deliberately not
 * unique — a unique index collides mid drag-reorder — so the ordering is
 * rewritten wholesale in one transaction instead.
 */
export const reorderListItemsSchema = z.object({
  itemIds: z.array(idSchema).min(1).max(500),
});
export type ReorderListItemsInput = z.infer<typeof reorderListItemsSchema>;
