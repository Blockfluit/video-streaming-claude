import { ConfigService } from '@nestjs/config';

import { OpenSubtitlesClient } from './opensubtitles.client';

/**
 * The client is the only thing in this codebase that talks to a machine it does
 * not own, so what is pinned here is the contract with that machine: which
 * headers go out, what comes back as a candidate, and — most of all — that a
 * failure arrives as something an admin can act on rather than as an upstream
 * body.
 */

type FetchArgs = [input: string, init?: RequestInit];

function clientWith(
  env: Record<string, string | undefined>,
  fetchImpl: jest.Mock,
): OpenSubtitlesClient {
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  const config = { get: (key: string) => env[key] } as ConfigService;
  return new OpenSubtitlesClient(config);
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const CONFIGURED = {
  OPENSUBTITLES_API_KEY: 'test-key',
  OPENSUBTITLES_USERNAME: 'operator',
  OPENSUBTITLES_PASSWORD: 'secret',
};

const SEARCH_BODY = {
  data: [
    {
      id: '900',
      attributes: {
        language: 'en',
        release: 'The.Matrix.1999.1080p.BluRay',
        download_count: 4200,
        hearing_impaired: false,
        moviehash_match: true,
        files: [{ file_id: 12345, file_name: 'The.Matrix.1999.1080p.srt' }],
      },
    },
  ],
};

describe('OpenSubtitlesClient', () => {
  const originalFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  describe('configuration', () => {
    it('is unconfigured without an API key', () => {
      const client = clientWith({}, jest.fn());
      expect(client.isConfigured).toBe(false);
    });

    it('is configured with a key alone, because searching needs no login', () => {
      const client = clientWith({ OPENSUBTITLES_API_KEY: 'test-key' }, jest.fn());
      expect(client.isConfigured).toBe(true);
    });
  });

  describe('search', () => {
    it('sends the API key and a descriptive User-Agent', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(SEARCH_BODY));
      const client = clientWith(CONFIGURED, fetchImpl);

      await client.search({ language: 'en', query: 'The Matrix' });

      const [, init] = fetchImpl.mock.calls[0] as FetchArgs;
      const headers = init?.headers as Record<string, string>;
      expect(headers['Api-Key']).toBe('test-key');
      // OpenSubtitles rejects a request that does not identify its client.
      expect(headers['User-Agent']).toMatch(/\S/);
    });

    it('queries by hash when one is available', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(SEARCH_BODY));
      const client = clientWith(CONFIGURED, fetchImpl);

      await client.search({ language: 'en', movieHash: '8e245d9679d31e12' });

      const [url] = fetchImpl.mock.calls[0] as FetchArgs;
      expect(url).toContain('moviehash=8e245d9679d31e12');
      expect(url).toContain('languages=en');
    });

    it('passes season and episode for an episode', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(SEARCH_BODY));
      const client = clientWith(CONFIGURED, fetchImpl);

      await client.search({ language: 'en', query: 'Twin Peaks', seasonNumber: 2, episodeNumber: 7 });

      const [url] = fetchImpl.mock.calls[0] as FetchArgs;
      expect(url).toContain('season_number=2');
      expect(url).toContain('episode_number=7');
    });

    it('maps a result to a candidate, taking the format from the file name', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(SEARCH_BODY));
      const client = clientWith(CONFIGURED, fetchImpl);

      const [candidate] = await client.search({ language: 'en', query: 'The Matrix' });

      expect(candidate).toEqual({
        fileId: '12345',
        language: 'en',
        releaseName: 'The.Matrix.1999.1080p.BluRay',
        fileName: 'The.Matrix.1999.1080p.srt',
        format: 'srt',
        downloadCount: 4200,
        hearingImpaired: false,
        fromHash: true,
      });
    });

    it('skips results carrying no downloadable file', async () => {
      // A result with an empty `files` array cannot be installed, and offering
      // it means a picker row that fails when clicked.
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(jsonResponse({ data: [{ id: '1', attributes: { language: 'en', files: [] } }] }));
      const client = clientWith(CONFIGURED, fetchImpl);

      await expect(client.search({ language: 'en', query: 'x' })).resolves.toEqual([]);
    });

    it('survives a response that is not shaped as documented', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ unexpected: true }));
      const client = clientWith(CONFIGURED, fetchImpl);

      await expect(client.search({ language: 'en', query: 'x' })).resolves.toEqual([]);
    });
  });

  describe('failures', () => {
    it('names the credentials on a 401', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, 401));
      const client = clientWith(CONFIGURED, fetchImpl);

      await expect(client.search({ language: 'en', query: 'x' })).rejects.toThrow(
        /credentials|rejected/i,
      );
    });

    it('names the quota on a 429', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ message: 'slow down' }, 429));
      const client = clientWith(CONFIGURED, fetchImpl);

      await expect(client.search({ language: 'en', query: 'x' })).rejects.toThrow(/quota|too many/i);
    });

    it('does not leak the upstream body into the message', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(jsonResponse({ message: 'internal detail nobody should read' }, 500));
      const client = clientWith(CONFIGURED, fetchImpl);

      await expect(client.search({ language: 'en', query: 'x' })).rejects.toThrow(
        /^(?!.*internal detail).*$/,
      );
    });
  });

  describe('download', () => {
    it('logs in for a token, then fetches the link the API hands back', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ token: 'jwt-token' }))
        .mockResolvedValueOnce(jsonResponse({ link: 'https://dl.example/sub.srt', file_name: 'sub.srt' }))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: async () => new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nhi\n').buffer,
        } as Response);
      const client = clientWith(CONFIGURED, fetchImpl);

      const result = await client.download('12345');

      expect(result.format).toBe('srt');
      expect(result.bytes.toString()).toContain('00:00:01,000');

      const [loginUrl, loginInit] = fetchImpl.mock.calls[0] as FetchArgs;
      expect(loginUrl).toContain('/login');
      expect(loginInit?.method).toBe('POST');

      const [, downloadInit] = fetchImpl.mock.calls[1] as FetchArgs;
      const headers = downloadInit?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer jwt-token');
    });

    it('reuses the token across downloads rather than logging in each time', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ token: 'jwt-token' }))
        .mockResolvedValue(jsonResponse({ link: 'https://dl.example/sub.srt', file_name: 'sub.srt' }));
      fetchImpl.mockImplementation(async (url: string) => {
        if (url.includes('/login')) return jsonResponse({ token: 'jwt-token' });
        if (url.includes('/download')) {
          return jsonResponse({ link: 'https://dl.example/sub.srt', file_name: 'sub.srt' });
        }
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) } as Response;
      });
      const client = clientWith(CONFIGURED, fetchImpl);

      await client.download('1');
      await client.download('2');

      const logins = fetchImpl.mock.calls.filter(([url]) => (url as string).includes('/login'));
      expect(logins).toHaveLength(1);
    });

    it('refuses to download without the account credentials', async () => {
      // The key alone is enough to search but not to download, and saying so is
      // better than a 401 from a machine the admin has never heard of.
      const client = clientWith({ OPENSUBTITLES_API_KEY: 'test-key' }, jest.fn());

      await expect(client.download('12345')).rejects.toThrow(/username|password|account/i);
    });

    it('reports an exhausted quota in words an admin can act on', async () => {
      const fetchImpl = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('/login')) return jsonResponse({ token: 'jwt-token' });
        return jsonResponse({ message: 'quota' }, 406);
      });
      const client = clientWith(CONFIGURED, fetchImpl);

      await expect(client.download('12345')).rejects.toThrow(/quota/i);
    });
  });
});
