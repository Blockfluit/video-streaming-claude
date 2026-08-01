import { mapYoutubeSearchResponse, redactKey } from './youtube-search';

const ID = 'dQw4w9WgXcQ';

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: { kind: 'youtube#video', videoId: ID },
    snippet: {
      title: 'Dune: Part Two | Official Trailer',
      channelTitle: 'Warner Bros. Pictures',
      description: 'In theatres now.',
      publishedAt: '2026-01-01T00:00:00Z',
      thumbnails: {
        default: { url: 'https://i.ytimg.com/vi/x/default.jpg' },
        medium: { url: 'https://i.ytimg.com/vi/x/mqdefault.jpg' },
        high: { url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' },
      },
    },
    ...overrides,
  };
}

describe('mapYoutubeSearchResponse', () => {
  it('maps a result to the fields the picker renders', () => {
    expect(mapYoutubeSearchResponse({ items: [item()] })).toEqual([
      {
        youtubeId: ID,
        title: 'Dune: Part Two | Official Trailer',
        channelTitle: 'Warner Bros. Pictures',
        description: 'In theatres now.',
        publishedAt: '2026-01-01T00:00:00Z',
        thumbnailUrl: 'https://i.ytimg.com/vi/x/mqdefault.jpg',
      },
    ]);
  });

  it('prefers the medium thumbnail and falls back through the others', () => {
    const noMedium = item({
      snippet: { title: 'T', thumbnails: { high: { url: 'high.jpg' } } },
    });

    expect(mapYoutubeSearchResponse({ items: [noMedium] })[0]!.thumbnailUrl).toBe('high.jpg');
  });

  /**
   * Tolerant on purpose. Nine good results and one odd one should show nine —
   * the admin is picking a trailer, not auditing Google's schema.
   */
  it('drops a result with no usable video id rather than failing the search', () => {
    const results = mapYoutubeSearchResponse({
      items: [item(), { id: { kind: 'youtube#channel', channelId: 'UC123' } }, { id: {} }],
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.youtubeId).toBe(ID);
  });

  it('drops an id that is not shaped like a video id', () => {
    expect(mapYoutubeSearchResponse({ items: [item({ id: { videoId: 'too-short' } })] })).toEqual([]);
  });

  /** A card with no label is unusable; naming it by its id at least selects. */
  it('names a titleless result by its id', () => {
    expect(mapYoutubeSearchResponse({ items: [item({ snippet: {} })] })[0]).toMatchObject({
      youtubeId: ID,
      title: ID,
      channelTitle: null,
      thumbnailUrl: null,
    });
  });

  it('survives a missing snippet entirely', () => {
    expect(mapYoutubeSearchResponse({ items: [{ id: { videoId: ID } }] })[0]).toMatchObject({
      youtubeId: ID,
      title: ID,
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['an object with no items', {}],
    ['items that are not an array', { items: 'nope' }],
  ])('returns nothing for %s rather than throwing', (_case, payload) => {
    expect(mapYoutubeSearchResponse(payload)).toEqual([]);
  });

  it('treats a blank field as absent', () => {
    const blank = item({ snippet: { title: '   ', channelTitle: '' } });

    expect(mapYoutubeSearchResponse({ items: [blank] })[0]).toMatchObject({
      title: ID,
      channelTitle: null,
    });
  });
});

/**
 * The key travels as a query parameter, so the request URL *is* the credential
 * — and `fetch` puts the whole URL into the error it throws.
 */
describe('redactKey', () => {
  it('removes the key from a message', () => {
    const message = 'request to https://googleapis.com/v3/search?q=x&key=SECRET123 failed';

    expect(redactKey(message, 'SECRET123')).not.toContain('SECRET123');
    expect(redactKey(message, 'SECRET123')).toContain('[redacted]');
  });

  it('removes every occurrence, not just the first', () => {
    expect(redactKey('SECRET SECRET SECRET', 'SECRET')).toBe('[redacted] [redacted] [redacted]');
  });

  it('leaves the text alone when no key is configured', () => {
    expect(redactKey('nothing to hide', undefined)).toBe('nothing to hide');
    expect(redactKey('nothing to hide', '')).toBe('nothing to hide');
  });
});
