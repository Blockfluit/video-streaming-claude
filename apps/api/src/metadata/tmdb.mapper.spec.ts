import { MOVIE as movie, SEARCH as search, SEASON as season, SERIES as series } from './tmdb.fixtures';
import { mapEpisodes, mapSearchResults, mapTitle } from './tmdb.mapper';

describe('mapTitle — a film', () => {
  const proposal = mapTitle(movie, 'movie', 'US');

  it('reads the fields a film keeps under its own names', () => {
    expect(proposal.title).toBe('Arrival');
    expect(proposal.originalTitle).toBe('Arrival');
    expect(proposal.tagline).toBe('Why are they here?');
    expect(proposal.description).toContain('linguist');
    expect(proposal.originalLanguage).toBe('en');
  });

  it('takes the year from the release date rather than asking for it separately', () => {
    expect(proposal.releaseDate).toEqual(new Date('2016-11-10'));
    expect(proposal.year).toBe(2016);
  });

  it('flattens genres to their names', () => {
    expect(proposal.genres).toEqual(['Drama', 'Science Fiction', 'Mystery']);
  });

  it('reads the certification for the country asked for, not the first one listed', () => {
    // The fixture lists AU before US precisely so that "the first one" fails.
    expect(mapTitle(movie, 'movie', 'US').certification).toBe('PG-13');
    expect(mapTitle(movie, 'movie', 'AU').certification).toBe('M');
  });

  it('has no certification for a country that did not classify it', () => {
    expect(mapTitle(movie, 'movie', 'NL').certification).toBeNull();
  });

  it('carries the external ids, which is what the IMDb link is built from', () => {
    expect(proposal.tmdbId).toBe(329865);
    expect(proposal.tmdbType).toBe('movie');
    expect(proposal.imdbId).toBe('tt2543164');
  });

  it('leaves the series-only fields null on a film', () => {
    expect(proposal.seriesStatus).toBeNull();
    expect(proposal.seasonCount).toBeNull();
    expect(proposal.episodeCount).toBeNull();
  });
});

describe('mapTitle — a show', () => {
  const proposal = mapTitle(series, 'tv', 'US');

  /**
   * TMDB names the same ideas differently for television — `name` rather than
   * `title`, `first_air_date` rather than `release_date`. Reading only the film
   * spelling gives a show with no title and no year, and nothing errors.
   */
  it('reads the fields a show keeps under different names', () => {
    expect(proposal.title).toBe('Severance');
    expect(proposal.originalTitle).toBe('Severance');
    expect(proposal.releaseDate).toEqual(new Date('2022-02-17'));
    expect(proposal.year).toBe(2022);
  });

  it('reads a show’s certification from content ratings, which are shaped differently', () => {
    expect(proposal.certification).toBe('TV-MA');
  });

  it('carries what a show has and a film does not', () => {
    expect(proposal.seriesStatus).toBe('Returning Series');
    expect(proposal.seasonCount).toBe(2);
    expect(proposal.episodeCount).toBe(19);
  });
});

describe('mapTitle — ratings', () => {
  it('reads the rating and how many people voted', () => {
    expect(mapTitle(movie, 'movie', 'US').tmdbRating).toBeCloseTo(7.6);
    expect(mapTitle(movie, 'movie', 'US').tmdbVoteCount).toBe(18234);
  });

  /**
   * TMDB sends `vote_average: 0` for anything nobody has rated, which is not a
   * score of zero. Storing it puts a confident "0.0 ★" on every obscure title
   * in the library.
   */
  it('has no rating when nobody has voted', () => {
    const unrated = { ...movie, vote_average: 0, vote_count: 0 };

    expect(mapTitle(unrated, 'movie', 'US').tmdbRating).toBeNull();
    expect(mapTitle(unrated, 'movie', 'US').tmdbVoteCount).toBeNull();
  });
});

describe('mapTitle — empty strings', () => {
  /**
   * TMDB uses `""` rather than null throughout for "we do not know". Passed
   * through, an unknown release date becomes an Invalid Date and an unknown
   * tagline becomes a blank line under the title.
   */
  it('reads an empty string as absent, not as a value', () => {
    const sparse = {
      ...movie,
      release_date: '',
      tagline: '',
      overview: '',
      original_language: '',
    };
    const proposal = mapTitle(sparse, 'movie', 'US');

    expect(proposal.releaseDate).toBeNull();
    expect(proposal.year).toBeNull();
    expect(proposal.tagline).toBeNull();
    expect(proposal.description).toBeNull();
    expect(proposal.originalLanguage).toBeNull();
  });

  it('survives a response holding almost nothing', () => {
    const proposal = mapTitle({ id: 1, title: 'Untitled' }, 'movie', 'US');

    expect(proposal.title).toBe('Untitled');
    expect(proposal.genres).toEqual([]);
    expect(proposal.cast).toEqual([]);
    expect(proposal.crew).toEqual([]);
    expect(proposal.imdbId).toBeNull();
  });
});

