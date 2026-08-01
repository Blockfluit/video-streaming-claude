import { normaliseTitle } from '@video/shared';

/**
 * Writing a title, and the comparison key that has to travel with it.
 *
 * `Video.normalisedTitle` and `Collection.normalisedTitle` are derived columns:
 * they exist so the request feature can ask "is this already in the library?"
 * against an index rather than by reading every title in the database. A derived
 * column is only worth anything while it agrees with what it was derived from,
 * and the way that rots is a new write site setting `title` and not knowing the
 * other column exists.
 *
 * So no service writes either column directly. They spread one of these instead,
 * which makes forgetting visible at the call site — the same reason
 * `StorageService` is the only thing that joins a path.
 *
 * The rule itself is `normaliseTitle` in `@video/shared`, which is also what the
 * request check runs on. One implementation, two callers.
 */

/** For a create, where a title is always present. */
export function titleData(title: string): { title: string; normalisedTitle: string } {
  return { title, normalisedTitle: normaliseTitle(title) };
}

/**
 * For an update, where the title is optional.
 *
 * Returns `{}` when the caller is not changing the title, so spreading it into a
 * Prisma `data` leaves both columns alone. Passing `title: undefined` through on
 * its own would be harmless; writing `normalisedTitle: normaliseTitle(undefined)`
 * would not, which is exactly the mistake this exists to make impossible.
 */
export function titleUpdate(
  title: string | undefined,
): { title: string; normalisedTitle: string } | Record<string, never> {
  return title === undefined ? {} : titleData(title);
}
