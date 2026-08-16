import { isKnownLanguage, languageName, languageNativeName, toIso6391 } from './language';

describe('isKnownLanguage', () => {
  it('knows the common two-letter codes', () => {
    expect(isKnownLanguage('en')).toBe(true);
    expect(isKnownLanguage('nl')).toBe(true);
    expect(isKnownLanguage('fr')).toBe(true);
  });

  // The case this exists for. A language can have two three-letter codes — one
  // from its English name, one from its own — and subtitle files use both.
  it('knows both three-letter forms of the same language', () => {
    expect(isKnownLanguage('dut')).toBe(true);
    expect(isKnownLanguage('nld')).toBe(true);
    expect(isKnownLanguage('ger')).toBe(true);
    expect(isKnownLanguage('deu')).toBe(true);
  });

  it('does not know an invented code', () => {
    expect(isKnownLanguage('zz')).toBe(false);
    expect(isKnownLanguage('qqq')).toBe(false);
  });

  it('ignores casing and stray whitespace', () => {
    expect(isKnownLanguage('EN')).toBe(true);
    expect(isKnownLanguage(' en ')).toBe(true);
  });

  it('says no to an empty code rather than throwing', () => {
    expect(isKnownLanguage('')).toBe(false);
    expect(isKnownLanguage('   ')).toBe(false);
  });
});

describe('languageName', () => {
  it('names a language from any of its codes', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('nl')).toBe('Dutch');
    expect(languageName('dut')).toBe('Dutch');
    expect(languageName('nld')).toBe('Dutch');
  });

  it('returns null for a code it does not know', () => {
    expect(languageName('zz')).toBeNull();
  });
});

describe('toIso6391', () => {
  /**
   * The reason this exists: an extracted track carries whatever the container
   * tagged it with (`eng`), a sidecar carries whatever the filename said
   * (`en`), and both are English. Comparing the raw strings makes them two
   * different languages, which is how "prefer English" would silently skip
   * every embedded track.
   */
  it('gives one answer for every form of the same language', () => {
    expect(toIso6391('en')).toBe('en');
    expect(toIso6391('eng')).toBe('en');
  });

  it('collapses both three-letter forms onto the same two-letter code', () => {
    expect(toIso6391('dut')).toBe('nl');
    expect(toIso6391('nld')).toBe('nl');
    expect(toIso6391('ger')).toBe('de');
    expect(toIso6391('deu')).toBe('de');
  });

  it('ignores casing and stray whitespace, as the other lookups do', () => {
    expect(toIso6391('ENG')).toBe('en');
    expect(toIso6391(' En ')).toBe('en');
  });

  it('returns null rather than guessing at a code it does not know', () => {
    expect(toIso6391('zz')).toBeNull();
    expect(toIso6391('qqq')).toBeNull();
    expect(toIso6391('')).toBeNull();
  });

  /**
   * `und` is what ffprobe reports for an untagged stream, so it arrives often
   * enough to be worth pinning: it is not English, and must not become English.
   */
  it('does not turn an undetermined track into a real language', () => {
    expect(toIso6391('und')).toBeNull();
  });
});

describe('languageNativeName', () => {
  // What a viewer choosing a subtitle track would rather see.
  it('gives the language its own name', () => {
    expect(languageNativeName('nl')).toBe('Nederlands');
    expect(languageNativeName('de')).toBe('Deutsch');
  });

  it('returns null for a code it does not know', () => {
    expect(languageNativeName('zz')).toBeNull();
  });
});
