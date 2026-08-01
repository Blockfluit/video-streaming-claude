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

export * from './identity.js';
export * from './pagination.js';
export * from './quality.js';
export * from './trailers.js';
export * from './primitives.js';
export * from './schemas/accounts.js';
export * from './schemas/auth.js';
export * from './schemas/comments.js';
export * from './schemas/library.js';
export * from './schemas/lists.js';
export * from './schemas/people.js';
export * from './schemas/watch.js';
