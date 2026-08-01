/**
 * Building the in-app URLs.
 *
 * Everything under a collection lives at `/c/:collection/*`, resolved by the
 * API's `/collections/:slug/resolve`. The shapes are assembled here rather than
 * interpolated at each call site, because a season that is present on one card
 * and absent on the next is exactly how a link ends up with a double slash in
 * it — which resolves to a different, missing route.
 */

export interface LinkableCollection {
  slug: string
}

export interface LinkableVideo {
  slug: string
  collection?: { slug: string } | null
  season?: { slug: string } | null
}

export function collectionPath(collection: LinkableCollection): string {
  return `/c/${collection.slug}`
}

/**
 * The watch URL. Returns null when the video arrived without its collection —
 * there is no page to link to, and a half-built href is worse than no link.
 */
export function watchPath(video: LinkableVideo): string | null {
  const collectionSlug = video.collection?.slug
  if (!collectionSlug) return null

  const segments = [collectionSlug, video.season?.slug, video.slug].filter(
    (segment): segment is string => typeof segment === 'string' && segment.length > 0,
  )

  return `/c/${segments.join('/')}`
}
