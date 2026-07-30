import { z } from 'zod';

/**
 * Small pieces every schema reuses, so that "what counts as an id" or "how a
 * boolean arrives in a query string" is decided once.
 */

/** A cuid from Prisma. Length-bounded rather than pattern-matched — a wrong-but-plausible id is a 404, not a 400. */
export const idSchema = z.string().trim().min(1).max(64);

/** Text that must actually say something: trimmed, and blank is not allowed. */
export const nonEmptyText = (max: number) => z.string().trim().min(1).max(max);

/** Optional prose. Trimmed, and an empty string is normalised to null rather than stored as "". */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullish();

/**
 * A boolean in a query string.
 *
 * `z.coerce.boolean()` is wrong here: it follows JavaScript truthiness, so the
 * string `"false"` becomes `true`. Query flags have to be read as text.
 */
export const booleanParam = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

export const tagsSchema = z.array(z.string().trim().min(1).max(50)).max(50);

/** Four-digit years only — from the first film ever shot to comfortably past anything anyone will own. */
export const yearSchema = z.coerce.number().int().min(1888).max(2200);
