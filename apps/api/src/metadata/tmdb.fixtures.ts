/**
 * Recorded-shape TMDB responses, for the mapper's tests.
 *
 * TypeScript rather than JSON on purpose: typed against the response interfaces,
 * a fixture that drifts from what the mapper expects fails to compile instead of
 * quietly testing a shape the provider no longer sends. (JSON would also need
 * `resolveJsonModule` turned on project-wide, which nothing else here wants.)
 *
 * Trimmed to the fields the mapper reads, and salted with the cases that catch
 * real mistakes: the cast is out of billing order, and `AU` is listed before
 * `US` so that "take the first certification" is visibly the wrong answer.
 */

import type { TmdbSearchResponse, TmdbSeasonDetail, TmdbTitleDetail } from './tmdb.types';

export const MOVIE: TmdbTitleDetail = {
  id: 329865,
  title: 'Arrival',
  original_title: 'Arrival',
  original_language: 'en',
  tagline: 'Why are they here?',
  overview:
    'Taking place after alien crafts land around the world, an expert linguist is recruited by the military to determine whether they come in peace or are a threat.',
  release_date: '2016-11-10',
  runtime: 116,
  poster_path: '/x2FJsf1ElAgr63Y3PNPtJrcmpoe.jpg',
  backdrop_path: '/yIZ1xendyqKvY3FGeeUYUd5X9Mm.jpg',
  vote_average: 7.6,
  vote_count: 18234,
  genres: [
    { id: 18, name: 'Drama' },
    { id: 878, name: 'Science Fiction' },
    { id: 9648, name: 'Mystery' },
  ],
  external_ids: { imdb_id: 'tt2543164' },
  videos: {
    results: [
      { key: 'ccccccccccc', site: 'YouTube', type: 'Featurette', official: true },
      { key: 'tFMo3UJ4B4g', site: 'YouTube', type: 'Trailer', official: true },
    ],
  },
  release_dates: {
    results: [
      { iso_3166_1: 'AU', release_dates: [{ certification: 'M' }] },
      { iso_3166_1: 'GB', release_dates: [{ certification: '' }] },
      // Two releases, the earlier one unrated — so the *first* is not the answer.
      { iso_3166_1: 'US', release_dates: [{ certification: '' }, { certification: 'PG-13' }] },
    ],
  },
  credits: {
    cast: [
      {
        id: 17604,
        name: 'Jeremy Renner',
        known_for_department: 'Acting',
        character: 'Ian Donnelly',
        order: 1,
      },
      {
        id: 1245,
        name: 'Amy Adams',
        known_for_department: 'Acting',
        character: 'Louise Banks',
        order: 0,
      },
      {
        id: 9778,
        name: 'Tzi Ma',
        known_for_department: 'Acting',
        character: 'General Shang',
        order: 3,
      },
      {
        id: 6807,
        name: 'Forest Whitaker',
        known_for_department: 'Acting',
        character: 'Colonel Weber',
        order: 2,
      },
    ],
    crew: [
      {
        id: 137427,
        name: 'Denis Villeneuve',
        known_for_department: 'Directing',
        job: 'Director',
        department: 'Directing',
      },
      {
        id: 1281473,
        name: 'Eric Heisserer',
        known_for_department: 'Writing',
        job: 'Screenplay',
        department: 'Writing',
      },
      {
        id: 1439,
        name: 'Jóhann Jóhannsson',
        known_for_department: 'Sound',
        job: 'Original Music Composer',
        department: 'Sound',
      },
      {
        id: 1341527,
        name: 'Bradford Young',
        known_for_department: 'Camera',
        job: 'Director of Photography',
        department: 'Camera',
      },
      {
        id: 1447306,
        name: 'Renée April',
        known_for_department: 'Costume & Make-Up',
        job: 'Costume Design',
        department: 'Costume & Make-Up',
      },
      // Contains "Director" and must not be promoted to one.
      {
        id: 1120044,
        name: 'Liz Tan',
        known_for_department: 'Directing',
        job: 'Second Unit Director',
        department: 'Directing',
      },
    ],
  },
};

