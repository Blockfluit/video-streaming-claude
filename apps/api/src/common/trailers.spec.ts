import {
  YOUTUBE_ID_PATTERN,
  YOUTUBE_EMBED_ORIGIN,
  parseYoutubeId,
  youtubeEmbedUrl,
  trailerYoutubeIdFor,
} from '@video/shared';

/**
 * The trailer helpers, tested from here rather than from `packages/shared`.
 *
 * `packages/shared` has no test runner of its own — `qualityLabel` is tested the
 * same way, from `media/quality.spec.ts`. The package is built by `pretest`, so
 * these run against the emitted CJS half, which is also what the API imports.
 */

describe('parseYoutubeId', () => {
  const ID = 'dQw4w9WgXcQ';

  it.each([
    ['a bare id', ID],
    ['a watch URL', `https://www.youtube.com/watch?v=${ID}`],
    ['a watch URL with other params first', `https://www.youtube.com/watch?feature=share&v=${ID}`],
    ['a watch URL with params after', `https://www.youtube.com/watch?v=${ID}&t=42s`],
    ['a short link', `https://youtu.be/${ID}`],
    ['a short link with a timestamp', `https://youtu.be/${ID}?t=42`],
    ['an embed URL', `https://www.youtube.com/embed/${ID}`],
    ['a nocookie embed URL', `https://www.youtube-nocookie.com/embed/${ID}`],
    ['a shorts URL', `https://www.youtube.com/shorts/${ID}`],
    ['a live URL', `https://www.youtube.com/live/${ID}`],
    ['the mobile host', `https://m.youtube.com/watch?v=${ID}`],
    ['the music host', `https://music.youtube.com/watch?v=${ID}`],
    ['no www', `https://youtube.com/watch?v=${ID}`],
    ['http rather than https', `http://www.youtube.com/watch?v=${ID}`],
    ['no protocol', `www.youtube.com/watch?v=${ID}`],
    ['protocol-relative', `//www.youtube.com/watch?v=${ID}`],
    ['surrounding whitespace', `  https://youtu.be/${ID}  `],
  ])('reads %s', (_case, input) => {
    expect(parseYoutubeId(input)).toBe(ID);
  });

  it('accepts the full id alphabet, including - and _', () => {
    expect(parseYoutubeId('a-b_c1D2E3F')).toBe('a-b_c1D2E3F');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace alone', '   '],
    ['a ten-character id', 'dQw4w9WgXc'],
    ['a twelve-character id', 'dQw4w9WgXcQZ'],
    ['an id with an illegal character', 'dQw4w9WgXc!'],
    ['a channel URL', 'https://www.youtube.com/@someone'],
    ['a playlist URL', 'https://www.youtube.com/playlist?list=PL1234567890'],
    ['a bare sentence', 'the trailer for the thing'],
  ])('rejects %s', (_case, input) => {
    expect(parseYoutubeId(input)).toBeNull();
  });

  /**
   * The host check has to be real. Matching `v=` anywhere would accept any site
   * that happens to use the same parameter name, and the embed would then fail
   * silently on a viewer's screen rather than at the point someone pasted it.
   */
  it('rejects a non-YouTube host that carries a v= parameter', () => {
    expect(parseYoutubeId(`https://evil.example/watch?v=${ID}`)).toBeNull();
    expect(parseYoutubeId(`https://notyoutube.com/watch?v=${ID}`)).toBeNull();
  });

  it('rejects a host that merely ends with the right letters', () => {
    expect(parseYoutubeId(`https://fakeyoutube.com/watch?v=${ID}`)).toBeNull();
  });
});

describe('YOUTUBE_ID_PATTERN', () => {
  it('is anchored, so a longer string is not a match with an id inside it', () => {
    expect(YOUTUBE_ID_PATTERN.test('dQw4w9WgXcQ')).toBe(true);
    expect(YOUTUBE_ID_PATTERN.test('xxdQw4w9WgXcQxx')).toBe(false);
  });
});

