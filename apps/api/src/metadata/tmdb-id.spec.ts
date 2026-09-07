import { parseTmdbId } from '@video/shared';

/**
 * Lives here rather than beside the source, for the reason `imdb.spec.ts`
 * records: `packages/shared` has no test runner, so a spec there is compiled
 * into `dist` and never executed.
 */

describe('parseTmdbId', () => {
  it('accepts a bare id, with no type', () => {
    expect(parseTmdbId('27205')).toEqual({ tmdbId: 27205, type: null });
  });

  it.each([
    ['a canonical URL with a slug', 'https://www.themoviedb.org/movie/27205-inception'],
    ['no slug', 'https://www.themoviedb.org/movie/27205'],
    ['no scheme, as a browser shows it', 'themoviedb.org/movie/27205-inception'],
    ['a deep link into the page', 'https://www.themoviedb.org/movie/27205-inception/cast'],
    ['a trailing slash', 'https://www.themoviedb.org/movie/27205-inception/'],
  ])('reads %s', (_what, input) => {
    expect(parseTmdbId(input)).toEqual({ tmdbId: 27205, type: 'movie' });
  });

  it('reads a tv URL as tv, not movie', () => {
    expect(parseTmdbId('https://www.themoviedb.org/tv/1399-game-of-thrones')).toEqual({
      tmdbId: 1399,
      type: 'tv',
    });
  });

  it('refuses another site that happens to use the same path', () => {
    expect(parseTmdbId('https://example.com/movie/27205-inception')).toBeNull();
    expect(parseTmdbId('https://notthemoviedb.org/movie/27205-inception')).toBeNull();
  });

  it('refuses a themoviedb.org URL with neither a movie nor a tv path', () => {
    expect(parseTmdbId('https://www.themoviedb.org/person/287-brad-pitt')).toBeNull();
    expect(parseTmdbId('https://www.themoviedb.org/')).toBeNull();
  });

  it('refuses something merely containing digits', () => {
    expect(parseTmdbId('see 27205')).toBeNull();
    expect(parseTmdbId('27205x')).toBeNull();
    expect(parseTmdbId('0')).toBeNull();
    expect(parseTmdbId('-1')).toBeNull();
  });

  it('has nothing to say about nothing', () => {
    expect(parseTmdbId(null)).toBeNull();
    expect(parseTmdbId(undefined)).toBeNull();
    expect(parseTmdbId('')).toBeNull();
    expect(parseTmdbId('   ')).toBeNull();
  });

  it('tolerates surrounding whitespace, which a paste often carries', () => {
    expect(parseTmdbId('  27205  ')).toEqual({ tmdbId: 27205, type: null });
    expect(parseTmdbId('  https://www.themoviedb.org/movie/27205-inception  ')).toEqual({
      tmdbId: 27205,
      type: 'movie',
    });
  });
});
