/**
 * The metadata-match modal's search request.
 *
 * Pure and specced, matching `peopleQuery` in shape: this is the one place
 * the modal's initial search and its "load more" window ask the same
 * question, so they cannot silently drift into two different querystrings.
 */
export function metadataSearchQuery(
  title: string,
  type: 'both' | 'movie' | 'tv',
  year: number | null | undefined,
  offset: number,
  limit: number,
): string {
  const params = new URLSearchParams({ title, limit: String(limit) })
  if (type !== 'both') params.set('type', type)
  if (year) params.set('year', String(year))
  // Left out at zero: `?offset=0` says the same thing and reads like a bug.
  if (offset > 0) params.set('offset', String(offset))

  return `/admin/metadata/search?${params.toString()}`
}
