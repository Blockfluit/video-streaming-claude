import { z } from 'zod';

import { pageQuerySchema } from '../pagination';
import { booleanParam, idSchema, nonEmptyText, optionalText, tagsSchema, yearSchema } from '../primitives';

export const publishStateSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED', 'MISSING']);
export type PublishState = z.infer<typeof publishStateSchema>;

/**
 * Slugs never move on their own. Renaming a title would otherwise break every
 * link anyone has shared, so regenerating one is an explicit act.
 */
const regenerateSlug = z.boolean().optional();

export const createCollectionSchema = z.object({
  title: nonEmptyText(200),
  description: optionalText(5000),
  year: yearSchema.optional(),
  tags: tagsSchema.optional(),
  /**
   * Folder under MEDIA_ROOT; defaults to the generated slug. Accepted so an
   * admin can adopt a folder that already holds files.
   */
  folderKey: nonEmptyText(500).optional(),
});
export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;

export const updateCollectionSchema = z.object({
  title: nonEmptyText(200).optional(),
  description: optionalText(5000),
  year: yearSchema.optional(),
  tags: tagsSchema.optional(),
  posterKey: optionalText(500),
  regenerateSlug,
});
export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;

export const listCollectionsSchema = pageQuerySchema.extend({
  state: publishStateSchema.optional(),
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(50).optional(),
});
export type ListCollectionsQuery = z.infer<typeof listCollectionsSchema>;

export const createSeasonSchema = z.object({
  collectionId: idSchema,
  /** Optional: "Specials" is a season with no number, and 0 is the conventional home for them. */
  number: z.coerce.number().int().min(0).max(999).optional(),
  title: nonEmptyText(200).optional(),
  description: optionalText(5000),
  folderKey: nonEmptyText(500).optional(),
});
export type CreateSeasonInput = z.infer<typeof createSeasonSchema>;

export const updateSeasonSchema = z.object({
  number: z.coerce.number().int().min(0).max(999).optional(),
  title: nonEmptyText(200).optional(),
  description: optionalText(5000),
  posterKey: optionalText(500),
  regenerateSlug,
});
export type UpdateSeasonInput = z.infer<typeof updateSeasonSchema>;

export const listVideosSchema = pageQuerySchema.extend({
  state: publishStateSchema.optional(),
  collectionId: idSchema.optional(),
  seasonId: idSchema.optional(),
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(50).optional(),
});
export type ListVideosQuery = z.infer<typeof listVideosSchema>;

/**
 * Metadata only. Nothing here touches `storageKey`, `contentTag` or the probed
 * fields — those describe the file on disk and belong to ingest and probing,
 * not to whoever is editing the page.
 */
export const updateVideoSchema = z.object({
  title: nonEmptyText(300).optional(),
  description: optionalText(10000),
  tags: tagsSchema.optional(),
  orderIndex: z.coerce.number().int().min(0).max(100000).optional(),
  /** `null` moves the video out of its season, which is different from omitting the field. */
  seasonId: idSchema.nullable().optional(),
  regenerateSlug,
});
export type UpdateVideoInput = z.infer<typeof updateVideoSchema>;

export const resolveQuerySchema = z.object({
  path: z.string().max(500).default(''),
});
export type ResolveQuery = z.infer<typeof resolveQuerySchema>;

export const deleteWithFilesSchema = z.object({
  /**
   * Defaults to false. Without the files gone, reconcile rebuilds the rows on
   * the next scan — annoying but recoverable, unlike the other way round.
   */
  deleteFiles: booleanParam.optional().default(false),
});
export type DeleteWithFilesQuery = z.infer<typeof deleteWithFilesSchema>;

export const publishCollectionSchema = z.object({
  cascade: booleanParam.optional().default(false),
});
export type PublishCollectionQuery = z.infer<typeof publishCollectionSchema>;
