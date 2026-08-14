import { listLibrarySchema, MAX_LIBRARY_OFFSET } from '@video/shared';

/**
 * What `GET /library` accepts.
 *
 * A query string is not JSON, and every one of these is a coercion that reads
 * as obviously right and is obviously wrong the other way round: a repeated
 * parameter arriving as a bare string, a number arriving as text, a bound that
 * exists because the endpoint's work scales with it.
 */
describe('listLibrarySchema', () => {
  const parse = (query: Record<string, unknown>) => listLibrarySchema.parse(query);

  describe('genre', () => {
    it('reads one genre as a list of one', () => {
      // Express hands over a bare string for `?genre=Drama` and an array for
      // `?genre=Drama&genre=Horror`. A filter that understands only the second
      // silently ignores every single-genre request.
      expect(parse({ genre: 'Drama' }).genre).toEqual(['Drama']);
    });

    it('reads several as they arrive', () => {
      expect(parse({ genre: ['Drama', 'Horror'] }).genre).toEqual(['Drama', 'Horror']);
    });

    it('trims, because a URL carries whatever was pasted into it', () => {
      expect(parse({ genre: '  Drama  ' }).genre).toEqual(['Drama']);
    });

    it('is absent when not asked for, rather than an empty filter', () => {
      expect(parse({}).genre).toBeUndefined();
    });

    it('refuses more terms than a filter has any business carrying', () => {
      const many = Array.from({ length: 21 }, (_, index) => `Genre ${index}`);

      expect(() => parse({ genre: many })).toThrow();
    });
  });

  describe('defaults and bounds', () => {
    it('sorts by title unless told otherwise', () => {
      expect(parse({}).sort).toBe('title');
      expect(parse({ sort: 'year' }).sort).toBe('year');
    });

    it('refuses a sort it does not have', () => {
      // Not silently defaulted: the API says what it accepts, and the page maps
      // an unknown value to a default before it ever gets here.
      expect(() => parse({ sort: 'rating' })).toThrow();
    });

    it('refuses a kind it does not have', () => {
      expect(() => parse({ kind: 'PODCAST' })).toThrow();
      expect(parse({ kind: 'FILM' }).kind).toBe('FILM');
    });

    /**
     * Both sides are read to `offset + limit` and merged, so the offset is what
     * the work scales with — an unbounded one is a request to read the library
     * several times over.
     */
    it('bounds how deep a page may be', () => {
      expect(parse({ offset: String(MAX_LIBRARY_OFFSET) }).offset).toBe(MAX_LIBRARY_OFFSET);
      expect(() => parse({ offset: String(MAX_LIBRARY_OFFSET + 1) })).toThrow();
    });

    it('still caps the page size like every other list', () => {
      expect(parse({}).limit).toBe(50);
      expect(() => parse({ limit: '101' })).toThrow();
    });
  });
});