export const SERIES: TmdbTitleDetail = {
  id: 95396,
  name: 'Severance',
  original_name: 'Severance',
  original_language: 'en',
  tagline: 'Work is a different world.',
  overview:
    'Mark leads a team of office workers whose memories have been surgically divided between their work and personal lives.',
  first_air_date: '2022-02-17',
  status: 'Returning Series',
  number_of_seasons: 2,
  number_of_episodes: 19,
  poster_path: '/lFf6LLrQjYldcZItzOkGmMMigP7.jpg',
  backdrop_path: '/8uxUCo4YkVTKZqbPzBTFJnRKmXY.jpg',
  vote_average: 8.4,
  vote_count: 1876,
  genres: [
    { id: 18, name: 'Drama' },
    { id: 9648, name: 'Mystery' },
    { id: 878, name: 'Sci-Fi & Fantasy' },
  ],
  external_ids: { imdb_id: 'tt11280740' },
  videos: {
    results: [{ key: 'xEQP4VVuyrY', site: 'YouTube', type: 'Trailer', official: true }],
  },
  // Television's certifications are a flat list, not one per release.
  content_ratings: {
    results: [
      { iso_3166_1: 'AU', rating: 'MA15+' },
      { iso_3166_1: 'US', rating: 'TV-MA' },
    ],
  },
  credits: {
    cast: [
      {
        id: 17881,
        name: 'Adam Scott',
        known_for_department: 'Acting',
        character: 'Mark Scout',
        order: 0,
      },
      {
        id: 6413,
        name: 'Patricia Arquette',
        known_for_department: 'Acting',
        character: 'Harmony Cobel',
        order: 1,
      },
    ],
    crew: [
      {
        id: 1425352,
        name: 'Dan Erickson',
        known_for_department: 'Writing',
        job: 'Writer',
        department: 'Writing',
      },
      {
        id: 1245,
        name: 'Ben Stiller',
        known_for_department: 'Directing',
        job: 'Executive Producer',
        department: 'Production',
      },
    ],
  },
};

/** One request per season: TMDB returns every episode inline. */
export const SEASON: TmdbSeasonDetail = {
  season_number: 1,
  episodes: [
    {
      id: 2395135,
      episode_number: 1,
      season_number: 1,
      name: 'Good News About Hell',
      overview: 'Mark is asked to take on a new role after the sudden departure of a colleague.',
      air_date: '2022-02-17',
      still_path: '/wLQyU4hxD4dSCkpBjhhpiTyBqbA.jpg',
      vote_average: 7.8,
      vote_count: 42,
    },
    {
      id: 2395136,
      episode_number: 2,
      season_number: 1,
      name: 'Half Loop',
      overview: 'Helly struggles to adjust while Mark tries to make her feel welcome.',
      air_date: '2022-02-17',
      still_path: '/nUJRRhrCbgSmnRRTPMSAO1Zvzll.jpg',
      vote_average: 7.6,
      vote_count: 33,
    },
  ],
};

/** Candidates carry only enough to tell two remakes apart. */
export const SEARCH: TmdbSearchResponse = {
  page: 1,
  total_results: 2,
  results: [
    {
      id: 329865,
      title: 'Arrival',
      release_date: '2016-11-10',
      overview:
        'Taking place after alien crafts land around the world, an expert linguist is recruited by the military.',
      poster_path: '/x2FJsf1ElAgr63Y3PNPtJrcmpoe.jpg',
    },
    {
      id: 9741,
      title: 'The Arrival',
      release_date: '1996-05-31',
      overview: 'An astronomer discovers evidence of an alien invasion.',
      poster_path: '/dJFCLkBHDwjNgN2Jm1BQfWLXvOw.jpg',
    },
  ],
};
