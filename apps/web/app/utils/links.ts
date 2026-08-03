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
 * Where a video is *described*.
 *
 * It was called `watchPath` until the player moved to its own route, at which
 * point the function named after the watch page was the one that did not go
 * there — with `playPath` sitting next to it doing exactly that. Deciding
 * between the two is the whole of "does this card play or describe", and a pair
 * of names that point at each other's routes is how that gets answered wrongly.
 *
 * Always available. It used to return null for a video that arrived without its
 * collection — a half-built href being worse than no link — which left every
 * caller handling a case that is now simply what a standalone video is.
 */
export function videoPath(video: LinkableVideo): string {
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
 *
 * Which of the two a surface calls is not a matter of taste:
 *
 * - **Inside a collection** — an episode row, the grid on a collection page, the
 *   "more from" shelf — plays. Opening a show and picking an episode is the
 *   decision; a page describing it is one you have already read.
 * - **Continue Watching and History** play, for the same reason.
 * - **Browse, My List and curated rows** describe. Those are the surfaces where
 *   the question is still what to watch.
 */
export function playPath(video: LinkableVideo): string {
  return `/watch/${video.slug}`
}
