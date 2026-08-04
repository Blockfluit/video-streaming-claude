/**
 * TMDB's JSON → the library's field names.
 *
 * Pure, and tested before anything that calls it. This is the highest-risk and
 * cheapest-to-test part of the import: every mistake here is quiet. A field read
 * under the wrong name comes back null, a title gets saved with a blank synopsis,
 * and nothing anywhere reports a problem.
 *
 * Two habits run through it:
 *
 *   - **`""` means absent.** TMDB uses an empty string rather than null for
 *     everything it does not know, and `new Date('')` is an Invalid Date that
 *     survives all the way to a column.
 *   - **Nothing is required.** Every field is optional in the response types, so
 *     a provider that stops sending one costs a null rather than an exception
 *     part-way through a title that is already half written.
 */

import { parseYoutubeId, type TmdbType } from '@video/shared';

import { creditRoleForJob } from './crew-role';
import type {
  TmdbEpisode,
  TmdbSeasonDetail,
  TmdbSearchResponse,
  TmdbTitleDetail,
} from './tmdb.types';
import type { CreditRole } from '../prisma/generated/enums';

export interface ProposedCredit {
  tmdbPersonId: number;
  name: string;
  knownFor: string | null;
  role: CreditRole;
  characterName: string | null;
  jobTitle: string | null;
  department: string | null;
  /** Billing order, from TMDB's own `order` for cast and appended for crew. */
  position: number;
}

export interface MetadataProposal {
  tmdbId: number;
  tmdbType: TmdbType;
  imdbId: string | null;
  title: string;
  description: string | null;
  tagline: string | null;
  year: number | null;
  releaseDate: Date | null;
  genres: string[];
  certification: string | null;
  originalTitle: string | null;
  originalLanguage: string | null;
  tmdbRating: number | null;
  tmdbVoteCount: number | null;
  seriesStatus: string | null;
  seasonCount: number | null;
  episodeCount: number | null;
  trailerYoutubeId: string | null;
  /** TMDB's relative image paths. Turned into URLs by the client, not here. */
  posterPath: string | null;
  backdropPath: string | null;
  cast: ProposedCredit[];
  crew: ProposedCredit[];
}

export interface MetadataCandidate {
  tmdbId: number;
  tmdbType: TmdbType;
  title: string;
  year: number | null;
  description: string | null;
  posterPath: string | null;
}

export interface ProposedEpisode {
  seasonNumber: number | null;
  episodeNumber: number;
  title: string | null;
  description: string | null;
  releaseDate: Date | null;
  stillPath: string | null;
}

export function mapTitle(
  detail: TmdbTitleDetail,
  type: TmdbType,
  certificationCountry: string,
): MetadataProposal {
  // Television keeps the same ideas under different names. Reading only the film
  // spelling gives a show with no title and no year, and nothing errors.
  const title = text(detail.title) ?? text(detail.name) ?? '';
  const releaseDate = date(detail.release_date ?? detail.first_air_date);
  const voteCount = positive(detail.vote_count);

  return {
    tmdbId: detail.id ?? 0,
    tmdbType: type,
    imdbId: text(detail.external_ids?.imdb_id),
    title,
    description: text(detail.overview),
    tagline: text(detail.tagline),
    year: releaseDate?.getUTCFullYear() ?? null,
    releaseDate,
    genres: (detail.genres ?? []).map((genre) => text(genre.name)).filter(isPresent),
    certification: certification(detail, type, certificationCountry),
    originalTitle: text(detail.original_title) ?? text(detail.original_name),
    originalLanguage: text(detail.original_language),
    // A rating with no votes behind it is TMDB's way of saying "unrated", not a
    // score of zero — stored, it puts a confident 0.0 on every obscure title.
    tmdbRating: voteCount === null ? null : (positive(detail.vote_average) ?? null),
    tmdbVoteCount: voteCount,
    seriesStatus: type === 'tv' ? text(detail.status) : null,
    seasonCount: type === 'tv' ? (positive(detail.number_of_seasons) ?? null) : null,
    episodeCount: type === 'tv' ? (positive(detail.number_of_episodes) ?? null) : null,
    trailerYoutubeId: trailer(detail),
    posterPath: text(detail.poster_path),
    backdropPath: text(detail.backdrop_path),
    cast: mapCast(detail),
    crew: mapCrew(detail),
  };
}

export function mapSearchResults(
  response: TmdbSearchResponse,
  fallbackType: TmdbType,
): MetadataCandidate[] {
  return (response.results ?? []).flatMap((result) => {
    // A multi-search labels each result; a single-catalogue search does not, and
    // the caller knows which one it asked for.
    const type = result.media_type ?? fallbackType;
    if (type !== 'movie' && type !== 'tv') return [];

    const id = positive(result.id);
    const title = text(result.title) ?? text(result.name);
    if (id === null || title === null) return [];

    const releaseDate = date(result.release_date ?? result.first_air_date);

    return [
      {
        tmdbId: id,
        tmdbType: type,
        title,
        year: releaseDate?.getUTCFullYear() ?? null,
        description: text(result.overview),
        posterPath: text(result.poster_path),
      },
    ];
  });
}

