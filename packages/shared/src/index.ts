/**
 * The contract between `apps/api` and `apps/web`.
 *
 * Request schemas live here rather than in the API so both sides validate
 * against the same definition. A signup form that disagrees with the server
 * produces the worst kind of validation error: the client says the input is
 * fine, the server says it is not, and the user sees whichever message they
 * reach first.
 *
 * These are **request** schemas — what a client may send. Response shapes stay
 * types, since the API is the only thing that produces them. Nothing here may
 * import from either app.
 */

export * from './identity';
export * from './pagination';
export * from './quality';
export * from './primitives';
export * from './schemas/accounts';
export * from './schemas/auth';
export * from './schemas/comments';
export * from './schemas/library';
export * from './schemas/people';
export * from './schemas/watch';
