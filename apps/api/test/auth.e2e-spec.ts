import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';

import { ThrottlerStorage } from '@nestjs/throttler';

import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password.service';
import { SessionStoreService } from '../src/auth/session-store.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The full auth flow, end to end through the real guards, controller and
 * session middleware.
 *
 * Postgres is swapped out in two places — an in-memory session store and a
 * stubbed user lookup — so this exercises the behaviour rather than the
 * database. What it does NOT cover is connect-pg-simple against the real
 * `session` table; that needs a live Postgres.
 */
describe('Auth (e2e)', () => {
  const PASSWORD = 'correct horse battery staple';

  let app: INestApplication;
  let users: Map<string, Record<string, unknown>>;

  // Mirrors Prisma's `select` so the test can assert on what the code selects,
  // not just on what the stub happens to return.
  function applySelect(
    record: Record<string, unknown> | undefined,
    select: Record<string, boolean> | undefined,
  ): Record<string, unknown> | null {
    if (!record) return null;
    if (!select) return { ...record };
    return Object.fromEntries(
      Object.entries(record).filter(([key]) => select[key] === true),
    ) as Record<string, unknown>;
  }

  beforeAll(async () => {
    // BootstrapService runs on app.init(). Point it at a scratch path first —
    // with an admin already present it deletes the file it finds, and the
    // default path is the real `.bootstrap-token` at the repo root.
    process.env.BOOTSTRAP_TOKEN_FILE = join(tmpdir(), 'auth-e2e-spec.bootstrap-token');

    const passwordHash = await new PasswordService().hash(PASSWORD);

    users = new Map([
      [
        'user-1',
        {
          id: 'user-1',
          username: 'viewer',
          displayName: 'Viewer',
          role: 'USER',
          isActive: true,
          passwordHash,
        },
      ],
      [
        'user-2',
        {
          id: 'user-2',
          username: 'deactivated',
          displayName: 'Deactivated',
          role: 'USER',
          isActive: false,
          passwordHash,
        },
      ],
    ]);

    const prismaStub = {
      user: {
        findUnique: jest.fn(
          ({
            where,
            select,
          }: {
            where: { id?: string; username?: string };
            select?: Record<string, boolean>;
          }) => {
            const found = [...users.values()].find(
              (user) =>
                (where.id !== undefined && user.id === where.id) ||
                (where.username !== undefined && user.username === where.username),
            );
            return Promise.resolve(applySelect(found, select));
          },
        ),
        // Read only by BootstrapService: a non-zero count means "an admin
        // exists", so it mints nothing and this suite stays about login.
        count: jest.fn().mockResolvedValue(1),
      },
      /*
       * Read by JobsService.onModuleInit, which fails jobs a previous process
       * left running. Nothing here is about jobs, but the hook runs on every
       * app boot — including this one — and without the stub the whole module
       * fails to initialise and every test in this file dies at startup.
       */
      mediaJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(SessionStoreService)
      .useValue({
        createMiddleware: () =>
          session({
            secret: 'test-secret',
            name: 'vsc.sid',
            resave: false,
            saveUninitialized: false,
            rolling: true,
            cookie: { httpOnly: true, sameSite: 'lax', secure: false, path: '/' },
          }),
        onModuleDestroy: () => Promise.resolve(),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
  });

  /*
   * Empties the rate-limit buckets between tests.
   *
   * Every request here arrives from one address with no session, so they all
   * share a bucket — and this file deliberately makes far more than ten login
   * attempts. Without a reset the limit does its job and the later tests see
   * 429 instead of what they came to check. That is the limit working, not a
   * bug, so the suite resets rather than the limit being loosened.
   */
  beforeEach(() => {
    const storage = app.get<ThrottlerStorage & { storage?: Map<string, unknown> }>(ThrottlerStorage);
    storage.storage?.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('access control', () => {
    it('leaves /health public', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('401s on /auth/me without a session', async () => {
      await request(app.getHttpServer()).get('/auth/me').expect(401);
    });
  });

  describe('POST /auth/login', () => {
    it('rejects a wrong password', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'viewer', password: 'wrong' })
        .expect(401);
    });

    it('rejects an unknown account with the same message as a wrong password', async () => {
      const unknown = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'nobody', password: PASSWORD })
        .expect(401);

      const wrongPassword = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'viewer', password: 'wrong' })
        .expect(401);

      expect(unknown.body.message).toEqual(wrongPassword.body.message);
    });

    it('rejects a deactivated account holding the right password', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'deactivated', password: PASSWORD })
        .expect(401);
    });

    it('rejects a malformed body with 400, not 401', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'viewer' })
        .expect(400);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ password: PASSWORD })
        .expect(400);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: '', password: PASSWORD })
        .expect(400);
    });

    it('accepts valid credentials and never returns the password hash', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'viewer', password: PASSWORD })
        .expect(200);

      expect(response.body).toMatchObject({ id: 'user-1', username: 'viewer' });
      expect(response.body.passwordHash).toBeUndefined();
      expect(response.headers['set-cookie']).toBeDefined();
    });

    it('matches usernames case-insensitively and ignores surrounding whitespace', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: '  VIEWER  ', password: PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'ViEwEr', password: PASSWORD })
        .expect(200);
    });

    it('sets an httpOnly cookie', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'viewer', password: PASSWORD })
        .expect(200);

      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies.join(';')).toMatch(/HttpOnly/i);
    });
  });

  describe('session lifecycle', () => {
    it('carries the session from login through /auth/me to logout', async () => {
      const agent = request.agent(app.getHttpServer());

      await agent.post('/auth/login').send({ username: 'viewer', password: PASSWORD }).expect(200);

      const me = await agent.get('/auth/me').expect(200);
      expect(me.body).toMatchObject({ id: 'user-1', displayName: 'Viewer' });

      await agent.post('/auth/logout').expect(204);
      await agent.get('/auth/me').expect(401);
    });

    it('regenerates the session id on every login (no fixation)', async () => {
      const agent = request.agent(app.getHttpServer());
      const sid = (response: request.Response): string => {
        const cookies = response.headers['set-cookie'] as unknown as string[] | undefined;
        expect(cookies).toBeDefined();
        return cookies![0].split(';')[0];
      };

      // Two logins on the same agent: the second arrives already holding the
      // first session's cookie, so an unchanged id here would mean regenerate()
      // is not doing its job.
      const first = await agent
        .post('/auth/login')
        .send({ username: 'viewer', password: PASSWORD })
        .expect(200);

      const second = await agent
        .post('/auth/login')
        .send({ username: 'viewer', password: PASSWORD })
        .expect(200);

      expect(sid(first)).not.toEqual(sid(second));
      await agent.get('/auth/me').expect(200);
    });

    // The reason SessionGuard re-reads the user instead of trusting the session.
    it('invalidates a live session as soon as the account is deactivated', async () => {
      const agent = request.agent(app.getHttpServer());

      await agent.post('/auth/login').send({ username: 'viewer', password: PASSWORD }).expect(200);
      await agent.get('/auth/me').expect(200);

      users.get('user-1')!.isActive = false;
      try {
        await agent.get('/auth/me').expect(401);
      } finally {
        users.get('user-1')!.isActive = true;
      }
    });
  });
});
