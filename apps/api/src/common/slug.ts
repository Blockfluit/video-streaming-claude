import baseSlugify from 'slugify';

/**
 * URL slugs, and the deduplication that keeps them unique within their scope.
 *
 * Pure — `uniqueSlug` is given the slugs already taken rather than looking them
 * up, because "scope" differs per entity: a collection slug is unique across the
 * library, a season or video slug only within its collection. Two collections
 * may both contain a `pilot`.
 */

/** Used when a title slugifies to nothing at all. A slug is a URL component; empty is not an option. */
export const SLUG_FALLBACK = 'untitled';

export function slugify(title: string): string {
  const slug = baseSlugify(title, {
    lower: true,
    strict: true, // drops anything that is not alphanumeric or a separator
    trim: true,
    locale: 'en',
  });

  return slug.length > 0 ? slug : SLUG_FALLBACK;
}

/**
 * `base`, or the first free `base-2`, `base-3`, … .
 *
 * Numbering starts at 2 because `pilot` and `pilot-2` reads the way a person
 * would write it, and fills gaps rather than tracking a high-water mark, so
 * deleting `pilot-2` lets the next one reuse it.
 */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = taken instanceof Set ? taken : new Set(taken);

  if (!used.has(base)) return base;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Anything with a `slug` column, which is all the lookup below needs.
 *
 * Structural rather than a Prisma type: the six models this is called with have
 * six different generated delegate types, and naming them here would drag the
 * generated client into a module that is otherwise pure.
 */
interface SlugDelegate {
  findMany(args: {
    where: Record<string, unknown>;
    select: { slug: true };
  }): Promise<{ slug: string }[]>;
}

/**
 * The first free slug for a new or renamed record.
 *
 * The pure half of this — `uniqueSlug` — was always shared. The lookup half was
 * written six times: in lists, people, collections, videos, seasons and
 * reconcile, identical but for the model, and differing only in cosmetics that
 * gave the copying away (two spelled the empty filter `{}` and one `undefined`).
 *
 * `scope` is what a season needs and a collection does not: season slugs are
 * unique within their collection, so two shows may both have a `pilot`, while a
 * collection slug is unique library-wide. `exceptId` is what an update needs, so
 * a record renaming to the slug it already holds does not collide with itself.
 *
 * Still reads every slug in scope, exactly as all six copies did. Narrowing it
 * to `startsWith(base)` is the obvious improvement and is deliberately not made
 * here — this change is meant to be invisible at runtime, and that one is worth
 * making once, on purpose, with a test for the numbering.
 */
export async function freeSlug(
  model: SlugDelegate,
  base: string,
  options: { scope?: Record<string, unknown>; exceptId?: string } = {},
): Promise<string> {
  const taken = await model.findMany({
    where: {
      ...options.scope,
      ...(options.exceptId === undefined ? {} : { NOT: { id: options.exceptId } }),
    },
    select: { slug: true },
  });

  return uniqueSlug(
    base,
    taken.map((row) => row.slug),
  );
}

/**
 * `season-1` for a numbered season, the slugified folder name otherwise.
 *
 * The number rather than the folder name, so `Season 01` and `Season 1` produce
 * the same URL — otherwise renaming a folder silently breaks links.
 */
export function seasonSlug(number: number | null, folderName: string): string {
  return number === null ? slugify(folderName) : `season-${number}`;
}
