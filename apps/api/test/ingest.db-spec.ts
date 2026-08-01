import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SessionStoreService } from '../src/auth/session-store.service';
import { bigIntReplacer } from '../src/common/json';
import { ReconcileService } from '../src/ingest/reconcile.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Reconcile against a real temp directory and a real Postgres — the plan asks
 * specifically for move, delete, restore and the `sourceDeletedAt` exemption,
 * because those are the behaviours most likely to regress silently.
 *
 * The watcher is disabled throughout: these tests drive reconcile directly, and
 * a background watcher reconciling the same tree would race them.
 */
describe('Ingest (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-ingest-test.bootstrap-token');

  let workspace: string;
  let mediaRoot: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let reconcile: ReconcileService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;

  /** Writes a file into the media tree, creating its folders. */
  async function put(relPath: string, body = 'video-bytes'): Promise<void> {
    const absolute = join(mediaRoot, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body);
  }

  async function move(from: string, to: string): Promise<void> {
    const target = join(mediaRoot, to);
    await mkdir(dirname(target), { recursive: true });
    await rename(join(mediaRoot, from), target);
  }

  const remove = (relPath: string): Promise<void> =>
    rm(join(mediaRoot, relPath), { force: true });

  async function startApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('json replacer', bigIntReplacer);
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
    prisma = app.get(PrismaService);
    reconcile = app.get(ReconcileService);
  }

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'ingest-'));
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
      'TRUNCATE "InviteToken", "User", "session", "Collection", "Season", "Video", "CollectionVideo", "IngestIssue" RESTART IDENTITY CASCADE',
    );
    await app.close();
    await rm(tokenFile, { force: true });

    await startApp();

    admin = request.agent(app.getHttpServer());
    const { readFile } = await import('node:fs/promises');
    await admin
      .post('/auth/redeem')
      .send({ token: (await readFile(tokenFile, 'utf8')).trim(), username: 'ada', password: PASSWORD })
      .expect(201);
  });

  afterEach(async () => {
    banner.mockRestore();
    await app?.close();
    await rm(tokenFile, { force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  const videos = () =>
    prisma.video.findMany({ orderBy: { storageKey: 'asc' }, include: { collections: true } });

  const openIssues = () =>
    prisma.ingestIssue.findMany({ where: { resolvedAt: null }, orderBy: { path: 'asc' } });

  describe('the plan checkpoint — drop a South Park folder', () => {
    beforeEach(async () => {
      await put('disk1/South Park/Season 01/01 - Cartman Gets an Anal Probe.mp4');
      await put('disk1/South Park/Season 01/02 - Weight Gain 4000.mp4');
      await put('disk1/South Park/Season 02/01 - Terrance and Phillip.mp4');
      await reconcile.run();
    });

    it('creates the collection from the folder name', async () => {
      const collection = await prisma.collection.findFirstOrThrow();

      expect(collection).toMatchObject({
        title: 'South Park',
        slug: 'south-park',
        folderKey: 'disk1/South Park',
        state: 'DRAFT',
        origin: 'INGEST',
      });
    });

    it('creates a season per folder, numbered', async () => {
      const seasons = await prisma.season.findMany({ orderBy: { number: 'asc' } });

      expect(seasons.map((season) => [season.number, season.slug])).toEqual([
        [1, 'season-1'],
        [2, 'season-2'],
      ]);
    });

    it('creates every episode as a draft, with its order and title', async () => {
      const all = await prisma.video.findMany({
        orderBy: { storageKey: 'asc' },
        // Running order belongs to the membership now: it says where the video
        // sits in *this* collection, and it may sit in others.
        include: { collections: true },
      });

      expect(all).toHaveLength(3);
      expect(all.map((video) => [video.collections[0].orderIndex, video.title])).toEqual([
        [1, 'Cartman Gets an Anal Probe'],
        [2, 'Weight Gain 4000'],
        [1, 'Terrance and Phillip'],
      ]);
      expect(all.every((video) => video.state === 'DRAFT')).toBe(true);
    });

    it('files each episode under the right season', async () => {
      const seasonOne = await prisma.season.findFirstOrThrow({ where: { number: 1 } });
      const episodes = await prisma.video.findMany({
        where: { collections: { some: { seasonId: seasonOne.id } } },
      });

      expect(episodes).toHaveLength(2);
    });
  });

  describe('idempotency', () => {
    // The property that stops an upload writing into the watched tree from
    // creating a second row for a file that is already known.
    it('changes nothing when run twice over the same tree', async () => {
      await put('disk1/Inception/Inception.mp4');

      const first = await reconcile.run();
      const before = await videos();
      const second = await reconcile.run();
      const after = await videos();

      expect(first.created).toBe(1);
      expect(second.created).toBe(0);
      expect(after).toEqual(before);
    });

    it('keeps the row id across scans, so nothing pointing at it breaks', async () => {
      await put('disk1/Inception/Inception.mp4');
      await reconcile.run();
      const [before] = await videos();

      await reconcile.run();
      const [after] = await videos();

      expect(after.id).toBe(before.id);
    });
  });

  describe('a file that moves', () => {
    /**
     * The reason `contentTag` exists. A move must keep the row — and with it
     * every comment, progress row and watchlist entry — rather than deleting
     * one video and creating another.
     */
    it('follows the file and keeps the same row', async () => {
      await put('disk1/Inception/Inception.mp4', 'the-same-bytes');
      await reconcile.run();
      const [before] = await videos();

      await move('disk1/Inception/Inception.mp4', 'disk1/Christopher Nolan/Inception.mp4');
      const summary = await reconcile.run();

      const all = await videos();
      expect(summary).toMatchObject({ moved: 1, created: 0, markedMissing: 0 });
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(before.id);
      expect(all[0].storageKey).toBe('disk1/Christopher Nolan/Inception.mp4');
    });

    /**
     * The folder layout is a suggestion, and it is only ever taken once.
     *
     * These two used to assert the opposite — that a move re-derived the
     * collection, season and order from the new path. That is the behaviour
     * this change deliberately reverses: an admin who has arranged the library
     * must not have it rearranged by someone tidying up a disk, and reconcile
     * cannot tell those two apart.
     */
    it('does not re-parent a video that moved between folders', async () => {
      await put('disk1/Show/Season 01/01 - Pilot.mp4', 'the-same-bytes');
      await reconcile.run();
      const [before] = await videos();
      const membershipBefore = before.collections[0];

      await move('disk1/Show/Season 01/01 - Pilot.mp4', 'disk1/Show/Season 02/05 - Pilot.mp4');
      await reconcile.run();

      const [after] = await videos();
      expect(after.collections).toHaveLength(1);
      expect(after.collections[0]).toMatchObject({
        collectionId: membershipBefore.collectionId,
        seasonId: membershipBefore.seasonId,
        orderIndex: membershipBefore.orderIndex,
      });
    });

    it('does not put a moved video into a collection it was never in', async () => {
      await put('disk1/Inception/Inception.mp4', 'the-same-bytes');
      await reconcile.run();

      // A lone film in a folder is a standalone video, so it starts in nothing.
      expect((await videos())[0].collections).toEqual([]);

      await move('disk1/Inception/Inception.mp4', 'disk1/Christopher Nolan/Inception.mp4');
      await reconcile.run();

      expect((await videos())[0].collections).toEqual([]);
    });

    // Same name, different bytes: two files, not a move.
    it('does not mistake a different file with the same name for a move', async () => {
      await put('disk1/A/film.mp4', 'first-bytes');
      await reconcile.run();

      await remove('disk1/A/film.mp4');
      await put('disk1/B/film.mp4', 'completely-different-bytes');
      const summary = await reconcile.run();

      expect(summary).toMatchObject({ moved: 0, created: 1, markedMissing: 1 });
    });
  });

  describe('a file that goes away', () => {
    it('marks the row MISSING rather than deleting it', async () => {
      await put('disk1/Inception/Inception.mp4');
      await reconcile.run();
      const [before] = await videos();

      await remove('disk1/Inception/Inception.mp4');
      const summary = await reconcile.run();

      const all = await videos();
      expect(summary.markedMissing).toBe(1);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: before.id, state: 'MISSING' });
      expect(all[0].missingSince).not.toBeNull();
    });

    /**
     * A file that comes back gets its old state back. Without this, a disk
     * unplugged for an afternoon would silently demote every published video
     * in the library to draft.
     */
    it('restores the state it had when the file comes back', async () => {
      await put('disk1/Inception/Inception.mp4');
      await reconcile.run();
      const [video] = await videos();
      await prisma.video.update({
        where: { id: video.id },
        data: { state: 'PUBLISHED', description: 'd', durationSec: 10, thumbnailKey: 't.jpg' },
      });

      await remove('disk1/Inception/Inception.mp4');
      await reconcile.run();
      await expect(prisma.video.findUniqueOrThrow({ where: { id: video.id } })).resolves.toMatchObject(
        { state: 'MISSING', stateBeforeMissing: 'PUBLISHED' },
      );

      await put('disk1/Inception/Inception.mp4');
      const summary = await reconcile.run();

      expect(summary.restored).toBe(1);
      await expect(prisma.video.findUniqueOrThrow({ where: { id: video.id } })).resolves.toMatchObject(
        { state: 'PUBLISHED', stateBeforeMissing: null, missingSince: null },
      );
    });

    it('does not keep re-marking something already missing', async () => {
      await put('disk1/Inception/Inception.mp4');
      await reconcile.run();
      await remove('disk1/Inception/Inception.mp4');
      await reconcile.run();

      const summary = await reconcile.run();

      expect(summary.markedMissing).toBe(0);
    });

    /**
     * The exemption the plan calls out. A video whose source was reclaimed
     * after conversion has no file under `media` by design — without this,
     * freeing disk space would mark half the library MISSING.
     */
    it('exempts a source that was reclaimed after conversion', async () => {
      await put('disk1/Inception/Inception.mp4');
      await reconcile.run();
      const [video] = await videos();
      await prisma.video.update({
        where: { id: video.id },
        data: {
          state: 'PUBLISHED',
          playbackKey: 'converted/inception.mp4',
          sourceDeletedAt: new Date(),
        },
      });

      await remove('disk1/Inception/Inception.mp4');
      const summary = await reconcile.run();

      expect(summary.markedMissing).toBe(0);
      await expect(prisma.video.findUniqueOrThrow({ where: { id: video.id } })).resolves.toMatchObject(
        { state: 'PUBLISHED' },
      );
    });

    // Half an exemption is no exemption: without a playbackKey there is nothing
    // to play, so the video really is missing.
    it('does not exempt a reclaimed source with no converted file', async () => {
      await put('disk1/Inception/Inception.mp4');
      await reconcile.run();
      const [video] = await videos();
      await prisma.video.update({
        where: { id: video.id },
        data: { sourceDeletedAt: new Date(), playbackKey: null },
      });

      await remove('disk1/Inception/Inception.mp4');
      const summary = await reconcile.run();

      expect(summary.markedMissing).toBe(1);
    });
  });

  describe('issues', () => {
    it('records a video sitting at the root instead of ingesting it', async () => {
      await put('loose.mp4');

      await reconcile.run();

      expect(await videos()).toHaveLength(0);
      expect(await openIssues()).toEqual([
        expect.objectContaining({ kind: 'ROOT_LEVEL_FILE', path: 'loose.mp4' }),
      ]);
    });

    it('records something buried too deep', async () => {
      await put('disk1/A/B/C/D/film.mp4');

      await reconcile.run();

      expect(await openIssues()).toEqual([
        expect.objectContaining({ kind: 'PATH_TOO_DEEP' }),
      ]);
    });

    // Still ingested — the episode is watchable, the season label just needs a
    // human. Refusing it would be worse.
    it('flags a season folder it could not read, without refusing the video', async () => {
      await put('disk1/Show/Specials/01 - Behind the Scenes.mp4');

      await reconcile.run();

      expect(await videos()).toHaveLength(1);
      expect(await openIssues()).toEqual([
        expect.objectContaining({ kind: 'UNREADABLE_SEASON', path: 'disk1/Show/Specials' }),
      ]);
    });

    it('does not pile up duplicates of the same complaint across scans', async () => {
      await put('loose.mp4');

      await reconcile.run();
      await reconcile.run();
      await reconcile.run();

      expect(await prisma.ingestIssue.count()).toBe(1);
    });

    it('resolves an issue once the problem is gone, rather than deleting it', async () => {
      await put('loose.mp4');
      await reconcile.run();

      await remove('loose.mp4');
      await reconcile.run();

      expect(await openIssues()).toHaveLength(0);
      // The record survives — what the library was once unhappy about is worth keeping.
      const all = await prisma.ingestIssue.findMany();
      expect(all).toHaveLength(1);
      expect(all[0].resolvedAt).not.toBeNull();
    });

    it('reopens an issue that comes back', async () => {
      await put('loose.mp4');
      await reconcile.run();
      await remove('loose.mp4');
      await reconcile.run();

      await put('loose.mp4');
      await reconcile.run();

      expect(await openIssues()).toHaveLength(1);
    });
  });

  describe('what it skips', () => {
    it('ignores dotfiles, partial downloads and unknown extensions', async () => {
      await put('disk1/Show/.DS_Store');
      await put('disk1/Show/film.mp4.part');
      await put('disk1/Show/notes.txt');
      await put('disk1/Show/poster.jpg');

      const summary = await reconcile.run();

      expect(await videos()).toHaveLength(0);
      expect(summary.issues).toBe(0);
    });

    it('does not descend into hidden directories', async () => {
      await put('disk1/.hidden/Show/film.mp4');

      await reconcile.run();

      expect(await videos()).toHaveLength(0);
    });
  });

  describe('the admin endpoints', () => {
    it('runs a scan on demand and reports what it did', async () => {
      await put('disk1/Inception/Inception.mp4');

      const response = await admin.post('/admin/ingest/scan').expect(200);

      expect(response.body).toMatchObject({ created: 1, scannedFiles: 1 });
    });

    it('reports status a dashboard can render', async () => {
      await put('disk1/Inception/Inception.mp4');
      await put('loose.mp4');
      await admin.post('/admin/ingest/scan').expect(200);

      const response = await admin.get('/admin/ingest/status').expect(200);

      expect(response.body).toMatchObject({
        scanning: false,
        watching: false,
        drafts: 1,
        missing: 0,
        openIssues: 1,
      });
      expect(response.body.lastScan).not.toBeNull();
    });

    it('pages the issue list and hides resolved ones by default', async () => {
      await put('loose.mp4');
      await put('also-loose.mp4');
      await admin.post('/admin/ingest/scan').expect(200);
      await remove('loose.mp4');
      await admin.post('/admin/ingest/scan').expect(200);

      const open = await admin.get('/admin/ingest/issues').expect(200);
      expect(open.body).toMatchObject({ total: 1 });

      const all = await admin.get('/admin/ingest/issues?includeResolved=true').expect(200);
      expect(all.body.total).toBe(2);
    });

    it('is admin-only', async () => {
      const invite = await admin.post('/admin/invites').send({}).expect(201);
      const user = request.agent(app.getHttpServer());
      await user
        .post('/auth/redeem')
        .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
        .expect(201);

      await user.post('/admin/ingest/scan').expect(403);
      await user.get('/admin/ingest/status').expect(403);
      await user.get('/admin/ingest/issues').expect(403);
    });
  });
});
