/**
 * Recognising the database errors that are part of a design rather than a fault.
 *
 * A unique violation is the normal, correct outcome of two callers racing for
 * the same row: both list adds are idempotent by *catching* one rather than by
 * checking first, because check-then-write is not atomic and a double-click
 * lands inside the gap. Requests use the same shape for "already asked for".
 *
 * Extracted because there were two identical copies of this and a third was
 * about to be written. Two divergent copies of "was that a unique violation" is
 * how one caller quietly stops being idempotent.
 */

/** Prisma's code for a unique constraint violation (Postgres 23505). */
const UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}
