import { z } from 'zod';

import { pageQuerySchema } from '../pagination.js';
import { booleanParam, nonEmptyText, optionalText, yearSchema } from '../primitives.js';

/**
 * Asking for something the library does not have.
 *
 * A request is a small piece of user-authored content with an admin workflow
 * attached, so it reads much like a comment — with one difference that shapes
 * everything: **who asked is not public**. Other viewers see the request and
 * its status, never the name behind it. That rule lives in the API's serializer;
 * what lives here is the shape of what a client may send.
 */

/**
 * Where a request can be in its life.
 *
 * `NEW` is where every request starts. The rest are an admin's answer, and the
 * order here is roughly the order they happen in — it is what the admin UI
 * renders its options from, so a status added later appears without anyone
 * having to remember a second list.
 */
export const REQUEST_STATUSES = [
  'NEW',
  'SEEN',
  'PROCESSING',
  'NOT_AVAILABLE',
  'REJECTED',
  'AVAILABLE',
] as const;
export const requestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

/**
 * The statuses that still have something to happen.
 *
 * This is what "already requested" means: a second request for the same title
 * is a duplicate while the first is still open, and is a fresh ask once the
 * first has been answered. Someone whose request was rejected a year ago may
 * reasonably ask again; someone asking for what is already `PROCESSING` is
 * asking twice.
 */
export const OPEN_REQUEST_STATUSES = ['NEW', 'SEEN', 'PROCESSING'] as const;
export type OpenRequestStatus = (typeof OPEN_REQUEST_STATUSES)[number];

export function isOpenStatus(status: RequestStatus): status is OpenRequestStatus {
  return (OPEN_REQUEST_STATUSES as readonly string[]).includes(status);
}

export const MAX_REQUEST_TITLE_LENGTH = 200;
export const MAX_REQUEST_COMMENT_LENGTH = 2000;
export const MAX_ADMIN_NOTE_LENGTH = 2000;

/**
 * The title is the only thing required. A year and a comment help an admin
 * identify what is actually being asked for — there are two films called
 * `The Thing` — but demanding them would turn a one-line ask into a form.
 */
export const createRequestSchema = z.object({
  title: nonEmptyText(MAX_REQUEST_TITLE_LENGTH),
  year: yearSchema.nullish(),
  comment: optionalText(MAX_REQUEST_COMMENT_LENGTH),
});
export type CreateRequestInput = z.infer<typeof createRequestSchema>;

/**
 * An admin's answer. ADMIN-only at the route, which is what makes the status
 * something a requester can read and not something they can set.
 *
 * `adminNote` is optional and, when omitted entirely, leaves whatever note is
 * already there alone — sending an explicit `null` is how it gets cleared.
 * Without that distinction, moving a request from SEEN to PROCESSING would wipe
 * the explanation attached to it.
 */
export const updateRequestStatusSchema = z.object({
  status: requestStatusSchema,
  adminNote: optionalText(MAX_ADMIN_NOTE_LENGTH),
});
export type UpdateRequestStatusInput = z.infer<typeof updateRequestStatusSchema>;

export const listRequestsSchema = pageQuerySchema.extend({
  status: requestStatusSchema.optional(),
  /** Only the caller's own. Not a leak — you already know what you asked for. */
  mine: booleanParam.optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListRequestsQuery = z.infer<typeof listRequestsSchema>;
