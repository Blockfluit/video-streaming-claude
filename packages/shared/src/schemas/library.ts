import { z } from 'zod';

import { parseImdbId } from '../imdb.js';
import { parseYoutubeId } from '../youtube.js';

import { pageQuerySchema } from '../pagination.js';
import {
  booleanParam,
  dateOnlyField,
  genresSchema,
  idSchema,
  listParam,
  nonEmptyText,
  optionalText,
  tagsSchema,
  yearSchema,
} from '../primitives.js';

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

/**
 * A trailer, as whatever the admin pasted.
 *
 * Stored as the **id**, so the field parses rather than validates: a watch URL
 * with a playlist and a timestamp on it is a perfectly good answer and comes out
 * as eleven characters. Anything `parseYoutubeId` cannot read is refused here
 * rather than saved — a stored non-id renders as an iframe that shows nothing,
 * with no clue in the admin form as to why.
 *
 * An explicit empty value clears it, which is the same distinction `adminNote`
 * draws between "leave this alone" and "remove it".
 */
export const trailerField = z
  .string()
  .trim()
  .max(300)
  .transform((value, ctx) => {
    if (value.length === 0) return null;

    const id = parseYoutubeId(value);
    if (id === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'That is not a YouTube link this can read',
      });
      return z.NEVER;
    }

    return id;
  })
  .nullish();

/**
 * An IMDb id, as whatever the admin pasted.
 *
 * Parses rather than validates, exactly like `trailerField`: what somebody has
 * in their address bar is `https://www.imdb.com/title/tt1179933/?ref_=nv_sr_1`,
 * and storing that verbatim gives a link that goes nowhere with nothing on the
 * form to say why. An explicit empty value clears it.
 */
export const imdbIdField = z
  .string()
  .trim()
  .max(300)
  .transform((value, ctx) => {
    if (value.length === 0) return null;

    const id = parseImdbId(value);
    if (id === null) {
      ctx.addIssue({ code: 'custom', message: 'That is not an IMDb title link this can read' });
      return z.NEVER;
    }

    return id;
  })
  .nullish();

/**
 * The descriptive fields an import writes, editable by hand.
 *
 * Shared between a collection and a video because a film here is a video
 * belonging to no collection, so both carry them. Everything a *provider* owns —
 * the TMDB id, the rating, the vote count — is deliberately absent: those are
 * facts about somebody else's database, and a hand-edited "TMDB rating" is a
 * lie. Clearing the match is its own action, not a field.
 */
const importedFields = {
  tagline: optionalText(300),
  genres: genresSchema.optional(),
  /** Short codes: "PG-13", "TV-MA", "12", "Kijkwijzer 16". */
  certification: optionalText(40),
  originalLanguage: z.string().trim().min(2).max(3).toLowerCase().nullish(),
  releaseDate: dateOnlyField,
  imdbId: imdbIdField,
};

export const updateCollectionSchema = z.object({
  title: nonEmptyText(200).optional(),
  description: optionalText(5000),
  year: yearSchema.optional(),
  tags: tagsSchema.optional(),
  posterKey: optionalText(500),
  trailerYoutubeId: trailerField,
  ...importedFields,
  originalTitle: optionalText(200),
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
  /**
   * The films: the videos **no season-holding collection claims**.
   *
   * A catalogue listing shows collections, so without this the eight films on
   * a "Harry Potter" shelf have nowhere to appear — the shelf is one card and
   * they are all on it. Seasons are the whole of the rule: an instalment of
   * something with seasons stays out, and is reached through its show.
   *
   * This was `standalone`, which asked for the videos in *no* collection and
   * therefore answered "nowhere" for exactly the films this exists to find.
   * The word still means that other, still-true thing in `ingest/structure.ts`,
   * which is why this one is not called it.
   *
   * Omitted means "do not filter"; `false` asks for the other half — the
   * episodes — rather than for the complement of the visibility rule.
   */
  film: booleanParam.optional(),
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(50).optional(),
});
export type ListVideosQuery = z.infer<typeof listVideosSchema>;

/**
 * What the catalogue holds, as one list.
 *
 * `GET /library` answers the question `/browse` asks — "what is in here, and
 * which of it do I want" — over **both** things the library is made of: a
 * collection is a shelf and a film is a video no season-holding shelf claims.
 * Browse used to ask the two endpoints separately and stitch the answers
 * together in the browser, which cannot page or sort across the join: each
 * half was capped, and the order was only ever right inside whatever window
 * happened to load.
 *
 * The filters are the same ideas both halves already understand, so nothing
 * here is a third definition of anything.
 */
