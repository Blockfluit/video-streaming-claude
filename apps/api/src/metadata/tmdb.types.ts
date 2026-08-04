/**
 * The parts of TMDB's responses this reads.
 *
 * Deliberately partial. Describing every field would be a second copy of
 * somebody else's schema to keep in step, and the mapper is written to survive
 * a field it has never seen — everything here is optional, because a provider
 * that stops sending `tagline` should cost a null rather than a crash.
 */

export interface TmdbGenre {
  id?: number;
  name?: string;
}

export interface TmdbCastMember {
  id?: number;
  name?: string;
  known_for_department?: string | null;
  character?: string | null;
  order?: number;
}

export interface TmdbCrewMember {
  id?: number;
  name?: string;
  known_for_department?: string | null;
  job?: string | null;
  department?: string | null;
}

export interface TmdbCredits {
  cast?: TmdbCastMember[];
  crew?: TmdbCrewMember[];
}

export interface TmdbVideo {
  key?: string;
  site?: string;
  type?: string;
  official?: boolean;
}

/** `/movie/{id}/release_dates` — a certification belongs to a release, not to a film. */
export interface TmdbReleaseDates {
  results?: {
    iso_3166_1?: string;
    release_dates?: { certification?: string | null }[];
  }[];
}

/** `/tv/{id}/content_ratings` — television's equivalent, shaped differently. */
export interface TmdbContentRatings {
  results?: { iso_3166_1?: string; rating?: string | null }[];
}

export interface TmdbExternalIds {
  imdb_id?: string | null;
}

/** A film and a show, in one type: the mapper reads whichever pair is present. */
export interface TmdbTitleDetail {
  id?: number;
  // Films.
  title?: string;
  original_title?: string;
  release_date?: string;
  runtime?: number | null;
  // Shows.
  name?: string;
  original_name?: string;
  first_air_date?: string;
  status?: string | null;
  number_of_seasons?: number | null;
  number_of_episodes?: number | null;

  overview?: string | null;
  tagline?: string | null;
  original_language?: string | null;
  genres?: TmdbGenre[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number | null;
  vote_count?: number | null;

  credits?: TmdbCredits;
  external_ids?: TmdbExternalIds;
  videos?: { results?: TmdbVideo[] };
  release_dates?: TmdbReleaseDates;
  content_ratings?: TmdbContentRatings;
}

export interface TmdbSearchResult {
  id?: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string | null;
  poster_path?: string | null;
  media_type?: string;
}

export interface TmdbSearchResponse {
  page?: number;
  total_results?: number;
  results?: TmdbSearchResult[];
}

export interface TmdbEpisode {
  id?: number;
  episode_number?: number;
  season_number?: number;
  name?: string;
  overview?: string | null;
  air_date?: string;
  still_path?: string | null;
  vote_average?: number | null;
  vote_count?: number | null;
}

export interface TmdbSeasonDetail {
  season_number?: number;
  episodes?: TmdbEpisode[];
}
