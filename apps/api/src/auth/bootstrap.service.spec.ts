import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service';
import { BootstrapService } from './bootstrap.service';
import { hashToken } from './tokens';

describe('BootstrapService', () => {
  let directory: string;
  let tokenFile: string;
  let count: jest.Mock;
  let findFirst: jest.Mock;
  let create: jest.Mock;
  let updateMany: jest.Mock;
  let service: BootstrapService;
  let banner: jest.SpyInstance;

  beforeEach(async () => {
    // The banner is deliberately loud in production and unreadable in test output.
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    directory = await mkdtemp(join(tmpdir(), 'bootstrap-'));
    tokenFile = join(directory, '.bootstrap-token');

    count = jest.fn().mockResolvedValue(0);
    findFirst = jest.fn().mockResolvedValue(null);
    create = jest.fn().mockResolvedValue({ id: 'token-1' });
    updateMany = jest.fn().mockResolvedValue({ count: 0 });

    const prisma = {
      user: { count },
      inviteToken: { findFirst, create, updateMany },
    } as unknown as PrismaService;

    service = new BootstrapService(
      prisma,
      new ConfigService({ BOOTSTRAP_TOKEN_FILE: tokenFile }),
    );
  });

  afterEach(async () => {
    banner.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  const readToken = async (): Promise<string> => (await readFile(tokenFile, 'utf8')).trim();

  describe('when no admin exists', () => {
    it('mints a token and writes the plaintext to disk', async () => {
      await service.onApplicationBootstrap();

      expect(create).toHaveBeenCalledTimes(1);
      await expect(readToken()).resolves.toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('stores only the hash — the plaintext never reaches the database', async () => {
      await service.onApplicationBootstrap();

      const plaintext = await readToken();
      const { data } = create.mock.calls[0][0];

      expect(data.tokenHash).toBe(hashToken(plaintext));
      expect(JSON.stringify(data)).not.toContain(plaintext);
    });

    it('grants ADMIN and marks the token BOOTSTRAP', async () => {
      await service.onApplicationBootstrap();

      expect(create.mock.calls[0][0].data).toMatchObject({
        kind: 'BOOTSTRAP',
        grantsRole: 'ADMIN',
      });
    });

    it('expires the token roughly 24 hours out', async () => {
      await service.onApplicationBootstrap();

      const { expiresAt } = create.mock.calls[0][0].data as { expiresAt: Date };
      const hours = (expiresAt.getTime() - Date.now()) / 3_600_000;

      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThanOrEqual(24);
    });

    // The file is a live credential until it is redeemed.
    it('writes the file readable only by its owner', async () => {
      await service.onApplicationBootstrap();

      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    });

    it('tightens the permissions of a file left behind by a previous run', async () => {
      await writeFile(tokenFile, 'stale', { mode: 0o644 });

      await service.onApplicationBootstrap();

      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    });

    // Whoever runs the API has to be able to see the token without going
    // looking for it — the console is the only place they are already watching.
    it('prints the plaintext in the startup banner', async () => {
      await service.onApplicationBootstrap();

      expect(banner.mock.calls.flat().join('\n')).toContain(await readToken());
    });

    it('revokes older unredeemed master tokens so only one is ever live', async () => {
      await service.onApplicationBootstrap();

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { kind: 'BOOTSTRAP', redeemedAt: null, revokedAt: null },
          data: { revokedAt: expect.any(Date) },
        }),
      );
    });
  });

  describe('when an admin already exists', () => {
    beforeEach(() => count.mockResolvedValue(1));

    it('mints nothing', async () => {
      await service.onApplicationBootstrap();

      expect(create).not.toHaveBeenCalled();
    });

    // A leftover token file is a credential lying around for no reason.
    it('deletes a stale token file', async () => {
      await writeFile(tokenFile, 'stale');

      await service.onApplicationBootstrap();

      await expect(readFile(tokenFile, 'utf8')).rejects.toThrow();
    });

    it('does not mind the file already being gone', async () => {
      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  describe('when a live master token already exists', () => {
    beforeEach(() => findFirst.mockResolvedValue({ id: 'token-1' }));

    it('reuses it while its plaintext is still on disk', async () => {
      await writeFile(tokenFile, 'previous-token\n');

      await service.onApplicationBootstrap();

      expect(create).not.toHaveBeenCalled();
      await expect(readToken()).resolves.toBe('previous-token');
    });

    // Only the sha256 is stored, so a row whose file is gone can never be
    // presented by anyone — reusing it would print a banner pointing at nothing.
    it('mints a replacement when the plaintext has been lost', async () => {
      await service.onApplicationBootstrap();

      expect(create).toHaveBeenCalledTimes(1);
      await expect(readToken()).resolves.not.toBe('');
    });
  });

  describe('removeTokenFile', () => {
    it('deletes the spent plaintext', async () => {
      await writeFile(tokenFile, 'spent');

      await service.removeTokenFile();

      await expect(readFile(tokenFile, 'utf8')).rejects.toThrow();
    });

    it('is a no-op when the file is already gone', async () => {
      await expect(service.removeTokenFile()).resolves.toBeUndefined();
    });
  });
});
