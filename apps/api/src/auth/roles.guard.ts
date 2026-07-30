import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { Role } from '../prisma/generated/enums';
import { ROLES_KEY } from './decorators';

/**
 * Enforces @Roles(). Registered globally but inert on routes without the
 * decorator, so it composes with SessionGuard rather than duplicating it.
 *
 * Order matters: SessionGuard must be registered first, since this reads the
 * user it attaches.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user) {
      // Only reachable if a route is marked both @Public() and @Roles(), which
      // is a contradiction worth failing loudly on.
      throw new UnauthorizedException('Authentication required');
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
