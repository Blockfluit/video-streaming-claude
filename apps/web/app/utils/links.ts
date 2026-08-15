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

export interface LinkablePerson {
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
 *
 * The optional collection is what lets the player offer the next and previous
 * episode. It has to be *carried* rather than worked out on arrival: a video
 * belongs to any number of collections, and `seasonId` and `orderIndex` sit on
 * the membership, so the same episode can be episode 3 of a show and item 1 of a
 * best-of row. Once the link has been followed there is no honest way to choose
 * between them — the surface that built the link is the one that knew.
 *
 * So the surfaces on the "plays" side of the rule above pass it, because being
 * inside a collection is exactly what put them there. Continue Watching and
 * History do not: they hold a video and a position, with no collection in hand.
 * Passing nothing is an ordinary state and simply means no stepper.
 */
export function playPath(video: LinkableVideo, fromCollectionSlug?: string | null): string {
  const path = `/watch/${video.slug}`
  if (!fromCollectionSlug) return path

  return `${path}?from=${encodeURIComponent(fromCollectionSlug)}`
}

/** Enough of a membership to tell an episode from everything else. */
export interface DescribableVideo extends LinkableVideo {
  collections?: { seasonId: string | null, collection: LinkableCollection }[] | null
}

/**
 * Where a video is described *from the player*, which is not always its own page.
 *
 * An episode is described by its **series**. Halfway through episode three, the
 * page worth reaching is the one you picked the episode from — the season list,
 * the synopsis of the show, the rest of it — not a page about the episode already
 * on screen. `videoPath` answers "where does this video live"; this answers "where
 * does someone watching it want to go", and for an episode those differ.
 *
 * Everything else keeps `/v/:slug`, including a film sitting in a saga collection.
 * That page carries the synopsis, cast and certification, and a collection page
 * repeats none of it — sending a film to its shelf would lose the whole reason the
 * button was pressed. `seasonId` is exactly the line between the two cases, and it
 * is the same test `/v/:slug` labels an episode by.
 *
 * The season-bearing membership is searched for rather than read off the front: a
 * video can be an episode of one collection and an extra in another, and only one
 * of those is a series. `collections[0]` — what the "from …" subtitle uses — would
 * answer that ordering wrongly.
 */
export function detailsPath(video: DescribableVideo): string {
  const episodeOf = video.collections?.find(membership => membership.seasonId)
  return episodeOf ? collectionPath(episodeOf.collection) : videoPath(video)
}

/**
 * A person's page — their filmography, and what they are known for.
 *
 * Keyed on the slug like everything else addressable here.
 *
 * The page this points at spent a long time unreachable. It had been committed
 * to `apps/web/apps/web/app/pages/…` — a duplicated `apps/web/` that Nuxt never
 * scans, and that no glob in the repo matches — so the route did not exist and
 * the directory's link went to a 404. It is a helper now because three surfaces
 * build this URL, and because the pairing of a link with its page is exactly
 * what broke: a link lands with its page, or it is not a link.
 */
export function personPath(person: LinkablePerson): string {
  return `/people/${person.slug}`
}

/**
 * Out to IMDb.
 *
 * Two shapes, because IMDb numbers titles and people in different namespaces:
 * `tt0133093` is a title and `nm0000158` is a person, and the paths that serve
 * them are not interchangeable. The prefix is checked rather than trusted, so a
 * person id that reached a title field renders no link at all instead of a link
 * to nothing — the ids arrive from a third party, and a 404 on somebody else's
 * site is not something this app can explain.
 *
 * Returns null when there is nothing to link to, which is the ordinary state of
 * every title nobody has matched yet.
 */
export function imdbTitleUrl(imdbId: string | null | undefined): string | null {
  return imdbUrl(imdbId, 'tt', 'title')
}

export function imdbPersonUrl(imdbId: string | null | undefined): string | null {
  return imdbUrl(imdbId, 'nm', 'name')
}

function imdbUrl(imdbId: string | null | undefined, prefix: string, path: string): string | null {
  if (typeof imdbId !== 'string') return null

  const id = imdbId.trim()
  // Anchored, and the digits are checked: an id-shaped fragment of something
  // else is exactly what an unanchored match would accept.
  if (!new RegExp(`^${prefix}\\d{4,}$`).test(id)) return null

  return `https://www.imdb.com/${path}/${id}/`
}
