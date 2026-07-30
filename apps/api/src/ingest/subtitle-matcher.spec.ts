import {
  isKnownLanguage,
  matchSubtitles,
  parseSubtitleName,
  type SubtitleCandidate,
  type VideoCandidate,
} from './subtitle-matcher';

const videoNamed = (basename: string, id = basename): VideoCandidate => ({ id, basename });
const subtitleNamed = (basename: string, extension = 'vtt'): SubtitleCandidate => ({
  basename,
  extension,
});

describe('parseSubtitleName', () => {
  it('splits stem, language and label', () => {
    expect(parseSubtitleName("01 - Philosopher's Stone_en_English")).toMatchObject({
      stem: "01 - Philosopher's Stone",
      lang: 'en',
      label: 'English',
    });
  });

  it('accepts three-letter codes', () => {
    expect(parseSubtitleName('film_dut_Nederlands')).toMatchObject({ lang: 'dut' });
  });

  it('keeps a label containing spaces and brackets', () => {
    expect(parseSubtitleName('01 - Pilot_en_English (SDH)')).toMatchObject({
      lang: 'en',
      label: 'English (SDH)',
    });
    expect(parseSubtitleName('film_en_Forced')).toMatchObject({ label: 'Forced' });
  });

  // The stem may itself contain underscores, so the split has to come from the
  // right — the last two underscore-separated parts are lang and label.
  it('takes the last two fields when the stem has underscores of its own', () => {
    expect(parseSubtitleName('My_Film_Name_en_English')).toMatchObject({
      stem: 'My_Film_Name',
      lang: 'en',
      label: 'English',
    });
  });

  // A stem containing a short word is where a non-greedy split goes wrong:
  // `The` and `Big` are both plausible-looking language codes, so splitting
  // from the left would read this as stem `The`, lang `Big`.
  it('is not fooled by a short word inside the stem', () => {
    expect(parseSubtitleName('The_Big_Sky_en_English')).toMatchObject({
      stem: 'The_Big_Sky',
      lang: 'en',
      label: 'English',
    });
  });

  it('rejects a name that is not in the sidecar shape', () => {
    expect(parseSubtitleName('subtitles')).toBeNull();
    expect(parseSubtitleName('film_en')).toBeNull();
    expect(parseSubtitleName('film__English')).toBeNull();
  });

  it('rejects a language field that is not a plausible code', () => {
    expect(parseSubtitleName('film_english_English')).toBeNull();
    expect(parseSubtitleName('film_e_English')).toBeNull();
    expect(parseSubtitleName('film_12_English')).toBeNull();
  });

  it('normalises the language code to lowercase', () => {
    expect(parseSubtitleName('film_EN_English')).toMatchObject({ lang: 'en' });
  });
});

describe('isKnownLanguage', () => {
  it('knows the common two-letter codes', () => {
    expect(isKnownLanguage('en')).toBe(true);
    expect(isKnownLanguage('nl')).toBe(true);
    expect(isKnownLanguage('fr')).toBe(true);
  });

  it('knows three-letter codes, in both bibliographic and terminological forms', () => {
    expect(isKnownLanguage('eng')).toBe(true);
    expect(isKnownLanguage('dut')).toBe(true);
    expect(isKnownLanguage('nld')).toBe(true);
  });

  it('does not know an invented code', () => {
    expect(isKnownLanguage('zz')).toBe(false);
    expect(isKnownLanguage('qqq')).toBe(false);
  });
});

