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
 * `season-1` for a numbered season, the slugified folder name otherwise.
 *
 * The number rather than the folder name, so `Season 01` and `Season 1` produce
 * the same URL — otherwise renaming a folder silently breaks links.
 */
export function seasonSlug(number: number | null, folderName: string): string {
  return number === null ? slugify(folderName) : `season-${number}`;
}
