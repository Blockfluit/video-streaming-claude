import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { PrismaService } from '../prisma/prisma.service';
import { SessionGuard } from './session.guard';

interface FakeRequest {
  session: { userId?: string; destroy: (cb: () => void) => void };
  user?: unknown;
}

function contextFor(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

function makeRequest(userId?: string): FakeRequest {
  return { session: { userId, destroy: (cb: () => void) => cb() } };
}

describe('SessionGuard', () => {
  const activeUser = {
    id: 'user-1',
    username: 'viewer',
    displayName: 'A',
    role: 'USER',
    isActive: true,
  };

  let findUnique: jest.Mock;
  let prisma: PrismaService;
  let reflector: Reflector;
  let guard: SessionGuard;

  beforeEach(() => {
    findUnique = jest.fn();
    prisma = { user: { findUnique } } as unknown as PrismaService;
    reflector = new Reflector();
    guard = new SessionGuard(reflector, prisma);
  });

  function markPublic(isPublic: boolean): void {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(isPublic);
  }

  it('lets @Public() routes through without touching the database', async () => {
    markPublic(true);

    await expect(guard.canActivate(contextFor(makeRequest()))).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects a request with no session', async () => {
    markPublic(false);

    await expect(guard.canActivate(contextFor(makeRequest()))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('attaches the user when the session is valid', async () => {
    markPublic(false);
    findUnique.mockResolvedValue(activeUser);
    const request = makeRequest('user-1');

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toEqual(activeUser);
  });

  it('rejects and destroys the session when the user no longer exists', async () => {
    markPublic(false);
    findUnique.mockResolvedValue(null);
    const request = makeRequest('deleted-user');
    const destroy = jest.spyOn(request.session, 'destroy');

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
    expect(destroy).toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  // The reason the user is re-read per request rather than cached in the session.
  it('rejects a deactivated user even though their session is still valid', async () => {
    markPublic(false);
    findUnique.mockResolvedValue({ ...activeUser, isActive: false });
    const request = makeRequest('user-1');
    const destroy = jest.spyOn(request.session, 'destroy');

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
    expect(destroy).toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('never selects the password hash', async () => {
    markPublic(false);
    findUnique.mockResolvedValue(activeUser);

    await guard.canActivate(contextFor(makeRequest('user-1')));

    const select = findUnique.mock.calls[0][0].select as Record<string, boolean>;
    expect(select.passwordHash).toBeUndefined();
  });
});
