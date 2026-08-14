/**
 * What a collection calls itself on a card.
 *
 * Browse now lists a saga *and* the films on it — both match a search for
 * "Harry Potter" and both are the right answer — so a card has to say which of
 * the two it is. Seasons are the whole of the distinction, and the same fact
 * the API filters films on: a shelf with seasons holds instalments, a shelf
 * without them holds films.
 *
 * A film gets **no** chip at all. Most of the library is films, so a chip on
 * every card distinguishes nothing; the chip next to the un-chipped film is
 * what teaches the convention.
 */

export interface HasCountsHere {
  /** Seasons *we hold* — never TMDB's `seasonCount`, which counts the whole show. */
  seasonsHere?: number | null
  videosHere?: number | null
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}

export function collectionChip(collection: HasCountsHere): string {
  const seasons = collection.seasonsHere ?? 0
  // Seasons before videos: a show holds far more episodes than seasons, and the
  // episode count is both the wrong answer and the larger, louder number.
  if (seasons > 0) return plural(seasons, 'season')

  const films = collection.videosHere ?? 0
  if (films > 0) return plural(films, 'film')

  // An empty shelf is still a shelf, and an absent count is not a promise that
  // it holds nothing. No chip at all means "this is a video", so neither case
  // may borrow that.
  return 'Collection'
}
