import { buildDiff, COLLECTION_FIELDS, VIDEO_FIELDS } from './diff';
import type { MetadataProposal } from './tmdb.mapper';

const proposal = (overrides: Partial<MetadataProposal> = {}): MetadataProposal => ({
  tmdbId: 1,
  tmdbType: 'movie',
  imdbId: 'tt1',
  title: 'Arrival',
  description: 'A linguist.',
  tagline: 'Why are they here?',
  year: 2016,
  releaseDate: new Date('2016-11-10'),
  genres: ['Drama', 'Science Fiction'],
  certification: 'PG-13',
  originalTitle: 'Arrival',
  originalLanguage: 'en',
  tmdbRating: 7.6,
  tmdbVoteCount: 18234,
  seriesStatus: null,
  seasonCount: null,
  episodeCount: null,
  trailerYoutubeId: 'tFMo3UJ4B4g',
  posterPath: '/poster.jpg',
  backdropPath: '/backdrop.jpg',
  cast: [],
  crew: [],
  ...overrides,
});

const find = (diffs: ReturnType<typeof buildDiff>, field: string) =>
  diffs.find((entry) => entry.field === field);

describe('buildDiff', () => {
  it('marks a field that would change on an empty record', () => {
    const diffs = buildDiff({}, proposal(), VIDEO_FIELDS);

    expect(find(diffs, 'description')).toMatchObject({
      current: null,
      proposed: 'A linguist.',
      changed: true,
    });
  });

  it('does not mark a field that already holds the same value', () => {
    const diffs = buildDiff({ description: 'A linguist.' }, proposal(), VIDEO_FIELDS);

    expect(find(diffs, 'description')?.changed).toBe(false);
  });

  /**
   * The rule that stops an import being destructive. TMDB not knowing a tagline
   * is not a reason to delete the one somebody wrote, and without this, applying
   * "everything" to a well-curated title empties half of it.
   */
  it('never offers to replace a value with nothing', () => {
    const diffs = buildDiff(
      { description: 'Mine, written by hand.', genres: ['Drama'] },
      proposal({ description: null, genres: [] }),
      VIDEO_FIELDS,
    );

    expect(find(diffs, 'description')?.changed).toBe(false);
    expect(find(diffs, 'genres')?.changed).toBe(false);
  });

  it('compares a list by its contents, not by identity', () => {
    const same = buildDiff({ genres: ['Drama', 'Science Fiction'] }, proposal(), VIDEO_FIELDS);
    expect(find(same, 'genres')?.changed).toBe(false);

    const reordered = buildDiff({ genres: ['Science Fiction', 'Drama'] }, proposal(), VIDEO_FIELDS);
    expect(find(reordered, 'genres')?.changed).toBe(true);
  });

  it('compares a date by the moment it names, not by object identity', () => {
    const diffs = buildDiff({ releaseDate: new Date('2016-11-10') }, proposal(), VIDEO_FIELDS);

    expect(find(diffs, 'releaseDate')?.changed).toBe(false);
  });

  describe('what is ticked by default', () => {
    /**
     * Every changed field is suggested except the title. Renaming a title an
     * admin has already fixed — and it is usually the first thing they fix — is
     * the most annoying possible default, and a slug does not follow a rename,
     * so the shared link and the name would then disagree.
     */
    it('suggests a changed field', () => {
      const diffs = buildDiff({}, proposal(), VIDEO_FIELDS);

      expect(find(diffs, 'description')?.suggested).toBe(true);
      expect(find(diffs, 'year')?.suggested).toBe(true);
    });

    it('does not suggest the title, even when it would change', () => {
      const diffs = buildDiff({ title: 'arrival.2016.1080p' }, proposal(), VIDEO_FIELDS);

      expect(find(diffs, 'title')?.changed).toBe(true);
      expect(find(diffs, 'title')?.suggested).toBe(false);
    });

    it('does not suggest a field that is not changing', () => {
      const diffs = buildDiff({ description: 'A linguist.' }, proposal(), VIDEO_FIELDS);

      expect(find(diffs, 'description')?.suggested).toBe(false);
    });
  });

  describe('which fields a target has', () => {
    /**
     * A film has no season count, and offering one is a checkbox that writes to
     * a column that is not there.
     */
    it('leaves the series-only fields out of a video’s diff', () => {
      const fields = buildDiff({}, proposal(), VIDEO_FIELDS).map((entry) => entry.field);

      expect(fields).not.toContain('seriesStatus');
      expect(fields).not.toContain('seasonCount');
      expect(fields).not.toContain('episodeCount');
    });

    it('includes them for a collection', () => {
      const fields = buildDiff({}, proposal(), COLLECTION_FIELDS).map((entry) => entry.field);

      expect(fields).toContain('seriesStatus');
      expect(fields).toContain('seasonCount');
    });

    it('returns the fields in the order they were asked for, so the table is stable', () => {
      const fields = buildDiff({}, proposal(), VIDEO_FIELDS).map((entry) => entry.field);

      expect(fields).toEqual([...VIDEO_FIELDS]);
    });
  });
});
