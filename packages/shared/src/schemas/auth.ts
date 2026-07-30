import { z } from 'zod';

import { passwordSchema, usernameSchema } from '../identity';

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
