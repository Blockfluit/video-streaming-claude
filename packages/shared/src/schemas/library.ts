import { z } from 'zod';

import { pageQuerySchema } from '../pagination.js';
import { booleanParam, idSchema, nonEmptyText, optionalText, tagsSchema, yearSchema } from '../primitives.js';

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
 *
 * Season and running order are deliberately absent too.
 *
 * They say where a video sits *in one collection*, and a video may sit in
 * several — so there is nothing here for them to mean. Both are set together by
 * `PATCH /collections/:id/videos/order`, which names the collection it is
 * talking about.
 */
export const updateVideoSchema = z.object({
  title: nonEmptyText(300).optional(),
  description: optionalText(10000),
  tags: tagsSchema.optional(),
  regenerateSlug,
});
export type UpdateVideoInput = z.infer<typeof updateVideoSchema>;

/**
 * A season's contents and their billing order, in one request.
 *
 * Dragging an episode changes two things at once — which season it is in and
 * where it sits — and touches every row after it. Doing that as one PATCH per
 * video is a dozen requests that can half-fail, leaving an order nobody chose;
 * `orderIndex` is deliberately not unique for the same reason `ListItem.position`
 * is not, so the whole sequence is rewritten in one transaction instead.
 *
 * `seasonId: null` is a real value meaning "directly in the collection", which
 * is where films live. The list is the season's **complete** contents after the
 * move, and the collection is named in the URL — taking ids on trust would make
 * a reorder a way to move episodes out of a show nobody mentioned.
 */
export const reorderCollectionVideosSchema = z.object({
  seasonId: idSchema.nullable(),
  videoIds: z.array(idSchema).max(1000),
});
export type ReorderCollectionVideosInput = z.infer<typeof reorderCollectionVideosSchema>;

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

export const ingestIssueKindSchema = z.enum([
  'ROOT_LEVEL_FILE',
  'LOOSE_DRIVE_FILE',
  'PATH_TOO_DEEP',
  'UNREADABLE_SEASON',
  'ORPHAN_SUBTITLE',
  'AMBIGUOUS_SUBTITLE',
  'UNREADABLE_FILE',
  'MISSING_FILE',
]);
export type IngestIssueKind = z.infer<typeof ingestIssueKindSchema>;

export const listIngestIssuesSchema = pageQuerySchema.extend({
  /** Resolved issues are history rather than a to-do, so they are off by default. */
  includeResolved: booleanParam.optional().default(false),
});
export type ListIngestIssuesQuery = z.infer<typeof listIngestIssuesSchema>;

/** Grabbing a poster frame at a chosen moment. */
export const captureThumbnailSchema = z.object({
  atSeconds: z.coerce.number().min(0).max(24 * 60 * 60),
});
export type CaptureThumbnailInput = z.infer<typeof captureThumbnailSchema>;

/** Image formats a browser will render as a poster. */
export const THUMBNAIL_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;
export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

/** A manually uploaded subtitle track. */
export const uploadSubtitleSchema = z.object({
  /** ISO 639-1/2. Unknown codes are accepted and flagged, never rejected. */
  language: z.string().trim().min(2).max(3).toLowerCase(),
  label: nonEmptyText(100),
  isDefault: booleanParam.optional().default(false),
});
export type UploadSubtitleInput = z.infer<typeof uploadSubtitleSchema>;

export const updateSubtitleSchema = z
  .object({
    language: z.string().trim().min(2).max(3).toLowerCase(),
    label: nonEmptyText(100),
    isDefault: z.boolean(),
  })
  .partial()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateSubtitleInput = z.infer<typeof updateSubtitleSchema>;

export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

export const jobTypeSchema = z.enum(['PROBE', 'THUMBNAIL', 'TRANSCODE', 'SUBTITLE_EXTRACT']);
export const jobStatusSchema = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const listJobsSchema = pageQuerySchema.extend({
  status: jobStatusSchema.optional(),
  type: jobTypeSchema.optional(),
  videoId: idSchema.optional(),
});
export type ListJobsQuery = z.infer<typeof listJobsSchema>;

/** 2 GB, matching MAX_UPLOAD_BYTES in the environment. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How many files one upload may carry.
 *
 * A whole season is an ordinary thing to drag in; a whole disk is not. The cap
 * bounds a single request rather than what anyone may upload in total.
 */
export const MAX_UPLOAD_FILES = 200;

/**
 * An upload names a **drive** and nothing else.
 *
 * It used to name a collection and a season, which made uploading a different
 * way of deciding what something is. It is not: the files land on the disk in
 * the shape the folder convention expects, and the scan makes of them exactly
 * what it would make of the same folders copied there by hand. Where they end up
 * in the library is edited afterwards, like anything else.
 *
 * `paths` carries one `webkitRelativePath` per file, in the order the files were
 * appended. multer strips both slash and backslash from a filename, so the shape
 * of an uploaded folder cannot survive inside `originalname` — it travels here
 * or it is lost.
 */
export const uploadVideoSchema = z.object({
  drive: nonEmptyText(255),
  paths: z.union([z.string(), z.array(z.string())]).optional(),
});
export type UploadVideoInput = z.infer<typeof uploadVideoSchema>;

/**
 * Skip markers. Each is independently optional, and an explicit `null` clears
 * one — which is different from omitting the field, and is how the editor
 * removes a marker it set by mistake.
 */
const markerSeconds = z.coerce.number().min(0).max(24 * 60 * 60).nullable();

export const updateMarkersSchema = z
  .object({
    introStartSec: markerSeconds,
    introEndSec: markerSeconds,
    outroStartSec: markerSeconds,
    outroEndSec: markerSeconds,
  })
  .partial()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateMarkersInput = z.infer<typeof updateMarkersSchema>;
