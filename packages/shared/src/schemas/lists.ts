import { z } from 'zod';

import { pageQuerySchema } from '../pagination.js';
import { booleanParam, idSchema, nonEmptyText, optionalText } from '../primitives.js';

/**
 * The two lists on the home page, which are deliberately different things.
 *
 * **My List** is explicit and per-user. **Curated rows** are admin-made and the
 * same for everyone. Continue Watching is neither — it is derived from
 * `WatchProgress` and lives in `schemas/watch.ts`.
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

export const createCuratedListSchema = z.object({
  title: nonEmptyText(200),
  description: optionalText(2000),
  /** Row order on the home page. Appended to the end when omitted. */
  position: z.coerce.number().int().min(0).max(9999).optional(),
  isVisible: z.boolean().optional(),
});
export type CreateCuratedListInput = z.infer<typeof createCuratedListSchema>;

export const updateCuratedListSchema = z
  .object({
    title: nonEmptyText(200).optional(),
    description: optionalText(2000),
    position: z.coerce.number().int().min(0).max(9999).optional(),
    isVisible: z.boolean().optional(),
    regenerateSlug: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
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
