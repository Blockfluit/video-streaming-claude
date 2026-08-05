import { parseImdbId } from '@video/shared';

/**
 * Lives here rather than beside the source, for the reason `youtube.spec.ts`
 * records: `packages/shared` has no test runner, so a spec there is compiled
 * into `dist` and never executed.
 */

const TITLE = 'tt1179933';
const NAME = 'nm0000158';

describe('parseImdbId', () => {
  it('accepts an id on its own', () => {
    expect(parseImdbId(TITLE)).toBe(TITLE);
    expect(parseImdbId(NAME, 'name')).toBe(NAME);
  });

  it.each([
    ['a canonical URL', `https://www.imdb.com/title/${TITLE}/`],
    ['no trailing slash', `https://www.imdb.com/title/${TITLE}`],
    ['no scheme, as a browser shows it', `imdb.com/title/${TITLE}/`],
    ['the referrer junk IMDb appends', `https://www.imdb.com/title/${TITLE}/?ref_=nv_sr_1`],
    ['a deep link into the page', `https://www.imdb.com/title/${TITLE}/fullcredits`],
    ['a regional host', `https://m.imdb.com/title/${TITLE}/`],
  ])('reads %s', (_what, input) => {
    expect(parseImdbId(input)).toBe(TITLE);
  });

  it('reads a person URL when a person was asked for', () => {
    expect(parseImdbId(`https://www.imdb.com/name/${NAME}/`, 'name')).toBe(NAME);
  });

  /**
   * The two namespaces are not interchangeable — `/title/nm0000158/` is
   * somebody else's 404 — so a person id in a title field is refused rather
   * than stored to become a dead link that looks deliberate.
   */
  it('refuses the wrong kind', () => {
    expect(parseImdbId(NAME)).toBeNull();
    expect(parseImdbId(TITLE, 'name')).toBeNull();
    expect(parseImdbId(`https://www.imdb.com/name/${NAME}/`)).toBeNull();
  });

  it('refuses something merely containing an id', () => {
    expect(parseImdbId(`see ${TITLE}`)).toBeNull();
    expect(parseImdbId(`${TITLE}x`)).toBeNull();
    expect(parseImdbId('tt')).toBeNull();
    expect(parseImdbId('tt12')).toBeNull();
  });

  it('refuses another site that happens to use the same path', () => {
    expect(parseImdbId(`https://example.com/title/${TITLE}/`)).toBeNull();
    // ...and one whose host merely ends in something similar.
    expect(parseImdbId(`https://notimdb.com/title/${TITLE}/`)).toBeNull();
  });

  it('has nothing to say about nothing', () => {
    expect(parseImdbId(null)).toBeNull();
    expect(parseImdbId(undefined)).toBeNull();
    expect(parseImdbId('')).toBeNull();
    expect(parseImdbId('   ')).toBeNull();
  });

  it('tolerates surrounding whitespace, which a paste often carries', () => {
    expect(parseImdbId(`  ${TITLE} `)).toBe(TITLE);
  });
});
