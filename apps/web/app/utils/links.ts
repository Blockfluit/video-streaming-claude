/**
 * Building the in-app URLs.
 *
 * Everything under a collection lives at `/c/:collection/*`, resolved by the
 * API's `/collections/:slug/resolve`. The shapes are assembled here rather than
 * interpolated at each call site, because a season that is present on one card
 * and absent on the next is exactly how a link ends up with a double slash in
 * it — which resolves to a different, missing route.
 *
 * A video has **two** links, and which one a screen uses is a product decision
 * rather than a technical one. `overviewPath` is where a card goes: it shows
 * what the thing is before committing anyone to watching it. `playPath` is the
 * same page with the player already open, and belongs only to the places where
 * someone has already decided — Continue Watching, and "Next episode" at the
 * end of what they were just watching.
 */

export interface LinkableCollection {
  slug: string
}

export interface LinkableVideo {
  slug: string
  collection?: { slug: string } | null
  season?: { slug: string } | null
}

/** The query that opens the player. One place, so the two halves cannot drift. */
export const PLAY_QUERY = 'play'
export const PLAY_VALUE = '1'

export function collectionPath(collection: LinkableCollection): string {
  return `/c/${collection.slug}`
}

/**
 * The overview: metadata, trailer, and a Play button.
 *
 * Returns null when the video arrived without its collection — there is no page
 * to link to, and a half-built href is worse than no link.
 */
export function overviewPath(video: LinkableVideo): string | null {
  const collectionSlug = video.collection?.slug
  if (!collectionSlug) return null

  const segments = [collectionSlug, video.season?.slug, video.slug].filter(
    (segment): segment is string => typeof segment === 'string' && segment.length > 0,
  )

  return `/c/${segments.join('/')}`
}

/**
 * The overview with the player open.
 *
 * A query rather than a path segment: the collection resolver reads every
 * segment after the collection as a season or video slug, so `/watch` would
 * become a reserved slug that resolution has to special-case for ever.
 */
export function playPath(video: LinkableVideo): string | null {
  const path = overviewPath(video)
  return path === null ? null : `${path}?${PLAY_QUERY}=${PLAY_VALUE}`
}
