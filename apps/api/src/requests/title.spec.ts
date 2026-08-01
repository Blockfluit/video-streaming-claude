import { normaliseTitle } from '@video/shared';

/**
 * The comparison key behind "is this already in the library?".
 *
 * Lives in `packages/shared` and is tested from here, the way `qualityLabel` is
 * — the API is the only thing that runs it, and this is where the test runner
 * lives.
 */
describe('normaliseTitle', () => {
  it('ignores case, punctuation and spacing', () => {
    const expected = 'thematrix';

    expect(normaliseTitle('The Matrix')).toBe(expected);
    expect(normaliseTitle('the matrix')).toBe(expected);
    expect(normaliseTitle('THE  MATRIX')).toBe(expected);
    expect(normaliseTitle('The Matrix!')).toBe(expected);
    expect(normaliseTitle('  The   Matrix  ')).toBe(expected);
    expect(normaliseTitle('the-matrix')).toBe(expected);
  });

  it('folds accents onto their base letters', () => {
    expect(normaliseTitle('Amélie')).toBe('amelie');
    expect(normaliseTitle('Amelie')).toBe('amelie');
    expect(normaliseTitle('Léon: The Professional')).toBe('leontheprofessional');
    expect(normaliseTitle('LEON THE PROFESSIONAL')).toBe('leontheprofessional');
  });

  it('drops a trailing bracketed year, which is how people type a film title', () => {
    expect(normaliseTitle('The Matrix (1999)')).toBe(normaliseTitle('The Matrix'));
    expect(normaliseTitle('Das Boot [1981]')).toBe(normaliseTitle('Das Boot'));
    expect(normaliseTitle('Amélie ( 2001 )')).toBe(normaliseTitle('Amelie'));
  });

  /*
   * The other half of that rule, and the reason it is anchored and bracketed
   * rather than "remove any four digits". These titles *are* their numbers.
   */
  it('keeps digits that are part of the title', () => {
    expect(normaliseTitle('Blade Runner 2049')).toBe('bladerunner2049');
    expect(normaliseTitle('2001: A Space Odyssey')).toBe('2001aspaceodyssey');
    expect(normaliseTitle('Se7en')).toBe('se7en');
    // Not a year, and not trailing — stays put.
    expect(normaliseTitle('Ocean\'s (Eleven)')).toBe('oceanseleven');
  });

  /*
   * Deliberately NOT matching. Dropping leading articles would match "The
   * Thing" to "Thing", which is usually right, and "The Others" to "Others",
   * which is not — and a false match refuses a legitimate request.
   */
  it('keeps leading articles, so an article is a difference', () => {
    expect(normaliseTitle('The Thing')).not.toBe(normaliseTitle('Thing'));
    expect(normaliseTitle('A Star Is Born')).not.toBe(normaliseTitle('Star Is Born'));
  });

  it('distinguishes different titles', () => {
    expect(normaliseTitle('The Matrix')).not.toBe(normaliseTitle('The Matrix Reloaded'));
    expect(normaliseTitle('Heat')).not.toBe(normaliseTitle('Heart'));
  });

  /*
   * A title made entirely of punctuation still has to be a usable key: two rows
   * spelled the same compare equal, two spelled differently do not. Falling
   * back to the lowercased original is what keeps both true — returning '' for
   * everything would make every such title a duplicate of every other.
   */
  it('never collapses a non-empty title to the empty key', () => {
    expect(normaliseTitle('???')).toBe('???');
    expect(normaliseTitle('???')).not.toBe(normaliseTitle('!!!'));
    expect(normaliseTitle('日本語')).toBe('日本語');
    expect(normaliseTitle('日本語')).not.toBe(normaliseTitle('한국어'));
  });

  it('reserves the empty key for input with no content at all', () => {
    expect(normaliseTitle('')).toBe('');
    expect(normaliseTitle('   ')).toBe('');
  });
});
