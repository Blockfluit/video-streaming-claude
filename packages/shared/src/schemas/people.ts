import { z } from 'zod';

import { pageQuerySchema } from '../pagination.js';
import { idSchema, nonEmptyText, optionalText } from '../primitives.js';

/**
 * People and the credits that attach them to a collection or a video.
 */

export const creditRoleSchema = z.enum([
  'ACTOR',
  'DIRECTOR',
  'WRITER',
  'PRODUCER',
  'COMPOSER',
  'CINEMATOGRAPHER',
  'EDITOR',
  'OTHER',
]);
export type CreditRoleName = z.infer<typeof creditRoleSchema>;

export const createPersonSchema = z.object({
  name: nonEmptyText(200),
  bio: optionalText(5000),
  photoKey: optionalText(500),
});
export type CreatePersonInput = z.infer<typeof createPersonSchema>;

export const updatePersonSchema = z
  .object({
    name: nonEmptyText(200).optional(),
    bio: optionalText(5000),
    photoKey: optionalText(500),
    /** Slugs are stable once created; moving one is deliberate. */
    regenerateSlug: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
export type UpdatePersonInput = z.infer<typeof updatePersonSchema>;

export const listPeopleSchema = pageQuerySchema.extend({
  /** Prefix and substring match on the name — this is also the autocomplete. */
  q: z.string().trim().max(200).optional(),
});
export type ListPeopleQuery = z.infer<typeof listPeopleSchema>;

export const createCreditSchema = z.object({
  personId: idSchema,
  role: creditRoleSchema,
  /** Only meaningful for ACTOR, and not enforced — a puppeteer has a character too. */
  characterName: optionalText(200),
  /** Billing order within the role. Appended to the end when omitted. */
  position: z.coerce.number().int().min(0).max(9999).optional(),
});
export type CreateCreditInput = z.infer<typeof createCreditSchema>;

export const updateCreditSchema = z
  .object({
    role: creditRoleSchema.optional(),
    characterName: optionalText(200),
    position: z.coerce.number().int().min(0).max(9999).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateCreditInput = z.infer<typeof updateCreditSchema>;

/**
 * A whole billing order in one request.
 *
 * The parent is named explicitly so the service can refuse ids belonging to
 * anything else — without it, a reorder is a way to renumber credits on a video
 * the caller never mentioned.
 */
export const reorderCreditsSchema = z
  .object({
    collectionId: idSchema.optional(),
    videoId: idSchema.optional(),
    creditIds: z.array(idSchema).min(1).max(500),
  })
  .refine((value) => (value.collectionId === undefined) !== (value.videoId === undefined), {
    message: 'Name exactly one of collectionId or videoId',
  });
export type ReorderCreditsInput = z.infer<typeof reorderCreditsSchema>;
