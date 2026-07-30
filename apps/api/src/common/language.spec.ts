import { isKnownLanguage, languageName, languageNativeName } from './language';

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
