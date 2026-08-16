import { searchTermsFor, type SearchSubject } from './search-terms';

const FILM: SearchSubject = {
  title: 'The Matrix',
  year: 1999,
  imdbId: null,
  collectionTitle: null,
  seasonNumber: null,
  episodeNumber: null,
};

const EPISODE: SearchSubject = {
  title: 'Zen, or the Skill to Catch a Killer',
  year: 1990,
  imdbId: null,
  collectionTitle: 'Twin Peaks',
  seasonNumber: 1,
  episodeNumber: 3,
};

describe('searchTermsFor', () => {
  it('asks for a film by its own title and year', () => {
    expect(searchTermsFor(FILM)).toEqual({ query: 'The Matrix', year: 1999 });
  });

  it('asks for an episode by the show, not the episode title', () => {
    // Nobody catalogues a subtitle under "Zen, or the Skill to Catch a Killer".
    // The show plus its numbers is the question every provider can answer.
    expect(searchTermsFor(EPISODE)).toEqual({
      query: 'Twin Peaks',
      seasonNumber: 1,
      episodeNumber: 3,
    });
  });

  it('leaves the year off an episode search', () => {
    // A show's year is the year it started, which is not the year of episode
    // three of season four — sending it narrows the search to nothing.
    expect(searchTermsFor(EPISODE).year).toBeUndefined();
  });

  it('prefers an IMDb id when there is one', () => {
    // An id is exact where a title is a guess, so it replaces the title rather
    // than joining it — sending both lets a bad title contradict a good id.
    const terms = searchTermsFor({ ...FILM, imdbId: 'tt0133093' });

    expect(terms.imdbId).toBe('tt0133093');
    expect(terms.query).toBeUndefined();
  });

  it('keeps the numbers alongside an IMDb id for an episode', () => {
    const terms = searchTermsFor({ ...EPISODE, imdbId: 'tt0098936' });

    expect(terms).toEqual({ imdbId: 'tt0098936', seasonNumber: 1, episodeNumber: 3 });
  });

  it("uses the admin's own words when they type some", () => {
    const terms = searchTermsFor(FILM, 'matrix 1999 remastered');

    expect(terms.query).toBe('matrix 1999 remastered');
    // The id and the year are what the admin is overriding: they are searching
    // by hand precisely because the derived question found nothing.
    expect(terms.imdbId).toBeUndefined();
    expect(terms.year).toBeUndefined();
  });

  it('keeps season and episode when the admin overrides the title', () => {
    // Overriding the show's name is the common case for a mis-titled folder;
    // it does not mean they want every episode ever made.
    const terms = searchTermsFor({ ...EPISODE, imdbId: 'tt0098936' }, 'Twin Peaks 1990');

    expect(terms).toEqual({ query: 'Twin Peaks 1990', seasonNumber: 1, episodeNumber: 3 });
  });

  it('ignores an override that is only whitespace', () => {
    expect(searchTermsFor(FILM, '   ')).toEqual({ query: 'The Matrix', year: 1999 });
  });

  it('falls back to the video title when an episode has no collection', () => {
    // A loose episode with no show attached still has to ask something.
    const orphan = { ...EPISODE, collectionTitle: null };

    expect(searchTermsFor(orphan).query).toBe('Zen, or the Skill to Catch a Killer');
  });

  it('omits an episode number that ingest could not work out', () => {
    const unnumbered = { ...EPISODE, episodeNumber: null };

    expect(searchTermsFor(unnumbered)).toEqual({ query: 'Twin Peaks', seasonNumber: 1 });
  });
});
