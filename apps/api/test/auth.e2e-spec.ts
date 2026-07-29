import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';

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
    const passwordHash = await new PasswordService().hash(PASSWORD);

    users = new Map([
      [
        'user-1',
        {
          id: 'user-1',
          email: 'viewer@example.com',
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
          email: 'gone@example.com',
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
            where: { id?: string; email?: string };
            select?: Record<string, boolean>;
          }) => {
            const found = [...users.values()].find(
              (user) =>
                (where.id !== undefined && user.id === where.id) ||
                (where.email !== undefined && user.email === where.email),
            );
            return Promise.resolve(applySelect(found, select));
          },
        ),
      },
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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
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
        .send({ email: 'viewer@example.com', password: 'wrong' })
        .expect(401);
    });

    it('rejects an unknown account with the same message as a wrong password', async () => {
      const unknown = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: PASSWORD })
        .expect(401);

      const wrongPassword = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'viewer@example.com', password: 'wrong' })
        .expect(401);

      expect(unknown.body.message).toEqual(wrongPassword.body.message);
    });

    it('rejects a deactivated account holding the right password', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'gone@example.com', password: PASSWORD })
        .expect(401);
    });

    it('rejects a malformed body with 400, not 401', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'not-an-email', password: PASSWORD })
        .expect(400);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'viewer@example.com' })
        .expect(400);
    });

    it('accepts valid credentials and never returns the password hash', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'viewer@example.com', password: PASSWORD })
        .expect(200);

      expect(response.body).toMatchObject({ id: 'user-1', email: 'viewer@example.com' });
      expect(response.body.passwordHash).toBeUndefined();
      expect(response.headers['set-cookie']).toBeDefined();
    });

    it('normalises email case and surrounding whitespace', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: '  VIEWER@Example.com  ', password: PASSWORD })
        .expect(200);
    });

    it('sets an httpOnly cookie', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'viewer@example.com', password: PASSWORD })
        .expect(200);

      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies.join(';')).toMatch(/HttpOnly/i);
    });
  });

  describe('session lifecycle', () => {
    it('carries the session from login through /auth/me to logout', async () => {
      const agent = request.agent(app.getHttpServer());

      await agent
        .post('/auth/login')
        .send({ email: 'viewer@example.com', password: PASSWORD })
        .expect(200);

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
        .send({ email: 'viewer@example.com', password: PASSWORD })
        .expect(200);

      const second = await agent
        .post('/auth/login')
        .send({ email: 'viewer@example.com', password: PASSWORD })
        .expect(200);

      expect(sid(first)).not.toEqual(sid(second));
      await agent.get('/auth/me').expect(200);
    });

    // The reason SessionGuard re-reads the user instead of trusting the session.
    it('invalidates a live session as soon as the account is deactivated', async () => {
      const agent = request.agent(app.getHttpServer());

      await agent
        .post('/auth/login')
        .send({ email: 'viewer@example.com', password: PASSWORD })
        .expect(200);
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
