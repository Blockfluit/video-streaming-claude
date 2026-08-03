/**
 * The artwork URLs.
 *
 * Two shapes, and which one a surface asks for is a design decision rather than
 * a detail: a **poster** (2:3) is what a card shows, and a **banner** (16:9) is
 * for the wide slots — the episode rows inside a show, and every page backdrop.
 *
 * These used to return `null` when the payload said there was no artwork, to
 * avoid a request that would 404. The routes no longer 404: a video nothing has
 * probed yet and a collection nobody has given a poster both resolve to
 * something — the first episode's picture, or the stock image — so there is no
 * longer a request worth not making, and no null for every caller to handle.
 *
 * A collection's URL is unconditional for a second reason. Its `posterKey` being
 * null means "no admin override", not "no picture", so deciding from it here
 * would blank the artwork on exactly the collections that inherit one.
 */

export function collectionPoster(collection: { id: string } | null | undefined): string | null {
  return collection ? `/api/collections/${collection.id}/poster` : null
}

export function collectionBanner(collection: { id: string } | null | undefined): string | null {
  return collection ? `/api/collections/${collection.id}/banner` : null
}

export function videoPoster(video: { id: string } | null | undefined): string | null {
  return video ? `/api/videos/${video.id}/poster` : null
}

export function videoBanner(video: { id: string } | null | undefined): string | null {
  return video ? `/api/videos/${video.id}/banner` : null
}
