/**
 * The artwork URLs, and when not to ask for one.
 *
 * `GET /collections/:id/poster` and `GET /videos/:id/thumbnail` 404 when there
 * is nothing stored — which is a perfectly normal state: a collection nobody has
 * given a poster, a video ingest has not probed yet. Every list response already
 * carries the key, so the page can know that before it asks.
 *
 * Asking anyway costs a failed round trip per card, makes the fallback appear
 * only after it, and fills the console with 404s that hide real ones. The
 * browser tests treat any 4xx as a failure for exactly that reason, and a
 * library holding one unposter'd collection was failing pages that had nothing
 * wrong with them.
 *
 * The distinction that matters is **`null` versus absent**. `null` is the API
 * saying there is no artwork; `undefined` is a payload that simply does not
 * carry the key, where the old behaviour — ask, and fall back if it 404s — is
 * still the right one. Treating the two the same would silently blank the
 * artwork on every screen whose response shape does not happen to include it.
 */

export function collectionPoster(
  collection: { id: string, posterKey?: string | null } | null | undefined,
): string | null {
  if (!collection || collection.posterKey === null) return null
  return `/api/collections/${collection.id}/poster`
}

export function videoThumbnail(
  video: { id: string, thumbnailKey?: string | null } | null | undefined,
): string | null {
  if (!video || video.thumbnailKey === null) return null
  return `/api/videos/${video.id}/thumbnail`
}
