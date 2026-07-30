import { createHash } from 'node:crypto';

import { TOKEN_BYTES, generateToken, hashToken, tokenState } from './tokens';

describe('generateToken', () => {
  it('carries 256 bits of entropy', () => {
    expect(Buffer.from(generateToken(), 'base64url')).toHaveLength(TOKEN_BYTES);
  });

  // base64url so the token survives a URL, a shell copy-paste and a double-click
  // without needing to be escaped.
  it('is URL-safe and padding-free', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 500 }, generateToken));

    expect(seen.size).toBe(500);
  });
});

describe('hashToken', () => {
  it('is sha256, hex-encoded', () => {
    expect(hashToken('abc')).toBe(createHash('sha256').update('abc', 'utf8').digest('hex'));
    expect(hashToken('abc')).toHaveLength(64);
  });

  it('is stable, so a token minted now still matches at redemption', () => {
    expect(hashToken('same-token')).toBe(hashToken('same-token'));
  });

  it('separates tokens that differ by a single character', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
  });

  // What the database holds must be useless to whoever reads it.
  it('never returns the plaintext', () => {
    const plaintext = generateToken();

    expect(hashToken(plaintext)).not.toBe(plaintext);
  });
});

describe('tokenState', () => {
  const now = new Date('2026-07-30T12:00:00.000Z');
  const hourAway = new Date('2026-07-30T13:00:00.000Z');
  const hourAgo = new Date('2026-07-30T11:00:00.000Z');

  const token = (overrides: Partial<Parameters<typeof tokenState>[0]> = {}) => ({
    expiresAt: hourAway,
    redeemedAt: null,
    revokedAt: null,
    ...overrides,
  });

  it('accepts an unredeemed, unrevoked, unexpired token', () => {
    expect(tokenState(token(), now)).toBe('VALID');
  });

  it('rejects an expired token', () => {
    expect(tokenState(token({ expiresAt: hourAgo }), now)).toBe('EXPIRED');
  });

  // The boundary is closed: a token expiring exactly now is already gone. Erring
  // the other way would leave a token usable for one more clock tick.
  it('treats the expiry instant itself as expired', () => {
    expect(tokenState(token({ expiresAt: now }), now)).toBe('EXPIRED');
  });

  it('rejects a redeemed token', () => {
    expect(tokenState(token({ redeemedAt: hourAgo }), now)).toBe('REDEEMED');
  });

  it('rejects a revoked token', () => {
    expect(tokenState(token({ revokedAt: hourAgo }), now)).toBe('REVOKED');
  });

  // Precedence only affects what an admin sees in the invite list — every
  // non-VALID state is one indistinguishable rejection at the API boundary.
  describe('precedence when several reasons apply', () => {
    it('reports REDEEMED over REVOKED and EXPIRED', () => {
      expect(
        tokenState(token({ redeemedAt: hourAgo, revokedAt: hourAgo, expiresAt: hourAgo }), now),
      ).toBe('REDEEMED');
    });

    it('reports REVOKED over EXPIRED', () => {
      expect(tokenState(token({ revokedAt: hourAgo, expiresAt: hourAgo }), now)).toBe('REVOKED');
    });
  });

  it('does not treat a future revocation or redemption as already applied', () => {
    const later = new Date('2026-07-30T12:30:00.000Z');

    expect(tokenState(token({ revokedAt: later, redeemedAt: later }), now)).toBe('VALID');
  });
});
