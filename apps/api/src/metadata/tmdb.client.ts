import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TmdbType } from '@video/shared';

import type {
  TmdbSearchResponse,
  TmdbSeasonDetail,
  TmdbTitleDetail,
} from './tmdb.types';

/**
 * The one thing in this API that talks to another server.
 *
 * Everything outbound goes through here so that the token, the timeout and the
 * error shape are decided once. It is also the seam the tests replace: there is
 * no HTTP mocking library in this project, and adding one to test a client this
 * thin would be testing the mock — `.overrideProvider(TmdbClient)` is how the
 * e2e and db suites exercise everything downstream of it.
 */

const BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

/**
 * Long enough for a slow response, short enough that an admin pressing a button
 * gets an answer. Nothing here is on a viewer's path.
 */
const TIMEOUT_MS = 10_000;

/** A poster is ~100KB. Anything past this is not a poster. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * A TMDB failure, with the token taken out of it.
 *
 * The token appears in the request headers, and a thrown `fetch` error or a
 * logged request URL is exactly the sort of thing that ends up in a response
 * body or a log aggregator. `FfmpegError` exists for the same reason: keep the
 * diagnosis, drop everything the reader cannot act on and should not see.
 */
export class TmdbError extends HttpException {
  /**
   * An `HttpException`, not a plain `Error`.
   *
   * As a plain Error this became a 500 "Internal server error" and the message
   * below — the one thing the admin could act on, such as "TMDB rejected the API
   * token" — never left the process. Shipped that way and caught the first time
   * the screen was opened in a browser with a bad token in the env.
   *
   * 502 rather than 500 because the failure is upstream: this server is fine and
   * the one it asked is not, which is also what stops it reading as our bug.
   */
  constructor(
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message, HttpStatus.BAD_GATEWAY);
    this.name = 'TmdbError';
  }
}

@Injectable()
export class TmdbClient {
  private readonly logger = new Logger(TmdbClient.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Whether the feature is usable at all.
   *
   * Read rather than thrown so the admin UI can hide a button that cannot work,
   * instead of offering one that always fails.
   */
  get isConfigured(): boolean {
    return this.token !== null;
  }

  get language(): string {
    return this.config.get<string>('TMDB_LANGUAGE') ?? 'en-US';
  }

  get certificationCountry(): string {
    return this.config.get<string>('TMDB_CERTIFICATION_COUNTRY') ?? 'US';
  }

  /** A relative TMDB image path (`/abc.jpg`) as a URL, at the configured width. */
  imageUrl(path: string, size?: string): string {
    const width = size ?? this.config.get<string>('TMDB_IMAGE_SIZE') ?? 'w780';
    return `${IMAGE_BASE_URL}/${width}${path}`;
  }

  async searchTitles(
    title: string,
    type: TmdbType | undefined,
    year: number | undefined,
  ): Promise<TmdbSearchResponse> {
    // No type means "either", and TMDB has one endpoint for that. It also
    // returns people, which the mapper drops.
    const path = type === undefined ? 'search/multi' : `search/${type}`;
    const params = new URLSearchParams({ query: title, include_adult: 'false' });

    if (year !== undefined) {
      // The two catalogues name the same filter differently, and multi-search
      // supports neither — so an unnarrowed search simply is not narrowed.
      if (type === 'movie') params.set('primary_release_year', String(year));
      else if (type === 'tv') params.set('first_air_date_year', String(year));
    }

    return this.get<TmdbSearchResponse>(path, params);
  }

  /**
   * A whole title in one request.
   *
   * `append_to_response` is what makes the import cheap: credits, external ids,
   * trailers and certifications would otherwise be four more round trips, and
   * the certification endpoint differs between films and shows.
   */
  async titleDetail(tmdbId: number, type: TmdbType): Promise<TmdbTitleDetail> {
    const appended = [
      'credits',
      'external_ids',
      'videos',
      type === 'movie' ? 'release_dates' : 'content_ratings',
    ].join(',');

    return this.get<TmdbTitleDetail>(`${type}/${tmdbId}`, new URLSearchParams({
      append_to_response: appended,
    }));
  }

  /** Every episode of a season, inline — which is why filling a series is cheap. */
  async seasonDetail(tmdbId: number, seasonNumber: number): Promise<TmdbSeasonDetail> {
    return this.get<TmdbSeasonDetail>(`tv/${tmdbId}/season/${seasonNumber}`, new URLSearchParams());
  }

  /**
   * A person's IMDb id, which is not returned alongside credits.
   *
   * Resolved one at a time and lazily for that reason — see `PersonLinksService`.
   */
  async personImdbId(tmdbPersonId: number): Promise<string | null> {
    const result = await this.get<{ imdb_id?: string | null }>(
      `person/${tmdbPersonId}/external_ids`,
      new URLSearchParams(),
    );
    const id = result.imdb_id;
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
  }

  /**
   * Downloads an image.
   *
   * Bounded and content-type checked: this writes to disk and is reachable from
   * an admin action, so "whatever came back" is not good enough.
   */
  async fetchImage(path: string, size?: string): Promise<{ body: Buffer; extension: string }> {
    const response = await this.send(this.imageUrl(path, size), {});

    const type = response.headers.get('content-type') ?? '';
    const extension = IMAGE_TYPES[type.split(';')[0]!.trim()];
    if (extension === undefined) {
      throw new TmdbError(`That artwork came back as ${type || 'an unknown type'}, not an image`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new TmdbError('That artwork is implausibly large for a poster');
    }

    return { body: buffer, extension };
  }

  private get token(): string | null {
    const value = this.config.get<string>('TMDB_API_TOKEN')?.trim();
    return value === undefined || value.length === 0 ? null : value;
  }

  private async get<T>(path: string, params: URLSearchParams): Promise<T> {
    params.set('language', this.language);
    const response = await this.send(`${BASE_URL}/${path}?${params.toString()}`, {
      Accept: 'application/json',
    });

    return (await response.json()) as T;
  }

  private async send(url: string, headers: Record<string, string>): Promise<Response> {
    const token = this.token;
    if (token === null) {
      throw new ServiceUnavailableException(
        'Metadata lookup is not configured. Set TMDB_API_TOKEN to switch it on.',
      );
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { ...headers, Authorization: `Bearer ${token}` },
        // Without this a hung provider holds a request open indefinitely, and
        // the admin gets a spinner rather than a message.
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Never interpolate the error verbatim: a fetch failure can carry the
      // request, and the request carries the token.
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      this.logger.warn(`TMDB ${reason}`);
      throw new TmdbError(`TMDB ${reason}. Try again in a moment.`);
    }

    if (!response.ok) {
      throw new TmdbError(await describeResponse(response), response.status);
    }

    return response;
  }
}

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/**
 * TMDB explains its own failures in the body, and its explanation is better than
 * a status code — but only its explanation is kept, never the URL that produced
 * it.
 */
async function describeResponse(response: Response): Promise<string> {
  if (response.status === 401) return 'TMDB rejected the API token.';
  if (response.status === 404) return 'TMDB has no such title.';
  if (response.status === 429) return 'TMDB is rate-limiting this server. Try again shortly.';

  try {
    const body = (await response.json()) as { status_message?: unknown };
    if (typeof body.status_message === 'string' && body.status_message.trim().length > 0) {
      return `TMDB said: ${body.status_message.trim()}`;
    }
  } catch {
    // A non-JSON error body tells us nothing; the status still does.
  }

  return `TMDB returned ${response.status}.`;
}
