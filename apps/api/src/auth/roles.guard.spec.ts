import { type ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { Role } from '../prisma/generated/enums';
import type { AuthUser } from './auth.types';
import { RolesGuard } from './roles.guard';

function contextFor(user?: AuthUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

function userWithRole(role: Role): AuthUser {
  return { id: 'u1', email: 'a@example.com', displayName: 'A', role, isActive: true };
}

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function requireRoles(roles: Role[] | undefined): void {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
  }

  it('is inert on routes with no @Roles()', () => {
    requireRoles(undefined);

    expect(guard.canActivate(contextFor(userWithRole('USER')))).toBe(true);
  });

  it('is inert when @Roles() is empty', () => {
    requireRoles([]);

    expect(guard.canActivate(contextFor(userWithRole('USER')))).toBe(true);
  });

  it('allows a caller holding the required role', () => {
    requireRoles(['ADMIN']);

    expect(guard.canActivate(contextFor(userWithRole('ADMIN')))).toBe(true);
  });

  it('forbids a USER from an ADMIN route', () => {
    requireRoles(['ADMIN']);

    expect(() => guard.canActivate(contextFor(userWithRole('USER')))).toThrow(ForbiddenException);
  });

  it('rejects when no user is attached — @Public() plus @Roles() is a contradiction', () => {
    requireRoles(['ADMIN']);

    expect(() => guard.canActivate(contextFor(undefined))).toThrow(UnauthorizedException);
  });
});