describe('matchSubtitles', () => {
  it('binds a sidecar whose stem is exactly the video filename', () => {
    const result = matchSubtitles(
      [videoNamed("01 - Philosopher's Stone")],
      [subtitleNamed("01 - Philosopher's Stone_en_English")],
    );

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({
      videoId: "01 - Philosopher's Stone",
      lang: 'en',
      label: 'English',
    });
    expect(result.unmatched).toHaveLength(0);
  });

  // The plan's second rule: the sidecar may be named after the cleaned title
  // rather than the full filename.
  it('binds a sidecar named after the cleaned title', () => {
    const result = matchSubtitles(
      [videoNamed("01 - Philosopher's Stone")],
      [subtitleNamed("Philosopher's Stone_nl_Nederlands")],
    );

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({ lang: 'nl', matchedBy: 'cleaned-title' });
  });

  it('binds several languages to one video', () => {
    const result = matchSubtitles(
      [videoNamed('Inception')],
      [
        subtitleNamed('Inception_en_English'),
        subtitleNamed('Inception_nl_Nederlands'),
        subtitleNamed('Inception_en_English (SDH)'),
      ],
    );

    expect(result.bindings).toHaveLength(3);
    expect(result.unmatched).toHaveLength(0);
  });

  it('reports a sidecar that matches nothing instead of dropping it', () => {
    const result = matchSubtitles(
      [videoNamed('Inception')],
      [subtitleNamed('Interstellar_en_English')],
    );

    expect(result.bindings).toHaveLength(0);
    expect(result.unmatched).toEqual([
      expect.objectContaining({ basename: 'Interstellar_en_English', reason: 'no-match' }),
    ]);
  });

  it('reports a file that is not in the sidecar shape at all', () => {
    const result = matchSubtitles([videoNamed('Inception')], [subtitleNamed('Inception')]);

    expect(result.unmatched).toEqual([
      expect.objectContaining({ reason: 'unparseable-name' }),
    ]);
  });

  describe('ambiguity', () => {
    // Two videos whose cleaned titles collide. The plan is explicit: resolve to
    // the exact match, and otherwise flag rather than guess.
    const videos = [
      videoNamed('01 - Pilot', 'a'),
      videoNamed('02 - Pilot', 'b'),
    ];

    it('resolves to the exact stem match when there is one', () => {
      const result = matchSubtitles(videos, [subtitleNamed('01 - Pilot_en_English')]);

      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0]).toMatchObject({ videoId: 'a', matchedBy: 'exact-stem' });
      expect(result.unmatched).toHaveLength(0);
    });

    it('flags rather than guessing when only the cleaned titles match', () => {
      const result = matchSubtitles(videos, [subtitleNamed('Pilot_en_English')]);

      expect(result.bindings).toHaveLength(0);
      expect(result.unmatched).toEqual([
        expect.objectContaining({ reason: 'ambiguous', candidateVideoIds: ['a', 'b'] }),
      ]);
    });
  });

  describe('language reporting', () => {
    it('accepts an unknown code but flags it', () => {
      const result = matchSubtitles([videoNamed('Inception')], [subtitleNamed('Inception_zz_Klingon')]);

      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0]).toMatchObject({ lang: 'zz', langKnown: false });
    });

    it('does not flag a code it knows', () => {
      const result = matchSubtitles([videoNamed('Inception')], [subtitleNamed('Inception_en_English')]);

      expect(result.bindings[0].langKnown).toBe(true);
    });
  });

  it('keeps the extension so the converter knows what it is dealing with', () => {
    const result = matchSubtitles(
      [videoNamed('Inception')],
      [subtitleNamed('Inception_en_English', 'srt')],
    );

    expect(result.bindings[0]).toMatchObject({ extension: 'srt', needsConversion: true });
  });

  it('marks a vtt sidecar as ready to serve', () => {
    const result = matchSubtitles(
      [videoNamed('Inception')],
      [subtitleNamed('Inception_en_English', 'vtt')],
    );

    expect(result.bindings[0].needsConversion).toBe(false);
  });

  it('handles an empty folder without complaint', () => {
    expect(matchSubtitles([], [])).toEqual({ bindings: [], unmatched: [] });
  });

  it('reports every sidecar in a folder with no videos', () => {
    const result = matchSubtitles([], [subtitleNamed('Inception_en_English')]);

    expect(result.unmatched).toHaveLength(1);
  });
});
