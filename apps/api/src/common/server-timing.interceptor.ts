import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';

import type { AuthUser } from '../auth/auth.types';

import { runWithTimings } from './timing';

/**
 * How slow a request has to be before it says so on its own.
 *
 * The number matters less than the fact that something eventually speaks. A
 * search that has to read two thousand rows to return fifty is the shape of
 * thing that degrades quietly as a library grows, and nobody goes looking at a
 * log for a page that merely feels sluggish.
 */
const SLOW_MS = 400;

/**
 * What a request spent, reported two ways.
 *
 * This exists because a performance problem on somebody else's server had to be
 * diagnosed through a browser, and could not be. Two audiences, two mechanisms:
 *
 * - **A log line, when a request was slow.** It arrives on its own, in
 *   `docker logs`, without anybody opening devtools or knowing what to look for.
 *   That is the half that matters, because the person who notices a slow search
 *   is rarely the person who would go hunting for a header.
 * - **A `Server-Timing` header, for an admin.** The same numbers, rendered by
 *   the browser's own Timing panel, for when somebody does want to look.
 *
 * **The header is ADMIN-only, and that is a real restriction rather than
 * tidiness.** The counts come from the candidate step, which runs *before*
 * Prisma applies visibility — and on the Postgres fallback path `searchCandidates`
 * takes no role at all, by design, because Prisma re-reads afterwards. So a
 * candidate count includes drafts. It is a number about the library rather than
 * about the caller, and it belongs to the same audience as `/search/status`.
 *
 * Nothing here ever carries text: no query, no title, no name, no id. Durations
 * and counts only, so a log line cannot become a record of what somebody
 * searched for.
 */
@Injectable()
export class ServerTimingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Timing');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthUser }>();
    const response = http.getResponse<Response>();

    const started = process.hrtime.bigint();
    const gathered = new Map<string, number>();

    /*
     * Subscribing *inside* the store is the whole trick. An interceptor returns
     * an Observable and the handler runs when something subscribes, so opening a
     * store around the construction captures nothing — see `runWithTimings`.
     */
    return new Observable((subscriber) =>
      runWithTimings(gathered, () =>
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (cause) => {
            this.report(request, response, started, gathered);
            subscriber.error(cause);
          },
          complete: () => {
            this.report(request, response, started, gathered);
            subscriber.complete();
          },
        }),
      ),
    );
  }

  private report(
    request: Request & { user?: AuthUser },
    response: Response,
    started: bigint,
    gathered: Map<string, number>,
  ): void {
    if (gathered.size === 0) return;

    const total = Number(process.hrtime.bigint() - started) / 1e6;
    const parts = [...gathered.entries()].map(([label, value]) => `${label};dur=${round(value)}`);

    /*
     * Guards have already run by the time an interceptor does, so `user` is
     * populated — and an absent one means no header at all rather than a
     * default, because the failure to be sure who is asking is exactly when not
     * to answer.
     */
    if (request.user?.role === 'ADMIN' && !response.headersSent) {
      response.setHeader('Server-Timing', [...parts, `total;dur=${round(total)}`].join(', '));
    }

    if (total >= SLOW_MS) {
      this.logger.warn(
        `${request.method} ${request.route?.path ?? request.path} took ${round(total)}ms — ${parts.join(' ')}`,
      );
    }
  }
}

/** Two decimals is more than anybody reads and less than floating point offers. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
