import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AUTH_USER_SELECT, type AuthUser } from './auth.types';
import { PasswordService } from './password.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  /** Returns the user on success, or null for any failure. Callers must not distinguish why. */
  async validateCredentials(email: string, password: string): Promise<AuthUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
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
}
