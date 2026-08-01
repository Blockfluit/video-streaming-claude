import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SessionStoreService } from '../src/auth/session-store.service';
import { bigIntReplacer } from '../src/common/json';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Watch tracking through the API.
 *
 * The rollup arithmetic is unit-tested in `src/watch/progress.spec.ts`. What is
 * worth testing here is everything that arithmetic sits inside: that the event
 * log and the rollup are written together, that a play session is counted once
 * across the beats it sends, that history and stats cannot show a viewer a
 * video they may not see, and that the final beacon of a page load — which
 * arrives as `text/plain` — is parsed at all.
 */
describe('Watch tracking (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-watch-test.bootstrap-token');

  let workspace: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;
  let viewer: request.Agent;
  let collectionId: string;
  /** A published, 600-second video, so the completion threshold sits at 540. */
  let videoId: string;

  async function startApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('json replacer', bigIntReplacer);
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
    prisma = app.get(PrismaService);
  }

  let seeded = 0;

  async function seedVideo(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    seeded += 1;
    const video = await prisma.video.create({
      data: {
        collections: { create: { collectionId, orderIndex: seeded } },
        slug: `film-${seeded}`,
        title: `Film ${seeded}`,
        storageKey: `Films/film-${seeded}.mkv`,
        contentTag: 'tag',
        originalName: `film-${seeded}.mkv`,
        mimeType: 'video/x-matroska',
        sizeBytes: BigInt(1024),
        fileMtime: new Date(),
        durationSec: 600,
        state: 'PUBLISHED',
        ...overrides,
      },
      select: { id: true },
    });
    return video.id;
  }

  /** A whole play session in one call, since most tests only care about the outcome. */
  const beat = (
    agent: request.Agent,
    body: Record<string, unknown>,
    id: string = videoId,
  ) => agent.post(`/videos/${id}/heartbeat`).send(body);

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'watch-'));
    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = tokenFile;
    process.env.MEDIA_ROOT = join(workspace, 'media');
    process.env.DERIVED_ROOT = join(workspace, 'derived');
    process.env.INGEST_WATCHER_ENABLED = 'false';
    await rm(tokenFile, { force: true });

    await startApp();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "InviteToken", "User", "session", "Collection", "Season", "Video" RESTART IDENTITY CASCADE',
    );
    await app.close();
    await rm(tokenFile, { force: true });

    await startApp();

    admin = request.agent(app.getHttpServer());
    await admin
      .post('/auth/redeem')
      .send({ token: (await readFile(tokenFile, 'utf8')).trim(), username: 'ada', password: PASSWORD })
      .expect(201);

    const invite = await admin.post('/admin/invites').send({}).expect(201);
    viewer = request.agent(app.getHttpServer());
    await viewer
      .post('/auth/redeem')
      .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
      .expect(201);

    const collection = await prisma.collection.create({
      data: { slug: 'films', title: 'Films', folderKey: 'Films', state: 'PUBLISHED' },
      select: { id: true },
    });
    collectionId = collection.id;
    seeded = 0;
    videoId = await seedVideo();
  });

  afterEach(async () => {
    banner.mockRestore();
    await app?.close();
    await rm(tokenFile, { force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  describe('a heartbeat', () => {
    it('creates the rollup on the first beat and returns it', async () => {
      const response = await beat(viewer, {
        playSessionId: randomUUID(),
        positionSec: 10,
        deltaSec: 10,
      }).expect(200);

      expect(response.body).toMatchObject({
        lastPositionSec: 10,
        maxPositionSec: 10,
        secondsWatched: 10,
        viewCount: 1,
        completed: false,
      });
    });

    it('writes an event alongside the rollup', async () => {
      const playSessionId = randomUUID();
      await beat(viewer, { playSessionId, positionSec: 10, deltaSec: 10 }).expect(200);

      const events = await prisma.watchEvent.findMany({ where: { playSessionId } });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ positionSec: 10, deltaSec: 10 });
    });

    it('accumulates across beats', async () => {
      const playSessionId = randomUUID();
      await beat(viewer, { playSessionId, positionSec: 10, deltaSec: 10 }).expect(200);
      await beat(viewer, { playSessionId, positionSec: 20, deltaSec: 10 }).expect(200);
      const response = await beat(viewer, {
        playSessionId,
        positionSec: 30,
        deltaSec: 10,
      }).expect(200);

      expect(response.body).toMatchObject({ secondsWatched: 30, lastPositionSec: 30 });
    });

    it('treats a beat with no watched time, such as a pause, as a position update', async () => {
      const playSessionId = randomUUID();
      await beat(viewer, { playSessionId, positionSec: 10, deltaSec: 10 }).expect(200);

      const response = await beat(viewer, { playSessionId, positionSec: 42 }).expect(200);

      expect(response.body).toMatchObject({ secondsWatched: 10, lastPositionSec: 42 });
    });

    it('404s a video that does not exist', async () => {
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 1, deltaSec: 1 }, 'nope').expect(
        404,
      );
    });
  });

  /**
   * The final beat of a page load goes out through `navigator.sendBeacon`,
   * which sends a string as `text/plain`. Without the scoped body parser the
   * global JSON parser ignores it and the handler sees an empty body — losing
   * the one beat that carries where the viewer actually stopped.
   */
  describe('the closing beacon', () => {
    it('parses a text/plain body on the heartbeat route', async () => {
      const response = await viewer
        .post(`/videos/${videoId}/heartbeat`)
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ playSessionId: randomUUID(), positionSec: 90, deltaSec: 8 }))
        .expect(200);

      expect(response.body).toMatchObject({ lastPositionSec: 90, secondsWatched: 8 });
    });

    it('does not parse text/plain anywhere else', async () => {
      await admin
        .post('/collections')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ title: 'Smuggled' }))
        .expect(400);
    });
  });

  describe('counting a view', () => {
    it('counts one play session once, however many beats it sends', async () => {
      const playSessionId = randomUUID();
      for (const positionSec of [10, 20, 30]) {
        await beat(viewer, { playSessionId, positionSec, deltaSec: 10 }).expect(200);
      }

      const response = await beat(viewer, {
        playSessionId,
        positionSec: 40,
        deltaSec: 10,
      }).expect(200);

      expect(response.body.viewCount).toBe(1);
    });

    it('counts a second page load as a second view', async () => {
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }).expect(200);

      const response = await beat(viewer, {
        playSessionId: randomUUID(),
        positionSec: 10,
        deltaSec: 10,
      }).expect(200);

      expect(response.body.viewCount).toBe(2);
    });
  });

  describe('what a client cannot claim', () => {
    /**
     * Against a buggy client — a delta from a bad subtraction, or a timer that
     * fired in a loop. The position still lands: refusing the beat would throw
     * away the viewer's resume point along with the bad figure.
     */
    it('caps one beat at 30 seconds and keeps the position', async () => {
      const response = await beat(viewer, {
        playSessionId: randomUUID(),
        positionSec: 120,
        deltaSec: 40_000,
      }).expect(200);

      expect(response.body).toMatchObject({ secondsWatched: 30, lastPositionSec: 120 });
    });

    it('records the credited seconds in the event log, not what was claimed', async () => {
      const playSessionId = randomUUID();
      await beat(viewer, { playSessionId, positionSec: 120, deltaSec: 40_000 }).expect(200);

      const [event] = await prisma.watchEvent.findMany({ where: { playSessionId } });

      expect(event.deltaSec).toBe(30);
    });

    it('clamps a position past the end of the video', async () => {
      const response = await beat(viewer, {
        playSessionId: randomUUID(),
        positionSec: 9_999,
        deltaSec: 5,
      }).expect(200);

      expect(response.body.lastPositionSec).toBe(600);
    });

    it('rejects a negative position', async () => {
      await beat(viewer, { playSessionId: randomUUID(), positionSec: -1, deltaSec: 1 }).expect(400);
    });

    it('rejects a play session id that is not a uuid', async () => {
      await beat(viewer, { playSessionId: 'always-the-same', positionSec: 1, deltaSec: 1 }).expect(
        400,
      );
    });

    it('rejects a beat with no play session at all', async () => {
      await beat(viewer, { positionSec: 1, deltaSec: 1 }).expect(400);
    });
  });

  describe('completion', () => {
    it('marks a video complete at 90%', async () => {
      const response = await beat(viewer, {
        playSessionId: randomUUID(),
        positionSec: 540,
        deltaSec: 30,
      }).expect(200);

      expect(response.body.completed).toBe(true);
    });

    // Judged on the high-water mark, so rewatching a scene does not un-finish it.
    it('stays complete after seeking back to the start', async () => {
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 600, deltaSec: 30 }).expect(200);

      const response = await beat(viewer, {
        playSessionId: randomUUID(),
        positionSec: 5,
        deltaSec: 5,
      }).expect(200);

      expect(response.body).toMatchObject({
        completed: true,
        lastPositionSec: 5,
        maxPositionSec: 600,
      });
    });

    it('never completes a video whose probe found no duration', async () => {
      const unprobed = await seedVideo({ durationSec: null });

      const response = await beat(
        viewer,
        { playSessionId: randomUUID(), positionSec: 9_999, deltaSec: 10 },
        unprobed,
      ).expect(200);

      expect(response.body).toMatchObject({ completed: false, lastPositionSec: 9_999 });
    });
  });

  describe('visibility', () => {
    it('refuses a heartbeat on a draft from a viewer', async () => {
      const draft = await seedVideo({ state: 'DRAFT' });

      await beat(viewer, { playSessionId: randomUUID(), positionSec: 1, deltaSec: 1 }, draft).expect(
        404,
      );
    });

    it('allows an admin to heartbeat a draft, which is how a preview works', async () => {
      const draft = await seedVideo({ state: 'DRAFT' });

      await beat(admin, { playSessionId: randomUUID(), positionSec: 1, deltaSec: 1 }, draft).expect(
        200,
      );
    });

    /**
     * A video unpublished after someone watched it must drop out of their
     * history rather than leak its title back to them.
     */
    it('drops a video from history once it is no longer visible', async () => {
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }).expect(200);
      await expect(viewer.get('/me/history').expect(200)).resolves.toMatchObject({
        body: { total: 1 },
      });

      await admin.post(`/videos/${videoId}/archive`).expect(200);

      const response = await viewer.get('/me/history').expect(200);
      expect(response.body.items).toEqual([]);
    });
  });

  describe('history', () => {
    it('is empty before anything is watched', async () => {
      const response = await viewer.get('/me/history').expect(200);

      expect(response.body).toMatchObject({ items: [], total: 0, hasMore: false });
    });

    it('returns a page, with the video needed to render a card', async () => {
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }).expect(200);

      const response = await viewer.get('/me/history').expect(200);

      expect(response.body).toMatchObject({ total: 1, limit: 50, offset: 0, hasMore: false });
      expect(response.body.items[0]).toMatchObject({
        video: {
          id: videoId,
          title: 'Film 1',
          durationSec: 600,
          // Through the membership: a card names the collections a video is
          // in, and it may be in several or in none.
          collections: [{ collection: { slug: 'films' } }],
        },
        progress: { lastPositionSec: 10, completed: false },
      });
    });

    it('puts the most recently watched first', async () => {
      const second = await seedVideo();

      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }).expect(200);
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }, second).expect(
        200,
      );

      const response = await viewer.get('/me/history').expect(200);

      expect(response.body.items.map((item: { video: { id: string } }) => item.video.id)).toEqual([
        second,
        videoId,
      ]);
    });

    it('pages', async () => {
      const second = await seedVideo();
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }).expect(200);
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }, second).expect(
        200,
      );

      const first = await viewer.get('/me/history?limit=1').expect(200);

      expect(first.body).toMatchObject({ total: 2, hasMore: true });
      expect(first.body.items).toHaveLength(1);
    });

    // The continue-watching row: started, not finished.
    it('filters out finished videos on request', async () => {
      const finished = await seedVideo();
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }).expect(200);
      await beat(
        viewer,
        { playSessionId: randomUUID(), positionSec: 600, deltaSec: 30 },
        finished,
      ).expect(200);

      const response = await viewer.get('/me/history?completed=false').expect(200);

      expect(response.body.items.map((item: { video: { id: string } }) => item.video.id)).toEqual([
        videoId,
      ]);
    });

    it('narrows to one collection, which is what a show page needs', async () => {
      const other = await prisma.collection.create({
        data: { slug: 'shows', title: 'Shows', folderKey: 'Shows', state: 'PUBLISHED' },
        select: { id: true },
      });
      // Seeded straight into the other collection: which collection a video
      // is in is a membership, not a column on the video.
      const elsewhere = await seedVideo({
        collections: { create: { collectionId: other.id } },
      });
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }).expect(200);
      await beat(
        viewer,
        { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 },
        elsewhere,
      ).expect(200);

      const response = await viewer.get(`/me/history?collectionId=${other.id}`).expect(200);

      expect(response.body.items.map((item: { video: { id: string } }) => item.video.id)).toEqual([
        elsewhere,
      ]);
    });

    it('is the caller’s own, not the library’s', async () => {
      await beat(admin, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }).expect(200);

      const response = await viewer.get('/me/history').expect(200);

      expect(response.body.items).toEqual([]);
    });
  });

  describe('per-video stats', () => {
    it('gives a viewer their own progress and nobody else’s figures', async () => {
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }).expect(200);
      await beat(admin, { playSessionId: randomUUID(), positionSec: 300, deltaSec: 30 }).expect(200);

      const response = await viewer.get(`/videos/${videoId}/stats`).expect(200);

      expect(response.body.mine).toMatchObject({ lastPositionSec: 10, secondsWatched: 10 });
      expect(response.body.totals).toBeUndefined();
    });

    it('reports null progress for a video the caller has not started', async () => {
      const response = await viewer.get(`/videos/${videoId}/stats`).expect(200);

      expect(response.body.mine).toBeNull();
    });

    it('gives an admin the aggregate', async () => {
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 540, deltaSec: 30 }).expect(200);
      await beat(admin, { playSessionId: randomUUID(), positionSec: 300, deltaSec: 30 }).expect(200);
      await beat(admin, { playSessionId: randomUUID(), positionSec: 310, deltaSec: 10 }).expect(200);

      const response = await admin.get(`/videos/${videoId}/stats`).expect(200);

      expect(response.body.totals).toMatchObject({
        viewers: 2,
        // Two page loads from the admin, one from the viewer.
        views: 3,
        secondsWatched: 70,
        completions: 1,
      });
      // Mean of 540/600 and 310/600.
      expect(response.body.totals.averageCompletion).toBeCloseTo((540 / 600 + 310 / 600) / 2);
    });

    it('has no average completion for a video with no known duration', async () => {
      const unprobed = await seedVideo({ durationSec: null });
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }, unprobed).expect(
        200,
      );

      const response = await admin.get(`/videos/${unprobed}/stats`).expect(200);

      expect(response.body.totals.averageCompletion).toBeNull();
    });

    it('404s a draft for a viewer', async () => {
      const draft = await seedVideo({ state: 'DRAFT' });

      await viewer.get(`/videos/${draft}/stats`).expect(404);
    });
  });

  describe('collection stats', () => {
    it('rolls the figures up over the collection', async () => {
      const second = await seedVideo();
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 540, deltaSec: 30 }).expect(200);
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 300, deltaSec: 20 }, second).expect(
        200,
      );

      const response = await admin.get(`/collections/${collectionId}/stats`).expect(200);

      expect(response.body).toMatchObject({
        videoCount: 2,
        totals: { views: 2, secondsWatched: 50, completions: 1 },
      });
    });

    // One person watching six episodes is one viewer, not six.
    it('counts a viewer once across the videos they watched', async () => {
      const second = await seedVideo();
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }).expect(200);
      await beat(viewer, { playSessionId: randomUUID(), positionSec: 10, deltaSec: 10 }, second).expect(
        200,
      );

      const response = await admin.get(`/collections/${collectionId}/stats`).expect(200);

      expect(response.body.totals.viewers).toBe(1);
    });

    it('is admin-only', async () => {
      await viewer.get(`/collections/${collectionId}/stats`).expect(403);
    });

    it('404s an unknown collection', async () => {
      await admin.get('/collections/nope/stats').expect(404);
    });
  });
});
