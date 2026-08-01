import { DEFAULT_INVITE_TTL_HOURS, type ListInvitesQuery } from '@video/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { InvitesService } from './invites.service';

/**
 * Unit coverage for the invite list. `redeem.db-spec.ts` proves the behaviour
 * over HTTP against a real Postgres; this pins the two things that are
 * invisible from outside — which columns the query actually asks for, and that
 * `state` is computed rather than read.
 *
 * The select assertion is the one that earns its keep. Dropping `username` from
 * either sub-select leaves every HTTP test passing, because `displayName` is
 * still there and nothing over the wire looks different until a screen tries to
 * tell two people with the same display name apart.
 */
describe('InvitesService', () => {
  const query: ListInvitesQuery = { limit: 50, offset: 0 };

  let findMany: jest.Mock;
  let count: jest.Mock;
  let create: jest.Mock;
  let $transaction: jest.Mock;
  let service: InvitesService;

  /** A row as Prisma would return it under `INVITE_SELECT`. */
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'invite-1',
    kind: 'INVITE',
    grantsRole: 'USER',
    expiresAt: new Date('2026-08-08T00:00:00.000Z'),
    redeemedAt: null,
    revokedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    createdBy: { id: 'admin-1', displayName: 'Ada', username: 'ada' },
    redeemedUser: null,
    ...overrides,
  });

  beforeEach(() => {
    findMany = jest.fn().mockReturnValue('findMany-promise');
    count = jest.fn().mockReturnValue('count-promise');
    create = jest.fn().mockResolvedValue(row());
    $transaction = jest.fn().mockResolvedValue([[row()], 1]);

    const prisma = {
      inviteToken: { findMany, count, create },
      $transaction,
    } as unknown as PrismaService;

    service = new InvitesService(prisma);
  });

  describe('list', () => {
    it('asks for the username of both people on a token, not just their display name', async () => {
      await service.list(query);

      const select = findMany.mock.calls[0][0].select;

      expect(select.createdBy.select).toMatchObject({ displayName: true, username: true });
      expect(select.redeemedUser.select).toMatchObject({ displayName: true, username: true });
    });

    it('computes state rather than reading a column', async () => {
      // Neither redeemed nor revoked, but long past its expiry.
      $transaction.mockResolvedValue([
        [row({ expiresAt: new Date('2020-01-01T00:00:00.000Z') })],
        1,
      ]);

      const page = await service.list(query);

      expect(page.items[0].state).toBe('EXPIRED');
    });

    it('carries a null minter through rather than inventing one', async () => {
      // A BOOTSTRAP token is minted at startup with no admin present. The
      // frontend branches on this null to say "system" instead of a name.
      $transaction.mockResolvedValue([[row({ kind: 'BOOTSTRAP', createdBy: null })], 1]);

      const page = await service.list(query);

      expect(page.items[0].createdBy).toBeNull();
    });
  });

  describe('mint', () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('falls back to the default TTL when none is given', async () => {
      await service.mint({}, 'admin-1');

      expect(create.mock.calls[0][0].data.expiresAt).toEqual(
        new Date(Date.now() + DEFAULT_INVITE_TTL_HOURS * 3_600_000),
      );
    });

    it('honours an explicit expiry', async () => {
      await service.mint({ expiresInHours: 24 }, 'admin-1');

      expect(create.mock.calls[0][0].data.expiresAt).toEqual(
        new Date(Date.now() + 24 * 3_600_000),
      );
    });
  });
});
