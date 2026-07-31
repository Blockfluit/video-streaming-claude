import { z } from 'zod';

import { pageQuerySchema } from '../pagination';
import { nonEmptyText } from '../primitives';

/**
 * Comments under the player. Flat, newest first, optionally pinned to a moment.
 */

export const MAX_COMMENT_LENGTH = 5000;

/**
 * The same absolute sanity cap the skip markers use. The real bound is the
 * video's duration, which is checked server-side — but only when a duration is
 * known, and this one applies either way.
 */
const timestampSec = z.coerce
  .number()
  .min(0)
  .max(24 * 60 * 60)
  .nullish();

export const createCommentSchema = z.object({
  body: nonEmptyText(MAX_COMMENT_LENGTH),
  /** Pins the comment to the playback position it was written at. */
  timestampSec,
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = z.object({
  body: nonEmptyText(MAX_COMMENT_LENGTH),
});
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

export const listCommentsSchema = pageQuerySchema;
export type ListCommentsQuery = z.infer<typeof listCommentsSchema>;
