import { z } from 'zod';

import { passwordSchema, usernameSchema } from '../identity.js';

/**
 * Login is deliberately looser than signup: it bounds the length and nothing
 * else. Enforcing the username *pattern* here would tell an attacker what the
 * pattern is, and would lock out any account created before the rules changed.
 */
export const loginSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .transform((value) => value.toLowerCase()),
  // Bounded so an unauthenticated caller cannot make the API hash a novel.
  password: z.string().min(1).max(1000),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Redeeming an invite or the master token. Username and password only — the
 * library sends no mail, so there is nothing else to ask for.
 *
 * The username arrives trimmed but **not** lowercased: the service stores the
 * lowercase form as `username` and this as-typed value as `displayName`, which
 * is why the pattern is case-insensitive.
 */
export const redeemSchema = z.object({
  token: z.string().min(1).max(512),
  username: usernameSchema,
  password: passwordSchema,
});

export type RedeemInput = z.infer<typeof redeemSchema>;

/**
 * What the signup *form* asks for: the endpoint's own fields, plus the password
 * a second time.
 *
 * The confirmation is deliberately **not** part of `redeemSchema`. The server
 * has no way to know what someone meant to type, so a second copy tells it
 * nothing it can act on — the field is a typo guard, and a typo guard belongs
 * where the typing happens. Requiring it at the endpoint would also break every
 * existing caller for no gain.
 *
 * Derived from `redeemSchema` rather than restated, so the two cannot drift:
 * a rule added to the endpoint's username or password reaches this form on the
 * next build without anyone remembering to copy it across.
 *
 * Asking twice is worth it here specifically because the account this creates
 * cannot be recovered. The library sends no mail and has no reset flow, so a
 * mistyped password is permanent and the only remedy is an admin minting a
 * fresh invite.
 */
export const redeemFormSchema = redeemSchema
  .extend({ confirmPassword: z.string() })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'Passwords do not match.',
    // Without a path the message attaches to the object itself, and a form
    // field-level error has nowhere to render it.
    path: ['confirmPassword'],
  });

export type RedeemFormInput = z.infer<typeof redeemFormSchema>;
