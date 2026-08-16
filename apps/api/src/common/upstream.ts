import { HttpException, HttpStatus, type Logger } from '@nestjs/common';

/**
 * The half of talking to somebody else's server that is the same whoever it is.
 *
 * There are two such clients — TMDB for metadata, OpenSubtitles for subtitle
 * search — and each opened by declaring itself the only one. "The one thing in
 * this API that talks to another server" and "this is the only outbound network
 * call the API makes" were both in the tree at the same time, and each was the
 * premise for solving the problem locally. They had independently grown the same
 * error class, the same timeout wrapper and the same shape of failure handling;
 * the second one's comment even cites the first ("for the reason `TmdbError`
 * records").
 *
 * What is genuinely shared is here. What is genuinely different — which statuses
 * mean what, and what to say about them — stays in each client, because those
 * sentences are the part an operator acts on and they are not the same sentences.
 */

/**
 * A failure from a machine we do not own.
 *
 * An `HttpException` rather than a plain `Error`, and **502 rather than 500**.
 * As a plain Error this became "Internal server error" and the one sentence the
 * admin could act on never left the process — shipped that way once, and caught
 * the first time a screen was opened with a bad token in the env. 502 because
 * the failure is upstream: this server is fine and the one it asked is not,
 * which is also what stops it reading as our bug.
 *
 * The message is always something already safe to show. Nothing upstream reaches
 * an admin verbatim, and no request URL or credential is ever interpolated into
 * one: a thrown `fetch` error can carry the request, and the request carries the
 * token.
 */
export class UpstreamError extends HttpException {
  constructor(
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message, HttpStatus.BAD_GATEWAY);
    this.name = 'UpstreamError';
  }
}

/**
 * `fetch` with a deadline, where a request that never completes becomes an
 * `UpstreamError` carrying a sentence rather than a stack.
 *
 * Returns the `Response` **whatever its status**. Deciding what a 401 or a 429
 * means is the caller's, and has to be: TMDB turns any non-2xx straight into an
 * error, while OpenSubtitles treats one particular 401 as "our cached session
 * token aged out" and retries it once before blaming the operator.
 *
 * Without the timeout a hung provider holds the request open indefinitely and
 * the admin gets a spinner rather than a message.
 */
export async function fetchUpstream(options: {
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  logger: Logger;
  /**
   * What to record and what to show when the request never completed at all.
   *
   * Two strings because they are not the same audience: the log gets the
   * diagnosis, the admin gets the sentence. Never interpolate `cause` into the
   * message — see `UpstreamError`.
   */
  onUnreachable: (cause: unknown) => { log: string; message: string };
  /**
   * Builds the error to throw. Each client passes its own named subclass, so
   * `TmdbError` stays a `TmdbError` on every path it could be thrown from.
   */
  error?: (message: string) => UpstreamError;
}): Promise<Response> {
  try {
    return await fetch(options.url, {
      ...options.init,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (cause) {
    const { log, message } = options.onUnreachable(cause);
    options.logger.warn(log);

    throw options.error ? options.error(message) : new UpstreamError(message);
  }
}

/** Whether `AbortSignal.timeout` is what ended the request, rather than the network. */
export function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'TimeoutError';
}
