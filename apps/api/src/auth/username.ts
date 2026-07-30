/**
 * Username rules, in one place because two DTOs need them: login (step 4) and
 * token redemption (step 5).
 *
 * Usernames are stored lowercase, which is what makes uniqueness and lookup
 * case-insensitive without citext or a functional index. `displayName` keeps
 * whatever casing was typed.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/**
 * Letters, digits, and inner `._-`; must start and end alphanumeric.
 *
 * Case-insensitive because redemption validates the username *before*
 * normalising it — `displayName` keeps whatever casing was typed, so the
 * as-typed value has to pass validation too. No `g` flag: `RegExp.test` with
 * one is stateful and would fail every other call.
 */
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

export const USERNAME_RULES =
  'Username must be 3-32 characters: letters, digits, and . _ - between them.';

/** Trim and lowercase. Applied on both signup and login so the two agree. */
export function normaliseUsername(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/**
 * Trim only, preserving case. Redemption stores this as `displayName` and the
 * lowercased form as `username`, so one field renders and the other logs in.
 */
export function trimUsername(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}
