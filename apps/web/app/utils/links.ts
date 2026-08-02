/**
 * Building the in-app URLs.
 *
 * A video has a page of its own at `/v/:slug`. It used to be reachable only
 * through a collection, which stops working the moment a video can belong to
 * several — or to none. There is no arbitrary choice to make here any more:
 * one video, one address.
 *
 * The old `/c/:collection/*` shapes still resolve, so links people have already
 * shared keep working; the API's `/collections/:slug/resolve` answers them and
 * the page sends a video on to its canonical URL.
 */

export interface LinkableCollection {
  slug: string
}

export interface LinkableVideo {
  slug: string
}

export function collectionPath(collection: LinkableCollection): string {
  return `/c/${collection.slug}`
}

/**
 * The watch URL.
 *
 * Always available now. It used to return null for a video that arrived without
 * its collection — a half-built href being worse than no link — which left
 * every caller handling a case that is now simply what a standalone video is.
 */
export function watchPath(video: LinkableVideo): string {
  return `/v/${video.slug}`
}

/**
 * Straight into playback.
 *
 * `/v/:slug` is where a video is *described* — synopsis, cast, what it belongs
 * to — and this is where it is *played*. Two routes rather than one page that
 * changes mode, so the back button returns to the description and a link that
 * starts playing can be shared as such.
 *
 * Keyed on the slug like everything else. Playback used to be worth keying on an
 * id, because the surfaces that offer to resume something held a video row
 * without its collection and no slug URL could be built from that; a video
 * addressing itself removed the problem rather than solving it.
 */
export function playPath(video: LinkableVideo): string {
  return `/watch/${video.slug}`
}
