import { z } from 'zod';

import { passwordSchema, usernameSchema } from '../identity.js';
import { pageQuerySchema } from '../pagination.js';

export const roleSchema = z.enum(['USER', 'ADMIN']);
export type Role = z.infer<typeof roleSchema>;

/** An admin creating an account directly. Same rules as redemption, so the result is indistinguishable. */
export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema.optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * `username` is deliberately absent. It is the login identity, and changing
 * what someone signs in with is a different operation needing its own thought
 * about who may do it — renaming means renaming `displayName`.
 */
export const updateUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(32),
    role: roleSchema,
    isActive: z.boolean(),
    /** With no mailer there is no reset link; an admin setting one by hand is the only recovery an account has. */
    password: passwordSchema,
  })
  .partial()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const listUsersSchema = pageQuerySchema;
export type ListUsersQuery = z.infer<typeof listUsersSchema>;

export const DEFAULT_INVITE_TTL_HOURS = 7 * 24;
export const MAX_INVITE_TTL_HOURS = 90 * 24;

export const createInviteSchema = z.object({
  grantsRole: roleSchema.optional(),
  // Bounded rather than open-ended: an invite that never practically expires is
  // a permanent way in, and this library has no other front door.
  expiresInHours: z.coerce.number().int().min(1).max(MAX_INVITE_TTL_HOURS).optional(),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const listInvitesSchema = pageQuerySchema;
export type ListInvitesQuery = z.infer<typeof listInvitesSchema>;
