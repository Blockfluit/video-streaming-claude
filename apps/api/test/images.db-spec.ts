import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SessionStoreService } from '../src/auth/session-store.service';
import { bigIntReplacer } from '../src/common/json';
import { StorageService } from '../src/common/storage.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Serving thumbnails and posters — the read side of what step 10 only wrote.
 *
 * The caching behaviour is the part worth pinning down. The storage key is
 * stable across replacements, so a lifetime-based cache would keep serving a
 * poster an admin has already replaced.
 */
describe('Artwork (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-images-test.bootstrap-token');
  const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  let workspace: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;
  let viewer: request.Agent;
  let collectionId: string;
  let videoId: string;

  async function startApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('json replacer', bigIntReplacer);
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
  }

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'images-'));
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
      .send({ token: (await readFile(tokenFile, 'utf8')).trim(), username: 'root', password: PASSWORD })
      .expect(201);

    const minted = await admin.post('/admin/invites').send({}).expect(201);
    viewer = request.agent(app.getHttpServer());
    await viewer
      .post('/auth/redeem')
      .send({ token: minted.body.token, username: 'viewer', password: PASSWORD })
      .expect(201);

    await storage.save('derived', 'thumbnails/film.png', PIXEL);
    await storage.save('derived', 'posters/films.png', PIXEL);

    const collection = await prisma.collection.create({
      data: {
        slug: 'films',
        title: 'Films',
        folderKey: 'Films',
        state: 'PUBLISHED',
        posterKey: 'posters/films.png',
      },
      select: { id: true },
    });
    collectionId = collection.id;

    const video = await prisma.video.create({
      data: {
        collectionId,
        slug: 'film',
        title: 'Film',
        storageKey: 'Films/film.mkv',
        contentTag: 'tag',
        originalName: 'film.mkv',
        mimeType: 'video/x-matroska',
        sizeBytes: BigInt(1024),
        fileMtime: new Date(),
        state: 'PUBLISHED',
        thumbnailKey: 'thumbnails/film.png',
      },
      select: { id: true },
    });
    videoId = video.id;
  });

  afterEach(async () => {
    banner.mockRestore();
    await app?.close();
    await rm(tokenFile, { force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  describe('a video thumbnail', () => {
    it('serves the image with a type taken from the key', async () => {
      const response = await viewer.get(`/videos/${videoId}/thumbnail`).expect(200);

      expect(response.headers['content-type']).toBe('image/png');
      expect(response.body).toEqual(PIXEL);
    });

    /**
     * The key is stable across replacements — a new poster overwrites
     * `thumbnails/<id>.jpg` — so any lifetime above zero serves the old picture
     * until it expires. Revalidation is what makes a replacement show up.
     */
    it('revalidates rather than carrying a lifetime', async () => {
      const response = await viewer.get(`/videos/${videoId}/thumbnail`).expect(200);

      expect(response.headers['cache-control']).toBe('private, no-cache');
      expect(response.headers.etag).toBeDefined();
    });

    it('answers 304 when the browser already has it', async () => {
      const first = await viewer.get(`/videos/${videoId}/thumbnail`).expect(200);

      await viewer
        .get(`/videos/${videoId}/thumbnail`)
        .set('If-None-Match', first.headers.etag)
        .expect(304);
    });

    it('changes its tag when the picture is replaced', async () => {
      const before = await viewer.get(`/videos/${videoId}/thumbnail`).expect(200);

      await storage.save('derived', 'thumbnails/film.png', Buffer.concat([PIXEL, PIXEL]));

      const after = await viewer.get(`/videos/${videoId}/thumbnail`).expect(200);
      expect(after.headers.etag).not.toBe(before.headers.etag);
    });

    // A shared cache must not hand one member's artwork to another.
    it('is never cached publicly', async () => {
      const response = await viewer.get(`/videos/${videoId}/thumbnail`).expect(200);

      expect(response.headers['cache-control']).toContain('private');
    });

    it('404s a video with no thumbnail', async () => {
      await prisma.video.update({ where: { id: videoId }, data: { thumbnailKey: null } });

      await viewer.get(`/videos/${videoId}/thumbnail`).expect(404);
    });

    /** The row says there is a picture and there is not — a 404, not a 500. */
    it('404s when the row points at a file that is gone', async () => {
      await storage.delete('derived', 'thumbnails/film.png');

      await viewer.get(`/videos/${videoId}/thumbnail`).expect(404);
    });

    it('404s a draft for a viewer but serves it to an admin', async () => {
      await prisma.video.update({ where: { id: videoId }, data: { state: 'DRAFT' } });

      await viewer.get(`/videos/${videoId}/thumbnail`).expect(404);
      await admin.get(`/videos/${videoId}/thumbnail`).expect(200);
    });

    it('needs a session', async () => {
      await request(app.getHttpServer()).get(`/videos/${videoId}/thumbnail`).expect(401);
    });
  });

  describe('a collection poster', () => {
    it('serves the image', async () => {
      const response = await viewer.get(`/collections/${collectionId}/poster`).expect(200);

      expect(response.headers['content-type']).toBe('image/png');
      expect(response.body).toEqual(PIXEL);
    });

    it('404s a collection with no poster', async () => {
      await prisma.collection.update({ where: { id: collectionId }, data: { posterKey: null } });

      await viewer.get(`/collections/${collectionId}/poster`).expect(404);
    });

    it('404s a draft for a viewer but serves it to an admin', async () => {
      await prisma.collection.update({ where: { id: collectionId }, data: { state: 'DRAFT' } });

      await viewer.get(`/collections/${collectionId}/poster`).expect(404);
      await admin.get(`/collections/${collectionId}/poster`).expect(200);
    });
  });
});