export const libraryKindSchema = z.enum(['FILM', 'SHOW']);
export type LibraryKind = z.infer<typeof libraryKindSchema>;

/**
 * Sorts, named for what a reader would call them rather than for the column.
 *
 * Every one of them is made total by the service, which breaks ties on the
 * entry's kind and id — offset paging over a non-total order repeats and skips
 * rows, and here the rows come from two tables that number themselves
 * independently, so ties are the norm rather than the exception.
 */
export const librarySortSchema = z.enum(['title', 'year', 'added']);
export type LibrarySort = z.infer<typeof librarySortSchema>;

/**
 * How deep a page may be asked for.
 *
 * Answering for the union means reading `offset + limit` rows from **both**
 * tables and merging — neither side can be skipped, because row 1 of one table
 * may be row 1 or row 900 of the merged order and nothing short of looking says
 * which. So the offset is what the work scales with, and an unbounded one is a
 * request to read the library several times over.
 *
 * 200 pages of 50. Nobody finds anything past page 200 by paging; they find it
 * by filtering, which is what the rest of this schema is for.
 */
export const MAX_LIBRARY_OFFSET = 10_000;

export const listLibrarySchema = pageQuerySchema.extend({
  offset: z.coerce.number().int().min(0).max(MAX_LIBRARY_OFFSET).default(0),
  state: publishStateSchema.optional(),
  q: z.string().trim().max(200).optional(),
  /**
   * Curator-authored, and deliberately still one value. The tag chips on a
   * collection page link here as `?tag=…`, and those links keep meaning
   * exactly what they meant.
   */
  tag: z.string().trim().max(50).optional(),
  /**
   * Provider-authored, and repeatable: `?genre=Drama&genre=Horror`.
   *
   * Kept apart from `tag` for the same reason the columns are — see
   * `genresSchema`. Several narrow rather than widen, which is what every
   * other control on the filter bar does.
   */
  genre: listParam(20).optional(),
  kind: libraryKindSchema.optional(),
  sort: librarySortSchema.default('title'),
});
export type ListLibraryQuery = z.infer<typeof listLibrarySchema>;

/**
 * One genre and how many visible entries carry it.
 *
 * A response shape, so a type rather than a schema — the barrel only holds
 * zod for *requests*. It exists so the filter can offer the vocabulary the
 * library actually has: `genres` is free text as far as the database is
 * concerned, and a control that lets you type one is a control that mostly
 * returns nothing.
 */
export interface GenreFacet {
  genre: string;
  count: number;
}

/**
 * One tile in the catalogue.
 *
 * A discriminated union rather than one shape with everything optional,
 * because the two halves genuinely differ: only a shelf can say how many
 * seasons it holds, and only a film has a running time. `kind` is what a card
 * reads to know which of the two it is drawing — and the absence of a chip on
 * a film is a deliberate part of that design, not a missing value.
 *
 * Shared so the endpoint and the grid cannot disagree about the shape; a
 * response type, so no zod.
 */
export interface LibraryCardBase {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  /** Curator-authored. */
  tags: string[];
  /** Provider-authored. Kept apart from tags, like the columns. */
  genres: string[];
  state: PublishState;
}

export interface LibraryCollectionCard extends LibraryCardBase {
  kind: 'collection';
  /** What it holds — never TMDB's `seasonCount`, which counts the whole show. */
  seasonsHere: number;
  videosHere: number;
}

export interface LibraryFilmCard extends LibraryCardBase {
  kind: 'film';
  durationSec: number | null;
}

export type LibraryCard = LibraryCollectionCard | LibraryFilmCard;

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
  /**
   * A film here is a video belonging to no collection, so a video needs a year
   * of its own — `Collection.year` cannot answer for one that has no collection.
   */
  year: yearSchema.optional(),
  tags: tagsSchema.optional(),
  trailerYoutubeId: trailerField,
  ...importedFields,
  originalTitle: optionalText(300),
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

/**
 * Putting an existing video into a collection.
 *
 * `seasonId` is optional and must belong to the collection in the URL — the
 * service checks that, because Prisma cannot express a constraint across a
 * relation. Omitted means the video sits directly in the collection, which is
 * where films live.
 */
export const addCollectionVideoSchema = z.object({
  videoId: idSchema,
  seasonId: idSchema.nullable().optional(),
});
export type AddCollectionVideoInput = z.infer<typeof addCollectionVideoSchema>;

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