describe('mapTitle — the trailer', () => {
  it('picks an official YouTube trailer and stores the id, never a URL', () => {
    expect(mapTitle(movie, 'movie', 'US').trailerYoutubeId).toBe('tFMo3UJ4B4g');
  });

  it('ignores a video that is not a trailer, and one that is not on YouTube', () => {
    const noTrailer = {
      ...movie,
      videos: {
        results: [
          { key: 'aaaaaaaaaaa', site: 'YouTube', type: 'Featurette', official: true },
          { key: 'bbbbbbbbbbb', site: 'Vimeo', type: 'Trailer', official: true },
        ],
      },
    };

    expect(mapTitle(noTrailer, 'movie', 'US').trailerYoutubeId).toBeNull();
  });

  /**
   * The stored value goes straight into an iframe `src`, so it goes through the
   * same parser the paste-a-link form uses rather than being trusted for being
   * machine-generated.
   */
  it('refuses a key that is not a YouTube id', () => {
    const bad = {
      ...movie,
      videos: { results: [{ key: 'not-an-id', site: 'YouTube', type: 'Trailer', official: true }] },
    };

    expect(mapTitle(bad, 'movie', 'US').trailerYoutubeId).toBeNull();
  });
});

describe('mapTitle — cast and crew', () => {
  const proposal = mapTitle(movie, 'movie', 'US');

  it('keeps every cast member, not a top-billed few', () => {
    expect(proposal.cast).toHaveLength(4);
  });

  it('reads a cast member as an actor with their character and billing order', () => {
    expect(proposal.cast[0]).toMatchObject({
      tmdbPersonId: 1245,
      name: 'Amy Adams',
      role: 'ACTOR',
      characterName: 'Louise Banks',
      position: 0,
      knownFor: 'Acting',
    });
  });

  it('numbers billing from TMDB’s order rather than from array position', () => {
    // The fixture lists them out of order on purpose.
    const positions = proposal.cast.map((entry) => entry.position);
    expect(positions).toEqual([0, 1, 2, 3]);
  });

  it('promotes the crew jobs the library has a role for', () => {
    const director = proposal.crew.find((entry) => entry.role === 'DIRECTOR');
    expect(director).toMatchObject({ name: 'Denis Villeneuve', jobTitle: 'Director' });
  });

  /**
   * The point of storing everyone: a person row that was never created can
   * never be searched for.
   */
  it('keeps a crew member whose job has no role of its own', () => {
    const costume = proposal.crew.find((entry) => entry.jobTitle === 'Costume Design');

    expect(costume).toMatchObject({
      role: 'OTHER',
      department: 'Costume & Make-Up',
      name: 'Renée April',
    });
  });

  it('drops an entry with no id, since there is nothing to upsert it on', () => {
    const broken = {
      ...movie,
      credits: { cast: [{ name: 'Nameless' }], crew: [{ id: 5, job: 'Director' }] },
    };
    const mapped = mapTitle(broken, 'movie', 'US');

    expect(mapped.cast).toEqual([]);
    // ...and one with an id but no name is just as unusable.
    expect(mapped.crew).toEqual([]);
  });
});

describe('mapSearchResults', () => {
  it('reads a film and a show from one multi-search', () => {
    const results = mapSearchResults(search, 'movie');

    expect(results[0]).toMatchObject({ tmdbId: 329865, title: 'Arrival', year: 2016 });
  });

  it('carries the type through, since an id alone is ambiguous', () => {
    // TMDB numbers films and shows separately, so 550 is two different titles.
    expect(mapSearchResults(search, 'tv')[0]!.tmdbType).toBe('tv');
  });

  it('prefers each result’s own media_type when the search returned mixed kinds', () => {
    const mixed = {
      results: [
        { id: 1, name: 'A Show', media_type: 'tv', first_air_date: '2020-01-01' },
        { id: 2, title: 'A Film', media_type: 'movie', release_date: '2019-01-01' },
      ],
    };
    const results = mapSearchResults(mixed, 'movie');

    expect(results.map((entry) => entry.tmdbType)).toEqual(['tv', 'movie']);
  });

  it('ignores a result that is neither a film nor a show', () => {
    const withPerson = { results: [{ id: 9, name: 'Amy Adams', media_type: 'person' }] };

    expect(mapSearchResults(withPerson, 'movie')).toEqual([]);
  });
});

describe('mapEpisodes', () => {
  const episodes = mapEpisodes(season);

  it('reads each episode’s own title, synopsis and air date', () => {
    expect(episodes[0]).toMatchObject({
      episodeNumber: 1,
      seasonNumber: 1,
      title: 'Good News About Hell',
      releaseDate: new Date('2022-02-17'),
    });
    expect(episodes[0]!.description).toContain('Mark');
  });

  it('reads an unknown air date as absent rather than as an invalid date', () => {
    const unaired = { episodes: [{ episode_number: 3, name: 'Later', air_date: '' }] };

    expect(mapEpisodes(unaired)[0]!.releaseDate).toBeNull();
  });

  it('drops an entry with no episode number, since there is nothing to match it to', () => {
    expect(mapEpisodes({ episodes: [{ name: 'Orphan' }] })).toEqual([]);
  });
});
