/**
 * Which artwork a hero should paint.
 *
 * The library now has three kinds of picture and they are not
 * interchangeable: a **banner** is a wide backdrop chosen for exactly this
 * job, a **thumbnail** is a 640px frame ffmpeg captured on its own, and a
 * **poster** is 2:3. A hero wants the first, tolerates the second, and is
 * distorted by the third — so the fallback order is a real decision rather
 * than a null check, and it lives here where both overview pages and the home
 * page can share it.
 *
 * The functions return a **URL or null**, never a storage key. The artwork
 * endpoints answer 404 when the row has no key, and a 404 in an `<img>` is a
 * broken-image icon rather than a graceful absence — so the key's presence
 * decides whether to ask at all.
 */

export interface HeroVideo {
  id: string
  bannerKey?: string | null
  thumbnailKey?: string | null
}

export interface HeroCollection {
  id: string
  bannerKey?: string | null
  posterKey?: string | null
}

/**
 * A video's backdrop: its banner, its collection's banner, its own thumbnail,
 * then the collection poster.
 *
 * The collection's banner outranks the video's thumbnail because a banner is
 * artwork somebody picked and a thumbnail is whatever was on screen at 10% of
 * the runtime.
 */
export function videoHeroImage(
  video: HeroVideo | null | undefined,
  collection?: HeroCollection | null,
): string | null {
  if (video && has(video.bannerKey)) return `/api/videos/${video.id}/banner`
  if (collection && has(collection.bannerKey)) return `/api/collections/${collection.id}/banner`
  if (video && has(video.thumbnailKey)) return `/api/videos/${video.id}/thumbnail`
  if (collection && has(collection.posterKey)) return `/api/collections/${collection.id}/poster`

  return null
}

/** A collection's backdrop: its banner, else its poster. */
export function collectionHeroImage(collection: HeroCollection | null | undefined): string | null {
  if (!collection) return null
  if (has(collection.bannerKey)) return `/api/collections/${collection.id}/banner`
  if (has(collection.posterKey)) return `/api/collections/${collection.id}/poster`

  return null
}

function has(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.length > 0
}
