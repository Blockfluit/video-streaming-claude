import http from 'node:http';
import https from 'node:https';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { describeError } from '../common/errors';
import { UpstreamError } from '../common/upstream';

import { TITLE_INDEX_SETTINGS, PERSON_INDEX_SETTINGS } from './documents';
import type { SearchCandidateRequest, SearchCandidates, SearchEngine } from './engine';
import { stateFilter } from './filters';

/**
 * How long to wait for the engine before giving up on it.
 *
 * **One second, against the fifteen the outbound clients use, and the difference
 * is the point.** TMDB and OpenSubtitles are somebody else's server across the
 * internet, asked because an admin pressed a button and is willing to wait. This
 * is a container on the same host on an interactive path, and the fallback
 * behind it answers in tens of milliseconds — so a slow engine must be abandoned
 * long before it becomes slower than not having one. `SearchService` then stops
 * asking entirely for thirty seconds.
 */
const TIMEOUT_MS = 1000;

/**
 * How long to let one indexing task run, and how often to ask.
 *
 * Generous next to `TIMEOUT_MS`, because these are different things: a *search*
 * has somebody waiting and must give up quickly, while an indexing task is
 * background work whose only deadline is that it must not hang for ever.
 */
const TASK_TIMEOUT_MS = 60_000;
const TASK_POLL_MS = 100;

/**
 * The shadow of an index — where the next contents are written.
 *
 * A plain suffix rather than a random name: a swap has to name both sides, and
 * a rebuild interrupted half way should find the same shadow next time rather
 * than leaving a new one behind on every attempt.
 */
function shadowOf(index: string): string {
  return `${index}_next`;
}

/**
 * Connections kept open, because a search asks on every settled keystroke.
 *
 * `maxSockets` is small on purpose: the API answers one search at a time per
 * request and the engine is milliseconds away, so a larger pool would only mean
 * more idle sockets against a service on the same host.
 */
const AGENT_OPTIONS = { keepAlive: true, maxSockets: 8 } as const;
const httpAgent = new http.Agent(AGENT_OPTIONS);
const httpsAgent = new https.Agent(AGENT_OPTIONS);

/** What `send` answers with — the two things every caller here reads. */
interface UpstreamResponse {
  status: number;
  text: string;
}

/** Index names, prefixed so two deployments can share one engine. */
interface Indexes {
  videos: string;
  collections: string;
  people: string;
}

interface MeiliHit {
  id: string;
  name?: string;
}

interface MeiliResult {
  hits: MeiliHit[];
}

class MeilisearchError extends UpstreamError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'MeilisearchError';
  }
}

/**
 * Meilisearch, spoken to over its REST API and nothing more.
 *
 * **No client library**, for the reason `opensubtitles.client.ts` gives about
 * its own: a package that exists to add retries and interceptors around a
 * handful of endpoints is a supply-chain dependency bought for convenience. Six
 * calls are used here — multi-search, settings, documents, swap, tasks, health —
 * and it keeps the API image exactly the size it is, which the move to Alpine
 * was about.
 *
 * It does **not** go through `fetchUpstream`, which is the one deviation in this
 * codebase from "all outbound calls look the same", and `send` below carries the
 * measurement that bought it.
 *
 * The master key is a full read/write credential over the whole catalogue, so it
 * follows the same rule as every other secret here: never interpolated into a
 * message, never logged, never returned by the status endpoint. `UpstreamError`
 * explains why that matters — a thrown `fetch` carries the request, and the
 * request carries the key.
 */
@Injectable()
export class MeilisearchClient implements SearchEngine {
  readonly name = 'meilisearch';

  private readonly logger = new Logger(MeilisearchClient.name);

  private readonly url: string;
  private readonly key: string;
  readonly indexes: Indexes;

  constructor(config: ConfigService) {
    this.url = (config.get<string>('MEILI_URL') ?? '').trim().replace(/\/+$/, '');
    this.key = (config.get<string>('MEILI_MASTER_KEY') ?? '').trim();

    const prefix = (config.get<string>('MEILI_INDEX_PREFIX') ?? 'library').trim();
    this.indexes = {
      videos: `${prefix}_videos`,
      collections: `${prefix}_collections`,
      people: `${prefix}_people`,
    };
  }

  /**
   * A URL is enough; a key is not required.
   *
   * Meilisearch runs keyless in development and refuses to start without a key
   * in production, so which of those an operator has is their business. What
   * decides whether this engine is switched on at all is whether anybody told it
   * where to look.
   */
  get isConfigured(): boolean {
    return this.url.length > 0;
  }

