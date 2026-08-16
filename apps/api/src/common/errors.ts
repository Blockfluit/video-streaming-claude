/**
 * The two questions every service ends up asking about a thrown value.
 *
 * Both were answered locally, repeatedly. `isUniqueViolation` lived in
 * `prisma-errors.ts` and was already shared; `describeError` was not, and had
 * been written thirteen times across eleven files — six as a module-private
 * function and seven inline.
 *
 * The naming is what made that worth collecting rather than tolerating. Five of
 * those six definitions were called `describe`, and `describe` elsewhere in this
 * codebase also means "turn a `Response` into a sentence for an admin" (the TMDB
 * client) and "turn a `ZodError` into a list of fields" (the validation pipe).
 * Three unrelated signatures under one name, in a tree where the reflex on
 * seeing `describe(error)` is to assume you already know what it returns.
 */

/** Prisma's code for a unique constraint violation (Postgres 23505). */
const UNIQUE_VIOLATION = 'P2002';

/**
 * A unique violation is the normal, correct outcome of two callers racing for
 * the same row: both list adds are idempotent by *catching* one rather than by
 * checking first, because check-then-write is not atomic and a double-click
 * lands inside the gap. Requests use the same shape for "already asked for".
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * Whatever was thrown, as a line worth logging.
 *
 * `catch` binds `unknown` and anything at all can be thrown, so the string
 * conversion is the fallback rather than the main path.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
