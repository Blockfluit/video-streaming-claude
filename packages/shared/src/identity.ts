import { z } from 'zod';

/**
 * Username and password rules.
 *
 * Shared because a signup form that disagrees with the API produces the worst
 * kind of validation: the client says a username is fine, the server says it is
 * not, and the message the user sees comes from whichever one they hit first.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/**
 * Letters, digits, and inner `._-`; must start and end alphanumeric.
 *
 * Case-insensitive because the value is validated *before* it is lowercased —
 * `displayName` keeps whatever casing was typed, so the as-typed value has to
 * pass too.
 */
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

export const USERNAME_RULES =
  'Username must be 3-32 characters: letters, digits, and . _ - between them.';

/**
 * No composition rules, only a length. Length is the one property that reliably
 * predicts how hard a password is to guess; "must contain a symbol" mostly
 * produces `Password1!`. 12 rather than 8 because there is no MFA here.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1000;

/** Trimmed but NOT lowercased — the caller keeps this as `displayName`. */
export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH, USERNAME_RULES)
  .max(USERNAME_MAX_LENGTH, USERNAME_RULES)
  .regex(USERNAME_PATTERN, USERNAME_RULES);

/**
 * What is stored and matched on. Lowercasing here is what makes login
 * case-insensitive without `citext` or a functional index.
 */
export const normalisedUsernameSchema = usernameSchema.transform((value) => value.toLowerCase());

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH);

/** Trim and lowercase, for matching an existing username. */
export function normaliseUsername(value: string): string {
  return value.trim().toLowerCase();
}
