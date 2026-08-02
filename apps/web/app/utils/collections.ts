/**
 * Naming the collection a video came from.
 *
 * A video belongs to any number of collections now, so a card that wants to say
 * "from The Sopranos" under a title has to pick one. It picks the first, which
 * is the order the API returns memberships in — and shows nothing at all for a
 * standalone video, because "no collection" is an ordinary thing to be rather
 * than something missing.
 *
 * Shared because three screens need the same answer, and two divergent copies
 * of it is how one of them ends up silently blank.
 */

export interface HasCollections {
  collections?: { collection: { title: string } }[] | null
}

export function collectionTitle(video: HasCollections): string | null {
  return video.collections?.[0]?.collection.title ?? null
}
