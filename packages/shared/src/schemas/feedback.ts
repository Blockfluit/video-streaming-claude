import { z } from 'zod';

import { pageQuerySchema } from '../pagination.js';
import { nonEmptyText } from '../primitives.js';

/**
 * Feedback submitted from the floating button: a message, plus everything the
 * page can tell about itself so an admin does not have to ask. No status
 * workflow — this is a plain list, unlike comments or requests.
 */

export const MAX_FEEDBACK_MESSAGE_LENGTH = 2000;

export const createFeedbackSchema = z.object({
  message: nonEmptyText(MAX_FEEDBACK_MESSAGE_LENGTH),
  pageUrl: z.string().trim().min(1).max(2048),
  userAgent: z.string().trim().min(1).max(512),
  viewportWidth: z.number().int().positive(),
  viewportHeight: z.number().int().positive(),
  /** A `data:image/png;base64,...` URL. Optional — capture can fail or be skipped. */
  screenshot: z.string().optional(),
});
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;

export const listFeedbackSchema = pageQuerySchema;
export type ListFeedbackQuery = z.infer<typeof listFeedbackSchema>;
