import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAX_SUBTITLE_CANDIDATES, type SubtitleCandidate } from '@video/shared';

import type {
  DownloadedSubtitle,
  SubtitleProvider,
  SubtitleQuery,
  SubtitleQuota,
} from './provider';

/**
 * OpenSubtitles, over the REST API.
 *
 * This is the only outbound network call the API makes, which shapes three
 * decisions.
 *
 * **No HTTP client dependency.** Node's `fetch` with `AbortSignal.timeout` does
 * everything needed here, and a library that exists to add retries and
 * interceptors to one endpoint pair is not worth the supply chain.
 *
 * **Nothing upstream reaches the admin verbatim.** A failure from a machine we
 * do not own becomes one of a few sentences naming what an operator can
 * actually change — a key, a quota, a network. The upstream body is logged,
 * never rendered.
 *
 * **Searching needs the key; downloading needs an account.** They are separate
 * credentials and separate failures, so a server configured for one and not the
 * other says which is missing instead of failing at the click.
 */

const BASE_URL = 'https://api.opensubtitles.com/api/v1';
const REQUEST_TIMEOUT_MS = 15_000;
/** Tokens last a day; expiring ours early costs one login and avoids the edge. */
const TOKEN_TTL_MS = 20 * 60 * 60 * 1000;
const DEFAULT_USER_AGENT = 'video-streaming-claude v1.0';

/**
 * A provider failure carrying a message already safe to show an admin.
 *
 * An `HttpException` rather than a plain `Error`, for the reason `TmdbError`
 * records: as a plain Error it becomes a 500 "Internal server error" and the
 * one sentence the admin could act on never leaves the process. 502 because the
 * failure is upstream — this server is fine and the one it asked is not.
 */
export class OpenSubtitlesError extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.BAD_GATEWAY);
    this.name = 'OpenSubtitlesError';
  }
}

interface OpenSubtitlesFile {
  file_id?: number | string;
  file_name?: string;
}

interface OpenSubtitlesResult {
  attributes?: {
    language?: string;
    release?: string;
    download_count?: number;
    hearing_impaired?: boolean;
    moviehash_match?: boolean;
    files?: OpenSubtitlesFile[];
  };
}

@Injectable()
export class OpenSubtitlesClient implements SubtitleProvider {
  readonly name = 'OpenSubtitles';

  private readonly logger = new Logger(OpenSubtitlesClient.name);
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return (this.apiKey?.trim().length ?? 0) > 0;
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    const parameters = new URLSearchParams({ languages: query.language });
    if (query.movieHash) parameters.set('moviehash', query.movieHash);
    if (query.query) parameters.set('query', query.query);
    // Numeric, without the `tt` — the API rejects the prefixed form.
    if (query.imdbId) parameters.set('imdb_id', query.imdbId.replace(/^tt/i, ''));
    if (query.year !== undefined) parameters.set('year', String(query.year));
    if (query.seasonNumber !== undefined) {
      parameters.set('season_number', String(query.seasonNumber));
    }
    if (query.episodeNumber !== undefined) {
      parameters.set('episode_number', String(query.episodeNumber));
    }

    /*
     * Alphabetical, because OpenSubtitles answers **301** to any other order and
     * redirects to the sorted form of the same query. `fetch` follows that, so
     * an unsorted request still works — it just pays a pointless round trip on
     * every search, and relies on a redirect preserving the `Api-Key` header.
     * Confirmed against the live API: insertion order 301s, sorted returns 200.
     */
    parameters.sort();

    const body = await this.request<{ data?: OpenSubtitlesResult[] }>(
      `${BASE_URL}/subtitles?${parameters.toString()}`,
    );

