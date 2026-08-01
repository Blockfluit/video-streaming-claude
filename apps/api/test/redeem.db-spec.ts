import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SessionStoreService } from '../src/auth/session-store.service';
import { hashToken } from '../src/auth/tokens';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Step 5 against a real Postgres — the bootstrap flow, redemption and invite
 * management, with nothing stubbed.
 *
 * The stubbed suite in `auth.e2e-spec.ts` cannot cover what matters here. The
 * redeem-once guarantee is a conditional `UPDATE ... WHERE redeemedAt IS NULL`
 * inside a transaction; against an in-memory fake that is just an `if`, and an
 * `if` cannot lose a race. So this suite talks to the database.
 */
describe('Bootstrap and invites (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-test.bootstrap-token');

  let app: INestApplication;
  let prisma: PrismaService;
  let banner: jest.SpyInstance;

  const http = () => request(app.getHttpServer());
  const readTokenFile = async (): Promise<string> => (await readFile(tokenFile, 'utf8')).trim();

  /** Boots the API exactly as `npm start` would, including BootstrapService. */
  async function startApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
    prisma = app.get(PrismaService);
  }

  async function truncate(): Promise<void> {
    const client = app.get(PrismaService);
    await client.$executeRawUnsafe(
      'TRUNCATE "InviteToken", "User", "session" RESTART IDENTITY CASCADE',
    );
  }

  beforeAll(() => {
    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = tokenFile;
  });

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await rm(tokenFile, { force: true });

    // Boot once to get a client, wipe, then boot the app under test so
    // BootstrapService sees a genuinely empty database.
    await startApp();
    await truncate();
    await app.close();
    await rm(tokenFile, { force: true });

    await startApp();
  });

  afterEach(async () => {
    banner.mockRestore();
    await app?.close();
    await rm(tokenFile, { force: true });
  });

  describe('startup with no admin', () => {
    it('mints exactly one BOOTSTRAP token granting ADMIN', async () => {
      const tokens = await prisma.inviteToken.findMany();

      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({ kind: 'BOOTSTRAP', grantsRole: 'ADMIN' });
    });

    it('writes the plaintext to a file only its owner can read', async () => {
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      await expect(readTokenFile()).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('stores only the hash — the plaintext is not in the database', async () => {
      const plaintext = await readTokenFile();
      const token = await prisma.inviteToken.findFirstOrThrow();

      expect(token.tokenHash).toBe(hashToken(plaintext));
      expect(JSON.stringify(token)).not.toContain(plaintext);
    });
  });

  describe('POST /auth/redeem', () => {
    it('creates the first admin and logs them straight in', async () => {
      const token = await readTokenFile();

      const response = await http()
        .post('/auth/redeem')
        .send({ token, username: 'Ada', password: PASSWORD })
        .expect(201);

      expect(response.body).toMatchObject({
        username: 'ada',
        displayName: 'Ada',
        role: 'ADMIN',
        isActive: true,
      });
      expect(response.body.passwordHash).toBeUndefined();
      expect(response.headers['set-cookie']).toBeDefined();
    });

    it('deletes the token file once it is spent', async () => {
      await http()
        .post('/auth/redeem')
        .send({ token: await readTokenFile(), username: 'ada', password: PASSWORD })
        .expect(201);

      await expect(readTokenFile()).rejects.toThrow();
    });

    // The plan's checkpoint, verbatim: repost the same token → 400, file gone.
    it('refuses the same token a second time', async () => {
      const token = await readTokenFile();
      await http().post('/auth/redeem').send({ token, username: 'ada', password: PASSWORD });

      await http()
        .post('/auth/redeem')
        .send({ token, username: 'grace', password: PASSWORD })
        .expect(400);

      await expect(prisma.user.count()).resolves.toBe(1);
    });

    /**
     * The invariant that matters: one token, one account, however many callers.
     *
     * This asserts the outcome, not the mechanism. A single-process API
     * serialises these enough that the loser is caught by the `tokenState`
     * check rather than by the conditional update — removing the `redeemedAt:
     * null` condition does not make this fail. The test below covers the
     * condition itself.
     */
    it('hands out exactly one account when several callers race the same token', async () => {
      const token = await readTokenFile();

      const names = ['ada', 'grace', 'edsger', 'alan', 'barbara', 'donald'];
      const results = await Promise.all(
        names.map((username) =>
          http().post('/auth/redeem').send({ token, username, password: PASSWORD }),
        ),
      );

      expect(results.filter((result) => result.status === 201)).toHaveLength(1);
      await expect(prisma.user.count()).resolves.toBe(1);
    });

    /**
     * The guard the race test above cannot reach, checked directly against
     * Postgres: once a token is claimed, the conditional UPDATE that redemption
     * ends with matches nothing. That zero is what makes a late writer throw
     * and roll back instead of issuing a second account.
     */
    it('claims a token exactly once at the SQL level', async () => {
      const token = await prisma.inviteToken.findFirstOrThrow();

      const first = await prisma.inviteToken.updateMany({
        where: { id: token.id, redeemedAt: null },
        data: { redeemedAt: new Date() },
      });
      const second = await prisma.inviteToken.updateMany({
        where: { id: token.id, redeemedAt: null },
        data: { redeemedAt: new Date() },
      });

      expect(first.count).toBe(1);
      expect(second.count).toBe(0);
    });

    it('rejects an unknown token', async () => {
      await http()
        .post('/auth/redeem')
        .send({ token: 'not-a-real-token', username: 'ada', password: PASSWORD })
        .expect(400);
    });

    it('rejects an expired token', async () => {
      const token = await readTokenFile();
      await prisma.inviteToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

      await http()
        .post('/auth/redeem')
        .send({ token, username: 'ada', password: PASSWORD })
        .expect(400);
    });

    it('rejects a revoked token', async () => {
      const token = await readTokenFile();
      await prisma.inviteToken.updateMany({ data: { revokedAt: new Date() } });

      await http()
        .post('/auth/redeem')
        .send({ token, username: 'ada', password: PASSWORD })
        .expect(400);
    });

    // Unknown, expired, revoked and spent must be indistinguishable, or a spent
    // token becomes a probe for which tokens ever existed.
    it('answers the same way whatever is wrong with the token', async () => {
      const token = await readTokenFile();
      const unknown = await http()
        .post('/auth/redeem')
        .send({ token: 'nope', username: 'ada', password: PASSWORD });

      await prisma.inviteToken.updateMany({ data: { revokedAt: new Date() } });
      const revoked = await http()
        .post('/auth/redeem')
        .send({ token, username: 'ada', password: PASSWORD });

      expect(unknown.body.message).toEqual(revoked.body.message);
    });

    it('rejects a username already taken, case-insensitively', async () => {
      // Redemption logs the new admin in, so this agent can mint the second invite.
      const agent = request.agent(app.getHttpServer());
      await agent
        .post('/auth/redeem')
        .send({ token: await readTokenFile(), username: 'ada', password: PASSWORD })
        .expect(201);

      const { body } = await agent.post('/admin/invites').send({}).expect(201);

      await http()
        .post('/auth/redeem')
        .send({ token: body.token, username: 'ADA', password: PASSWORD })
        .expect(409);
    });

    it('rejects a password under the minimum length', async () => {
      await http()
        .post('/auth/redeem')
        .send({ token: await readTokenFile(), username: 'ada', password: 'short' })
        .expect(400);
    });

    it('rejects a username that breaks the shape rules', async () => {
      const token = await readTokenFile();

      for (const username of ['ad', '.ada', 'ada.', 'ada lovelace', 'a'.repeat(33)]) {
        await http().post('/auth/redeem').send({ token, username, password: PASSWORD }).expect(400);
      }
    });

    it('leaves the token unspent when the request is rejected', async () => {
      const token = await readTokenFile();
      await http().post('/auth/redeem').send({ token, username: 'ad', password: PASSWORD });

      await http()
        .post('/auth/redeem')
        .send({ token, username: 'ada', password: PASSWORD })
        .expect(201);
    });
  });

  describe('restarting', () => {
    it('mints no new token once an admin exists, and clears the stale file', async () => {
      await http()
        .post('/auth/redeem')
        .send({ token: await readTokenFile(), username: 'ada', password: PASSWORD })
        .expect(201);

      await app.close();
      await startApp();

      await expect(prisma.inviteToken.count()).resolves.toBe(1);
      await expect(readTokenFile()).rejects.toThrow();
    });

    it('reuses the same master token while it is still unredeemed', async () => {
      const before = await readTokenFile();

      await app.close();
      await startApp();

      await expect(readTokenFile()).resolves.toBe(before);
      await expect(prisma.inviteToken.count()).resolves.toBe(1);
    });
  });

  describe('admin invites', () => {
    /** Redeems the master token as an admin and returns an agent holding their session. */
    async function adminAgent(username = 'ada'): Promise<request.Agent> {
      const agent = request.agent(app.getHttpServer());
      await agent
        .post('/auth/redeem')
        .send({ token: await readTokenFile(), username, password: PASSWORD })
        .expect(201);
      return agent;
    }

    it('lets an admin mint an invite and returns the plaintext once', async () => {
      const agent = await adminAgent();

      const response = await agent.post('/admin/invites').send({}).expect(201);

      expect(response.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.body).toMatchObject({ kind: 'INVITE', grantsRole: 'USER', state: 'VALID' });
    });

    it('never stores or re-serves the plaintext', async () => {
      const agent = await adminAgent();
      const minted = await agent.post('/admin/invites').send({}).expect(201);

      const stored = await prisma.inviteToken.findMany();
      expect(JSON.stringify(stored)).not.toContain(minted.body.token);

      const listed = await agent.get('/admin/invites').expect(200);
      expect(JSON.stringify(listed.body)).not.toContain(minted.body.token);
      expect(JSON.stringify(listed.body)).not.toContain('tokenHash');
    });

    it('creates a USER account when that invite is redeemed', async () => {
      const agent = await adminAgent();
      const { body } = await agent.post('/admin/invites').send({}).expect(201);

      const response = await http()
        .post('/auth/redeem')
        .send({ token: body.token, username: 'grace', password: PASSWORD })
        .expect(201);

      expect(response.body.role).toBe('USER');
    });

    it('mints an ADMIN invite when asked', async () => {
      const agent = await adminAgent();
      const { body } = await agent.post('/admin/invites').send({ grantsRole: 'ADMIN' }).expect(201);

      const response = await http()
        .post('/auth/redeem')
        .send({ token: body.token, username: 'grace', password: PASSWORD })
        .expect(201);

      expect(response.body.role).toBe('ADMIN');
    });

    it('refuses a revoked invite and reports the state to the admin', async () => {
      const agent = await adminAgent();
      const { body } = await agent.post('/admin/invites').send({}).expect(201);

      await agent.delete(`/admin/invites/${body.id}`).expect(204);

      await http()
        .post('/auth/redeem')
        .send({ token: body.token, username: 'grace', password: PASSWORD })
        .expect(400);

      const listed = await agent.get('/admin/invites').expect(200);
      expect(listed.body.items.find((row: { id: string }) => row.id === body.id).state).toBe('REVOKED');
    });

    it('404s revoking something that is not there', async () => {
      const agent = await adminAgent();

      await agent.delete('/admin/invites/does-not-exist').expect(404);
    });

    it('shows a redeemed invite as REDEEMED, with who used it', async () => {
      const agent = await adminAgent();
      const { body } = await agent.post('/admin/invites').send({}).expect(201);
      await http()
        .post('/auth/redeem')
        .send({ token: body.token, username: 'Grace', password: PASSWORD })
        .expect(201);

      const listed = await agent.get('/admin/invites').expect(200);
      const row = listed.body.items.find((entry: { id: string }) => entry.id === body.id);

      expect(row.state).toBe('REDEEMED');
      expect(row.redeemedUser.displayName).toBe('Grace');
      // The username as well as the display name: only the username is unique,
      // so it is the only thing that can name the account unambiguously. This
      // row is the one place both halves of `normaliseUsername()` are on the
      // wire together — typed as `Grace`, stored and served as `grace`.
      expect(row.redeemedUser.username).toBe('grace');
      expect(row.createdBy.username).toBe('ada');
    });

    it('honours an explicit expiry', async () => {
      const agent = await adminAgent();

      const before = Date.now();
      const { body } = await agent.post('/admin/invites').send({ expiresInHours: 24 }).expect(201);
      const after = Date.now();

      // A window rather than an instant — the request takes real time, and the
      // clock is read inside the service.
      const expiresAt = new Date(body.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * 3_600_000);
      expect(expiresAt).toBeLessThanOrEqual(after + 24 * 3_600_000);
    });

    it('refuses an expiry past the cap', async () => {
      const agent = await adminAgent();

      // The bound is the only thing standing between an invite and a permanent
      // way in, and this library has no other front door.
      await agent.post('/admin/invites').send({ expiresInHours: 2161 }).expect(400);
    });

    describe('role enforcement', () => {
      /** An admin plus a plain user, both real accounts. */
      async function bothRoles(): Promise<{ admin: request.Agent; user: request.Agent }> {
        const admin = await adminAgent();
        const { body } = await admin.post('/admin/invites').send({}).expect(201);

        const user = request.agent(app.getHttpServer());
        await user
          .post('/auth/redeem')
          .send({ token: body.token, username: 'grace', password: PASSWORD })
          .expect(201);

        return { admin, user };
      }

      it('403s a USER on every admin invite route', async () => {
        const { user } = await bothRoles();

        await user.get('/admin/invites').expect(403);
        await user.post('/admin/invites').send({}).expect(403);
        await user.delete('/admin/invites/whatever').expect(403);
      });

      it('401s an anonymous caller rather than 403', async () => {
        await http().get('/admin/invites').expect(401);
      });

      it('stops working the moment the admin is deactivated', async () => {
        const { admin } = await bothRoles();
        await admin.get('/admin/invites').expect(200);

        await prisma.user.updateMany({ where: { role: 'ADMIN' }, data: { isActive: false } });

        await admin.get('/admin/invites').expect(401);
      });
    });
  });
});
