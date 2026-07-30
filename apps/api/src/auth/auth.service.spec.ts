import { BadRequestException, ConflictException } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { BootstrapService } from './bootstrap.service';
import type { RedeemDto } from './dto/redeem.dto';
import { PasswordService } from './password.service';
import { hashToken } from './tokens';

/**
 * Unit coverage for `redeem()`. `redeem.db-spec.ts` proves the behaviour
 * against a real Postgres; this pins the two things that are invisible from
 * outside — that the claim stays conditional, and what happens when it loses.
 */
describe('AuthService.redeem', () => {
  const hourAway = new Date(Date.now() + 3_600_000);

  let findUniqueToken: jest.Mock;
  let findUniqueUser: jest.Mock;
  let createUser: jest.Mock;
  let updateManyToken: jest.Mock;
  let removeTokenFile: jest.Mock;
  let service: AuthService;

  const dto = (overrides: Partial<RedeemDto> = {}): RedeemDto =>
    ({ token: 'plaintext-token', username: 'Ada', password: 'a'.repeat(12), ...overrides }) as RedeemDto;

  beforeEach(() => {
    findUniqueToken = jest.fn().mockResolvedValue({
      id: 'token-1',
      kind: 'INVITE',
      grantsRole: 'USER',
      expiresAt: hourAway,
      redeemedAt: null,
      revokedAt: null,
    });
    findUniqueUser = jest.fn().mockResolvedValue(null);
    createUser = jest.fn().mockResolvedValue({
      id: 'user-1',
      username: 'ada',
      displayName: 'Ada',
      role: 'USER',
      isActive: true,
    });
    updateManyToken = jest.fn().mockResolvedValue({ count: 1 });
    removeTokenFile = jest.fn().mockResolvedValue(undefined);

    const tx = {
      inviteToken: { findUnique: findUniqueToken, updateMany: updateManyToken },
      user: { findUnique: findUniqueUser, create: createUser },
    };

    const prisma = {
      $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
    } as unknown as PrismaService;

    service = new AuthService(prisma, new PasswordService(), {
      removeTokenFile,
    } as unknown as BootstrapService);
  });

  it('looks the token up by hash, never by plaintext', async () => {
    await service.redeem(dto());

    expect(findUniqueToken).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashToken('plaintext-token') } }),
    );
  });

  // Removing this condition is the mutation the HTTP-level race test cannot catch.
  it('claims the token conditionally on it still being unredeemed', async () => {
    await service.redeem(dto());

    expect(updateManyToken).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'token-1', redeemedAt: null },
      }),
    );
  });

  it('rejects the redemption when the claim matches nothing', async () => {
    updateManyToken.mockResolvedValue({ count: 0 });

    await expect(service.redeem(dto())).rejects.toThrow(BadRequestException);
  });

  it('takes the role from the token, so the request body cannot escalate it', async () => {
    findUniqueToken.mockResolvedValue({
      id: 'token-1',
      kind: 'INVITE',
      grantsRole: 'ADMIN',
      expiresAt: hourAway,
      redeemedAt: null,
      revokedAt: null,
    });

    await service.redeem({ ...dto(), role: 'ADMIN' } as RedeemDto & { role: string });

    expect(createUser.mock.calls[0][0].data.role).toBe('ADMIN');
  });

  it('stores the username lowercased and keeps the typed casing for display', async () => {
    await service.redeem(dto({ username: 'AdaLovelace' }));

    expect(createUser.mock.calls[0][0].data).toMatchObject({
      username: 'adalovelace',
      displayName: 'AdaLovelace',
    });
  });

  it('never stores the password in the clear', async () => {
    const password = 'a-very-secret-password';

    await service.redeem(dto({ password }));

    const { data } = createUser.mock.calls[0][0];
    expect(data.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(data)).not.toContain(password);
  });

  it('rejects an expired token without creating anything', async () => {
    findUniqueToken.mockResolvedValue({
      id: 'token-1',
      kind: 'INVITE',
      grantsRole: 'USER',
      expiresAt: new Date(Date.now() - 1000),
      redeemedAt: null,
      revokedAt: null,
    });

    await expect(service.redeem(dto())).rejects.toThrow(BadRequestException);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('409s a taken username rather than letting the unique index throw', async () => {
    findUniqueUser.mockResolvedValue({ id: 'someone-else' });

    await expect(service.redeem(dto())).rejects.toThrow(ConflictException);
    expect(createUser).not.toHaveBeenCalled();
  });

  describe('the master token file', () => {
    it('is deleted after a BOOTSTRAP redemption', async () => {
      findUniqueToken.mockResolvedValue({
        id: 'token-1',
        kind: 'BOOTSTRAP',
        grantsRole: 'ADMIN',
        expiresAt: hourAway,
        redeemedAt: null,
        revokedAt: null,
      });

      await service.redeem(dto());

      expect(removeTokenFile).toHaveBeenCalled();
    });

    it('is left alone by an ordinary invite', async () => {
      await service.redeem(dto());

      expect(removeTokenFile).not.toHaveBeenCalled();
    });
  });
});
