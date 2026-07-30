import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConflictException, Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SessionStoreService } from '../src/auth/session-store.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';

/**
 * `/admin/users` against a real Postgres.
 *
 * The self-lockout rule is the reason this is a db-spec rather than a stubbed
 * suite: it is enforced with a locking read, and a lock is not something an
 * in-memory fake can be wrong about.
 */
describe('Admin users (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-users-test.bootstrap-token');

  let app: INestApplication;
  let prisma: PrismaService;
  let users: UsersService;
  let banner: jest.SpyInstance;

  const http = () => request(app.getHttpServer());

  async function startApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
    prisma = app.get(PrismaService);
    users = app.get(UsersService);
  }

  /** An admin created by redeeming the master token, plus their logged-in agent. */
  async function admin(username = 'ada'): Promise<{ agent: request.Agent; id: string }> {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const agent = request.agent(app.getHttpServer());
    const response = await agent
      .post('/auth/redeem')
      .send({ token, username, password: PASSWORD })
      .expect(201);

    return { agent, id: response.body.id };
  }

  /** A second account of any role, created through the admin API. */
  async function account(
    agent: request.Agent,
    username: string,
    role: 'USER' | 'ADMIN' = 'USER',
  ): Promise<string> {
    const response = await agent
      .post('/admin/users')
      .send({ username, password: PASSWORD, role })
      .expect(201);

    return response.body.id;
  }

  async function loggedInAs(username: string, password = PASSWORD): Promise<request.Agent> {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/auth/login').send({ username, password }).expect(200);
    return agent;
  }

  const activeAdmins = (): Promise<number> =>
    prisma.user.count({ where: { role: 'ADMIN', isActive: true } });

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = tokenFile;
    await rm(tokenFile, { force: true });

    await startApp();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "InviteToken", "User", "session" RESTART IDENTITY CASCADE',
    );
    await app.close();
    await rm(tokenFile, { force: true });

    await startApp();
  });

  afterEach(async () => {
    banner.mockRestore();
    await app?.close();
    await rm(tokenFile, { force: true });
  });

  describe('access control', () => {
    it('401s an anonymous caller', async () => {
      await http().get('/admin/users').expect(401);
      await http().post('/admin/users').send({}).expect(401);
      await http().patch('/admin/users/whoever').send({}).expect(401);
      await http().delete('/admin/users/whoever').expect(401);
    });

    it('403s a USER on every route', async () => {
      const { agent } = await admin();
      await account(agent, 'grace');
      const user = await loggedInAs('grace');

      await user.get('/admin/users').expect(403);
      await user.post('/admin/users').send({ username: 'mallory', password: PASSWORD }).expect(403);
      await user.patch('/admin/users/whoever').send({ displayName: 'x' }).expect(403);
      await user.delete('/admin/users/whoever').expect(403);
    });
  });

  describe('GET /admin/users', () => {
    it('lists accounts without ever exposing a password hash', async () => {
      const { agent } = await admin();
      await account(agent, 'grace');

      const response = await agent.get('/admin/users').expect(200);

      expect(response.body.items).toHaveLength(2);
      expect(response.body.total).toBe(2);
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
      expect(JSON.stringify(response.body)).not.toContain('$argon2');
    });
  });

  describe('POST /admin/users', () => {
    it('creates an account that can log in immediately', async () => {
      const { agent } = await admin();

      const response = await agent
        .post('/admin/users')
        .send({ username: 'Grace', password: PASSWORD })
        .expect(201);

      expect(response.body).toMatchObject({
        username: 'grace',
        displayName: 'Grace',
        role: 'USER',
        isActive: true,
      });
      await loggedInAs('grace');
    });

    it('creates an admin when asked', async () => {
      const { agent } = await admin();

      const response = await agent
        .post('/admin/users')
        .send({ username: 'grace', password: PASSWORD, role: 'ADMIN' })
        .expect(201);

      expect(response.body.role).toBe('ADMIN');
    });

    it('409s a username already taken, whatever its casing', async () => {
      const { agent } = await admin();
      await account(agent, 'grace');

      await agent
        .post('/admin/users')
        .send({ username: 'GRACE', password: PASSWORD })
        .expect(409);
    });

    it('holds new accounts to the same rules redemption uses', async () => {
      const { agent } = await admin();

      await agent.post('/admin/users').send({ username: 'ad', password: PASSWORD }).expect(400);
      await agent.post('/admin/users').send({ username: '.bad', password: PASSWORD }).expect(400);
      await agent.post('/admin/users').send({ username: 'grace', password: 'short' }).expect(400);
    });
  });

  describe('PATCH /admin/users/:id', () => {
    it('renames without touching the login identity', async () => {
      const { agent } = await admin();
      const id = await account(agent, 'grace');

      const response = await agent
        .patch(`/admin/users/${id}`)
        .send({ displayName: 'Grace Hopper' })
        .expect(200);

      expect(response.body).toMatchObject({ username: 'grace', displayName: 'Grace Hopper' });
      await loggedInAs('grace');
    });

    // The only password recovery this library has, since there is no mailer.
    it('resets a password, invalidating the old one', async () => {
      const { agent } = await admin();
      const id = await account(agent, 'grace');
      const replacement = 'a-brand-new-long-password';

      await agent.patch(`/admin/users/${id}`).send({ password: replacement }).expect(200);

      await http().post('/auth/login').send({ username: 'grace', password: PASSWORD }).expect(401);
      await loggedInAs('grace', replacement);
    });

    it('promotes and demotes', async () => {
      const { agent } = await admin();
      const id = await account(agent, 'grace');

      await agent.patch(`/admin/users/${id}`).send({ role: 'ADMIN' }).expect(200);
      const promoted = await loggedInAs('grace');
      await promoted.get('/admin/users').expect(200);

      await agent.patch(`/admin/users/${id}`).send({ role: 'USER' }).expect(200);
      await promoted.get('/admin/users').expect(403);
    });

    // Why SessionGuard re-reads the user instead of trusting the session.
    it('cuts off a deactivated account mid-session', async () => {
      const { agent } = await admin();
      const id = await account(agent, 'grace');
      const grace = await loggedInAs('grace');
      await grace.get('/auth/me').expect(200);

      await agent.patch(`/admin/users/${id}`).send({ isActive: false }).expect(200);

      await grace.get('/auth/me').expect(401);
      await http().post('/auth/login').send({ username: 'grace', password: PASSWORD }).expect(401);
    });

    it('400s an empty patch rather than silently doing nothing', async () => {
      const { agent } = await admin();
      const id = await account(agent, 'grace');

      await agent.patch(`/admin/users/${id}`).send({}).expect(400);
    });

    it('404s an unknown id', async () => {
      const { agent } = await admin();

      await agent.patch('/admin/users/nope').send({ displayName: 'x' }).expect(404);
    });
  });

  describe('DELETE /admin/users/:id', () => {
    it('removes the account', async () => {
      const { agent } = await admin();
      const id = await account(agent, 'grace');

      await agent.delete(`/admin/users/${id}`).expect(204);

      await expect(prisma.user.count()).resolves.toBe(1);
      await http().post('/auth/login').send({ username: 'grace', password: PASSWORD }).expect(401);
    });

    it('404s an id that is already gone', async () => {
      const { agent } = await admin();
      const id = await account(agent, 'grace');

      await agent.delete(`/admin/users/${id}`).expect(204);
      await agent.delete(`/admin/users/${id}`).expect(404);
    });
  });

  describe('the last active admin', () => {
    it('cannot be demoted', async () => {
      const { agent, id } = await admin();

      await agent.patch(`/admin/users/${id}`).send({ role: 'USER' }).expect(409);
      await expect(activeAdmins()).resolves.toBe(1);
    });

    it('cannot be deactivated', async () => {
      const { agent, id } = await admin();

      await agent.patch(`/admin/users/${id}`).send({ isActive: false }).expect(409);
      await expect(activeAdmins()).resolves.toBe(1);
    });

    it('cannot be deleted', async () => {
      const { agent, id } = await admin();

      await agent.delete(`/admin/users/${id}`).expect(409);
      await expect(activeAdmins()).resolves.toBe(1);
    });

    // Plain users are irrelevant to the rule — only admins hold the door open.
    it('is still the last admin however many users exist', async () => {
      const { agent, id } = await admin();
      await account(agent, 'grace');
      await account(agent, 'edsger');

      await agent.patch(`/admin/users/${id}`).send({ role: 'USER' }).expect(409);
    });

    it('can be edited in ways that keep them an admin', async () => {
      const { agent, id } = await admin();

      await agent.patch(`/admin/users/${id}`).send({ displayName: 'Ada L' }).expect(200);
      await agent.patch(`/admin/users/${id}`).send({ role: 'ADMIN', isActive: true }).expect(200);
    });

    it('stops being the last one once somebody else is promoted', async () => {
      const { agent, id } = await admin();
      const graceId = await account(agent, 'grace');

      await agent.patch(`/admin/users/${graceId}`).send({ role: 'ADMIN' }).expect(200);
      await agent.patch(`/admin/users/${id}`).send({ role: 'USER' }).expect(200);

      await expect(activeAdmins()).resolves.toBe(1);
    });

    // A deactivated admin is not holding anything open, so the count must not
    // include them — otherwise the real last admin could still be demoted.
    it('does not count a deactivated admin as cover', async () => {
      const { agent, id } = await admin();
      const graceId = await account(agent, 'grace', 'ADMIN');
      await agent.patch(`/admin/users/${graceId}`).send({ isActive: false }).expect(200);

      await agent.patch(`/admin/users/${id}`).send({ role: 'USER' }).expect(409);
    });

    /**
     * The invariant, not the mechanism. Prisma serialises interactive
     * transactions inside one process, so these two never actually interleave
     * and removing `FOR UPDATE` does not make this fail. `holds a lock on the
     * active admins` below covers the lock itself.
     */
    it('survives two admins being demoted concurrently', async () => {
      const { agent, id } = await admin();
      const graceId = await account(agent, 'grace', 'ADMIN');
      expect(await activeAdmins()).toBe(2);

      const outcomes = await Promise.allSettled([
        users.update(id, { role: 'USER' }),
        users.update(graceId, { role: 'USER' }),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(
        outcomes.find((outcome) => outcome.status === 'rejected')?.reason,
      ).toBeInstanceOf(ConflictException);
      await expect(activeAdmins()).resolves.toBe(1);
    });

    it('survives the last admin being demoted and deleted concurrently', async () => {
      const { agent, id } = await admin();
      const graceId = await account(agent, 'grace', 'ADMIN');

      const outcomes = await Promise.allSettled([
        users.update(id, { role: 'USER' }),
        users.remove(graceId),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      await expect(activeAdmins()).resolves.toBe(1);
    });

    /**
     * What the service actually relies on, checked against Postgres directly
     * because no amount of application-level concurrency reaches it: a second
     * transaction issuing the same `FOR UPDATE` read blocks until the first
     * commits, and then sees the committed result rather than its stale one.
     *
     * Two raw connections, because Prisma will not run two transactions at once.
     */
    it('holds a lock on the active admins for the length of the transaction', async () => {
      const { agent } = await admin();
      await account(agent, 'grace', 'ADMIN');

      const lockingRead =
        'SELECT id FROM "User" WHERE role = \'ADMIN\' AND "isActive" = true FOR UPDATE';
      const first = new Client({ connectionString: process.env.DATABASE_URL });
      const second = new Client({ connectionString: process.env.DATABASE_URL });
      await Promise.all([first.connect(), second.connect()]);

      try {
        await first.query('BEGIN');
        expect((await first.query(lockingRead)).rows).toHaveLength(2);

        await second.query('BEGIN');
        let secondReturned = false;
        const blocked = second.query(lockingRead).then((result) => {
          secondReturned = true;
          return result;
        });

        // Long enough that a non-blocking read would certainly have answered.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(secondReturned).toBe(false);

        // The first transaction demotes one admin and commits.
        await first.query('UPDATE "User" SET role = \'USER\' WHERE id = $1', [
          (await first.query(lockingRead)).rows[0].id,
        ]);
        await first.query('COMMIT');

        // Only now does the second read return — and it sees one admin, not two.
        expect((await blocked).rows).toHaveLength(1);
        await second.query('COMMIT');
      } finally {
        await Promise.all([first.end(), second.end()]);
      }
    });
  });
});
