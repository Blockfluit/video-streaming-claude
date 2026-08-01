import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toPage, type Page, type TrailerSearchQuery } from '@video/shared';

import { mapYoutubeSearchResponse, redactKey, type TrailerSearchResult } from './youtube-search';

/**
 * Searching YouTube on an admin's behalf.
 *
 * A proxy rather than a browser-side call for two reasons: the API key must
 * never reach the browser, and YouTube refuses to be framed — everything
 * except `/embed/` sends `X-Frame-Options: DENY`, so searching *inside* an
 * iframe is not possible and the results have to be rendered by us.
 *
 * Optional by design. Without a key the endpoint says so and the admin pastes
 * a URL instead, which is the path that always works.
 */

const SEARCH_URL = 'https://youtube.googleapis.com/youtube/v3/search';

/** Long enough for a slow answer, short enough that nobody wonders if it hung. */
const TIMEOUT_MS = 8_000;

@Injectable()
export class TrailersService {
  private readonly logger = new Logger(TrailersService.name);

  constructor(private readonly config: ConfigService) {}

  async search(query: TrailerSearchQuery): Promise<Page<TrailerSearchResult>> {
    // Read per call rather than cached at construction: a test that sets the
    // key after the module is built should still see it.
    const key = this.config.get<string>('YOUTUBE_API_KEY');

    if (!key) {
      throw new ServiceUnavailableException(
        'YouTube search is not configured. Set YOUTUBE_API_KEY in apps/api/.env, or paste a YouTube URL instead.',
      );
    }

    const url = new URL(SEARCH_URL);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    // A trailer nobody can embed is not a trailer we can use.
    url.searchParams.set('videoEmbeddable', 'true');
    url.searchParams.set('maxResults', String(query.limit));
    url.searchParams.set('q', query.q);
    url.searchParams.set('key', key);

    const response = await this.fetchOrExplain(url, key);

    if (!response.ok) {
      throw this.explainUpstream(response.status, key);
    }

    const items = mapYoutubeSearchResponse(await response.json().catch(() => null));

    /*
     * A `Page` because every list endpoint here returns one, though upstream
     * pages by opaque token rather than by offset. `total` is this page's own
     * length and `hasMore` is therefore false — Google's `pageInfo.totalResults`
     * is an estimate it openly disclaims, and reporting an estimate as a total
     * would make the number a lie rather than a limitation.
     */
    return toPage(items, items.length, { limit: query.limit, offset: 0 });
  }

  private async fetchOrExplain(url: URL, key: string): Promise<Response> {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      // `fetch` puts the whole URL — key included — into what it throws.
      const detail = redactKey(error instanceof Error ? error.message : String(error), key);

      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        this.logger.warn(`YouTube search timed out: ${detail}`);
        throw new GatewayTimeoutException('YouTube search timed out. Try again, or paste a URL.');
      }

      this.logger.warn(`YouTube search could not reach Google: ${detail}`);
      throw new BadGatewayException('Could not reach YouTube. Paste a URL instead.');
    }
  }

  /**
   * Google's own body is never forwarded: it can echo the key back and it names
   * the Cloud project. The status is enough to say something useful.
   */
  private explainUpstream(status: number, key: string): Error {
    this.logger.warn(redactKey(`YouTube search failed with HTTP ${status}`, key));

    if (status === 403 || status === 429) {
      // The overwhelmingly common cause: 100 quota units a search against a
      // 10,000/day default is about 100 searches for the whole install.
      return new ServiceUnavailableException(
        'YouTube search is unavailable — the daily quota is spent, or the key was refused. Paste a YouTube URL instead.',
      );
    }

    return new BadGatewayException('YouTube search failed. Paste a YouTube URL instead.');
  }
}
