import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SessionStoreService } from '../src/auth/session-store.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Rate limiting, against a stubbed database.
 *
 * Two halves, and the second matters as much as the first. A limit that never
 * rejects is decoration; a limit on the wrong route breaks the app in a way no
 * other test would catch, because everything still returns 200 until a real
 * person scrubs through a film.
 *
 * The tracker keys on the signed-in user and falls back to the IP, so these
 * unauthenticated requests all share one bucket — which is exactly the
 * behaviour the login limit depends on.
 */
describe('Rate limiting', () => {
  let app: INestApplication;

  const prismaStub = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    onModuleInit: jest.fn().mockResolvedValue(undefined),
    onModuleDestroy: jest.fn().mockResolvedValue(undefined),
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(1),
    },
    inviteToken: { findFirst: jest.fn().mockResolvedValue(null) },
    mediaJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };

  beforeAll(async () => {
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

  afterAll(async () => {
    await app?.close();
  });

  describe('credentials', () => {
    /**
     * `/auth/login` and `/auth/redeem` are the only routes reachable without a
     * session, so they are the only ones an outsider can reach at all.
     */
    it('stops a login being retried indefinitely', async () => {
      const server = app.getHttpServer();
      const statuses: number[] = [];

      // One bucket, because all of these share an IP and none is signed in.
      for (let attempt = 0; attempt < 14; attempt += 1) {
        const response = await request(server)
          .post('/auth/login')
          .send({ username: 'ada', password: 'wrong-password-entirely' });
        statuses.push(response.status);
      }

      expect(statuses).toContain(429);
      // The limit is 10, so the first few must still have been answered
      // normally — a limit that rejects from the first request is a broken app,
      // not a protected one.
      expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    });

    it('stops invite tokens being probed at speed', async () => {
      const server = app.getHttpServer();
      const statuses: number[] = [];

      for (let attempt = 0; attempt < 14; attempt += 1) {
        const response = await request(server)
          .post('/auth/redeem')
          .send({ token: `guess-${attempt}`, username: `u${attempt}`, password: 'correct horse battery staple' });
        statuses.push(response.status);
      }

      expect(statuses).toContain(429);
    });
  });

  describe('what must never be throttled', () => {
    /**
     * The half that would break the app silently.
     *
     * A single `<video>` issues a range request per seek and several more while
     * buffering; every card on a shelf asks for a poster. If any of these ever
     * starts counting, playback and artwork break for one person watching one
     * thing — and every other test here would still pass.
     *
     * They are checked by status rather than by reading the decorator, because
     * a decorator on the wrong method is exactly the mistake worth catching.
     * 404 is the honest answer from a stubbed database; 429 never is.
     */
    it.each([
      ['a video stream', '/videos/whatever/stream'],
      ['a video poster', '/videos/whatever/thumbnail'],
      ['a collection poster', '/collections/whatever/poster'],
      ['a subtitle track', '/videos/whatever/subtitles/track.vtt'],
      ['the session probe', '/auth/me'],
    ])('never rate-limits %s', async (_label, path) => {
      const server = app.getHttpServer();
      const statuses = new Set<number>();

      // Comfortably past every bucket in the app, including the 300/min default.
      for (let attempt = 0; attempt < 320; attempt += 1) {
        statuses.add((await request(server).get(path)).status);
      }

      expect([...statuses]).not.toContain(429);
    });
  });
});
