import { createHash, randomBytes } from 'node:crypto';

/**
 * Invite and bootstrap tokens — pure logic, no database and no clock of its own.
 *
 * These are hashed with **sha256, not argon2**, which looks wrong next to
 * `PasswordService` until you notice what is being hashed: 256 bits of CSPRNG
 * output, not a guessable secret. A slow KDF exists to make brute force
 * expensive, and there is nothing here to brute force. Passwords still get
 * argon2id.
 */

export const TOKEN_BYTES = 32;

/** 256 bits, base64url so the token survives a URL and a copy-paste unescaped. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Lookup is `WHERE tokenHash = ...` against a unique index rather than a
 * comparison in JS, so there is no string compare to make timing-safe.
 */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export type TokenState = 'VALID' | 'REDEEMED' | 'REVOKED' | 'EXPIRED';

/** The columns of `InviteToken` that decide whether it can still be used. */
export interface RedeemableToken {
  expiresAt: Date;
  redeemedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Why a token cannot be used, or `VALID`.
 *
 * `now` is a parameter rather than a `new Date()` inside so the boundary cases
 * are testable. Callers pass one instant for the whole decision — reading the
 * clock twice could classify a token as valid and then expired mid-redemption.
 *
 * Precedence is redeemed → revoked → expired, which only matters for what an
 * admin sees in the invite list: at the API boundary every non-`VALID` state
 * collapses into the same rejection, so a caller cannot probe for which
 * tokens exist.
 */
export function tokenState(token: RedeemableToken, now: Date): TokenState {
  if (token.redeemedAt !== null && token.redeemedAt <= now) return 'REDEEMED';
  if (token.revokedAt !== null && token.revokedAt <= now) return 'REVOKED';
  // Closed boundary: a token expiring exactly now is already gone.
  if (token.expiresAt <= now) return 'EXPIRED';
  return 'VALID';
}
