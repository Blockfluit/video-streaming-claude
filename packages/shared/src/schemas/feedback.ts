import { z } from 'zod';

import { pageQuerySchema } from '../pagination.js';
import { nonEmptyText } from '../primitives.js';

/**
 * Feedback submitted from the floating button: a message, plus everything the
 * page can tell about itself so an admin does not have to ask. No status
 * workflow — this is a plain list, unlike comments or requests.
 */

export const MAX_FEEDBACK_MESSAGE_LENGTH = 2000;

/**
 * `pageUrl` is rendered on `/admin/feedback` as `<a :href="item.pageUrl">` —
 * an admin sees it as "where the user was" and may click it. The client sends
 * `route.fullPath`, but the client is not the trusted party here: any
 * signed-in `USER` can submit whatever they like as `pageUrl`, and a
 * `javascript:` or off-site value dressed up as "where I was" is a
 * USER-to-ADMIN escalation. Enforced server-side, in the shared schema, for
 * exactly that reason.
 *
 * The checks mirror `apps/web/app/utils/safe-redirect.ts` exactly (same
 * reasoning: an admin's click is the "after authenticating" moment that
 * function guards, just with a different action following it) — a bare `/`
 * prefix is not enough, since `//evil.example` is protocol-relative and
 * `/\evil.example` is normalised the same way by some browsers, and a control
 * character can smuggle a line break past a naive check.
 */
function isSameSitePagePath(value: string): boolean {
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

export const createFeedbackSchema = z.object({
  message: nonEmptyText(MAX_FEEDBACK_MESSAGE_LENGTH),
  pageUrl: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(isSameSitePagePath, 'That page is not on this site.'),
  userAgent: z.string().trim().min(1).max(512),
  viewportWidth: z.number().int().positive(),
  viewportHeight: z.number().int().positive(),
  /** A `data:image/png;base64,...` URL. Optional — capture can fail or be skipped. */
  screenshot: z.string().optional(),
});
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;

export const listFeedbackSchema = pageQuerySchema;
export type ListFeedbackQuery = z.infer<typeof listFeedbackSchema>;
