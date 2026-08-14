import { collectionBanner, videoBanner } from './artwork'
import { collectionTitle } from './collections'
import { collectionChip } from './kinds'
import { collectionPath, videoPath } from './links'

/**
 * What the home page leads with, from whichever of two sources can answer.
 *
 * The hero features what was **recently added**. It reads the admin's
 * `RECENTLY_ADDED` row when there is one, exactly the way it used to read the
 * Continue Watching row — so moving, renaming or hiding that row moves the
 * hero with it, which is the coherent reading of doing any of those things.
 *
 * No migration seeds such a row, though, so on a fresh library there is
 * nothing to follow. Rather than leave the hero empty on the install where it
 * matters most, it falls back to `GET /library?sort=added`, which is the
 * catalogue's own recency answer and the one `/browse` already sorts by.
 *
 * The two sources are shaped differently — a row entry is a
 * `{ collection, video }` pair, a library card is a `kind`-discriminated union
 * — and both fold into one entry here so the page renders a hero rather than
 * two heroes with a branch between them.
 *
 * Deliberately absent: a description. Neither card select carries one, and
 * widening them would ship a synopsis for every card on every shelf on the
 * page to serve three lines in one place. The trailer is what the hero leads
 * with instead.
 *
 * Nuxt auto-imports the helpers below at runtime; the imports are explicit
 * because vitest runs this file in plain node, where nothing is auto-imported.
 */

/** A shelf, not a catalogue. Five is what a person will sit through before it loops. */
export const HERO_LIMIT = 5

export interface HeroEntry {
  id: string
  title: string
  /** A shelf's chip, a video's collection, or a year. Null renders no line at all. */
  meta: string | null
  /**
   * Where the CTA goes. Both are *describing* routes: a new arrival is
   * something the viewer is still deciding about, which is the same rule
   * browse, My List and curated rows follow. A collection has nothing single
   * to play in any case.
   */
  to: string
  /** A banner. A wide slot never takes a poster. */
  image: string | null
  trailerId: string | null
}

/** The half of a row entry that is a video. */
interface RowVideo {
  id: string
  slug: string
  title: string
  trailerYoutubeId?: string | null
  collections?: { collection: { title: string } }[] | null
}

/** The half that is a collection. */
interface RowCollection {
  id: string
  slug: string
  title: string
  year?: number | null
  seasonsHere?: number | null
  videosHere?: number | null
  trailerYoutubeId?: string | null
}

export interface RowEntry {
  id: string
  video?: RowVideo | null
  collection?: RowCollection | null
}

export interface HomeShelf {
  source: string
  items: RowEntry[]
}

/** A `LibraryCard`, structurally — the fields this needs and no dependency on the barrel. */
export interface LibraryEntry {
  kind: string
  id: string
  slug: string
  title: string
  year?: number | null
  seasonsHere?: number | null
  videosHere?: number | null
  trailerYoutubeId?: string | null
}

/**
 * `shelves` must be the rows that resolved to something, not every row.
 *
 * A `RECENTLY_ADDED` row holding nothing would otherwise shadow the fallback
 * and render an empty hero over a library with plenty in it — the row exists,
 * so nothing looks wrong from here.
 */
export function heroEntries(shelves: HomeShelf[], newest: LibraryEntry[]): HeroEntry[] {
  const row = shelves.find(shelf => shelf.source === 'RECENTLY_ADDED' && shelf.items.length > 0)

  const entries = row
    ? row.items.map(fromRowEntry).filter((entry): entry is HeroEntry => entry !== null)
    : newest.map(fromLibraryEntry)

  return entries.slice(0, HERO_LIMIT)
}

function fromRowEntry(entry: RowEntry): HeroEntry | null {
  if (entry.collection) {
    const collection = entry.collection
    return {
      // The row's own item id, which is stable per entry and is what the
      // rotation keys on. A computed row's is `collection:<id>`, a hand-picked
      // row's is the `ListItem` id, and neither is the record's id.
      id: entry.id,
      title: collection.title,
      meta: collectionChip(collection),
      to: collectionPath(collection),
      image: collectionBanner(collection),
      trailerId: collection.trailerYoutubeId ?? null,
    }
  }

  if (entry.video) {
    const video = entry.video
    return {
      id: entry.id,
      title: video.title,
      meta: collectionTitle(video),
      to: videoPath(video),
      image: videoBanner(video),
      trailerId: video.trailerYoutubeId ?? null,
    }
  }

  // Exactly one of the two is a CHECK constraint on the table, so this is not
  // a state the API produces. Skipping beats rendering a hero with no title.
  return null
}

function fromLibraryEntry(card: LibraryEntry): HeroEntry {
  const isCollection = card.kind === 'collection'

  return {
    id: card.id,
    title: card.title,
    // A shelf says what it holds; a film has no collection to name, so its year
    // is the only thing left that is worth a line.
    meta: isCollection ? collectionChip(card) : (card.year ? String(card.year) : null),
    to: isCollection ? collectionPath(card) : videoPath(card),
    image: isCollection ? collectionBanner(card) : videoBanner(card),
    trailerId: card.trailerYoutubeId ?? null,
  }
}
