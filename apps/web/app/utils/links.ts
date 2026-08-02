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
 * A video's own page — its title page, where the description, the cast and the
 * Play button are. This is the canonical URL for a video and the one worth
 * sharing: it is built from slugs, so it survives and it reads.
 *
 * Returns null when the video arrived without its collection — there is no page
 * to link to, and a half-built href is worse than no link.
 */
export function watchPath(video: LinkableVideo): string | null {
  const collectionSlug = video.collection?.slug
  if (!collectionSlug) return null

  const segments = [collectionSlug, video.season?.slug, video.slug].filter(
    (segment): segment is string => typeof segment === 'string' && segment.length > 0,
  )

  return `/c/${segments.join('/')}`
}

/**
 * Straight into playback.
 *
 * Keyed on the id rather than the slug path because that is the one thing every
 * surface offering to resume something already has: a Continue Watching card, a
 * history row and the player's own next-episode button all hold a video row,
 * and not one of them reliably holds its season's slug. `watchPath` returns
 * null in exactly that case, which is the right answer for a link to a title
 * page and the wrong one for "keep playing".
 *
 * The two live side by side here so that the choice between them is made once
 * per surface, deliberately, rather than by whichever string a page happened to
 * interpolate.
 */
export function playPath(video: { id: string }): string {
  return `/watch/${video.id}`
}
