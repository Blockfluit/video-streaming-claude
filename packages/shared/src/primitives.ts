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

/**
 * Imported genres, kept apart from `tags`.
 *
 * The same shape as `tagsSchema` and deliberately a different name: `tags` is
 * curator-authored and genres are the provider's, and sharing one column — or
 * one schema that invites sharing a column — means a re-import cannot tell
 * which entries it owns and may replace.
 */
export const genresSchema = z.array(z.string().trim().min(1).max(50)).max(30);

/**
 * A repeatable query parameter, as a list.
 *
 * `?genre=a&genre=b` arrives from Express's parser as an array and `?genre=a`
 * as a bare string, so a filter that reads one shape silently ignores the
 * other — and the one it ignores is whichever the caller happened to send.
 * Normalising both here, beside `booleanParam`, keeps "how a list arrives in a
 * query string" a decision made once rather than per endpoint.
 *
 * Bounded like the write-side schemas: a filter is not a place to accept an
 * unbounded number of terms, each of which is another array containment test.
 */
export const listParam = (max: number) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .pipe(z.array(z.string().trim().min(1).max(50)).max(max));

/**
 * A calendar date from a date input, as `YYYY-MM-DD`.
 *
 * Not `z.coerce.date()`: that accepts anything `new Date()` will swallow,
 * including `"tomorrow"`-shaped junk that lands as an Invalid Date in a column.
 * An empty value clears the field, the same "omitted vs explicitly empty"
 * distinction `optionalText` draws.
 *
 * Read as UTC midnight. The column holds a release date, which is a day rather
 * than a moment, and parsing it in the server's local zone shifts it a day for
 * anybody west of Greenwich.
 */
export const dateOnlyField = z
  .string()
  .trim()
  .max(10)
  .transform((value, ctx) => {
    if (value.length === 0) return null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      ctx.addIssue({ code: 'custom', message: 'That is not a date this can read (YYYY-MM-DD)' });
      return z.NEVER;
    }

    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'That is not a real date' });
      return z.NEVER;
    }

    return parsed;
  })
  .nullish();
