import { SLUG_FALLBACK, seasonSlug, slugify, uniqueSlug } from './slug';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Harry Potter')).toBe('harry-potter');
    expect(slugify('South Park')).toBe('south-park');
  });

  it('drops punctuation that has no place in a URL', () => {
    expect(slugify("Philosopher's Stone")).toBe('philosophers-stone');
    expect(slugify('Cartman Gets an Anal Probe!')).toBe('cartman-gets-an-anal-probe');
    expect(slugify('What?! Really...')).toBe('what-really');
  });

  it('folds accents rather than dropping the letters', () => {
    expect(slugify('Amélie')).toBe('amelie');
    expect(slugify('Jägerbataillon')).toBe('jagerbataillon');
  });

  it('collapses runs of separators', () => {
    expect(slugify('A   B')).toBe('a-b');
    expect(slugify('A -- B')).toBe('a-b');
    expect(slugify('  Leading and trailing  ')).toBe('leading-and-trailing');
  });

  it('keeps digits', () => {
    expect(slugify('Blade Runner 2049')).toBe('blade-runner-2049');
    expect(slugify('2001 A Space Odyssey')).toBe('2001-a-space-odyssey');
  });

  // A slug is a URL component, so an empty one would produce a route that
  // cannot be linked to.
  it('never returns an empty slug', () => {
    expect(slugify('')).toBe(SLUG_FALLBACK);
    expect(slugify('...')).toBe(SLUG_FALLBACK);
    expect(slugify('???')).toBe(SLUG_FALLBACK);
  });

  it('produces something usable from a title with no latin characters', () => {
    expect(slugify('日本語')).not.toBe('');
    expect(slugify('日本語')).toMatch(/^[a-z0-9-]+$/);
  });

  it('is idempotent', () => {
    const once = slugify("Philosopher's Stone");
    expect(slugify(once)).toBe(once);
  });
});

describe('uniqueSlug', () => {
  it('leaves a free slug alone', () => {
    expect(uniqueSlug('pilot', [])).toBe('pilot');
    expect(uniqueSlug('pilot', ['other'])).toBe('pilot');
  });

  it('suffixes from -2 upwards, the way a person would number them', () => {
    expect(uniqueSlug('pilot', ['pilot'])).toBe('pilot-2');
    expect(uniqueSlug('pilot', ['pilot', 'pilot-2'])).toBe('pilot-3');
    expect(uniqueSlug('pilot', ['pilot', 'pilot-2', 'pilot-3'])).toBe('pilot-4');
  });

  it('fills a gap left by a deletion rather than counting past it', () => {
    expect(uniqueSlug('pilot', ['pilot', 'pilot-3'])).toBe('pilot-2');
  });

  it('is not confused by a similar slug that is not a numbered variant', () => {
    expect(uniqueSlug('pilot', ['pilot-episode'])).toBe('pilot');
  });

  it('accepts a Set as well as an array', () => {
    expect(uniqueSlug('pilot', new Set(['pilot']))).toBe('pilot-2');
  });

  // Scope is the caller's business: the same slug is free in a different
  // collection, which is why `taken` is passed in rather than looked up here.
  it('only knows about the slugs it is given', () => {
    expect(uniqueSlug('pilot', ['pilot'])).toBe('pilot-2');
    expect(uniqueSlug('pilot', [])).toBe('pilot');
  });
});

describe('seasonSlug', () => {
  it('numbers a season the way the URLs in the plan read', () => {
    expect(seasonSlug(1, 'Season 01')).toBe('season-1');
    expect(seasonSlug(12, 'Season 12')).toBe('season-12');
  });

  // Leading zeros in the folder name must not reach the URL, or
  // /season-01 and /season-1 become two different pages.
  it('drops leading zeros from the number', () => {
    expect(seasonSlug(1, 'Season 001')).toBe('season-1');
  });

  it('falls back to the folder name when the number could not be read', () => {
    expect(seasonSlug(null, 'Specials')).toBe('specials');
    expect(seasonSlug(null, 'Bonus Features')).toBe('bonus-features');
  });
});
