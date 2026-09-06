import type { PasswordService } from '../auth/password.service';
import type { StorageService } from '../common/storage.service';
import { feedbackScreenshotKey } from '../feedback/keys';
import type { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

/**
 * `UsersService.remove`'s feedback-screenshot sweep.
 *
 * `Feedback.userId` cascades, which deletes the row — but a cascade cannot
 * touch a filesystem, and nothing else sweeps a screenshot under
 * `derived/feedback/`. This is the one behaviour worth a unit test of its
 * own: everything else about `remove` (the last-admin lock) is already
 * covered against a real database in `users.db-spec.ts`, which does not
 * exercise storage at all.
 */
describe('UsersService.remove — feedback screenshots', () => {
  let findUnique: jest.Mock;
  let feedbackFindMany: jest.Mock;
  let deleteUser: jest.Mock;
  let queryRaw: jest.Mock;
  let deleteFile: jest.Mock;
  let service: UsersService;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue({ id: 'user-1', role: 'USER', isActive: true });
    feedbackFindMany = jest.fn().mockResolvedValue([]);
    deleteUser = jest.fn().mockResolvedValue(undefined);
    // A plain USER being deleted never holds the last-admin door open, so an
    // empty admin list satisfies `assertKeepsAnAdmin` without further setup.
    queryRaw = jest.fn().mockResolvedValue([]);
    deleteFile = jest.fn().mockResolvedValue(undefined);

    const tx = {
      user: { findUnique, delete: deleteUser },
      feedback: { findMany: feedbackFindMany },
      $queryRaw: queryRaw,
    };

    const prisma = {
      $transaction: jest.fn((callback: (tx: unknown) => unknown) => callback(tx)),
    } as unknown as PrismaService;

    const storage = { delete: deleteFile } as unknown as StorageService;
    const passwords = {} as PasswordService;

    service = new UsersService(prisma, passwords, storage);
  });

  it('deletes no files when the account left no feedback screenshots behind', async () => {
    await service.remove('user-1');

    expect(feedbackFindMany.mock.calls[0][0]).toMatchObject({
      where: { userId: 'user-1', hasScreenshot: true },
    });
    expect(deleteUser).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('sweeps every screenshot belonging to the deleted account', async () => {
    feedbackFindMany.mockResolvedValue([{ id: 'fb-1' }, { id: 'fb-2' }]);

    await service.remove('user-1');

    expect(deleteFile).toHaveBeenCalledWith('derived', feedbackScreenshotKey('fb-1'));
    expect(deleteFile).toHaveBeenCalledWith('derived', feedbackScreenshotKey('fb-2'));
    expect(deleteFile).toHaveBeenCalledTimes(2);
  });

  it('reads the feedback ids inside the transaction, before deleting the file', async () => {
    feedbackFindMany.mockResolvedValue([{ id: 'fb-1' }]);
    const order: string[] = [];
    deleteUser.mockImplementation(async () => {
      order.push('user-deleted');
    });
    deleteFile.mockImplementation(async () => {
      order.push('file-deleted');
    });

    await service.remove('user-1');

    // The row (and the cascade taking `Feedback` with it) is committed before
    // the file is ever touched — the read that names the file happens inside
    // the same transaction, ahead of both.
    expect(order).toEqual(['user-deleted', 'file-deleted']);
  });
});
