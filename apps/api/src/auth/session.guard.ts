import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { AUTH_USER_SELECT } from './auth.types';
import { IS_PUBLIC_KEY } from './decorators';

/**
 * Registered globally, so every route requires a session unless marked @Public().
 *
 * The user is re-read from the database on each request rather than cached in
 * the session. That costs a query per request and buys the thing sessions were
 * chosen for in the first place: deactivating an account or demoting an admin
 * takes effect immediately, instead of whenever their cookie happens to expire.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.session?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: AUTH_USER_SELECT,
    });

    if (!user || !user.isActive) {
      // The session outlived the account, or the account was deactivated. Drop
      // the session so the caller stops presenting a cookie that can never work.
      request.session.destroy(() => undefined);
      throw new UnauthorizedException('Session is no longer valid');
    }

    request.user = user;
    return true;
  }
}
