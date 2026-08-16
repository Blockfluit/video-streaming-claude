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
import { STREAM_CHUNK_BYTES } from '../src/videos/range';

/**
 * Range streaming end to end, against real files and a real Postgres.
 *
 * The plan's checkpoint is `curl -r 0-1023` returning a 206, and that is only
 * meaningful over a real socket: the headers, the status, and the bytes on the
 * wire are the entire feature.
 */
describe('Streaming (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-stream-test.bootstrap-token');

  /** Deterministic content so a byte range can be checked against what it should contain. */
  const BODY = Buffer.from(
    Array.from({ length: 5000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join(''),
  );

  let workspace: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;
  let collectionId: string;

  const http = () => request(app.getHttpServer());

  async function startApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('json replacer', bigIntReplacer);
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
  }

  /** A video row plus the file it points at. */
  async function seedVideo(
    title: string,
    overrides: Record<string, unknown> = {},
    body: Buffer = BODY,
  ): Promise<{ id: string; storageKey: string }> {
    const storageKey = `films/${title}.mp4`;
    await storage.save('media', storageKey, body);

    const video = await prisma.video.create({
      data: {
        collections: { create: { collectionId } },
        slug: title.toLowerCase(),
        title,
        storageKey,
        contentTag: 'tag',
        originalName: `${title}.mp4`,
        mimeType: 'video/mp4',
        sizeBytes: BigInt(body.length),
        fileMtime: new Date('2026-01-01T00:00:00Z'),
        state: 'PUBLISHED',
        description: 'A description.',
        durationSec: 120,
        bannerKey: 'thumbs/a.jpg',
        ...overrides,
      },
      select: { id: true, storageKey: true },
    });

    return video;
  }

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'streaming-'));
    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = tokenFile;
    process.env.MEDIA_ROOT = join(workspace, 'media');
    process.env.DERIVED_ROOT = join(workspace, 'derived');
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

    const collection = await admin.post('/collections').send({ title: 'Films' }).expect(201);
    collectionId = collection.body.id;
  });

  afterEach(async () => {
    banner.mockRestore();
    await app?.close();
    await rm(tokenFile, { force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  async function asUser(): Promise<request.Agent> {
    const invite = await admin.post('/admin/invites').send({}).expect(201);
    const user = request.agent(app.getHttpServer());
    await user
      .post('/auth/redeem')
      .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
      .expect(201);
    return user;
  }

  describe('the plan checkpoint', () => {
    // `curl -r 0-1023` — the one that decides whether the app works at all.
    it('answers a byte range with 206 and the right bytes', async () => {
      const video = await seedVideo('Inception');

      const response = await admin
        .get(`/videos/${video.id}/stream`)
        .set('Range', 'bytes=0-1023')
        .expect(206);

      expect(response.headers['content-range']).toBe(`bytes 0-1023/${BODY.length}`);
      expect(response.headers['content-length']).toBe('1024');
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.body.length).toBe(1024);
      expect(Buffer.from(response.body).equals(BODY.subarray(0, 1024))).toBe(true);
    });
  });

  describe('without a Range header', () => {
    it('answers 200 with the whole file', async () => {
      const video = await seedVideo('Inception');

      const response = await admin.get(`/videos/${video.id}/stream`).expect(200);

      expect(response.headers['content-length']).toBe(String(BODY.length));
      expect(response.headers['content-range']).toBeUndefined();
      expect(Buffer.from(response.body).equals(BODY)).toBe(true);
    });

    // Without this the client never learns it may seek.
    it('still advertises range support', async () => {
      const video = await seedVideo('Inception');

      const response = await admin.get(`/videos/${video.id}/stream`).expect(200);

      expect(response.headers['accept-ranges']).toBe('bytes');
    });
  });

  describe('range requests', () => {
    it('serves a range from the middle', async () => {
      const video = await seedVideo('Inception');

      const response = await admin
        .get(`/videos/${video.id}/stream`)
        .set('Range', 'bytes=1000-1999')
        .expect(206);

      expect(response.headers['content-range']).toBe(`bytes 1000-1999/${BODY.length}`);
      expect(Buffer.from(response.body).equals(BODY.subarray(1000, 2000))).toBe(true);
    });

    it('serves the last bytes of the file for a suffix range', async () => {
      const video = await seedVideo('Inception');

      const response = await admin
        .get(`/videos/${video.id}/stream`)
        .set('Range', 'bytes=-500')
        .expect(206);

      expect(response.headers['content-range']).toBe(
        `bytes ${BODY.length - 500}-${BODY.length - 1}/${BODY.length}`,
      );
      expect(Buffer.from(response.body).equals(BODY.subarray(BODY.length - 500))).toBe(true);
    });

    it('caps an open-ended range rather than sending the whole file', async () => {
      const big = Buffer.alloc(STREAM_CHUNK_BYTES * 2, 'x');
      const video = await seedVideo('Big', {}, big);

      const response = await admin
        .get(`/videos/${video.id}/stream`)
        .set('Range', 'bytes=0-')
        .expect(206);

      expect(response.headers['content-length']).toBe(String(STREAM_CHUNK_BYTES));
      expect(response.headers['content-range']).toBe(
        `bytes 0-${STREAM_CHUNK_BYTES - 1}/${big.length}`,
      );
    });

    it('clamps an end past the file to the last byte', async () => {
      const video = await seedVideo('Inception');

      const response = await admin
        .get(`/videos/${video.id}/stream`)
        .set('Range', 'bytes=4900-999999')
        .expect(206);

      expect(response.headers['content-range']).toBe(`bytes 4900-4999/${BODY.length}`);
      expect(response.headers['content-length']).toBe('100');
    });

    it('serves a single byte', async () => {
      const video = await seedVideo('Inception');

      const response = await admin
        .get(`/videos/${video.id}/stream`)
        .set('Range', 'bytes=0-0')
        .expect(206);

      expect(response.headers['content-length']).toBe('1');
    });
  });

  describe('ranges it cannot serve', () => {
    // The `*` tells the client the size it should have asked within.
    it('answers 416 with the file size for a range past the end', async () => {
      const video = await seedVideo('Inception');

      const response = await admin
        .get(`/videos/${video.id}/stream`)
        .set('Range', 'bytes=99999-')
        .expect(416);

      expect(response.headers['content-range']).toBe(`bytes */${BODY.length}`);
    });

    it('answers 416 for a malformed range', async () => {
      const video = await seedVideo('Inception');

      await admin.get(`/videos/${video.id}/stream`).set('Range', 'bytes=abc-def').expect(416);
      await admin.get(`/videos/${video.id}/stream`).set('Range', 'bytes=500-100').expect(416);
    });

    // RFC 7233: a unit we do not understand must be ignored, not rejected.
    it('ignores a unit that is not bytes and sends the whole file', async () => {
      const video = await seedVideo('Inception');

      const response = await admin
        .get(`/videos/${video.id}/stream`)
        .set('Range', 'items=0-5')
        .expect(200);

      expect(response.headers['content-length']).toBe(String(BODY.length));
    });

    // Answering one range of a multi-range request would be a lie about what
    // was asked for; the whole body is a legal answer.
    it('ignores a multi-range request', async () => {
      const video = await seedVideo('Inception');

      await admin.get(`/videos/${video.id}/stream`).set('Range', 'bytes=0-99,200-299').expect(200);
    });
  });

  describe('which file gets served', () => {
    it('prefers the converted playback file over the source', async () => {
      const converted = Buffer.from('converted-mp4-body');
      const video = await seedVideo('Inception');
      await storage.save('media', 'films/inception.mp4', converted);
      await prisma.video.update({
        where: { id: video.id },
        data: { playbackKey: 'films/inception.mp4', playbackMime: 'video/mp4' },
      });

      const response = await admin.get(`/videos/${video.id}/stream`).expect(200);

      expect(Buffer.from(response.body).equals(converted)).toBe(true);
    });

    /**
     * A row whose file has not been relocated yet still plays.
     *
     * Converted files used to live under `derived/converted/` and now live
     * beside their source, and the files are moved by an admin endpoint rather
     * than by a migration — a transcode costs hours of CPU and cannot be
     * abandoned the way regenerable artwork was. Between deploying and running
     * that, both layouts exist, and reading a legacy key as a media key would
     * 404 every already-converted video in the library.
     */
    it('still plays a converted file that has not been relocated yet', async () => {
      const converted = Buffer.from('legacy-converted-body');
      const video = await seedVideo('Inception');
      await storage.save('derived', `converted/${video.id}.mp4`, converted);
      await prisma.video.update({
        where: { id: video.id },
        data: { playbackKey: `converted/${video.id}.mp4`, playbackMime: 'video/mp4' },
      });

      const response = await admin.get(`/videos/${video.id}/stream`).expect(200);

      expect(Buffer.from(response.body).equals(converted)).toBe(true);
    });

    /**
     * Reclaiming a source after conversion must not break playback — the URL is
     * the same before and after, which is the point of `playbackKey`.
     */
    it('still plays when the source has been reclaimed', async () => {
      const converted = Buffer.from('converted-mp4-body');
      const video = await seedVideo('Inception');
      await storage.save('media', 'films/inception.mp4', converted);
      await prisma.video.update({
        where: { id: video.id },
        data: {
          playbackKey: 'films/inception.mp4',
          playbackMime: 'video/mp4',
          sourceDeletedAt: new Date(),
        },
      });
      await storage.delete('media', video.storageKey);

      await admin.get(`/videos/${video.id}/stream`).expect(200);
    });

    it('sends the playback mime type when there is one', async () => {
      const video = await seedVideo('Inception', { mimeType: 'video/x-matroska' });
      await storage.save('media', 'films/inception.mp4', Buffer.from('x'));
      await prisma.video.update({
        where: { id: video.id },
        data: { playbackKey: 'films/inception.mp4', playbackMime: 'video/mp4' },
      });

      const response = await admin.get(`/videos/${video.id}/stream`).expect(200);

      expect(response.headers['content-type']).toContain('video/mp4');
    });

    it('falls back to the source mime type otherwise', async () => {
      const video = await seedVideo('Inception', { mimeType: 'video/x-matroska' });

      const response = await admin.get(`/videos/${video.id}/stream`).expect(200);

      expect(response.headers['content-type']).toContain('video/x-matroska');
    });
  });

  describe('access control', () => {
    it('401s an anonymous caller — a stream URL is not a public URL', async () => {
      const video = await seedVideo('Inception');

      await http().get(`/videos/${video.id}/stream`).expect(401);
    });

    it('404s a USER on a draft, the same as every other read', async () => {
      const video = await seedVideo('Draft', { state: 'DRAFT', slug: 'draft' });
      const user = await asUser();

      await user.get(`/videos/${video.id}/stream`).expect(404);
    });

    it('lets a USER stream a published video', async () => {
      const video = await seedVideo('Inception');
      const user = await asUser();

      await user.get(`/videos/${video.id}/stream`).set('Range', 'bytes=0-99').expect(206);
    });

    it('410s a video whose file the library knows is missing', async () => {
      const video = await seedVideo('Gone', { state: 'MISSING', slug: 'gone' });

      await admin.get(`/videos/${video.id}/stream`).expect(410);
    });

    it('404s a video whose file vanished without the library noticing yet', async () => {
      const video = await seedVideo('Vanishing');
      await storage.delete('media', video.storageKey);

      await admin.get(`/videos/${video.id}/stream`).expect(404);
    });

    it('404s an id that does not exist', async () => {
      await admin.get('/videos/nope/stream').expect(404);
    });
  });

  describe('caching', () => {
    /**
     * Private media behind a session cookie. A shared cache holding a range
     * response as though it were the whole file also corrupts playback for the
     * next viewer.
     */
    it('tells every cache not to keep it', async () => {
      const video = await seedVideo('Inception');

      const response = await admin.get(`/videos/${video.id}/stream`).expect(200);

      expect(response.headers['cache-control']).toBe('private, no-store');
    });
  });
});