    const results = Array.isArray(body?.data) ? body.data : [];
    return results
      .map((result) => toCandidate(result))
      .filter((candidate): candidate is SubtitleCandidate => candidate !== null)
      .slice(0, MAX_SUBTITLE_CANDIDATES);
  }

  /**
   * Today's allowance, straight from the account.
   *
   * Needs the login token, not just the key — the allowance belongs to the
   * account rather than to the consumer, which is why a search-only server has
   * no number to report rather than a zero.
   */
  async quota(): Promise<SubtitleQuota | null> {
    if (!this.hasAccount) return null;

    const token = await this.authenticate();
    const response = await this.fetchWithTimeout(`${BASE_URL}/infos/user`, {
      headers: { ...this.headers(), Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw this.errorFor(response.status, await safeBody(response));

    const body = (await response.json()) as {
      data?: { remaining_downloads?: number; allowed_downloads?: number };
    };
    const remaining = body?.data?.remaining_downloads;
    const allowed = body?.data?.allowed_downloads;

    // Null rather than a guess: a made-up allowance shown as fact is worse than
    // no indicator, because the admin would plan around it.
    if (typeof remaining !== 'number' || typeof allowed !== 'number') return null;

    return { remaining, allowed };
  }

  async download(fileId: string): Promise<DownloadedSubtitle> {
    const link = await this.requestDownloadLink(fileId);

    const response = await this.fetchWithTimeout(link.url, {});
    if (!response.ok) {
      throw new OpenSubtitlesError('OpenSubtitles offered a download link that did not work.');
    }

    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      format: formatOf(link.fileName),
    };
  }

  /**
   * The download endpoint answers with a link rather than the file, and needs a
   * session token rather than just the key. A 401 here means our cached token
   * aged out, so it is worth exactly one retry before blaming the operator.
   */
  private async requestDownloadLink(
    fileId: string,
    retrying = false,
  ): Promise<{ url: string; fileName: string | null }> {
    const token = await this.authenticate();

    const response = await this.fetchWithTimeout(`${BASE_URL}/download`, {
      method: 'POST',
      headers: { ...this.headers(), Authorization: `Bearer ${token}` },
      body: JSON.stringify({ file_id: Number(fileId) || fileId }),
    });

    if (response.status === 401 && !retrying) {
      this.token = null;
      return this.requestDownloadLink(fileId, true);
    }
    if (!response.ok) throw this.errorFor(response.status, await safeBody(response));

    const body = (await response.json()) as { link?: string; file_name?: string };
    if (!body?.link) {
      throw new OpenSubtitlesError('OpenSubtitles did not return a download link.');
    }

    return { url: body.link, fileName: body.file_name ?? null };
  }

  /** Searching needs only the key; downloading and the allowance need the account. */
  private get hasAccount(): boolean {
    return Boolean(
      this.config.get<string>('OPENSUBTITLES_USERNAME') &&
        this.config.get<string>('OPENSUBTITLES_PASSWORD'),
    );
  }

  private async authenticate(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;

    const username = this.config.get<string>('OPENSUBTITLES_USERNAME');
    const password = this.config.get<string>('OPENSUBTITLES_PASSWORD');
    if (!username || !password) {
      throw new OpenSubtitlesError(
        'Downloading needs an OpenSubtitles account. Set OPENSUBTITLES_USERNAME and OPENSUBTITLES_PASSWORD.',
      );
    }

    const response = await this.fetchWithTimeout(`${BASE_URL}/login`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) throw this.errorFor(response.status, await safeBody(response));

    const body = (await response.json()) as { token?: string };
    if (!body?.token) throw new OpenSubtitlesError('OpenSubtitles did not return a session token.');

    this.token = { value: body.token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return body.token;
  }

  private async request<T>(url: string): Promise<T | null> {
    const response = await this.fetchWithTimeout(url, { headers: this.headers() });
    if (!response.ok) throw this.errorFor(response.status, await safeBody(response));

    try {
      return (await response.json()) as T;
    } catch {
      throw new OpenSubtitlesError('OpenSubtitles returned something that was not JSON.');
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (cause) {
      // A timeout and a DNS failure are the same thing to an admin: the service
      // is not answering, and nothing they type into this app will change it.
      this.logger.warn(`OpenSubtitles request failed: ${describe(cause)}`);
      throw new OpenSubtitlesError('OpenSubtitles did not respond.');
    }
  }

  private headers(): Record<string, string> {
    return {
      'Api-Key': this.apiKey ?? '',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // OpenSubtitles refuses a client that does not identify itself.
      'User-Agent': this.config.get<string>('OPENSUBTITLES_USER_AGENT') ?? DEFAULT_USER_AGENT,
    };
  }

  private get apiKey(): string | undefined {
    return this.config.get<string>('OPENSUBTITLES_API_KEY');
  }

  /** One sentence an operator can act on, and the real answer in the log. */
  private errorFor(status: number, body: string): OpenSubtitlesError {
    this.logger.warn(`OpenSubtitles responded ${status}: ${body.slice(0, 500)}`);

    if (status === 401 || status === 403) {
      return new OpenSubtitlesError('OpenSubtitles rejected the configured credentials.');
    }
    if (status === 406) {
      return new OpenSubtitlesError('The OpenSubtitles download quota for today is used up.');
    }
    if (status === 429) {
      return new OpenSubtitlesError('OpenSubtitles is refusing further requests for now — too many in a short time.');
    }
    return new OpenSubtitlesError(`OpenSubtitles could not be reached (HTTP ${status}).`);
  }
}

/** A result is only useful if it names a file that can actually be downloaded. */
function toCandidate(result: OpenSubtitlesResult): SubtitleCandidate | null {
  const attributes = result?.attributes;
  const file = attributes?.files?.[0];
  if (!attributes || !file?.file_id) return null;

  return {
    fileId: String(file.file_id),
    language: (attributes.language ?? '').toLowerCase(),
    releaseName: attributes.release ?? file.file_name ?? 'Untitled release',
    fileName: file.file_name ?? null,
    format: formatOf(file.file_name ?? null),
    downloadCount: attributes.download_count ?? 0,
    hearingImpaired: attributes.hearing_impaired ?? false,
    fromHash: attributes.moviehash_match === true,
  };
}

/**
 * The subtitle formats worth recognising in a file name.
 *
 * A closed set, because OpenSubtitles' `file_name` is usually a *release* name
 * rather than a filename — `10 Cloverfield Lane (2016).DVD` and
 * `Some.Release.en` both end in something extension-shaped that is not one.
 * Anything outside this list is not an extension, whatever it looks like.
 * (Found by searching against the live API, where `.DVD` became a format.)
 */
const KNOWN_FORMATS = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub', 'smi', 'sbv']);

/**
 * SRT unless the name genuinely says otherwise — it is what OpenSubtitles
 * overwhelmingly serves, and guessing `vtt` would skip the conversion the file
 * actually needs and then refuse it for not being WebVTT.
 */
function formatOf(fileName: string | null): string {
  const extension = fileName?.split('.').pop()?.toLowerCase();
  return extension && KNOWN_FORMATS.has(extension) ? extension : 'srt';
}

async function safeBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable>';
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
