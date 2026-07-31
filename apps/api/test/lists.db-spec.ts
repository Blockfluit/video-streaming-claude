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
 * The two lists on the home page.
 *
 * **My List** is explicit and per-user; **curated rows** are admin-made and the
 * same for everyone. What is worth testing against a real database is what a
 * stub cannot lose: that adding twice is genuinely idempotent, that a reorder
 * cannot half-apply, and that neither list becomes a way to see a draft.
 */
describe('My List and curated rows (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-lists-test.bootstrap-token');

  let workspace: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;
  let viewer: request.Agent;
  let showId: string;
  let filmId: string;

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
    collectionId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    seeded += 1;
    const video = await prisma.video.create({
      data: {
        collectionId,
        slug: `video-${seeded}`,
        title: `Video ${seeded}`,
        storageKey: `Show/video-${seeded}.mkv`,
        contentTag: 'tag',
        originalName: `video-${seeded}.mkv`,
        mimeType: 'video/x-matroska',
        sizeBytes: BigInt(1024),
        fileMtime: new Date(),
        durationSec: 600,
        state: 'PUBLISHED',
        orderIndex: seeded,
        ...overrides,
      },
      select: { id: true },
    });
    return video.id;
  }

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'lists-'));
    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = tokenFile;
    process.env.MEDIA_ROOT = join(workspace, 'media');
    process.env.DERIVED_ROOT = join(workspace, 'derived');
    process.env.INGEST_WATCHER_ENABLED = 'false';
    await rm(tokenFile, { force: true });

    await startApp();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "InviteToken", "User", "session", "Collection", "Season", "Video", "CuratedList" RESTART IDENTITY CASCADE',
    );
    await app.close();
    await rm(tokenFile, { force: true });

    await startApp();

    admin = request.agent(app.getHttpServer());
    await admin
      .post('/auth/redeem')
      .send({ token: (await readFile(tokenFile, 'utf8')).trim(), username: 'root', password: PASSWORD })
      .expect(201);

    const invite = await admin.post('/admin/invites').send({}).expect(201);
    viewer = request.agent(app.getHttpServer());
    await viewer
      .post('/auth/redeem')
      .send({ token: invite.body.token, username: 'viewer', password: PASSWORD })
      .expect(201);

    const show = await prisma.collection.create({
      data: { slug: 'show', title: 'Show', folderKey: 'Show', state: 'PUBLISHED' },
      select: { id: true },
    });
    showId = show.id;
    seeded = 0;
    filmId = await seedVideo(showId);
  });

  afterEach(async () => {
    banner.mockRestore();
    await app?.close();
    await rm(tokenFile, { force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  describe('My List', () => {
    it('starts empty', async () => {
      const response = await viewer.get('/me/watchlist').expect(200);

      expect(response.body).toMatchObject({ items: [], total: 0 });
    });

    it('saves a video and reads it back', async () => {
      await viewer.post('/me/watchlist').send({ videoId: filmId }).expect(200);

      const response = await viewer.get('/me/watchlist').expect(200);

      expect(response.body.total).toBe(1);
      expect(response.body.items[0].video).toMatchObject({ id: filmId, title: 'Video 1' });
    });

    // The two partial uniques are what enforce it; a double-click is normal.
    it('is idempotent', async () => {
      const first = await viewer.post('/me/watchlist').send({ videoId: filmId }).expect(200);
      const second = await viewer.post('/me/watchlist').send({ videoId: filmId }).expect(200);

      expect(second.body.id).toBe(first.body.id);
      await expect(viewer.get('/me/watchlist').expect(200)).resolves.toMatchObject({
        body: { total: 1 },
      });
    });

    it('removes by what was saved, not by row id', async () => {
      await viewer.post('/me/watchlist').send({ videoId: filmId }).expect(200);

      await viewer.delete('/me/watchlist').send({ videoId: filmId }).expect(204);

      await expect(viewer.get('/me/watchlist').expect(200)).resolves.toMatchObject({
        body: { total: 0 },
      });
    });

    it('removing something already gone leaves it gone', async () => {
      await viewer.delete('/me/watchlist').send({ videoId: filmId }).expect(204);
    });

    it('refuses a body naming both a collection and a video', async () => {
      await viewer.post('/me/watchlist').send({ videoId: filmId, collectionId: showId }).expect(400);
    });

    it('refuses a body naming neither', async () => {
      await viewer.post('/me/watchlist').send({}).expect(400);
    });

    it('is the caller’s own', async () => {
      await admin.post('/me/watchlist').send({ videoId: filmId }).expect(200);

      await expect(viewer.get('/me/watchlist').expect(200)).resolves.toMatchObject({
        body: { total: 0 },
      });
    });

    describe('visibility', () => {
      it('refuses to save a draft', async () => {
        const draft = await seedVideo(showId, { state: 'DRAFT' });

        await viewer.post('/me/watchlist').send({ videoId: draft }).expect(404);
      });

      it('drops a saved video that is no longer visible', async () => {
        await viewer.post('/me/watchlist').send({ videoId: filmId }).expect(200);

        await admin.post(`/videos/${filmId}/archive`).expect(200);

        const response = await viewer.get('/me/watchlist').expect(200);
        expect(response.body.items).toEqual([]);
      });
    });

    /**
     * A saved *collection* renders as one card, and the card has to name an
     * episode — resolved against the caller's own progress.
     */
    describe('a saved collection', () => {
      it('offers the first episode when nothing has been watched', async () => {
        await seedVideo(showId);
        await viewer.post('/me/watchlist').send({ collectionId: showId }).expect(200);

        const response = await viewer.get('/me/watchlist').expect(200);

        expect(response.body.items[0].next).toMatchObject({
          id: filmId,
          progress: null,
        });
      });

      it('moves on once an episode is finished', async () => {
        const second = await seedVideo(showId);
        await viewer.post('/me/watchlist').send({ collectionId: showId }).expect(200);
        await viewer
          .post(`/videos/${filmId}/heartbeat`)
          .send({
            playSessionId: '3f6a1c1e-2b0d-4c8a-9f2e-11a2b3c4d5e6',
            positionSec: 600,
            deltaSec: 30,
          })
          .expect(200);

        const response = await viewer.get('/me/watchlist').expect(200);

        expect(response.body.items[0].next.id).toBe(second);
      });

      it('carries the progress, so the card can show where to resume', async () => {
        await viewer.post('/me/watchlist').send({ collectionId: showId }).expect(200);
        await viewer
          .post(`/videos/${filmId}/heartbeat`)
          .send({
            playSessionId: '3f6a1c1e-2b0d-4c8a-9f2e-11a2b3c4d5e6',
            positionSec: 120,
            deltaSec: 30,
          })
          .expect(200);

        const response = await viewer.get('/me/watchlist').expect(200);

        expect(response.body.items[0].next).toMatchObject({
          id: filmId,
          progress: { lastPositionSec: 120 },
        });
      });

      it('never offers an episode the caller may not see', async () => {
        await prisma.video.update({ where: { id: filmId }, data: { state: 'DRAFT' } });
        const published = await seedVideo(showId);
        await viewer.post('/me/watchlist').send({ collectionId: showId }).expect(200);

        const response = await viewer.get('/me/watchlist').expect(200);

        expect(response.body.items[0].next.id).toBe(published);
      });

      it('has nothing to offer for an empty collection', async () => {
        const empty = await prisma.collection.create({
          data: { slug: 'empty', title: 'Empty', folderKey: 'Empty', state: 'PUBLISHED' },
          select: { id: true },
        });
        await viewer.post('/me/watchlist').send({ collectionId: empty.id }).expect(200);

        const response = await viewer.get('/me/watchlist').expect(200);

        expect(response.body.items[0].next).toBeNull();
      });
    });
  });

  describe('curated rows', () => {
    let listId: string;

    beforeEach(async () => {
      const response = await admin.post('/lists').send({ title: 'Staff Picks' }).expect(201);
      listId = response.body.id;
    });

    it('creates a row with a slug from the title', async () => {
      const response = await admin.get('/lists').expect(200);

      expect(response.body.items[0]).toMatchObject({ title: 'Staff Picks', slug: 'staff-picks' });
    });

    it('holds collections and videos side by side', async () => {
      await admin.post(`/lists/${listId}/items`).send({ videoId: filmId }).expect(200);
      await admin.post(`/lists/${listId}/items`).send({ collectionId: showId }).expect(200);

      const response = await viewer.get('/lists').expect(200);

      expect(response.body.items[0].items).toHaveLength(2);
    });

    it('is idempotent when the same entry is added twice', async () => {
      const first = await admin.post(`/lists/${listId}/items`).send({ videoId: filmId }).expect(200);
      const second = await admin
        .post(`/lists/${listId}/items`)
        .send({ videoId: filmId })
        .expect(200);

      expect(second.body.id).toBe(first.body.id);
    });

    it('refuses an entry naming both a collection and a video', async () => {
      await admin
        .post(`/lists/${listId}/items`)
        .send({ videoId: filmId, collectionId: showId })
        .expect(400);
    });

    it('removes an entry', async () => {
      const item = await admin.post(`/lists/${listId}/items`).send({ videoId: filmId }).expect(200);

      await admin.delete(`/lists/${listId}/items/${item.body.id}`).expect(204);

      const response = await admin.get('/lists').expect(200);
      expect(response.body.items[0].items).toEqual([]);
    });

    // An item id alone must not reach into a row the caller did not name.
    it('refuses to remove an entry through the wrong row', async () => {
      const other = await admin.post('/lists').send({ title: 'Other' }).expect(201);
      const item = await admin.post(`/lists/${listId}/items`).send({ videoId: filmId }).expect(200);

      await admin.delete(`/lists/${other.body.id}/items/${item.body.id}`).expect(404);
    });

    /**
     * `ListItem.position` is deliberately not unique — a unique index collides
     * mid drag-reorder — so the whole order is rewritten at once instead.
     */
    describe('reordering', () => {
      let first: string;
      let second: string;

      beforeEach(async () => {
        const a = await admin.post(`/lists/${listId}/items`).send({ videoId: filmId }).expect(200);
        const b = await admin
          .post(`/lists/${listId}/items`)
          .send({ collectionId: showId })
          .expect(200);
        first = a.body.id;
        second = b.body.id;
      });

      it('rewrites the order from the list it is given', async () => {
        const response = await admin
          .patch(`/lists/${listId}/reorder`)
          .send({ itemIds: [second, first] })
          .expect(200);

        expect(response.body.map((item: { id: string }) => item.id)).toEqual([second, first]);
      });

      it('refuses a partial list', async () => {
        await admin.patch(`/lists/${listId}/reorder`).send({ itemIds: [first] }).expect(400);
      });

      it('refuses the same item listed twice', async () => {
        await admin
          .patch(`/lists/${listId}/reorder`)
          .send({ itemIds: [first, first] })
          .expect(400);
      });

      it('refuses an item from another row', async () => {
        const other = await admin.post('/lists').send({ title: 'Other' }).expect(201);
        const stranger = await admin
          .post(`/lists/${other.body.id}/items`)
          .send({ videoId: filmId })
          .expect(200);

        await admin
          .patch(`/lists/${listId}/reorder`)
          .send({ itemIds: [first, second, stranger.body.id] })
          .expect(400);
      });
    });

    describe('what a viewer sees', () => {
      /**
       * A curated row is admin-made and can hold anything, so this filter is the
       * only thing stopping a home-page shelf from advertising a draft.
       */
      it('never shows a draft entry', async () => {
        const draft = await seedVideo(showId, { state: 'DRAFT' });
        await admin.post(`/lists/${listId}/items`).send({ videoId: draft }).expect(200);
        await admin.post(`/lists/${listId}/items`).send({ videoId: filmId }).expect(200);

        const response = await viewer.get('/lists').expect(200);

        expect(response.body.items[0].items.map((i: { video: { id: string } }) => i.video.id)).toEqual([
          filmId,
        ]);
      });

      it('never shows a hidden row, whatever it asks for', async () => {
        await admin.patch(`/lists/${listId}`).send({ isVisible: false }).expect(200);

        const response = await viewer.get('/lists?includeHidden=true').expect(200);

        expect(response.body.items).toEqual([]);
      });

      it('shows a hidden row to an admin that asks', async () => {
        await admin.patch(`/lists/${listId}`).send({ isVisible: false }).expect(200);

        await expect(admin.get('/lists').expect(200)).resolves.toMatchObject({
          body: { total: 0 },
        });
        const response = await admin.get('/lists?includeHidden=true').expect(200);
        expect(response.body.total).toBe(1);
      });

      it('404s a hidden row read by slug', async () => {
        await admin.patch(`/lists/${listId}`).send({ isVisible: false }).expect(200);

        await viewer.get('/lists/staff-picks').expect(404);
        await admin.get('/lists/staff-picks').expect(200);
      });
    });

    it('orders rows by position', async () => {
      await admin.patch(`/lists/${listId}`).send({ position: 5 }).expect(200);
      await admin.post('/lists').send({ title: 'Newest', position: 1 }).expect(201);

      const response = await viewer.get('/lists').expect(200);

      expect(response.body.items.map((row: { title: string }) => row.title)).toEqual([
        'Newest',
        'Staff Picks',
      ]);
    });

    it('deletes a row without touching the library', async () => {
      await admin.post(`/lists/${listId}/items`).send({ videoId: filmId }).expect(200);

      await admin.delete(`/lists/${listId}`).expect(204);

      await admin.get(`/videos/${filmId}`).expect(200);
    });

    it('is written only by an admin', async () => {
      await viewer.post('/lists').send({ title: 'Mine' }).expect(403);
      await viewer.patch(`/lists/${listId}`).send({ title: 'Mine' }).expect(403);
      await viewer.delete(`/lists/${listId}`).expect(403);
      await viewer.post(`/lists/${listId}/items`).send({ videoId: filmId }).expect(403);
    });
  });
});
