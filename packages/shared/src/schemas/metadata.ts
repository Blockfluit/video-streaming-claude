import { z } from 'zod';

import { pageQuerySchema } from '../pagination.js';
import { nonEmptyText, yearSchema } from '../primitives.js';

/**
 * Importing a title's metadata from TMDB.
 *
 * The shape of an *apply* is the design in one object: the caller names the
 * candidate, and then names every field it may write. Nothing is implied. That
 * is what removes the need for per-field provenance columns — an admin has
 * looked at a diff and said which halves of it to keep, so there is no question
 * later about whether a value was typed or imported.
 */

/**
 * Which TMDB catalogue a candidate came from.
 *
 * Films and shows are numbered in separate sequences, so an id on its own is
 * ambiguous — 550 is both *Fight Club* and a television series.
 */
export const tmdbTypeSchema = z.enum(['movie', 'tv']);
export type TmdbType = z.infer<typeof tmdbTypeSchema>;

export const searchMetadataSchema = pageQuerySchema.extend({
  title: nonEmptyText(200),
  /** Narrows a search that would otherwise return every remake. */
  year: yearSchema.optional(),
  /** Omitted searches both catalogues, which is what an admin usually wants. */
  type: tmdbTypeSchema.optional(),
});
export type SearchMetadataQuery = z.infer<typeof searchMetadataSchema>;

/**
 * Every field an import is allowed to write.
 *
 * An allow-list rather than "whatever the proposal holds": it is the one place
 * that says an import can never reach `storageKey`, `state`, `slug` or anything
 * else describing the file or its place in the library. Adding a column to
 * `Video` must not silently make it importable.
 *
 * Some entries only exist on one kind of target — `seasonCount` is meaningless
 * on a film. Naming one that the proposal does not carry is a no-op rather than
 * an error, so a client need not know which is which.
 */
export const METADATA_FIELDS = [
  'title',
  'description',
  'tagline',
  'year',
  'releaseDate',
  'genres',
  'certification',
  'originalTitle',
  'originalLanguage',
  'tmdbRating',
  'seriesStatus',
  'seasonCount',
  'episodeCount',
  'trailerYoutubeId',
] as const;

export const metadataFieldSchema = z.enum(METADATA_FIELDS);
export type MetadataField = z.infer<typeof metadataFieldSchema>;

export const previewMetadataSchema = z.object({
  tmdbId: z.coerce.number().int().positive().max(100_000_000),
  type: tmdbTypeSchema,
});
export type PreviewMetadataQuery = z.infer<typeof previewMetadataSchema>;

export const applyMetadataSchema = z.object({
  tmdbId: z.number().int().positive().max(100_000_000),
  type: tmdbTypeSchema,
  /**
   * Exactly the fields to write. An empty list is legal and meaningful: it is
   * how somebody imports only the cast, or only the artwork, without touching a
   * synopsis they wrote themselves.
   */
  fields: z.array(metadataFieldSchema).max(METADATA_FIELDS.length),
  /** Cast and crew — every one of them, not the top-billed few. */
  includeCredits: z.boolean().optional().default(false),
  /** Poster and banner, downloaded into DERIVED_ROOT. */
  includeArtwork: z.boolean().optional().default(false),
  /** Series only: fill each episode's own title, synopsis and air date. */
  includeEpisodes: z.boolean().optional().default(false),
});
export type ApplyMetadataInput = z.infer<typeof applyMetadataSchema>;
