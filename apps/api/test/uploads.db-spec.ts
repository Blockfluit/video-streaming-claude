import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { StorageService } from '../src/common/storage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { DbHarness, PASSWORD } from './db/harness';

const run = promisify(execFile);

/**
 * Browser uploads, against a real database and real files.
 *
 * An upload **places files**; the scan makes rows of them. So the property
 * worth testing hardest is parity: a file uploaded to a drive has to become
 * exactly what the same file copied onto that drive would become — a lone film
 * a standalone video, a folder of two a collection, a folder of seasons a
 * series. Anything else and there are two rules for what the library is, which
 * is the thing this design exists to avoid.
 *
 * The old race still matters and is still tested: a partial upload must never
 * be ingested, and a finished one must not be created twice.
 */
describe('Uploads (real database)', () => {
  const harness = new DbHarness({ name: 'upload', workspace: true, admin: 'ada' });

  const DRIVE = 'disk1';

  let mediaRoot: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let admin: request.Agent;
  let videoBytes: Buffer;


  const scan = () => admin.post('/admin/ingest/scan').expect(200);

  beforeAll(async () => {
    // One real, small video, reused by every test.
    const scratch = await mkdtemp(join(tmpdir(), 'upload-src-'));
    const path = join(scratch, 'source.mp4');
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=5:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      path,
    ]);
    videoBytes = await readFile(path);
    await rm(scratch, { recursive: true, force: true });
  }, 60000);

  beforeEach(async () => {
    await harness.start();
    ({ app, prisma, admin } = harness);
    storage = app.get(StorageService);
    mediaRoot = join(harness.workspace, 'media');
    // The drive an upload targets. In production this is a symlink to a disk;
    // here a plain directory, which the browse and placement code treat alike.
    await mkdir(join(mediaRoot, DRIVE), { recursive: true });




  });

  afterEach(() => harness.stop());

  /** Posts a multipart upload the way a browser would. */
  const upload = (
    filename: string,
    options: {
      drive?: string;
      relativePath?: string;
      body?: Buffer;
      contentType?: string;
    } = {},
  ) => {
    const post = admin.post('/videos/upload').field('drive', options.drive ?? DRIVE);
    if (options.relativePath !== undefined) post.field('paths', options.relativePath);
    return post.attach('file', options.body ?? videoBytes, {
      filename,
      contentType: options.contentType ?? 'video/mp4',
    });
  };

  /** A whole folder in one request, the way `webkitdirectory` sends one. */
  const uploadFolder = (paths: string[]) => {
    const post = admin.post('/videos/upload').field('drive', DRIVE);
    for (const path of paths) post.field('paths', path);
    for (const path of paths) {
      post.attach('file', videoBytes, {
        filename: path.slice(path.lastIndexOf('/') + 1),
        contentType: 'video/mp4',
      });
    }
    return post;
  };

  const videos = () =>
    prisma.video.findMany({ orderBy: { storageKey: 'asc' }, include: { collections: true } });

  /**
   * The requirement in one describe: uploading has to mean the same thing as
   * copying onto the disk.
   */
  describe('placement follows the same rules as the disk', () => {
    it('gives a single file a folder of its own, and makes it a standalone video', async () => {
      const response = await upload('My Film.mp4').expect(201);

      expect(response.body.placed).toEqual([
        expect.objectContaining({ storageKey: `${DRIVE}/My Film/My Film.mp4` }),
      ]);

      const [video] = await videos();
      expect(video).toMatchObject({ title: 'My Film', state: 'DRAFT', origin: 'UPLOAD' });
      // A folder holding one video is a standalone video: no collection.
      expect(video.collections).toEqual([]);
    });

    /**
     * The reason a single file gets a folder at all. A bare file in a drive root
     * is a triage issue, so an upload that dropped one there would create work
     * for an admin every time.
     */
    it('never leaves a file loose in the drive root', async () => {
      await upload('My Film.mp4').expect(201);

      const atRoot = await readdir(join(mediaRoot, DRIVE), { withFileTypes: true });
      expect(atRoot.filter((entry) => entry.isFile())).toEqual([]);

      const issues = await prisma.ingestIssue.findMany({ where: { resolvedAt: null } });
      expect(issues).toEqual([]);
    });

    it('makes a collection of a folder holding two films', async () => {
      await uploadFolder(['Avatar/Avatar.mp4', 'Avatar/Avatar The Way Of Water.mp4']).expect(201);

      const collection = await prisma.collection.findFirstOrThrow();
      expect(collection).toMatchObject({ title: 'Avatar', folderKey: `${DRIVE}/Avatar` });

      const all = await videos();
      expect(all).toHaveLength(2);
      expect(all.every((video) => video.collections[0]?.collectionId === collection.id)).toBe(true);
    });

    it('makes a series of a folder holding season folders', async () => {
      await uploadFolder([
        'Chernobyl/Season 01/01 - Episode One.mp4',
        'Chernobyl/Season 01/02 - Episode Two.mp4',
      ]).expect(201);

      const collection = await prisma.collection.findFirstOrThrow();
      expect(collection.title).toBe('Chernobyl');

      const season = await prisma.season.findFirstOrThrow();
      expect(season).toMatchObject({ number: 1, folderKey: `${DRIVE}/Chernobyl/Season 01` });

      const all = await videos();
      expect(all.map((video) => video.collections[0].orderIndex)).toEqual([1, 2]);
      expect(all.every((video) => video.collections[0].seasonId === season.id)).toBe(true);
    });

    it('records who uploaded it, which the scan alone could not know', async () => {
      await upload('My Film.mp4').expect(201);

      const uploader = await prisma.user.findFirstOrThrow();
      const [video] = await videos();
      expect(video).toMatchObject({ uploadedById: uploader.id, origin: 'UPLOAD' });
    });
  });

  describe('choosing a drive', () => {
    it('lists the drives available to upload to', async () => {
      const response = await admin.get('/videos/upload/drives').expect(200);

      expect(response.body.items).toEqual([{ name: DRIVE }]);
    });

    it('refuses a drive that does not exist', async () => {
      await upload('My Film.mp4', { drive: 'not-a-disk' }).expect(404);
    });

    it('refuses to escape the media root through the drive name', async () => {
      await upload('My Film.mp4', { drive: '../../etc' }).expect(400);
    });

    it('refuses a request with no drive at all', async () => {
      await admin
        .post('/videos/upload')
        .attach('file', videoBytes, { filename: 'My Film.mp4', contentType: 'video/mp4' })
        .expect(400);
    });
  });

  /**
   * multer strips slashes from a filename, so an uploaded folder's shape rides
   * in a parallel field. Every segment of it is client-supplied and none of it
   * can be trusted.
   */
  describe('the path is data, not a route into the filesystem', () => {
    it('does not let a traversal escape the drive', async () => {
      await upload('film.mp4', { relativePath: '../../escaped/film.mp4' }).expect(201);

      const [video] = await videos();
      expect(video.storageKey.startsWith(`${DRIVE}/`)).toBe(true);
      expect(video.storageKey).not.toContain('..');
    });

    it('does not let a Windows path escape either', async () => {
      await upload('C:\\Windows\\System32\\film.mp4').expect(201);

      const [video] = await videos();
      expect(video.storageKey.startsWith(`${DRIVE}/`)).toBe(true);
    });

    /**
     * A leading dot survives multer, and a dot-prefixed folder is one the
     * scanner skips at any depth — so an upload could otherwise write a file
     * that never becomes anything and never explains why.
     */
    it('does not create a hidden folder or file', async () => {
      await upload('.hidden.mp4', { relativePath: '.secret/.hidden.mp4' }).expect(201);

      const [video] = await videos();
      expect(video.storageKey.split('/').some((segment) => segment.startsWith('.'))).toBe(false);
    });

    it('keeps the browser filename as metadata', async () => {
      await upload('My Film.mp4').expect(201);

      const [video] = await videos();
      expect(video.originalName).toBe('My Film.mp4');
    });
  });

  /**
   * The type a browser attaches comes from the OS registry rather than the
   * file. Gating on it refused real MKVs, which is why the extension decides
   * alone.
   */
  describe('whatever the browser claims the type is', () => {
    for (const contentType of ['video/x-matroska', 'video/mkv', 'application/octet-stream', '']) {
      it(`accepts a .mkv sent as "${contentType || 'nothing'}"`, async () => {
        await upload('Film.mkv', { contentType }).expect(201);

        expect(await videos()).toHaveLength(1);
      });
    }

    it('still refuses a non-video extension dressed as a video', async () => {
      await upload('notes.txt', { contentType: 'video/mp4' }).expect(400);
    });
  });

  describe('what it refuses', () => {
    it('rejects a file that is not a video', async () => {
      await upload('notes.txt').expect(400);
    });

    it('rejects a request with no file', async () => {
      await admin.post('/videos/upload').field('drive', DRIVE).expect(400);
    });

    it('is admin-only', async () => {
      const invite = await admin.post('/admin/invites').send({}).expect(201);
      const viewer = request.agent(app.getHttpServer());
      await viewer
        .post('/auth/redeem')
        .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
        .expect(201);

      await viewer
        .post('/videos/upload')
        .field('drive', DRIVE)
        .attach('file', videoBytes, { filename: 'Film.mp4', contentType: 'video/mp4' })
        .expect(403);
    });
  });

  describe('living alongside the watcher', () => {
    it('is not duplicated by the scan that follows', async () => {
      await upload('My Film.mp4').expect(201);

      await scan();

      expect(await videos()).toHaveLength(1);
    });

    it('keeps the row id across that scan, so nothing pointing at it breaks', async () => {
      await upload('My Film.mp4').expect(201);
      const [before] = await videos();

      await scan();

      const [after] = await videos();
      expect(after.id).toBe(before.id);
    });

    it('ignores a half-finished upload left in staging', async () => {
      await mkdir(join(mediaRoot, '.uploads'), { recursive: true });
      await writeFile(join(mediaRoot, '.uploads', 'abandoned.part'), videoBytes);

      await scan();

      expect(await videos()).toEqual([]);
    });

    it('leaves nothing behind in staging after a successful upload', async () => {
      await upload('My Film.mp4').expect(201);

      await expect(readdir(join(mediaRoot, '.uploads'))).resolves.toEqual([]);
    });

    it('leaves nothing behind in staging after a rejected upload', async () => {
      await upload('My Film.mp4', { drive: 'not-a-disk' }).expect(404);

      await expect(readdir(join(mediaRoot, '.uploads'))).resolves.toEqual([]);
    });
  });

  describe('name collisions', () => {
    it('does not overwrite an existing upload', async () => {
      await upload('My Film.mp4').expect(201);
      await upload('My Film.mp4').expect(201);

      const all = await videos();
      expect(all).toHaveLength(2);
      expect(new Set(all.map((video) => video.storageKey)).size).toBe(2);
    });

    /**
     * Checked against the filesystem as well as the database: a file can be on
     * disk seconds before anything has scanned it, and overwriting it would
     * destroy something nobody asked to replace.
     */
    it('does not overwrite a file that has no row yet', async () => {
      await mkdir(join(mediaRoot, DRIVE, 'My Film'), { recursive: true });
      await writeFile(join(mediaRoot, DRIVE, 'My Film', 'My Film.mp4'), 'older bytes');

      await upload('My Film.mp4').expect(201);

      const existing = await readFile(join(mediaRoot, DRIVE, 'My Film', 'My Film.mp4'), 'utf8');
      expect(existing).toBe('older bytes');
    });

    /**
     * Folders merge where files do not. Uploading `Avatar/` onto a drive that
     * already has one is how a second season arrives, so the folder is joined
     * rather than renamed out of the way.
     */
    it('adds to a folder that already exists', async () => {
      await uploadFolder(['Avatar/Avatar.mp4']).expect(201);
      await uploadFolder(['Avatar/Avatar The Way Of Water.mp4']).expect(201);

      const all = await videos();
      expect(all).toHaveLength(2);
      expect(all.every((video) => video.storageKey.startsWith(`${DRIVE}/Avatar/`))).toBe(true);
    });
  });

  describe('large files', () => {
    it('accepts a file far larger than a comfortable buffer', async () => {
      const padded = Buffer.concat([videoBytes, Buffer.alloc(24 * 1024 * 1024, 0)]);

      await upload('Large.mp4', { body: padded }).expect(201);

      const stats = await storage.statOf('media', `${DRIVE}/Large/Large.mp4`);
      expect(stats?.size).toBe(padded.length);
    });
  });
});