  /**
   * The three questions in one round trip.
   *
   * `multi-search` rather than three calls, for the same reason
   * `postgres.candidates.ts` puts its three queries in one transaction: this is
   * on the path a person is waiting on, and two extra round trips is two extra
   * round trips.
   *
   * `attributesToRetrieve` is `id` — and `name` for people, because
   * `relevance.ts` scores the name and re-reading it from Postgres would be work
   * the engine has already done. Everything else about the row is read from the
   * database afterwards, which is what makes a stale document harmless.
   */
  async candidates(request: SearchCandidateRequest): Promise<SearchCandidates> {
    const filter = stateFilter(request.role);

    const body = {
      queries: [
        {
          indexUid: this.indexes.collections,
          q: request.q,
          filter,
          limit: request.limit,
          attributesToRetrieve: ['id'],
        },
        {
          indexUid: this.indexes.videos,
          q: request.q,
          filter,
          limit: request.limit,
          attributesToRetrieve: ['id'],
        },
        {
          // People have no publish state of their own — a person is visible
          // through whatever they are credited on, which Prisma decides.
          indexUid: this.indexes.people,
          q: request.q,
          limit: request.limit,
          attributesToRetrieve: ['id', 'name'],
        },
      ],
    };

    const results = await this.post<{ results: MeiliResult[] }>('/multi-search', body);
    const [collections, videos, people] = results.results;

    return {
      collectionIds: (collections?.hits ?? []).map(hit => hit.id),
      videoIds: (videos?.hits ?? []).map(hit => hit.id),
      people: (people?.hits ?? [])
        .filter((hit): hit is { id: string; name: string } => typeof hit.name === 'string')
        .map(hit => ({ id: hit.id, name: hit.name })),
    };
  }

  /** Whether the engine is up, for the status endpoint. Never throws. */
  async isReachable(): Promise<boolean> {
    try {
      const response = await this.send('GET', '/health');
      return response.status >= 200 && response.status < 300;
    }
    catch {
      return false;
    }
  }

  /**
   * Applies the settings every index needs, to the live index and its shadow.
   *
   * Safe to run on every boot, and it is also what *creates* an index — a
   * settings write to a name that does not exist makes it. Both halves are set
   * up here so a swap always has two indexes to exchange.
   */
  async ensureSettings(): Promise<void> {
    for (const index of Object.values(this.indexes)) {
      const settings = index === this.indexes.people ? PERSON_INDEX_SETTINGS : TITLE_INDEX_SETTINGS;
      await this.patch(`/indexes/${index}/settings`, settings);
      await this.patch(`/indexes/${shadowOf(index)}/settings`, settings);
    }
  }

  /**
   * Replaces an index's contents **atomically**, via its shadow and a swap.
   *
   * The obvious version — delete every document, then add the new ones — has a
   * window in which the index is empty, and it is not a theoretical one:
   * Meilisearch applies writes as background tasks, so the delete lands, the add
   * is still queued, and every search in between answers *nothing*. A rebuild
   * runs after every reconcile pass, which is after every upload and every
   * change on disk, so that window would sit squarely in the middle of ordinary
   * use. Caught by measuring: a query answered 138 rows one moment and 25 the
   * next, entirely because a rebuild was in flight.
   *
   * So the new contents are written to a shadow index nobody is searching, and
   * `swap-indexes` exchanges the two in one atomic step. The old contents end up
   * in the shadow, which is where the next rebuild starts by clearing anyway.
   * Searches see the previous index until the moment they see the next one.
   */
  async replaceAll(index: string, documents: object[]): Promise<void> {
    const shadow = shadowOf(index);

    await this.awaitTask(await this.taskOf('DELETE', `/indexes/${shadow}/documents`));

    if (documents.length > 0) {
      await this.awaitTask(await this.taskOf('POST', `/indexes/${shadow}/documents`, documents));
    }

    await this.awaitTask(
      await this.taskOf('POST', '/swap-indexes', [{ indexes: [index, shadow] }]),
    );
  }

  /** Every write is a background task; this is its number. */
  private async taskOf(method: string, path: string, body?: unknown): Promise<number> {
    const accepted = await this.json<{ taskUid: number }>(method, path, body);
    return accepted.taskUid;
  }

