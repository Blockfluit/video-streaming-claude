/**
 * Turning a row in the library into the question a subtitle provider can
 * answer. Pure — it is the part most likely to be wrong in a way no HTTP status
 * would reveal, because a badly-phrased search returns an empty list and an
 * empty list looks exactly like "nothing exists".
 */

export interface SearchSubject {
  title: string;
  year: number | null;
  imdbId: string | null;
  /** The show, when this video is an episode of one. */
  collectionTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export interface SearchTerms {
  query?: string;
  imdbId?: string;
  year?: number;
  seasonNumber?: number;
  episodeNumber?: number;
}

export function searchTermsFor(subject: SearchSubject, override?: string | null): SearchTerms {
  const typed = override?.trim();
  const isEpisode = subject.seasonNumber !== null;

  const terms: SearchTerms = {};

  if (isEpisode) {
    terms.seasonNumber = subject.seasonNumber as number;
    // A null episode number means ingest could not tell. Sending nothing asks
    // for the season, which is a wide answer; sending a guess asks for the
    // wrong episode, which is a confidently wrong one.
    if (subject.episodeNumber !== null) terms.episodeNumber = subject.episodeNumber;
  }

  if (typed) {
    // The admin is typing because the derived question failed. Their words
    // replace the identifiers rather than competing with them.
    terms.query = typed;
    return terms;
  }

  if (subject.imdbId) {
    // Exact beats approximate, and sending a title alongside an id only gives
    // the provider something to disagree with.
    terms.imdbId = subject.imdbId;
    return terms;
  }

  terms.query = isEpisode ? subject.collectionTitle ?? subject.title : subject.title;

  // A show's year is the year it began, which is not the year of the episode
  // being searched for — it narrows an episode search to nothing.
  if (!isEpisode && subject.year !== null) terms.year = subject.year;

  return terms;
}
