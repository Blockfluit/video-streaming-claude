import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AUTH_USER_SELECT, type AuthUser } from './auth.types';
import { BootstrapService } from './bootstrap.service';
import type { RedeemDto } from './dto/redeem.dto';
import { PasswordService } from './password.service';
import { hashToken, tokenState } from './tokens';
import { normaliseUsername } from './username';

/**
 * One message for every way a token can be unusable — unknown, expired,
 * revoked, already redeemed. Saying which would let anyone holding a spent
 * token learn that it once existed, and let a guesser tell "wrong" from "too
 * late".
 */
const INVALID_TOKEN = 'That invite token is not valid';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly bootstrap: BootstrapService,
  ) {}

  /** Returns the user on success, or null for any failure. Callers must not distinguish why. */
  async validateCredentials(username: string, password: string): Promise<AuthUser | null> {
    const user = await this.prisma.user.findUnique({
      // Usernames are stored lowercase, so this normalisation is what makes the
      // lookup case-insensitive.
      where: { username: String(normaliseUsername(username)) },
      select: { ...AUTH_USER_SELECT, passwordHash: true },
    });

    if (!user) {
      // Hash anyway. Returning early here would make "no such account" measurably
      // faster than "wrong password", which is enough to enumerate who has one.
      await this.passwords.hash(password);
      return null;
    }

    const matches = await this.passwords.verify(user.passwordHash, password);
    if (!matches || !user.isActive) {
      return null;
    }

    const { passwordHash: _passwordHash, ...authUser } = user;
    return authUser;
  }

  /**
   * Trades a token for an account. The token decides the role, so nothing the
   * caller sends can escalate it.
   *
   * The whole thing is one transaction ending in a **conditional** update
   * (`WHERE redeemedAt IS NULL`). Read-then-write is not atomic on its own: two
   * transactions can both read the token as unredeemed and both write. The
   * condition makes the second write match zero rows, which throws and rolls
   * back the user it had already created.
   *
   * In practice a single-process API serialises these enough that the check
   * above catches the loser first — `redeem.db-spec.ts` cannot force the
   * interleaving over HTTP, and says so. The condition is what keeps it correct
   * anyway once this runs as more than one process.
   */
  async redeem(dto: RedeemDto): Promise<AuthUser> {
    const tokenHash = hashToken(dto.token);
    const username = String(normaliseUsername(dto.username));
    // Hashed outside the transaction: argon2id is deliberately slow, and
    // holding a row lock for the duration would serialise concurrent signups.
    const passwordHash = await this.passwords.hash(dto.password);

    const { user, kind } = await this.prisma.$transaction(async (tx) => {
      const token = await tx.inviteToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          kind: true,
          grantsRole: true,
          expiresAt: true,
          redeemedAt: true,
          revokedAt: true,
        },
      });

      if (!token || tokenState(token, new Date()) !== 'VALID') {
        throw new BadRequestException(INVALID_TOKEN);
      }

      // Postgres would catch this with the unique index anyway; checking first
      // turns a 500-shaped constraint error into an answerable 409.
      const taken = await tx.user.findUnique({ where: { username }, select: { id: true } });
      if (taken) {
        throw new ConflictException('That username is taken');
      }

      const created = await tx.user.create({
        data: {
          username,
          displayName: dto.username,
          passwordHash,
          role: token.grantsRole,
        },
        select: AUTH_USER_SELECT,
      });

      // Conditional on purpose. The check above has already passed, so this
      // matching zero rows means another transaction claimed the token between
      // the two statements — the one case the check cannot see.
      const claimed = await tx.inviteToken.updateMany({
        where: { id: token.id, redeemedAt: null },
        data: { redeemedAt: new Date(), redeemedById: created.id },
      });

      // Lost the race. Throwing rolls back the user created above.
      if (claimed.count === 0) {
        throw new BadRequestException(INVALID_TOKEN);
      }

      return { user: created, kind: token.kind };
    });

    if (kind === 'BOOTSTRAP') {
      // Spent. Leaving the plaintext on disk would leave a dead credential
      // lying around looking live.
      await this.bootstrap.removeTokenFile();
    }

    return user;
  }
}
