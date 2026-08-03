import { parseYoutubeId, youtubeEmbedUrl } from '@video/shared';

/**
 * Lives in `apps/api` rather than beside the source in `packages/shared`,
 * because `packages/shared` has no test runner at all — a spec there is compiled
 * into `dist` and never executed, which is the same "reports green while testing
 * nothing" trap as a skip that never runs. `qualityLabel` and `normaliseTitle`
 * are tested from here for the same reason.
 */

/** A real-shaped id: 11 characters, and containing both `-` and `_`. */
const ID = 'dQw4w9Wg-_Q';

describe('parseYoutubeId', () => {
  it('accepts an id on its own', () => {
    expect(parseYoutubeId(ID)).toBe(ID);
  });

  it.each([
    ['watch URL', `https://www.youtube.com/watch?v=${ID}`],
    ['watch URL without www', `https://youtube.com/watch?v=${ID}`],
    ['mobile', `https://m.youtube.com/watch?v=${ID}`],
    ['short link', `https://youtu.be/${ID}`],
    ['embed', `https://www.youtube.com/embed/${ID}`],
    ['privacy embed', `https://www.youtube-nocookie.com/embed/${ID}`],
    ['shorts', `https://www.youtube.com/shorts/${ID}`],
    ['old /v/', `https://www.youtube.com/v/${ID}`],
    ['live', `https://www.youtube.com/live/${ID}`],
    ['http', `http://youtube.com/watch?v=${ID}`],
  ])('reads the id out of a %s', (_name, input) => {
    expect(parseYoutubeId(input)).toBe(ID);
  });

  /**
   * What a share sheet actually produces. The id is one parameter among several
   * and is not always the first — reading "everything after `v=`" gets the
   * timestamp too.
   */
  it.each([
    `https://www.youtube.com/watch?v=${ID}&list=PLA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6&index=2`,
    `https://www.youtube.com/watch?list=PLA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6&v=${ID}`,
    `https://youtu.be/${ID}?si=aBcDeFgHiJkLmNoP&t=42`,
    `https://www.youtube.com/watch?v=${ID}&t=1h2m3s`,
  ])('ignores everything hanging off the URL', (input) => {
    expect(parseYoutubeId(input)).toBe(ID);
  });

  // A browser shows `youtu.be/xyz` without the scheme, so that is what gets copied.
  it('tolerates a missing scheme', () => {
    expect(parseYoutubeId(`youtu.be/${ID}`)).toBe(ID);
    expect(parseYoutubeId(`www.youtube.com/watch?v=${ID}`)).toBe(ID);
  });

  it('trims surrounding whitespace', () => {
    expect(parseYoutubeId(`  https://youtu.be/${ID}  `)).toBe(ID);
  });

  it.each([
    ['nothing', ''],
    ['whitespace', '   '],
    ['null', null],
    ['undefined', undefined],
    ['prose', 'the trailer for it'],
    ['another site', 'https://vimeo.com/123456789'],
    ['a lookalike host', `https://youtube.com.evil.example/watch?v=${ID}`],
    ['a channel', 'https://www.youtube.com/@somechannel'],
    ['a watch URL with no v', 'https://www.youtube.com/watch?list=PL123'],
    ['too short', 'abc123'],
  ])('refuses %s', (_name, input) => {
    expect(parseYoutubeId(input)).toBeNull();
  });

  /**
   * The anchors on the pattern are what does this. A playlist id is 34
   * characters of the same alphabet, so an unanchored match finds an
   * "id-shaped" run inside one and returns a video that does not exist.
   */
  it('does not mistake a playlist id for a video id', () => {
    expect(parseYoutubeId('PLA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6')).toBeNull();
    expect(parseYoutubeId('https://www.youtube.com/playlist?list=PLA1B2C3D4E5F6G7H8')).toBeNull();
  });

  it('is idempotent, so re-saving a stored id does not lose it', () => {
    const once = parseYoutubeId(`https://youtu.be/${ID}`);
    expect(parseYoutubeId(once)).toBe(ID);
  });
});

describe('youtubeEmbedUrl', () => {
  it('embeds through the no-cookie host', () => {
    expect(youtubeEmbedUrl(ID)).toContain('youtube-nocookie.com/embed/' + ID);
  });

  /**
   * Muted is not a default anyone chose — it is the only state a browser will
   * start unprompted, and the failure when it is wrong is silent: the iframe
   * loads and never plays.
   */
  it('starts muted and playing', () => {
    const url = youtubeEmbedUrl(ID);
    expect(url).toContain('mute=1');
    expect(url).toContain('autoplay=1');
  });

  it('can be asked for sound, once a person has clicked something', () => {
    expect(youtubeEmbedUrl(ID, { muted: false })).toContain('mute=0');
  });

  // The hero has its own controls; YouTube's would sit on top of the title.
  it('hides the player chrome', () => {
    expect(youtubeEmbedUrl(ID)).toContain('controls=0');
  });

  // Without it the page cannot hear the video end, and the hero keeps a black
  // frame where the banner should have come back.
  it('enables the JS API so the page can hear it finish', () => {
    expect(youtubeEmbedUrl(ID)).toContain('enablejsapi=1');
  });
});
