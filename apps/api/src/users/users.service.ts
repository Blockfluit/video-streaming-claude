import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  normaliseUsername,
  toPage,
  type CreateUserInput,
  type ListUsersQuery,
  type Page,
  type UpdateUserInput,
} from '@video/shared';

import { PasswordService } from '../auth/password.service';
import { StorageService } from '../common/storage.service';
import { feedbackScreenshotKey } from '../feedback/keys';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { DELETED, wouldRemoveLastActiveAdmin, type AccountState } from './last-admin';

/** Never includes `passwordHash`. */
const USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface UserView {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const LOCKOUT_MESSAGE =
  'That would leave the library with no active admin. Promote someone else first.';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly storage: StorageService,
  ) {}

  async list(query: ListUsersQuery): Promise<Page<UserView>> {
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        select: USER_SELECT,
        // `username` is unique, so this order is already total — but the id
        // stays as a habit, since most orderings are not.
        orderBy: [{ role: 'asc' }, { username: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.user.count(),
    ]);

    return toPage(users, total, query);
  }

  async create(dto: CreateUserInput): Promise<UserView> {
    const username = normaliseUsername(dto.username);
    const passwordHash = await this.passwords.hash(dto.password);

    const taken = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (taken) {
      throw new ConflictException('That username is taken');
    }

    return this.prisma.user.create({
      data: {
        username,
        // As typed, matching what redemption does — an account created here is
        // indistinguishable from an invited one.
        displayName: dto.username,
        passwordHash,
        role: dto.role ?? 'USER',
      },
      select: USER_SELECT,
    });
  }

  async update(id: string, dto: UpdateUserInput): Promise<UserView> {
    // Hashed before the transaction: argon2id is slow, and the transaction
    // holds a lock over every active admin row while it runs.
    const passwordHash = dto.password ? await this.passwords.hash(dto.password) : undefined;

    return this.prisma.$transaction(async (tx) => {
      const current = await this.loadForChange(tx, id);

      const next: AccountState = {
        role: dto.role ?? current.role,
        isActive: dto.isActive ?? current.isActive,
      };

      await this.assertKeepsAnAdmin(tx, current, next, id);

      return tx.user.update({
        where: { id },
        data: {
          displayName: dto.displayName,
          role: dto.role,
          isActive: dto.isActive,
          passwordHash,
        },
        select: USER_SELECT,
      });
    });
  }

  /**
   * A real delete, not a deactivation — `PATCH { isActive: false }` is the
   * reversible option. Cascades take the account's comments, watch history,
   * watchlist and feedback rows with it; uploads survive with a null uploader.
   *
   * The cascade can delete a `Feedback` row, but it cannot touch a filesystem
   * — nothing else sweeps a screenshot under `derived/feedback/`, so a row
   * with `hasScreenshot: true` has its id read **before** the transaction
   * commits (the row, and the file it names, are both gone the moment it
   * does) and its screenshot deleted **after**, the same "generated output of
   * a row that has stopped existing must be swept" rule videos and their
   * artwork already follow. Best-effort: `StorageService.delete` already
   * no-ops on a missing file, so there is nothing to guard here either.
   */
  async remove(id: string): Promise<void> {
    const feedbackScreenshots = await this.prisma.$transaction(async (tx) => {
      const current = await this.loadForChange(tx, id);

      await this.assertKeepsAnAdmin(tx, current, DELETED, id);

      const feedback = await tx.feedback.findMany({
        where: { userId: id, hasScreenshot: true },
        select: { id: true },
      });

      await tx.user.delete({ where: { id } });

      return feedback;
    });

    for (const { id: feedbackId } of feedbackScreenshots) {
      await this.storage.delete('derived', feedbackScreenshotKey(feedbackId));
    }
  }

  private async loadForChange(
    tx: Pick<PrismaService, 'user'>,
    id: string,
  ): Promise<AccountState & { id: string }> {
    const user = await tx.user.findUnique({
      where: { id },
      select: { id: true, role: true, isActive: true },
    });

    if (!user) throw new NotFoundException('No user with that id');
    return user;
  }

  /**
   * Refuses changes that would leave nobody able to administer the library.
   *
   * The count comes from a locking read. Read-then-write is not atomic: two
   * admins demoted at the same moment could both see "one other active admin
   * remains" and both commit, leaving zero — the exact outcome this rule
   * exists to prevent. Locking every active admin row makes the second
   * transaction wait and then re-read the truth.
   *
   * Prisma serialises interactive transactions within a process, so removing
   * `FOR UPDATE` does not make `users.db-spec.ts` fail — the suite says so
   * where it tests this, and covers the lock's semantics separately. The lock
   * is what keeps the rule true once this runs as more than one process.
   */
  private async assertKeepsAnAdmin(
    tx: { $queryRaw: PrismaService['$queryRaw'] },
    current: AccountState,
    next: AccountState | typeof DELETED,
    id: string,
  ): Promise<void> {
    const activeAdmins = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "User" WHERE role = 'ADMIN' AND "isActive" = true FOR UPDATE
    `;

    const others = activeAdmins.filter((admin) => admin.id !== id).length;

    if (wouldRemoveLastActiveAdmin(current, next, others)) {
      throw new ConflictException(LOCKOUT_MESSAGE);
    }
  }
}