  /**
   * Waits for one background task to finish.
   *
   * Without this a rebuild "completes" while Meilisearch is still reading the
   * documents, and the swap would exchange a half-written index into service —
   * which is the very thing the shadow exists to prevent.
   *
   * Bounded, because this runs on a timer with nobody waiting: a task that never
   * settles must not leave a rebuild pinned for ever. Giving up here leaves the
   * live index exactly as it was, which is the safe direction.
   */
  private async awaitTask(uid: number): Promise<void> {
    const deadline = Date.now() + TASK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const task = await this.get<{ status: string; error?: { message?: string } }>(`/tasks/${uid}`);

      if (task.status === 'succeeded') return;
      if (task.status === 'failed' || task.status === 'canceled') {
        throw new MeilisearchError(
          `The search engine could not apply an index update (${task.status}).`,
        );
      }

      await new Promise(resolve => setTimeout(resolve, TASK_POLL_MS));
    }

    throw new MeilisearchError('The search engine did not finish an index update in time.');
  }

  async documentCount(index: string): Promise<number | null> {
    try {
      const stats = await this.get<{ numberOfDocuments?: number }>(`/indexes/${index}/stats`);
      return stats.numberOfDocuments ?? null;
    }
    catch {
      return null;
    }
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>('POST', path, body);
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>('PATCH', path, body);
  }

  private get<T>(path: string): Promise<T> {
    return this.json<T>('GET', path);
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);

    /*
     * A non-2xx is a **failure**, never an empty answer.
     *
     * The one that would bite: a filter naming an attribute the index has not
     * been told is filterable returns 400 with no hits. Swallowed, that is
     * indistinguishable from "nothing matched" — so a viewer's search would
     * quietly return nothing at all, for ever, after a settings change nobody
     * connected to it. Throwing sends it to the fallback and puts it in a log.
     */
    if (response.status < 200 || response.status >= 300) {
      throw new MeilisearchError(
        `The search engine answered ${response.status}. Search is falling back to the database.`,
        response.status,
      );
    }

    return JSON.parse(response.text) as T;
  }

  /**
   * **`node:http`, deliberately, and not the `fetchUpstream` every other client
   * here uses.** This is the one place in the codebase that deviates, so it owes
   * an explanation and a number.
   *
   * Measured, container to container, asking this engine one question whose
   * answer is 113 ids:
   *
   *   `fetch` (undici), keep-alive        50.5 ms
   *   `fetch`, `Connection: close`         4.5 ms
   *   `node:http`, keep-alive              1.6 ms
   *
   * Meilisearch reports spending **0–1 ms** on that query. Nearly fifty
   * milliseconds were being spent in the HTTP client, on a reused connection,
   * whenever the response outgrew a single TCP segment — the cost appears as a
   * step between a 20-hit answer (3.5 ms) and a 60-hit one (59 ms), which is the
   * signature of a delayed-ACK stall rather than of parsing or of size.
   *
   * That is the whole benefit of having an engine, spent on the way back from
   * it: with `fetch`, searching through Meilisearch was **slower** than searching
   * through Postgres, which is how this was found.
   *
   * `fetchUpstream` stays right for TMDB and OpenSubtitles — a request across the
   * internet, once, because somebody pressed a button — where fifty milliseconds
   * is noise and its shared timeout and error handling are worth having. Here the
   * whole request should cost less than that, and does.
   */
  private send(method: string, path: string, body?: unknown): Promise<UpstreamResponse> {
    const target = new URL(`${this.url}${path}`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const transport = target.protocol === 'https:' ? https : http;
    const agent = target.protocol === 'https:' ? httpsAgent : httpAgent;

    return new Promise<UpstreamResponse>((resolve, reject) => {
      const fail = (cause: unknown, timedOut: boolean): void => {
        this.logger.warn(
          `Meilisearch ${method} ${path} did not complete: ${describeError(cause)}`,
        );
        reject(
          new MeilisearchError(
            timedOut
              ? 'The search engine did not answer in time. Search is falling back to the database.'
              : 'The search engine could not be reached. Search is falling back to the database.',
          ),
        );
      };

      const request = transport.request(
        {
          agent,
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method,
          headers: {
            ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
            ...(payload === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                }),
          },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            text += chunk;
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
        },
      );

      request.setTimeout(TIMEOUT_MS, () => {
        request.destroy(new Error(`timed out after ${TIMEOUT_MS}ms`));
      });
      request.on('error', (cause) => {
        fail(cause, /timed out/.test(cause.message));
      });

      if (payload !== undefined) request.write(payload);
      request.end();
    });
  }
}
