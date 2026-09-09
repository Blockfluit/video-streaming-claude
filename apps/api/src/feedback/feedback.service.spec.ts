import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';

import type { AuthUser } from '../auth/auth.types';
import type { StorageService } from '../common/storage.service';
import type { PrismaService } from '../prisma/prisma.service';
import { FeedbackService } from './feedback.service';
import { feedbackScreenshotKey } from './keys';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('FeedbackService', () => {
  const user: AuthUser = {
    id: 'user-1',
    username: 'ada',
    displayName: 'Ada',
    role: 'USER',
    isActive: true,
  };

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'fb-1',
    message: 'Broken player',
    pageUrl: '/watch/heat',
    userAgent: 'Mozilla/5.0',
    viewportWidth: 1280,
    viewportHeight: 800,
    hasScreenshot: false,
    createdAt: new Date('2026-09-06T00:00:00.000Z'),
    user: { id: 'user-1', displayName: 'Ada' },
    ...overrides,
  });

  let create: jest.Mock;
  let findMany: jest.Mock;
  let count: jest.Mock;
  let findUnique: jest.Mock;
  let deleteRow: jest.Mock;
  let $transaction: jest.Mock;
  let save: jest.Mock;
  let statOf: jest.Mock;
  let deleteFile: jest.Mock;
  let resolvePath: jest.Mock;
  let service: FeedbackService;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue(row());
    findMany = jest.fn().mockReturnValue('findMany-promise');
    count = jest.fn().mockReturnValue('count-promise');
    findUnique = jest.fn();
    deleteRow = jest.fn().mockResolvedValue(undefined);
    $transaction = jest.fn().mockResolvedValue([[row()], 1]);
    save = jest.fn().mockResolvedValue('/derived/feedback/fb-1.png');
    statOf = jest.fn().mockResolvedValue({ size: 100, mtime: new Date() });
    deleteFile = jest.fn().mockResolvedValue(undefined);
    resolvePath = jest.fn().mockReturnValue('/derived/feedback/fb-1.png');

    const prisma = {
      feedback: { create, findMany, count, findUnique, delete: deleteRow },
      $transaction,
    } as unknown as PrismaService;

    const storage = {
      save,
      statOf,
      delete: deleteFile,
      resolvePath,
    } as unknown as StorageService;

    service = new FeedbackService(prisma, storage);
  });

  describe('create', () => {
    it('creates the row with hasScreenshot false and never touches storage when no screenshot is sent', async () => {
      await service.create(user, {
        message: 'Broken player',
        pageUrl: '/watch/heat',
        userAgent: 'Mozilla/5.0',
        viewportWidth: 1280,
        viewportHeight: 800,
      });

      expect(create.mock.calls[0][0].data).toMatchObject({ userId: 'user-1', hasScreenshot: false });
      expect(save).not.toHaveBeenCalled();
    });

    it('decodes a data-URL screenshot and saves it under the deterministic key', async () => {
      create.mockResolvedValue(row({ hasScreenshot: true }));

      await service.create(user, {
        message: 'Broken player',
        pageUrl: '/watch/heat',
        userAgent: 'Mozilla/5.0',
        viewportWidth: 1280,
        viewportHeight: 800,
        screenshot: `data:image/png;base64,${TINY_PNG_BASE64}`,
      });

      expect(create.mock.calls[0][0].data.hasScreenshot).toBe(true);
      expect(save).toHaveBeenCalledWith(
        'derived',
        feedbackScreenshotKey('fb-1'),
        Buffer.from(TINY_PNG_BASE64, 'base64'),
      );
    });

    it('rejects a screenshot over the size cap, before writing anything', async () => {
      const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString('base64');

      await expect(
        service.create(user, {
          message: 'Broken player',
          pageUrl: '/watch/heat',
          userAgent: 'Mozilla/5.0',
          viewportWidth: 1280,
          viewportHeight: 800,
          screenshot: `data:image/png;base64,${oversized}`,
        }),
      ).rejects.toThrow('too large');

      expect(create).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('listForAdmin', () => {
    it('returns a Page ordered newest first', async () => {
      const page = await service.listForAdmin({ limit: 50, offset: 0 });

      expect($transaction).toHaveBeenCalled();
      expect(findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(page).toMatchObject({ total: 1, limit: 50, offset: 0 });
      expect(page.items[0].id).toBe('fb-1');
    });
  });

  describe('sendScreenshot', () => {
    const response = { setHeader: jest.fn(), req: { headers: {} } } as unknown as Response;

    it('404s when the row has no screenshot', async () => {
      findUnique.mockResolvedValue(row({ hasScreenshot: false }));

      await expect(service.sendScreenshot('fb-1', response)).rejects.toThrow(NotFoundException);
    });

    it('404s when the row does not exist', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.sendScreenshot('fb-1', response)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes the row and the screenshot file when one exists', async () => {
      findUnique.mockResolvedValue(row({ hasScreenshot: true }));

      await service.remove('fb-1');

      expect(deleteRow).toHaveBeenCalledWith({ where: { id: 'fb-1' } });
      expect(deleteFile).toHaveBeenCalledWith('derived', feedbackScreenshotKey('fb-1'));
    });

    it('skips the storage delete when there was never a screenshot', async () => {
      findUnique.mockResolvedValue(row({ hasScreenshot: false }));

      await service.remove('fb-1');

      expect(deleteFile).not.toHaveBeenCalled();
    });

    it('404s an unknown id', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.remove('nope')).rejects.toThrow(NotFoundException);
    });
  });
});