export function mapEpisodes(season: TmdbSeasonDetail): ProposedEpisode[] {
  return (season.episodes ?? []).flatMap((episode: TmdbEpisode) => {
    // Without a number there is nothing to line an episode up against, and
    // guessing from array position is how a missing entry shifts a whole season.
    const episodeNumber = episode.episode_number;
    if (typeof episodeNumber !== 'number' || !Number.isFinite(episodeNumber)) return [];

    return [
      {
        seasonNumber: typeof episode.season_number === 'number' ? episode.season_number : null,
        episodeNumber,
        title: text(episode.name),
        description: text(episode.overview),
        releaseDate: date(episode.air_date),
        stillPath: text(episode.still_path),
      },
    ];
  });
}

function mapCast(detail: TmdbTitleDetail): ProposedCredit[] {
  const cast = (detail.credits?.cast ?? []).flatMap((member, index) => {
    const person = identify(member.id, member.name);
    if (person === null) return [];

    return [
      {
        ...person,
        knownFor: text(member.known_for_department),
        role: 'ACTOR' as CreditRole,
        characterName: text(member.character),
        jobTitle: null,
        department: 'Acting',
        // TMDB's own billing order, falling back to where it appeared. A cast
        // list is not always sorted, so trusting the array puts the lead fourth.
        position: typeof member.order === 'number' ? member.order : index,
      },
    ];
  });

  // TMDB does not always send the cast in billing order, and the preview an
  // admin approves lists it — a panel headed by the fourth-billed actor reads as
  // a wrong match. Sorted on name as well as position so the order is total:
  // ties are ordinary, and a list that reshuffles between requests looks like a
  // rendering bug for weeks.
  return cast.sort(
    (a, b) =>
      a.position - b.position ||
      a.name.localeCompare(b.name) ||
      a.tmdbPersonId - b.tmdbPersonId,
  );
}

function mapCrew(detail: TmdbTitleDetail): ProposedCredit[] {
  return (detail.credits?.crew ?? []).flatMap((member, index) => {
    const person = identify(member.id, member.name);
    if (person === null) return [];

    const jobTitle = text(member.job);

    return [
      {
        ...person,
        knownFor: text(member.known_for_department),
        role: creditRoleForJob(jobTitle ?? ''),
        characterName: null,
        jobTitle,
        department: text(member.department),
        // Crew has no billing order of its own; the response order is the only
        // signal there is, and it is at least stable between requests.
        position: index,
      },
    ];
  });
}

/**
 * A person needs both halves to be usable: the id is what an import upserts on,
 * and the name is what it would create the row with. Either missing and the
 * entry is dropped rather than guessed at.
 */
function identify(id: number | undefined, name: string | undefined) {
  const tmdbPersonId = positive(id);
  const trimmed = text(name);
  if (tmdbPersonId === null || trimmed === null) return null;

  return { tmdbPersonId, name: trimmed };
}

/**
 * A film's certification hangs off a *release* — it may have been rated
 * differently in different countries and on re-release — while a show's is a
 * flat list. Two shapes for one idea, so both are read here rather than in a
 * caller that would have to know which it was looking at.
 */
function certification(
  detail: TmdbTitleDetail,
  type: TmdbType,
  country: string,
): string | null {
  const wanted = country.trim().toUpperCase();

  if (type === 'tv') {
    const entry = (detail.content_ratings?.results ?? []).find(
      (result) => result.iso_3166_1?.toUpperCase() === wanted,
    );
    return text(entry?.rating);
  }

  const entry = (detail.release_dates?.results ?? []).find(
    (result) => result.iso_3166_1?.toUpperCase() === wanted,
  );
  // One country can hold several releases, and the earlier ones often carry an
  // empty certification — the first non-empty is the answer, not the first.
  for (const release of entry?.release_dates ?? []) {
    const value = text(release.certification);
    if (value !== null) return value;
  }
  return null;
}

/**
 * The official YouTube trailer, as an id.
 *
 * Run through the same parser the paste-a-link form uses rather than trusted for
 * being machine-generated: the value ends up in an iframe `src`, and a stored
 * non-id renders as a player showing nothing with no clue as to why.
 */
function trailer(detail: TmdbTitleDetail): string | null {
  const candidates = (detail.videos?.results ?? []).filter(
    (video) => video.site === 'YouTube' && video.type === 'Trailer',
  );
  const chosen = candidates.find((video) => video.official === true) ?? candidates[0];

  return parseYoutubeId(chosen?.key);
}

/** Trimmed, with TMDB's `""`-for-unknown normalised to null. */
function text(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** `new Date('')` is an Invalid Date, which survives all the way to a column. */
function date(value: string | null | undefined): Date | null {
  const trimmed = text(value);
  if (trimmed === null) return null;

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function positive(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
