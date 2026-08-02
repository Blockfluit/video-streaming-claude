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
 * Collections, seasons, videos and slug resolution against a real Postgres.
 *
 * The things worth testing here are the ones a stub cannot have an opinion
 * about: uniqueness scoping (two collections may both contain a `pilot`),
 * resolution precedence, and whether the visibility filter actually reaches the
 * nested rows.
 */
describe('Library (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-library-test.bootstrap-token');

  let workspace: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;

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

  /** A video row, which only ingest or upload would normally create. */
  async function seedVideo(
    collectionId: string,
    title: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; slug: string }> {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return prisma.video.create({
      data: {
        collectionId,
        slug,
        title,
        storageKey: `${collectionId}/${title}-${Math.round(performance.now() * 1000)}.mp4`,
        contentTag: 'tag',
        originalName: `${title}.mp4`,
        mimeType: 'video/mp4',
        sizeBytes: BigInt('9007199254740993'),
        fileMtime: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
      },
      select: { id: true, slug: true },
    });
  }

  /** A video with everything publish gating asks for. */
  const publishable = {
    description: 'A description.',
    durationSec: 120,
    thumbnailKey: 'thumbs/a.jpg',
  };

  async function createCollection(title: string, extra: Record<string, unknown> = {}) {
    const response = await admin.post('/collections').send({ title, ...extra }).expect(201);
    return response.body;
  }

  /** Publishing a collection needs a description and a poster first. */
  async function publishCollection(id: string): Promise<void> {
    await admin
      .patch(`/collections/${id}`)
      .send({ description: 'A description.', posterKey: 'posters/a.jpg' })
      .expect(200);
    await admin.post(`/collections/${id}/publish`).expect(200);
  }

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'library-'));
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
  });

  afterEach(async () => {
    banner.mockRestore();
    await app?.close();
    await rm(tokenFile, { force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  /** A signed-in USER, for the visibility checks. */
  async function asUser(): Promise<request.Agent> {
    const invite = await admin.post('/admin/invites').send({}).expect(201);
    const user = request.agent(app.getHttpServer());
    await user
      .post('/auth/redeem')
      .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
      .expect(201);
    return user;
  }

  describe('POST /collections', () => {
    it('slugifies the title and creates the folder on disk', async () => {
      const collection = await createCollection('Harry Potter');

      expect(collection).toMatchObject({ slug: 'harry-potter', folderKey: 'harry-potter' });
      await expect(storage.exists('media', 'harry-potter')).resolves.toBe(true);
    });

    it('deduplicates a slug that is already taken', async () => {
      await createCollection('Harry Potter');
      const second = await admin
        .post('/collections')
        .send({ title: 'Harry Potter', folderKey: 'harry-potter-2' })
        .expect(201);

      expect(second.body.slug).toBe('harry-potter-2');
    });

    it('refuses two collections pointing at the same folder', async () => {
      await createCollection('Harry Potter');

      await admin
        .post('/collections')
        .send({ title: 'Something Else', folderKey: 'harry-potter' })
        .expect(400);
    });

    it('403s a USER', async () => {
      const user = await asUser();

      await user.post('/collections').send({ title: 'Nope' }).expect(403);
    });
  });

  describe('PATCH /collections/:id', () => {
    it('does not move the slug when the title changes', async () => {
      const collection = await createCollection('Harry Potter');

      const updated = await admin
        .patch(`/collections/${collection.id}`)
        .send({ title: 'Harry Potter Collection' })
        .expect(200);

      // A shared link must keep working after a rename.
      expect(updated.body).toMatchObject({ title: 'Harry Potter Collection', slug: 'harry-potter' });
    });

    it('moves it when regeneration is asked for explicitly', async () => {
      const collection = await createCollection('Harry Potter');

      const updated = await admin
        .patch(`/collections/${collection.id}`)
        .send({ title: 'The Wizarding World', regenerateSlug: true })
        .expect(200);

      expect(updated.body.slug).toBe('the-wizarding-world');
    });
  });

  describe('slug scoping', () => {
    // The plan's manual check: two collections may both contain a `pilot`.
    it('lets two collections each hold a video with the same slug', async () => {
      const south = await createCollection('South Park');
      const simpsons = await createCollection('The Simpsons');

      await seedVideo(south.id, 'Pilot');
      await seedVideo(simpsons.id, 'Pilot');

      const bySlug = await prisma.video.findMany({ where: { slug: 'pilot' } });
      expect(bySlug).toHaveLength(2);
    });

    it('refuses the same slug twice inside one collection', async () => {
      const south = await createCollection('South Park');
      await seedVideo(south.id, 'Pilot');

      await expect(seedVideo(south.id, 'Pilot')).rejects.toThrow();
    });

    it('deduplicates when regenerating a video slug into a taken one', async () => {
      const south = await createCollection('South Park');
      await seedVideo(south.id, 'Pilot');
      const second = await seedVideo(south.id, 'Another');

      const updated = await admin
        .patch(`/videos/${second.id}`)
        .send({ title: 'Pilot', regenerateSlug: true })
        .expect(200);

      expect(updated.body.slug).toBe('pilot-2');
    });
  });

  describe('seasons', () => {
    it('numbers the slug rather than copying the folder name', async () => {
      const south = await createCollection('South Park');

      const season = await admin
        .post('/seasons')
        .send({ collectionId: south.id, number: 1, title: 'Season 01' })
        .expect(201);

      // /season-01 and /season-1 must not become two different pages.
      expect(season.body.slug).toBe('season-1');
    });

    // Postgres treats NULLs as distinct, so the composite unique cannot do this.
    it('refuses a duplicate season number in one collection', async () => {
      const south = await createCollection('South Park');
      await admin.post('/seasons').send({ collectionId: south.id, number: 1 }).expect(201);

      await admin.post('/seasons').send({ collectionId: south.id, number: 1 }).expect(400);
    });

    it('allows several unnumbered seasons, which is what NULL is for', async () => {
      const south = await createCollection('South Park');

      await admin.post('/seasons').send({ collectionId: south.id, title: 'Specials' }).expect(201);
      await admin.post('/seasons').send({ collectionId: south.id, title: 'Extras' }).expect(201);
    });

    it('leaves the videos behind when the season goes', async () => {
      const south = await createCollection('South Park');
      const season = await admin
        .post('/seasons')
        .send({ collectionId: south.id, number: 1 })
        .expect(201);
      const video = await seedVideo(south.id, 'Pilot', { seasonId: season.body.id });

      await admin.delete(`/seasons/${season.body.id}`).expect(204);

      const survivor = await prisma.video.findUnique({ where: { id: video.id } });
      expect(survivor).toMatchObject({ seasonId: null, collectionId: south.id });
    });
  });

  describe('the folder a season leaves behind', () => {
    /**
     * A season's folder is what reconcile rebuilds its row from, so leaving an
     * empty one behind meant deleting a season did not stick: the next scan
     * found the directory and created the season again. The screen and the disk
     * disagreed, and the disk won a few minutes later.
     */
    it('removes the folder when nothing is in it', async () => {
      const show = await createCollection('A Show');
      const season = await admin
        .post('/seasons')
        .send({ collectionId: show.id, number: 1 })
        .expect(201);

      expect(await storage.exists('media', season.body.folderKey)).toBe(true);

      await admin.delete(`/seasons/${season.body.id}`).expect(204);

      expect(await storage.exists('media', season.body.folderKey)).toBe(false);
    });

    /**
     * The other half, and the one that matters more: an empty directory holds
     * nothing anyone can lose, but a directory with films in it must survive a
     * delete that did not ask for `deleteFiles`. Nobody loses a film by
     * pressing the same button that tidies up an empty folder.
     */
    it('keeps a folder that still holds something', async () => {
      const show = await createCollection('A Show');
      const season = await admin
        .post('/seasons')
        .send({ collectionId: show.id, number: 1 })
        .expect(201);

      await storage.save('media', `${season.body.folderKey}/episode.mp4`, Buffer.from('film'));

      await admin.delete(`/seasons/${season.body.id}`).expect(204);

      expect(await storage.exists('media', season.body.folderKey)).toBe(true);
      expect(await storage.exists('media', `${season.body.folderKey}/episode.mp4`)).toBe(true);
    });

    /** deleteFiles is still the destructive opt-in it always was. */
    it('takes the whole folder when deleteFiles is asked for', async () => {
      const show = await createCollection('A Show');
      const season = await admin
        .post('/seasons')
        .send({ collectionId: show.id, number: 1 })
        .expect(201);

      await storage.save('media', `${season.body.folderKey}/episode.mp4`, Buffer.from('film'));

      await admin.delete(`/seasons/${season.body.id}?deleteFiles=true`).expect(204);

      expect(await storage.exists('media', season.body.folderKey)).toBe(false);
    });
  });

  describe('reordering a collection\'s videos', () => {
    /**
     * One request rewrites a whole season's contents and their order. A PATCH
     * per video is a dozen calls that can half-fail, leaving an order nobody
     * chose — and `orderIndex` is deliberately not unique, so the sequence has
     * to be rewritten wholesale rather than swapped pairwise.
     */
    it('sets the season and the order in one call', async () => {
      const show = await createCollection('A Show');
      const season = await admin
        .post('/seasons')
        .send({ collectionId: show.id, number: 1 })
        .expect(201);

      const a = await seedVideo(show.id, 'Ep A');
      const b = await seedVideo(show.id, 'Ep B');
      const c = await seedVideo(show.id, 'Ep C');

      await admin
        .patch(`/collections/${show.id}/videos/order`)
        .send({ seasonId: season.body.id, videoIds: [c.id, a.id, b.id] })
        .expect(200);

      const rows = await prisma.video.findMany({
        where: { collectionId: show.id },
        select: { id: true, seasonId: true, orderIndex: true },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get(c.id)).toMatchObject({ seasonId: season.body.id, orderIndex: 0 });
      expect(byId.get(a.id)).toMatchObject({ seasonId: season.body.id, orderIndex: 1 });
      expect(byId.get(b.id)).toMatchObject({ seasonId: season.body.id, orderIndex: 2 });
    });

    /** null is a real value: it means "directly in the collection", where films live. */
    it('moves videos back out of a season with a null seasonId', async () => {
      const show = await createCollection('A Show');
      const season = await admin
        .post('/seasons')
        .send({ collectionId: show.id, number: 1 })
        .expect(201);
      const video = await seedVideo(show.id, 'Ep A', { seasonId: season.body.id });

      await admin
        .patch(`/collections/${show.id}/videos/order`)
        .send({ seasonId: null, videoIds: [video.id] })
        .expect(200);

      const after = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
      expect(after).toMatchObject({ seasonId: null, orderIndex: 0 });
    });

    /**
     * Both parents are checked. Taking ids on trust would make a reorder a way
     * to pull episodes out of a show the caller never named — the same reason
     * `PATCH /credits/reorder` names its parent explicitly.
     */
    it('refuses a video belonging to another collection', async () => {
      const mine = await createCollection('Mine');
      const theirs = await createCollection('Theirs');
      const elsewhere = await seedVideo(theirs.id, 'Not Mine');

      await admin
        .patch(`/collections/${mine.id}/videos/order`)
        .send({ seasonId: null, videoIds: [elsewhere.id] })
        .expect(400);

      const untouched = await prisma.video.findUniqueOrThrow({ where: { id: elsewhere.id } });
      expect(untouched.collectionId).toBe(theirs.id);
    });

    it('refuses a season belonging to another collection', async () => {
      const mine = await createCollection('Mine');
      const theirs = await createCollection('Theirs');
      const foreign = await admin
        .post('/seasons')
        .send({ collectionId: theirs.id, number: 1 })
        .expect(201);
      const video = await seedVideo(mine.id, 'Ep A');

      await admin
        .patch(`/collections/${mine.id}/videos/order`)
        .send({ seasonId: foreign.body.id, videoIds: [video.id] })
        .expect(400);
    });

    it('refuses the same video twice', async () => {
      const show = await createCollection('A Show');
      const video = await seedVideo(show.id, 'Ep A');

      await admin
        .patch(`/collections/${show.id}/videos/order`)
        .send({ seasonId: null, videoIds: [video.id, video.id] })
        .expect(400);
    });

    it('is admin-only', async () => {
      const show = await createCollection('A Show');
      const user = await asUser();

      await user
        .patch(`/collections/${show.id}/videos/order`)
        .send({ seasonId: null, videoIds: [] })
        .expect(403);
    });
  });

  describe('GET /collections/:slug/resolve', () => {
    let south: { id: string; slug: string };
    let seasonId: string;

    beforeEach(async () => {
      south = await createCollection('South Park');
      const season = await admin
        .post('/seasons')
        .send({ collectionId: south.id, number: 1 })
        .expect(201);
      seasonId = season.body.id;

      await seedVideo(south.id, 'Cartman Gets an Anal Probe', { seasonId, ...publishable });
      await seedVideo(south.id, 'Standalone', publishable);
    });

    it('resolves the collection itself for an empty path', async () => {
      const response = await admin.get(`/collections/${south.slug}/resolve?path=`).expect(200);

      expect(response.body).toMatchObject({ type: 'collection' });
    });

    it('resolves a season', async () => {
      const response = await admin
        .get(`/collections/${south.slug}/resolve?path=season-1`)
        .expect(200);

      expect(response.body).toMatchObject({ type: 'season' });
      expect(response.body.data.number).toBe(1);
    });

    it('resolves a video inside a season', async () => {
      const response = await admin
        .get(`/collections/${south.slug}/resolve?path=season-1/cartman-gets-an-anal-probe`)
        .expect(200);

      expect(response.body).toMatchObject({ type: 'video' });
      expect(response.body.data.title).toBe('Cartman Gets an Anal Probe');
    });

    it('resolves a video sitting directly in the collection', async () => {
      const response = await admin
        .get(`/collections/${south.slug}/resolve?path=standalone`)
        .expect(200);

      expect(response.body).toMatchObject({ type: 'video' });
    });

    /**
     * The precedence the plan specifies. A season and a video can share a slug;
     * checking seasons first means the answer is defined rather than incidental.
     */
    it('prefers a season over a video with the same slug', async () => {
      await prisma.season.update({ where: { id: seasonId }, data: { slug: 'clash' } });
      await prisma.video.updateMany({ where: { slug: 'standalone' }, data: { slug: 'clash' } });

      const response = await admin.get(`/collections/${south.slug}/resolve?path=clash`).expect(200);

      expect(response.body.type).toBe('season');
    });

    it('404s a path that means nothing', async () => {
      await admin.get(`/collections/${south.slug}/resolve?path=nonsense`).expect(404);
      await admin.get(`/collections/${south.slug}/resolve?path=season-1/nonsense`).expect(404);
      await admin.get(`/collections/${south.slug}/resolve?path=a/b/c`).expect(404);
    });

    it('tolerates trailing and doubled slashes', async () => {
      await admin.get(`/collections/${south.slug}/resolve?path=season-1/`).expect(200);
      await admin.get(`/collections/${south.slug}/resolve?path=//season-1//`).expect(200);
    });

    // The literal route has to be matched before `:slug`, or `resolve` reads as
    // a collection slug.
    it('does not shadow the collection detail route', async () => {
      await admin.get(`/collections/${south.slug}`).expect(200);
    });
  });

  /**
   * What the player page reads. Keyed on an id rather than a slug path,
   * which is what makes the key set below worth pinning: `GET /videos/:id`
   * hands out storage keys, and the whole reason this endpoint exists is that
   * the viewer-side player must not.
   */
  describe('GET /videos/:id/playback', () => {
    let south: { id: string; slug: string };
    let episode: { id: string; slug: string };

    beforeEach(async () => {
      south = await createCollection('South Park');
      const season = await admin
        .post('/seasons')
        .send({ collectionId: south.id, number: 1 })
        .expect(201);
      episode = await seedVideo(south.id, 'Cartman Gets an Anal Probe', {
        seasonId: season.body.id,
        ...publishable,
      });
    });

    it('carries both parents, so the page can link back and link on', async () => {
      const response = await admin.get(`/videos/${episode.id}/playback`).expect(200);

      expect(response.body).toMatchObject({
        id: episode.id,
        title: 'Cartman Gets an Anal Probe',
        collection: { slug: 'south-park', title: 'South Park' },
        season: { slug: 'season-1', number: 1 },
      });
    });

    /**
     * Pinned as an exact set, the way `requests/serialize.spec.ts` pins its
     * view. A `toMatchObject` would pass just as happily with `storageKey`
     * riding along, and the way that arrives is somebody adding a column to
     * the shared projection for an admin screen.
     */
    it('exposes no storage keys or probe diagnostics', async () => {
      const response = await admin.get(`/videos/${episode.id}/playback`).expect(200);

      expect(Object.keys(response.body).sort()).toEqual(
        [
          'collection',
          'collectionId',
          'description',
          'durationSec',
          'height',
          'id',
          'introEndSec',
          'introStartSec',
          'orderIndex',
          'outroEndSec',
          'outroStartSec',
          'season',
          'seasonId',
          'slug',
          'state',
          'tags',
          'thumbnailKey',
          'title',
          'width',
        ].sort(),
      );
    });

    it('is null-seasoned for a video sitting directly in the collection', async () => {
      const film = await seedVideo(south.id, 'Bigger Longer Uncut', publishable);

      const response = await admin.get(`/videos/${film.id}/playback`).expect(200);

      expect(response.body.season).toBeNull();
    });

    it('404s a draft for a USER, so an id cannot confirm one exists', async () => {
      const user = await asUser();

      await user.get(`/videos/${episode.id}/playback`).expect(404);
    });

    /**
     * The case a filter on the video alone gets wrong. Publishing the episode
     * without publishing its collection leaves it unreachable through the slug
     * route; an id must not be the way around that.
     */
    it('404s a published video inside a draft collection', async () => {
      await admin.post(`/videos/${episode.id}/publish`).expect(200);
      const user = await asUser();

      await user.get(`/videos/${episode.id}/playback`).expect(404);
    });

    it('serves it once both are published', async () => {
      await admin.post(`/videos/${episode.id}/publish`).expect(200);
      await publishCollection(south.id);
      const user = await asUser();

      await user.get(`/videos/${episode.id}/playback`).expect(200);
    });
  });

  /**
   * The title page's hero button and every episode's resume bar, in one read.
   */
  describe('GET /collections/:slug/progress', () => {
    let south: { id: string; slug: string };
    let first: { id: string; slug: string };
    let second: { id: string; slug: string };

    beforeEach(async () => {
      south = await createCollection('South Park');
      first = await seedVideo(south.id, 'One', { orderIndex: 1, ...publishable });
      second = await seedVideo(south.id, 'Two', { orderIndex: 2, ...publishable });
      await admin.post(`/videos/${first.id}/publish`).expect(200);
      await admin.post(`/videos/${second.id}/publish`).expect(200);
      await publishCollection(south.id);
    });

    it('offers the first episode when nothing has been watched', async () => {
      const response = await admin.get(`/collections/${south.slug}/progress`).expect(200);

      expect(response.body.next).toMatchObject({ videoId: first.id, lastPositionSec: 0 });
      expect(response.body.items).toEqual([]);
    });

    it('offers the next unfinished one, and reports how far each got', async () => {
      await admin
        .post(`/videos/${first.id}/heartbeat`)
        .send({ playSessionId: '11111111-1111-4111-8111-111111111111', positionSec: 119, deltaSec: 30 })
        .expect(200);

      const response = await admin.get(`/collections/${south.slug}/progress`).expect(200);

      // 119 of 120 seconds is past the completion threshold, so the offer moves on.
      expect(response.body.next.videoId).toBe(second.id);
      expect(response.body.items).toEqual([
        { videoId: first.id, lastPositionSec: 119, maxPositionSec: 119, completed: true },
      ]);
    });

    it('resumes a half-watched episode rather than skipping it', async () => {
      await admin
        .post(`/videos/${first.id}/heartbeat`)
        .send({ playSessionId: '11111111-1111-4111-8111-111111111111', positionSec: 30, deltaSec: 30 })
        .expect(200);

      const response = await admin.get(`/collections/${south.slug}/progress`).expect(200);

      expect(response.body.next).toMatchObject({ videoId: first.id, lastPositionSec: 30 });
    });

    /** One person's positions are not another's. */
    it('is scoped to the caller', async () => {
      await admin
        .post(`/videos/${first.id}/heartbeat`)
        .send({ playSessionId: '11111111-1111-4111-8111-111111111111', positionSec: 30, deltaSec: 30 })
        .expect(200);
      const user = await asUser();

      const response = await user.get(`/collections/${south.slug}/progress`).expect(200);

      expect(response.body.items).toEqual([]);
      expect(response.body.next).toMatchObject({ videoId: first.id, lastPositionSec: 0 });
    });

    it('never offers a draft episode to a USER', async () => {
      const draft = await seedVideo(south.id, 'Zero', { orderIndex: 0, ...publishable });
      const user = await asUser();

      const asAdmin = await admin.get(`/collections/${south.slug}/progress`).expect(200);
      const asViewer = await user.get(`/collections/${south.slug}/progress`).expect(200);

      // The admin can see it, so the draft really is first in order.
      expect(asAdmin.body.next.videoId).toBe(draft.id);
      expect(asViewer.body.next.videoId).toBe(first.id);
    });

    it('404s a collection the caller cannot see', async () => {
      const hidden = await createCollection('Hidden');
      const user = await asUser();

      await user.get(`/collections/${hidden.slug}/progress`).expect(404);
    });

    it('has nothing to offer for an empty collection', async () => {
      const empty = await createCollection('Empty');

      const response = await admin.get(`/collections/${empty.slug}/progress`).expect(200);

      expect(response.body).toEqual({ next: null, items: [] });
    });
  });

  describe('publish gating', () => {
    it('refuses a video that is not ready, and says what is missing', async () => {
      const collection = await createCollection('Harry Potter');
      const video = await seedVideo(collection.id, 'Philosophers Stone');

      const response = await admin.post(`/videos/${video.id}/publish`).expect(400);

      expect(response.body.missingFields).toEqual(
        expect.arrayContaining(['description', 'durationSec', 'thumbnailKey']),
      );
    });

    it('publishes one that is', async () => {
      const collection = await createCollection('Harry Potter');
      const video = await seedVideo(collection.id, 'Philosophers Stone', publishable);

      const response = await admin.post(`/videos/${video.id}/publish`).expect(200);

      expect(response.body.state).toBe('PUBLISHED');
    });

    it('shows the checklist on every admin read, not only on rejection', async () => {
      const collection = await createCollection('Harry Potter');
      const video = await seedVideo(collection.id, 'Philosophers Stone');

      const response = await admin.get(`/videos/${video.id}`).expect(200);

      expect(response.body.missingFields).toContain('thumbnailKey');
    });

    it('refuses a collection with nothing publishable in it', async () => {
      const collection = await createCollection('Empty', {});
      await admin
        .patch(`/collections/${collection.id}`)
        .send({ description: 'x', posterKey: 'p.jpg' })
        .expect(200);

      const response = await admin.post(`/collections/${collection.id}/publish`).expect(400);

      expect(response.body.missingFields).toEqual(['videos']);
    });

    it('cascades to the ready videos when asked', async () => {
      const collection = await createCollection('Harry Potter');
      await admin
        .patch(`/collections/${collection.id}`)
        .send({ description: 'x', posterKey: 'p.jpg' })
        .expect(200);
      const ready = await seedVideo(collection.id, 'Ready', publishable);
      const notReady = await seedVideo(collection.id, 'Not Ready');

      await admin.post(`/collections/${collection.id}/publish?cascade=true`).expect(200);

      await expect(
        prisma.video.findUnique({ where: { id: ready.id }, select: { state: true } }),
      ).resolves.toMatchObject({ state: 'PUBLISHED' });
      // A video that is not ready is left alone rather than dragged along.
      await expect(
        prisma.video.findUnique({ where: { id: notReady.id }, select: { state: true } }),
      ).resolves.toMatchObject({ state: 'DRAFT' });
    });

    it('leaves the videos alone without cascade', async () => {
      const collection = await createCollection('Harry Potter');
      await admin
        .patch(`/collections/${collection.id}`)
        .send({ description: 'x', posterKey: 'p.jpg' })
        .expect(200);
      const ready = await seedVideo(collection.id, 'Ready', publishable);

      await admin.post(`/collections/${collection.id}/publish`).expect(200);

      await expect(
        prisma.video.findUnique({ where: { id: ready.id }, select: { state: true } }),
      ).resolves.toMatchObject({ state: 'DRAFT' });
    });
  });

  describe('what a USER may see', () => {
    let user: request.Agent;
    let collection: { id: string; slug: string };

    beforeEach(async () => {
      user = await asUser();
      collection = await createCollection('Harry Potter');
      await admin
        .patch(`/collections/${collection.id}`)
        .send({ description: 'x', posterKey: 'p.jpg' })
        .expect(200);
    });

    it('hides a draft collection entirely', async () => {
      await user.get(`/collections/${collection.slug}`).expect(404);
      await expect(user.get('/collections').expect(200)).resolves.toMatchObject({
        body: { items: [], total: 0 },
      });
    });

    /**
     * The case a per-endpoint filter gets wrong: the collection is published,
     * so it is visible — but the draft video inside it must not be.
     */
    it('hides draft videos inside a published collection', async () => {
      const published = await seedVideo(collection.id, 'Published', publishable);
      await seedVideo(collection.id, 'Draft One');
      await admin.post(`/videos/${published.id}/publish`).expect(200);
      await admin.post(`/collections/${collection.id}/publish`).expect(200);

      const response = await user.get(`/collections/${collection.slug}`).expect(200);

      expect(response.body.videos).toHaveLength(1);
      expect(response.body.videos[0].title).toBe('Published');
    });

    it('hides a draft video from the list, from detail and from resolve', async () => {
      const draft = await seedVideo(collection.id, 'Draft One');
      // A collection needs something publishable before it can be published.
      const shown = await seedVideo(collection.id, 'Published', publishable);
      await admin.post(`/videos/${shown.id}/publish`).expect(200);
      await admin.post(`/collections/${collection.id}/publish`).expect(200);

      const list = await user.get('/videos').expect(200);
      expect(list.body.items.map((video: { id: string }) => video.id)).toEqual([shown.id]);

      await user.get(`/videos/${draft.id}`).expect(404);
      await user.get(`/collections/${collection.slug}/resolve?path=draft-one`).expect(404);
    });

    it('cannot widen its own filter by asking for DRAFT', async () => {
      await seedVideo(collection.id, 'Draft One');
      const shown = await seedVideo(collection.id, 'Published', publishable);
      await admin.post(`/videos/${shown.id}/publish`).expect(200);
      await admin.post(`/collections/${collection.id}/publish`).expect(200);

      const response = await user.get('/videos?state=DRAFT').expect(200);

      expect(response.body.items).toEqual([]);
      expect(response.body.total).toBe(0);
    });

    it('gets no publish checklist — that is an admin concern', async () => {
      const video = await seedVideo(collection.id, 'Published', publishable);
      await admin.post(`/videos/${video.id}/publish`).expect(200);

      const response = await user.get(`/videos/${video.id}`).expect(200);

      expect(response.body.missingFields).toBeUndefined();
    });

    it('cannot write anything', async () => {
      const video = await seedVideo(collection.id, 'Published', publishable);

      await user.patch(`/videos/${video.id}`).send({ title: 'Hacked' }).expect(403);
      await user.delete(`/videos/${video.id}`).expect(403);
      await user.post(`/videos/${video.id}/publish`).expect(403);
      await user.post('/seasons').send({ collectionId: collection.id, number: 1 }).expect(403);
    });
  });

  describe('videos', () => {
    it('serialises sizeBytes as a string, since BigInt would break JSON', async () => {
      const collection = await createCollection('Harry Potter');
      const video = await seedVideo(collection.id, 'Philosophers Stone');

      const response = await admin.get(`/videos/${video.id}`).expect(200);

      // Beyond Number.MAX_SAFE_INTEGER — a JSON number would have rounded it.
      expect(response.body.sizeBytes).toBe('9007199254740993');
    });

    it('refuses to move a video into another collection\'s season', async () => {
      const south = await createCollection('South Park');
      const simpsons = await createCollection('The Simpsons');
      const foreign = await admin
        .post('/seasons')
        .send({ collectionId: simpsons.id, number: 1 })
        .expect(201);
      const video = await seedVideo(south.id, 'Pilot');

      await admin.patch(`/videos/${video.id}`).send({ seasonId: foreign.body.id }).expect(400);
    });

    // The other half of the intersection: narrowing must still work for the
    // role that is allowed to see more than one state.
    it('lets an admin filter by state', async () => {
      const collection = await createCollection('Harry Potter');
      const published = await seedVideo(collection.id, 'Published', publishable);
      await seedVideo(collection.id, 'Draft One');
      await admin.post(`/videos/${published.id}/publish`).expect(200);

      const drafts = await admin.get('/videos?state=DRAFT').expect(200);
      expect(drafts.body.items.map((video: { title: string }) => video.title)).toEqual(['Draft One']);

      const live = await admin.get('/videos?state=PUBLISHED').expect(200);
      expect(live.body.items.map((video: { title: string }) => video.title)).toEqual(['Published']);

      const everything = await admin.get('/videos').expect(200);
      expect(everything.body.items).toHaveLength(2);
    });

    it('filters by collection, tag and search text', async () => {
      const south = await createCollection('South Park');
      const simpsons = await createCollection('The Simpsons');
      await seedVideo(south.id, 'Cartman', { tags: ['funny'] });
      await seedVideo(simpsons.id, 'Bart', { tags: ['classic'] });

      const byCollection = await admin.get(`/videos?collectionId=${south.id}`).expect(200);
      expect(byCollection.body.items).toHaveLength(1);

      const byTag = await admin.get('/videos?tag=classic').expect(200);
      expect(byTag.body.items).toHaveLength(1);

      const bySearch = await admin.get('/videos?q=cart').expect(200);
      expect(bySearch.body.items).toHaveLength(1);
    });
  });

  describe('pagination', () => {
    /** 12 videos in one collection, titled so their order is predictable. */
    async function seedMany(): Promise<string> {
      const collection = await createCollection('Big Show');
      for (let index = 0; index < 12; index += 1) {
        await seedVideo(collection.id, `Episode ${String(index).padStart(2, '0')}`);
      }
      return collection.id;
    }

    it('returns a bounded page with the counts a UI needs', async () => {
      await seedMany();

      const response = await admin.get('/videos?limit=5').expect(200);

      expect(response.body.items).toHaveLength(5);
      expect(response.body).toMatchObject({ total: 12, limit: 5, offset: 0, hasMore: true });
    });

    it('says when there is nothing more to fetch', async () => {
      await seedMany();

      const response = await admin.get('/videos?limit=5&offset=10').expect(200);

      expect(response.body.items).toHaveLength(2);
      expect(response.body.hasMore).toBe(false);
    });

    it('defaults to a page rather than the whole table', async () => {
      await seedMany();

      const response = await admin.get('/videos').expect(200);

      expect(response.body.limit).toBe(50);
      expect(response.body.items).toHaveLength(12);
    });

    /**
     * Offset paging over a non-total order silently repeats and skips rows, so
     * every paged query sorts by `id` last. Walking the whole list a page at a
     * time must see each row exactly once.
     */
    it('covers every row exactly once when walked page by page', async () => {
      await seedMany();

      const seen: string[] = [];
      for (let offset = 0; offset < 12; offset += 5) {
        const page = await admin.get(`/videos?limit=5&offset=${offset}`).expect(200);
        seen.push(...page.body.items.map((video: { id: string }) => video.id));
      }

      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
    });

    it('refuses a limit past the cap instead of quietly returning everything', async () => {
      await seedMany();

      await admin.get('/videos?limit=101').expect(400);
      await admin.get('/videos?limit=0').expect(400);
      await admin.get('/videos?limit=all').expect(400);
    });

    it('pages collections, users and invites too', async () => {
      await createCollection('One');
      await createCollection('Two');

      const collections = await admin.get('/collections?limit=1').expect(200);
      expect(collections.body).toMatchObject({ total: 2, hasMore: true });

      const users = await admin.get('/admin/users?limit=1').expect(200);
      expect(users.body.items).toHaveLength(1);

      const invites = await admin.get('/admin/invites?limit=1').expect(200);
      expect(invites.body).toHaveProperty('total');
    });

    // Paging is a window onto what the role may see, never a way past it.
    it('does not let a USER page into drafts', async () => {
      const collectionId = await seedMany();
      const shown = await seedVideo(collectionId, 'Visible', publishable);
      await admin.post(`/videos/${shown.id}/publish`).expect(200);
      await admin
        .patch(`/collections/${collectionId}`)
        .send({ description: 'x', posterKey: 'p.jpg' })
        .expect(200);
      await admin.post(`/collections/${collectionId}/publish`).expect(200);
      const user = await asUser();

      for (const query of ['', '?limit=100', '?offset=0&limit=100', '?state=DRAFT&limit=100']) {
        const response = await user.get(`/videos${query}`).expect(200);
        const states = response.body.items.map((video: { state: string }) => video.state);
        expect(states.every((state: string) => state === 'PUBLISHED')).toBe(true);
      }

      const everything = await user.get('/videos?limit=100').expect(200);
      expect(everything.body.total).toBe(1);
    });
  });

  describe('DELETE /collections/:id', () => {
    it('keeps the files unless asked, because reconcile would rebuild the row', async () => {
      const collection = await createCollection('Harry Potter');

      await admin.delete(`/collections/${collection.id}`).expect(204);

      await expect(storage.exists('media', 'harry-potter')).resolves.toBe(true);
      await expect(prisma.collection.count()).resolves.toBe(0);
    });

    it('removes the folder when asked explicitly', async () => {
      const collection = await createCollection('Harry Potter');

      await admin.delete(`/collections/${collection.id}?deleteFiles=true`).expect(204);

      await expect(storage.exists('media', 'harry-potter')).resolves.toBe(false);
    });

    it('takes the seasons and videos with it', async () => {
      const collection = await createCollection('Harry Potter');
      await admin.post('/seasons').send({ collectionId: collection.id, number: 1 }).expect(201);
      await seedVideo(collection.id, 'Philosophers Stone');

      await admin.delete(`/collections/${collection.id}`).expect(204);

      await expect(prisma.video.count()).resolves.toBe(0);
      await expect(prisma.season.count()).resolves.toBe(0);
    });
  });
});