describe('youtubeEmbedUrl', () => {
  const ID = 'dQw4w9WgXcQ';

  it('embeds through the nocookie host', () => {
    expect(youtubeEmbedUrl(ID)).toContain(`${YOUTUBE_EMBED_ORIGIN}/embed/${ID}`);
  });

  /**
   * The one that bites. `loop=1` on a single video does nothing at all unless
   * `playlist` names that same video — the trailer plays once and stops, which
   * reads as a bug rather than as a missing parameter.
   */
  it('pairs loop with a playlist naming the same video', () => {
    const url = new URL(youtubeEmbedUrl(ID, { loop: true }));

    expect(url.searchParams.get('loop')).toBe('1');
    expect(url.searchParams.get('playlist')).toBe(ID);
  });

  it('does not send a playlist when it is not looping', () => {
    const url = new URL(youtubeEmbedUrl(ID, { loop: false }));

    expect(url.searchParams.get('playlist')).toBeNull();
  });

  it('mutes and autoplays when asked', () => {
    const url = new URL(youtubeEmbedUrl(ID, { autoplay: true, mute: true }));

    expect(url.searchParams.get('autoplay')).toBe('1');
    expect(url.searchParams.get('mute')).toBe('1');
  });

  it('sends mute=0 rather than omitting it, so the value is never ambiguous', () => {
    const url = new URL(youtubeEmbedUrl(ID, { mute: false }));

    expect(url.searchParams.get('mute')).toBe('0');
  });

  /**
   * `enablejsapi` without an `origin` is refused by YouTube, and the origin can
   * only be read in a browser — so the pair travels together or not at all.
   */
  it('sends origin alongside enablejsapi', () => {
    const url = new URL(youtubeEmbedUrl(ID, { jsApi: true, origin: 'https://library.example' }));

    expect(url.searchParams.get('enablejsapi')).toBe('1');
    expect(url.searchParams.get('origin')).toBe('https://library.example');
  });

  it('omits enablejsapi when no origin is available', () => {
    const url = new URL(youtubeEmbedUrl(ID, { jsApi: true }));

    expect(url.searchParams.get('enablejsapi')).toBeNull();
  });

  it('hides the chrome a background trailer must not show', () => {
    const url = new URL(youtubeEmbedUrl(ID, { controls: false }));

    expect(url.searchParams.get('controls')).toBe('0');
    expect(url.searchParams.get('rel')).toBe('0');
    expect(url.searchParams.get('iv_load_policy')).toBe('3');
    expect(url.searchParams.get('playsinline')).toBe('1');
  });

  it('refuses an id it would not have parsed, rather than building a dead URL', () => {
    expect(() => youtubeEmbedUrl('not-an-id')).toThrow();
  });
});

describe('trailerYoutubeIdFor', () => {
  const own = { trailerYoutubeId: 'aaaaaaaaaaa' };
  const parent = { trailerYoutubeId: 'bbbbbbbbbbb' };

  it("prefers the video's own trailer", () => {
    expect(trailerYoutubeIdFor(own, parent)).toBe('aaaaaaaaaaa');
  });

  it("falls back to the collection's", () => {
    expect(trailerYoutubeIdFor({ trailerYoutubeId: null }, parent)).toBe('bbbbbbbbbbb');
  });

  it('is null when neither has one', () => {
    expect(trailerYoutubeIdFor({ trailerYoutubeId: null }, { trailerYoutubeId: null })).toBeNull();
  });

  it('treats a blank string as absent, because a cleared field can arrive either way', () => {
    expect(trailerYoutubeIdFor({ trailerYoutubeId: '  ' }, parent)).toBe('bbbbbbbbbbb');
  });

  it('survives a missing video or a missing collection', () => {
    expect(trailerYoutubeIdFor(null, parent)).toBe('bbbbbbbbbbb');
    expect(trailerYoutubeIdFor(own, null)).toBe('aaaaaaaaaaa');
    expect(trailerYoutubeIdFor(null, null)).toBeNull();
    expect(trailerYoutubeIdFor(undefined, undefined)).toBeNull();
  });
});
