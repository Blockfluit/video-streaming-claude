import { Inject, Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/errors';

import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';

import { SEARCH_ENGINE, type SearchCandidates, type SearchEngine } from './engine';
import { searchCandidates } from './postgres.candidates';

/**
 * How long to stop asking an engine that has just failed.
 *
 * The part of a fallback that is easy to get wrong. A per-request `fetch` at a
 * one-second timeout against a container that is down makes **every keystroke
 * slower than having no engine at all** — the feature added to make search quick
 * becoming the reason it is not, at exactly the moment nobody is watching the
 * logs. So the first failure closes the door for half a minute and the next
 * request after that reopens it.
 */
const DEGRADED_MS = 30_000;

/**
 * Which rows resemble the text, from whichever half of the system is answering.
 *
 * One decision, in one place, with one shape coming out of it. Everything
 * downstream — `collectionSearch`, `filmSearch`, `collectionEvidence`,
 * `scoreEntry`, `mergePage`, `toPage` — is identical either way, and that is
 * the property worth protecting: **there is no code path that only works when an
 * engine is configured.** A db-spec asserts the two answers are the same shape
 * by asserting the responses are equal.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  /** When the engine may be asked again. Zero while it is behaving. */
  private degradedUntil = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SEARCH_ENGINE) private readonly engine: SearchEngine,
  ) {}

  /** What `/search/status` reports, and what the fallback decision reads. */
  get isConfigured(): boolean {
    return this.engine.isConfigured;
  }

  get engineName(): string {
    return this.engine.name;
  }

  /** False while the breaker is open — an engine configured but not answering. */
  get isHealthy(): boolean {
    return this.engine.isConfigured && this.degradedUntil <= Date.now();
  }

  async candidates(
    q: string,
    normalised: string,
    role: Role,
    limit: number,
  ): Promise<SearchCandidates> {
    if (!this.isHealthy) return searchCandidates(this.prisma, q, normalised);

    try {
      return await this.engine.candidates({ q, normalised, role, limit });
    }
    catch (cause) {
      /*
       * Logged once per window rather than once per request. A failing engine on
       * an interactive path produces a request per keystroke, and a log that
       * scrolls faster than it can be read is a log nobody reads.
       */
      this.degradedUntil = Date.now() + DEGRADED_MS;
      this.logger.warn(
        `${this.engine.name} search failed; falling back to Postgres for ${
          DEGRADED_MS / 1000
        }s. (${describeError(cause)})`,
      );

      return searchCandidates(this.prisma, q, normalised);
    }
  }
}
