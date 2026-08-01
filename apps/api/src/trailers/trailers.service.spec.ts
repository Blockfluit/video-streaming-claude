import { ConfigService } from '@nestjs/config';

import { TrailersService } from './trailers.service';

/**
 * The search proxy's failure modes.
 *
 * Never a live call: these run in CI, and a test that depends on Google
 * answering is a test that fails for reasons having nothing to do with the
 * code.
 */

const KEY = 'AIzaSy-not-a-real-key-000000000000000000';

function serviceWith(key: string | undefined) {
  const config = { get: () => key } as unknown as ConfigService;
  const service = new TrailersService(config);
  // Silence the warnings these tests deliberately provoke.
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  return service;
}

const query = { q: 'dune trailer', limit: 10 };

describe('TrailersService.search', () => {
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  /** Unconfigured is an ordinary state, not an error — paste still works. */
  it('explains itself when no key is configured, and never calls out', async () => {
    fetchSpy = jest.spyOn(global, 'fetch');
    const service = serviceWith(undefined);

    await expect(service.search(query)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('not configured'),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a successful response', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Dune | Trailer' } }],
      }),
    } as Response);

    const page = await serviceWith(KEY).search(query);

    expect(page.items).toEqual([
      expect.objectContaining({ youtubeId: 'dQw4w9WgXcQ', title: 'Dune | Trailer' }),
    ]);
    expect(page).toMatchObject({ total: 1, limit: 10, offset: 0, hasMore: false });
  });

  it('asks only for embeddable videos', async () => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [] }) } as Response);

    await serviceWith(KEY).search(query);

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.get('videoEmbeddable')).toBe('true');
    expect(url.searchParams.get('type')).toBe('video');
    expect(url.searchParams.get('q')).toBe('dune trailer');
  });

  /**
   * 403 is overwhelmingly the quota, which is the one failure an admin can act
   * on — 100 units a search against a 10,000/day default.
   */
  it.each([403, 429])('reports %s as an unavailable service, naming the quota', async (status) => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status } as Response);

    await expect(serviceWith(KEY).search(query)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('quota'),
    });
  });

  it.each([400, 404, 500, 503])('reports %s upstream as a bad gateway', async (status) => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status } as Response);

    await expect(serviceWith(KEY).search(query)).rejects.toMatchObject({ status: 502 });
  });

  it('reports a timeout as one', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(timeout);

    await expect(serviceWith(KEY).search(query)).rejects.toMatchObject({ status: 504 });
  });

  it('reports an unreachable host as a bad gateway', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(serviceWith(KEY).search(query)).rejects.toMatchObject({ status: 502 });
  });

  /**
   * The assertions this file exists for.
   *
   * The key travels as a query parameter, so the request URL *is* the
   * credential — and `fetch` puts the whole URL into the message of what it
   * throws. Two different guards keep it in: the client-facing message is a
   * **fixed string** that never forwards upstream text, and the log line is
   * **redacted**. Mutation-checked — deleting `redactKey` fails the log test
   * and only the log test, which is what tells you the other two are pinning
   * the non-forwarding rule rather than the redaction.
   */
  describe('the API key never escapes', () => {
    it('is kept out of the client message, which never forwards what fetch threw', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(
          new Error(`request to https://youtube.googleapis.com/youtube/v3/search?key=${KEY} failed`),
        );

      await expect(serviceWith(KEY).search(query)).rejects.toMatchObject({
        message: expect.not.stringContaining(KEY),
      });
    });

    it('is kept out of the client message, which never forwards Google\'s body', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        // Google really does echo the key back in some error bodies.
        json: async () => ({ error: { message: `API key not valid: ${KEY}` } }),
        text: async () => `API key not valid: ${KEY}`,
      } as unknown as Response);

      await expect(serviceWith(KEY).search(query)).rejects.toMatchObject({
        message: expect.not.stringContaining(KEY),
      });
    });

    /** The one that depends on `redactKey`, and the one mutation kills. */
    it('is redacted out of every log line', async () => {
      const service = serviceWith(KEY);
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error(`connect ECONNREFUSED — url contained ${KEY}`));

      await expect(service.search(query)).rejects.toBeDefined();

      expect(warn).toHaveBeenCalled();
      for (const call of warn.mock.calls) {
        expect(String(call[0])).not.toContain(KEY);
      }
    });
  });
});
