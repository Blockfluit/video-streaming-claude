import { pickDefaultTrack, type DefaultCandidate } from './default-track';

function track(overrides: Partial<DefaultCandidate> & { id: string }): DefaultCandidate {
  return { language: 'en', label: 'English', isDefault: false, ...overrides };
}

describe('pickDefaultTrack', () => {
  it('picks the English track', () => {
    const chosen = pickDefaultTrack([
      track({ id: 'nl', language: 'nl', label: 'Nederlands' }),
      track({ id: 'en', language: 'en', label: 'English' }),
    ]);

    expect(chosen).toBe('en');
  });

  /**
   * The case the whole thing turns on. An extracted track carries the
   * container's three-letter tag, so a naive `language === 'en'` would leave
   * every embedded English track unselected — which is most of them.
   */
  it('recognises English however the file spelled it', () => {
    expect(pickDefaultTrack([track({ id: 'a', language: 'eng' })])).toBe('a');
    expect(pickDefaultTrack([track({ id: 'b', language: 'EN' })])).toBe('b');
  });

  /**
   * English only, deliberately. A default on the wrong language is worse than
   * no default: the viewer gets subtitles they cannot read and has to work out
   * which menu turned them on. With none set, the browser shows nothing until
   * they choose, which is the honest state.
   */
  it('leaves a video with no English track with no default at all', () => {
    const chosen = pickDefaultTrack([
      track({ id: 'nl', language: 'nl', label: 'Nederlands' }),
      track({ id: 'de', language: 'ger', label: 'Deutsch' }),
    ]);

    expect(chosen).toBeNull();
  });

  it('has nothing to pick from an empty list', () => {
    expect(pickDefaultTrack([])).toBeNull();
  });

  it('does not mistake an undetermined track for English', () => {
    expect(pickDefaultTrack([track({ id: 'a', language: 'und' })])).toBeNull();
  });

  /**
   * A rescan must not reshuffle a settled choice. Nothing about the library
   * changed, so nothing about the answer should either — and a default that
   * moves between passes reads as a rendering bug for weeks before anyone
   * suspects the picker.
   */
  it('keeps an English track that is already the default', () => {
    const chosen = pickDefaultTrack([
      track({ id: 'sdh', label: 'English (SDH)', isDefault: true }),
      track({ id: 'plain', label: 'English' }),
    ]);

    expect(chosen).toBe('sdh');
  });

  it('ignores a non-English track that somehow holds the default', () => {
    const chosen = pickDefaultTrack([
      track({ id: 'nl', language: 'nl', label: 'Nederlands', isDefault: true }),
      track({ id: 'en', label: 'English' }),
    ]);

    expect(chosen).toBe('en');
  });

  /**
   * Total, not merely "sorted by label". The two ends of a video's subtitle
   * list are numbered independently, so ties are normal rather than
   * exceptional, and a tie broken by whatever order the database returned is a
   * default that moves on its own.
   */
  it('breaks a tie the same way every time', () => {
    const tracks = [
      track({ id: 'z', label: 'English' }),
      track({ id: 'a', label: 'English' }),
    ];

    expect(pickDefaultTrack(tracks)).toBe('a');
    expect(pickDefaultTrack([...tracks].reverse())).toBe('a');
  });

  it('orders by label before falling back to id', () => {
    const chosen = pickDefaultTrack([
      track({ id: 'a', label: 'English (SDH)' }),
      track({ id: 'z', label: 'English' }),
    ]);

    expect(chosen).toBe('z');
  });

  it('does not mutate the list it was given', () => {
    const tracks = [track({ id: 'z', label: 'English' }), track({ id: 'a', label: 'English' })];
    const order = tracks.map((entry) => entry.id);

    pickDefaultTrack(tracks);

    expect(tracks.map((entry) => entry.id)).toEqual(order);
  });
});
