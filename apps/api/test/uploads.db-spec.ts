import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SessionStoreService } from '../src/auth/session-store.service';
import { bigIntReplacer } from '../src/common/json';
import { StorageService } from '../src/common/storage.service';
import { MediaService } from '../src/media/media.service';
import { PrismaService } from '../src/prisma/prisma.service';

const run = promisify(execFile);

/**
 * Browser uploads, against a real database and real files.
 *
 * The property worth testing hardest is that an upload writes into the same
 * tree the watcher scans **without** racing it: a partial upload must never be
 * ingested, and a finished one must not be created twice.
 */
describe('Uploads (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-upload-test.bootstrap-token');

  let workspace: string;
  let mediaRoot: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let media: MediaService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;
  let collectionId: string;
  let videoBytes: Buffer;

  async function startApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('json replacer', bigIntReplacer);
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
    media = app.get(MediaService);
  }

  const scan = () => admin.post('/admin/ingest/scan').expect(200);

  beforeAll(async () => {
    // One real, small video, reused by every test.
    const scratch = await mkdtemp(join(tmpdir(), 'upload-src-'));
    const path = join(scratch, 'source.mp4');
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '1', path,
    ]);
    videoBytes = await readFile(path);
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'uploads-'));
    mediaRoot = join(workspace, 'media');
    await mkdir(mediaRoot, { recursive: true });

    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = tokenFile;
    process.env.MEDIA_ROOT = mediaRoot;
    process.env.DERIVED_ROOT = join(workspace, 'derived');
    process.env.INGEST_WATCHER_ENABLED = 'false';
    await rm(tokenFile, { force: true });

    await startApp();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "InviteToken", "User", "session", "Collection", "Season", "Video", "IngestIssue", "Subtitle", "MediaJob" RESTART IDENTITY CASCADE',
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

  /** Posts a multipart upload the way a browser would. */
  const upload = (
    filename: string,
    fields: Record<string, string> = {},
    body: Buffer = videoBytes,
    contentType = 'video/mp4',
  ) => {
    const post = admin.post('/videos/upload').field('collectionId', collectionId);
    for (const [key, value] of Object.entries(fields)) post.field(key, value);
    return post.attach('file', body, { filename, contentType });
  };

  describe('a successful upload', () => {
    it('lands in the collection folder and creates a draft', async () => {
      const response = await upload('My Film.mp4').expect(201);

      expect(response.body).toMatchObject({
        title: 'My Film',
        storageKey: 'films/My Film.mp4',
        state: 'DRAFT',
        origin: 'UPLOAD',
      });
      await expect(storage.exists('media', 'films/My Film.mp4')).resolves.toBe(true);
    });

    it('records who uploaded it', async () => {
      const response = await upload('My Film.mp4').expect(201);

      const uploader = await prisma.user.findFirstOrThrow();
      expect(response.body.uploadedById).toBe(uploader.id);
    });

    it('gets probed like any other video', async () => {
      const response = await upload('My Film.mp4').expect(201);
      await media.drain();

      await expect(
        prisma.video.findUniqueOrThrow({ where: { id: response.body.id } }),
      ).resolves.toMatchObject({ width: 320, height: 240, videoCodec: 'h264' });
    });

    it('reads an order prefix out of the filename, as ingest does', async () => {
      const response = await upload('03 - Third Episode.mp4').expect(201);

      expect(response.body).toMatchObject({ orderIndex: 3, title: 'Third Episode' });
    });

    it('takes an explicit title over the filename', async () => {
      const response = await upload('whatever.mp4', { title: 'Proper Title' }).expect(201);

      expect(response.body.title).toBe('Proper Title');
    });

    it('places it in a season when asked', async () => {
      const season = await admin
        .post('/seasons')
        .send({ collectionId, number: 1 })
        .expect(201);

      const response = await upload('Episode.mp4', { seasonId: season.body.id }).expect(201);

      expect(response.body.seasonId).toBe(season.body.id);
      expect(response.body.storageKey).toBe(`${season.body.folderKey}/Episode.mp4`);
    });

    it('refuses a season belonging to another collection', async () => {
      const other = await admin.post('/collections').send({ title: 'Other' }).expect(201);
      const season = await admin
        .post('/seasons')
        .send({ collectionId: other.body.id, number: 1 })
        .expect(201);

      await upload('Episode.mp4', { seasonId: season.body.id }).expect(400);
    });
  });

  describe('the filename is metadata, not a path', () => {
    it('does not let a traversal escape the collection folder', async () => {
      const response = await upload('../../../etc/passwd.mp4').expect(201);

      expect(response.body.storageKey).toBe('films/passwd.mp4');
      await expect(storage.exists('media', 'films/passwd.mp4')).resolves.toBe(true);
    });

    it('does not let a Windows path escape either', async () => {
      const response = await upload('C:\\Windows\\System32\\film.mp4').expect(201);

      expect(response.body.storageKey).toBe('films/film.mp4');
    });

    // A leading dot would hide the file from the scanner — an upload that
    // silently never appears in the library.
    it('does not create a hidden file', async () => {
      const response = await upload('.hidden.mp4').expect(201);

      expect(response.body.storageKey).toBe('films/hidden.mp4');
    });

    /**
     * Checked against multer 2.2 rather than assumed. It strips **both** slash
     * and backslash paths from `originalname` before we see it, so the two
     * traversal tests above pass with our own stripping removed — they are
     * belt-and-braces.
     *
     * What multer does **not** strip is a leading dot: `.hidden.mp4` arrives
     * intact, and without our sanitising it would become a file the ingest
     * scanner skips — an upload that silently never appears in the library.
     * The hidden-file test above is the one carrying real weight here, and it
     * fails if the dot-stripping is removed.
     */
    it('keeps whatever name survives as metadata, and never as a path', async () => {
      const response = await upload('../../etc/passwd.mp4').expect(201);

      expect(response.body.originalName).toBe('passwd.mp4');
      expect(response.body.storageKey).toBe('films/passwd.mp4');
    });
  });

  describe('what it refuses', () => {
    it('rejects a file that is not a video', async () => {
      await upload('notes.txt', {}, Buffer.from('hello'), 'text/plain').expect(400);
      await upload('script.sh', {}, Buffer.from('#!/bin/sh'), 'application/x-sh').expect(400);
    });

    it('rejects an unknown collection', async () => {
      await admin
        .post('/videos/upload')
        .field('collectionId', 'nope')
        .attach('file', videoBytes, { filename: 'a.mp4', contentType: 'video/mp4' })
        .expect(404);
    });

    it('rejects a request with no file', async () => {
      await admin.post('/videos/upload').field('collectionId', collectionId).expect(400);
    });

    it('is admin-only', async () => {
      const invite = await admin.post('/admin/invites').send({}).expect(201);
      const user = request.agent(app.getHttpServer());
      await user
        .post('/auth/redeem')
        .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
        .expect(201);

      await user
        .post('/videos/upload')
        .field('collectionId', collectionId)
        .attach('file', videoBytes, { filename: 'a.mp4', contentType: 'video/mp4' })
        .expect(403);
    });
  });

  describe('living alongside the watcher', () => {
    /**
     * The property the plan calls out: reconcile is keyed on `storageKey`, and
     * an upload writes the row using the same key the scanner would derive — so
     * the scan that follows recognises the file instead of creating it again.
     */
    it('is not duplicated by the scan that follows', async () => {
      await upload('My Film.mp4').expect(201);

      await scan();
      await scan();

      await expect(prisma.video.count()).resolves.toBe(1);
    });

    it('keeps the row id across that scan, so nothing pointing at it breaks', async () => {
      const response = await upload('My Film.mp4').expect(201);

      await scan();

      const [video] = await prisma.video.findMany();
      expect(video.id).toBe(response.body.id);
      expect(video.origin).toBe('UPLOAD');
    });

    /**
     * Uploads stage inside a dot-directory that both the scanner and the
     * watcher skip, so a partial or abandoned transfer is never a candidate for
     * ingestion — and never becomes a truncated video in the library.
     */
    it('ignores a half-finished upload left in staging', async () => {
      await mkdir(join(mediaRoot, '.uploads'), { recursive: true });
      await writeFile(join(mediaRoot, '.uploads', 'abandoned.part'), videoBytes);

      const summary = await scan();

      expect(summary.body).toMatchObject({ created: 0, issues: 0 });
      await expect(prisma.video.count()).resolves.toBe(0);
    });

    it('leaves nothing behind in staging after a successful upload', async () => {
      await upload('My Film.mp4').expect(201);

      const staged = await readdir(join(mediaRoot, '.uploads'));
      expect(staged).toEqual([]);
    });

    it('leaves nothing behind in staging after a rejected upload', async () => {
      const other = await admin.post('/collections').send({ title: 'Other' }).expect(201);
      const season = await admin
        .post('/seasons')
        .send({ collectionId: other.body.id, number: 1 })
        .expect(201);

      await upload('Episode.mp4', { seasonId: season.body.id }).expect(400);

      const staged = await readdir(join(mediaRoot, '.uploads'));
      expect(staged).toEqual([]);
    });
  });

  describe('name collisions', () => {
    it('does not overwrite an existing upload', async () => {
      const first = await upload('My Film.mp4').expect(201);
      const second = await upload('My Film.mp4').expect(201);

      expect(second.body.storageKey).toBe('films/My Film-2.mp4');
      expect(first.body.storageKey).toBe('films/My Film.mp4');
      await expect(prisma.video.count()).resolves.toBe(2);
    });

    /**
     * A file can be on disk without a row — dropped in seconds ago and not yet
     * scanned. Overwriting it would destroy something nobody asked to replace.
     */
    it('does not overwrite a file that has no row yet', async () => {
      await storage.save('media', 'films/My Film.mp4', Buffer.from('already here'));

      const response = await upload('My Film.mp4').expect(201);

      expect(response.body.storageKey).toBe('films/My Film-2.mp4');
      await expect(
        readFile(storage.resolvePath('media', 'films/My Film.mp4'), 'utf8'),
      ).resolves.toBe('already here');
    });
  });

  describe('large files', () => {
    // Streamed to disk rather than buffered: a 2 GB file held in the heap would
    // take the process with it. 24 MB is enough to prove it is not in memory
    // without slowing the suite down.
    it('accepts a file far larger than a comfortable buffer', async () => {
      const padded = Buffer.concat([videoBytes, Buffer.alloc(24 * 1024 * 1024, 0)]);

      const response = await upload('Large.mp4', {}, padded).expect(201);

      expect(Number(response.body.sizeBytes)).toBe(padded.length);
      const stats = await storage.statOf('media', 'films/Large.mp4');
      expect(stats?.size).toBe(padded.length);
    }, 60_000);
  });
});
