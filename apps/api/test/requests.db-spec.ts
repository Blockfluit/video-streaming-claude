import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { normaliseTitle } from '@video/shared';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SessionStoreService } from '../src/auth/session-store.service';
import { bigIntReplacer } from '../src/common/json';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Requests for things the library does not have.
 *
 * The anonymisation shape is unit-tested in `src/requests/serialize.spec.ts` and
 * the comparison key in `src/requests/title.spec.ts`. What needs a real database
 * is everything those two cannot prove:
 *
 *  - the **partial unique index** that makes "already requested" atomic. A stub
 *    cannot lose a race, and an index Prisma does not know about is exactly the
 *    kind of thing that silently does not exist;
 *  - the existence check being scoped to **what the caller can see**, which is a
 *    join against real rows in real states;
 *  - `normalisedTitle` actually being written by the services that write titles.
 *    A derived column is worth nothing while it disagrees with its source, and
 *    that only shows up against the real write path.
 */
describe('Requests (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-requests-test.bootstrap-token');

  let workspace: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;
  let ada: request.Agent;
  let grace: request.Agent;
  let collectionId: string;

  async function startApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('json replacer', bigIntReplacer);
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
    prisma = app.get(PrismaService);
  }

  let seeded = 0;

  /**
   * A video created the way reconcile does, comparison column and all.
   *
   * Written explicitly rather than left to default, because the default is `''`
   * — the "not comparable" sentinel — and a seed that quietly used it would make
   * every matching test pass for the wrong reason.
   */
  async function seedVideo(
    title: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    seeded += 1;
    const video = await prisma.video.create({
      data: {
        collectionId,
        slug: `film-${seeded}`,
        title,
        normalisedTitle: normaliseTitle(title),
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

  async function invite(username: string): Promise<request.Agent> {
    const minted = await admin.post('/admin/invites').send({}).expect(201);
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/auth/redeem')
      .send({ token: minted.body.token, username, password: PASSWORD })
      .expect(201);
    return agent;
  }

  const ask = (agent: request.Agent, body: Record<string, unknown>) =>
    agent.post('/requests').send(body);

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'requests-'));
    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = tokenFile;
    process.env.MEDIA_ROOT = join(workspace, 'media');
    process.env.DERIVED_ROOT = join(workspace, 'derived');
    process.env.INGEST_WATCHER_ENABLED = 'false';
    await rm(tokenFile, { force: true });

    await startApp();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "InviteToken", "User", "session", "Collection", "Season", "Video", "VideoRequest" RESTART IDENTITY CASCADE',
    );
    await app.close();
    await rm(tokenFile, { force: true });

    await startApp();

    admin = request.agent(app.getHttpServer());
    await admin
      .post('/auth/redeem')
      .send({ token: (await readFile(tokenFile, 'utf8')).trim(), username: 'root', password: PASSWORD })
      .expect(201);

    ada = await invite('ada');
    grace = await invite('grace');

    const collection = await prisma.collection.create({
      data: {
        slug: 'films',
        title: 'Films',
        normalisedTitle: normaliseTitle('Films'),
        folderKey: 'Films',
        state: 'PUBLISHED',
      },
      select: { id: true },
    });
    collectionId = collection.id;
    seeded = 0;
  });

  afterEach(async () => {
    banner.mockRestore();
    await app?.close();
    await rm(tokenFile, { force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  describe('asking for something', () => {
    it('records a request, starting at NEW', async () => {
      const response = await ask(ada, { title: 'Stalker' }).expect(201);

      expect(response.body).toMatchObject({
        title: 'Stalker',
        status: 'NEW',
        year: null,
        comment: null,
        mine: true,
      });
    });

    it('keeps the year and the comment when they are given', async () => {
      const response = await ask(ada, {
        title: 'Solaris',
        year: 1972,
        comment: 'The Tarkovsky one.',
      }).expect(201);

      expect(response.body).toMatchObject({
        year: 1972,
        comment: 'The Tarkovsky one.',
      });
    });

    it('refuses a request with no title', async () => {
      await ask(ada, { title: '   ' }).expect(400);
      await ask(ada, {}).expect(400);
    });

    it('stores the comparison key alongside the title', async () => {
      const response = await ask(ada, { title: 'The  Matrix!' }).expect(201);

      const row = await prisma.videoRequest.findUniqueOrThrow({
        where: { id: response.body.id },
      });
      expect(row.normalisedTitle).toBe('thematrix');
    });
  });

  describe('the existence check', () => {
    it('refuses a title already in the library', async () => {
      await seedVideo('Stalker');

      const response = await ask(ada, { title: 'Stalker' }).expect(409);

      expect(response.body.reason).toBe('ALREADY_IN_LIBRARY');
      expect(response.body.match).toMatchObject({ kind: 'video', title: 'Stalker' });
    });

    /** The whole point of normalising: these are one film, not four. */
    it('matches regardless of case, punctuation, spacing or accents', async () => {
      await seedVideo('Amélie');

      for (const title of ['amelie', 'AMELIE', 'Amélie', 'Amelie (2001)']) {
        const response = await ask(ada, { title }).expect(409);
        expect(response.body.reason).toBe('ALREADY_IN_LIBRARY');
      }
    });

    it('lets a genuinely different title through', async () => {
      await seedVideo('The Matrix');

      await ask(ada, { title: 'The Matrix Reloaded' }).expect(201);
    });

    /**
     * The visibility-scoped half, and the reason this is not simply "does a row
     * exist". Refusing a USER because a DRAFT matches would tell them the draft
     * exists — which is precisely what `whereVisible` is there to prevent.
     */
    it('does not refuse a viewer on the strength of a draft they cannot see', async () => {
      await seedVideo('Stalker', { state: 'DRAFT' });

      const response = await ask(ada, { title: 'Stalker' }).expect(201);
      expect(response.body.status).toBe('NEW');
    });

    it('does refuse an admin, who can see the draft', async () => {
      await seedVideo('Solaris', { state: 'DRAFT' });

      const response = await ask(admin, { title: 'Solaris' }).expect(409);
      expect(response.body.reason).toBe('ALREADY_IN_LIBRARY');
    });

    /**
     * Proves `titleData` is actually wired into the collection service. The
     * derived column is only worth having while the write path maintains it, and
     * that cannot be shown by seeding the column by hand.
     *
     * Asked **as the admin**, because `POST /collections` creates a DRAFT and a
     * viewer is deliberately never refused on the strength of one — the test
     * two above this pins that. Asking as `ada` here would be asserting the
     * opposite of the rule, which is exactly what it did until it was noticed.
     */
    it('sees a collection created through the API', async () => {
      await admin.post('/collections').send({ title: 'Berlin Alexanderplatz' }).expect(201);

      const response = await ask(admin, { title: 'berlin alexanderplatz' }).expect(409);
      expect(response.body.match).toMatchObject({ kind: 'collection' });
    });

    /** The same for the update path: renaming a video moves its comparison key. */
    it('follows a video that is renamed through the API', async () => {
      const videoId = await seedVideo('Working Title');

      await admin.patch(`/videos/${videoId}`).send({ title: 'Andrei Rublev' }).expect(200);

      await ask(ada, { title: 'Andrei Rublev' }).expect(409);
      // And no longer matches what it used to be called.
      await ask(ada, { title: 'Working Title' }).expect(201);
    });

    /**
     * A film is a collection holding one video of the same name, so both match.
     * The collection wins, because it is the page a person wants to land on.
     *
     * Also asked as the admin: the collection is a DRAFT, and to a viewer only
     * the video would be visible — which would make this assert the preference
     * while only one of the two candidates existed.
     */
    it('prefers the collection when a film matches both', async () => {
      await admin.post('/collections').send({ title: 'Stalker' }).expect(201);
      await seedVideo('Stalker');

      const response = await ask(admin, { title: 'Stalker' }).expect(409);
      expect(response.body.match.kind).toBe('collection');
    });
  });

  describe('asking twice', () => {
    it('refuses a second open request for the same title', async () => {
      const first = await ask(ada, { title: 'Stalker' }).expect(201);

      const response = await ask(grace, { title: 'stalker!' }).expect(409);

      expect(response.body.reason).toBe('ALREADY_REQUESTED');
      expect(response.body.requestId).toBe(first.body.id);
    });

    /**
     * The partial index is filtered on status, not blanket-unique: something
     * rejected a year ago is a fair thing to ask about again.
     */
    it('allows a fresh request once the first has been settled', async () => {
      const first = await ask(ada, { title: 'Stalker' }).expect(201);
      await admin.patch(`/requests/${first.body.id}/status`).send({ status: 'REJECTED' }).expect(200);

      await ask(grace, { title: 'Stalker' }).expect(201);
    });

    it('refuses reopening a settled request while another is open', async () => {
      const first = await ask(ada, { title: 'Stalker' }).expect(201);
      await admin.patch(`/requests/${first.body.id}/status`).send({ status: 'REJECTED' }).expect(200);
      await ask(grace, { title: 'Stalker' }).expect(201);

      const response = await admin
        .patch(`/requests/${first.body.id}/status`)
        .send({ status: 'NEW' })
        .expect(409);
      expect(response.body.reason).toBe('ALREADY_REQUESTED');
    });

    /**
     * The constraint is in the database, not in the service — which is what
     * makes it hold when two requests race. Asserted directly, because the HTTP
     * path is serialised enough that the earlier check usually wins anyway.
     */
    it('is enforced by the database, not only by the check before it', async () => {
      await ask(ada, { title: 'Stalker' }).expect(201);

      const user = await prisma.user.findFirstOrThrow({ where: { username: 'grace' } });
      await expect(
        prisma.videoRequest.create({
          data: {
            userId: user.id,
            title: 'Stalker',
            normalisedTitle: normaliseTitle('Stalker'),
            status: 'SEEN',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('frees the title again when the request is withdrawn', async () => {
      const first = await ask(ada, { title: 'Stalker' }).expect(201);
      await ada.delete(`/requests/${first.body.id}`).expect(204);

      await ask(grace, { title: 'Stalker' }).expect(201);
    });
  });

  describe('what a viewer is shown', () => {
    beforeEach(async () => {
      await ask(ada, { title: 'Stalker', comment: 'Please.' }).expect(201);
    });

    it('shows the request and its status without the name behind it', async () => {
      const response = await grace.get('/requests').expect(200);

      expect(response.body.items[0]).toMatchObject({
        title: 'Stalker',
        comment: 'Please.',
        status: 'NEW',
        requestedBy: null,
        statusChangedBy: null,
        mine: false,
      });
    });

    /** The blunt version of the same assertion: the name is nowhere in the body. */
    it('never mentions the requester anywhere in the response', async () => {
      const response = await grace.get('/requests').expect(200);

      expect(JSON.stringify(response.body)).not.toContain('ada');
    });

    it('marks the caller’s own requests', async () => {
      const mine = await ada.get('/requests').expect(200);
      expect(mine.body.items[0].mine).toBe(true);

      const filtered = await ada.get('/requests?mine=true').expect(200);
      expect(filtered.body.total).toBe(1);

      const others = await grace.get('/requests?mine=true').expect(200);
      expect(others.body.total).toBe(0);
    });

    it('returns a Page, like every other list endpoint', async () => {
      const response = await grace.get('/requests').expect(200);

      expect(response.body).toMatchObject({ total: 1, limit: 50, offset: 0, hasMore: false });
    });

    it('shows an admin who asked and, once answered, who answered', async () => {
      const listed = await admin.get('/requests').expect(200);
      expect(listed.body.items[0].requestedBy).toMatchObject({ username: 'ada' });

      const id = listed.body.items[0].id;
      await admin.patch(`/requests/${id}/status`).send({ status: 'SEEN' }).expect(200);

      const after = await admin.get('/requests').expect(200);
      expect(after.body.items[0].statusChangedBy).toMatchObject({ displayName: 'root' });
      expect(after.body.items[0].statusChangedAt).not.toBeNull();
    });

    it('filters by status', async () => {
      const listed = await admin.get('/requests').expect(200);
      await admin
        .patch(`/requests/${listed.body.items[0].id}/status`)
        .send({ status: 'PROCESSING' })
        .expect(200);

      expect((await grace.get('/requests?status=PROCESSING').expect(200)).body.total).toBe(1);
      expect((await grace.get('/requests?status=NEW').expect(200)).body.total).toBe(0);
    });
  });

  /**
   * The library-match hint. It is computed over the whole library including
   * drafts, so handing it to a viewer would be the leak the existence check was
   * carefully scoped to avoid.
   */
  describe('the library-match hint', () => {
    beforeEach(async () => {
      await seedVideo('Stalker', { state: 'DRAFT' });
      await ask(ada, { title: 'Stalker' }).expect(201);
    });

    it('tells an admin the title is already there as a draft', async () => {
      const response = await admin.get('/requests').expect(200);

      expect(response.body.items[0].libraryMatch).toMatchObject({
        kind: 'video',
        title: 'Stalker',
        state: 'DRAFT',
      });
    });

    it('is withheld from a viewer entirely', async () => {
      const response = await ada.get('/requests').expect(200);

      expect(response.body.items[0].libraryMatch).toBeNull();
    });
  });

  describe('changing the status', () => {
    let requestId: string;

    beforeEach(async () => {
      const created = await ask(ada, { title: 'Stalker' }).expect(201);
      requestId = created.body.id;
    });

    it('is refused to the person who asked', async () => {
      await ada.patch(`/requests/${requestId}/status`).send({ status: 'AVAILABLE' }).expect(403);
    });

    it('is refused to any other viewer', async () => {
      await grace.patch(`/requests/${requestId}/status`).send({ status: 'AVAILABLE' }).expect(403);
    });

    it('is allowed to an admin, and shows up for everyone', async () => {
      await admin.patch(`/requests/${requestId}/status`).send({ status: 'AVAILABLE' }).expect(200);

      const response = await grace.get('/requests').expect(200);
      expect(response.body.items[0].status).toBe('AVAILABLE');
    });

    it('accepts every status the enum offers', async () => {
      for (const status of ['SEEN', 'PROCESSING', 'NOT_AVAILABLE', 'REJECTED', 'AVAILABLE', 'NEW']) {
        await admin.patch(`/requests/${requestId}/status`).send({ status }).expect(200);
      }
    });

    it('refuses a status that is not one of them', async () => {
      await admin.patch(`/requests/${requestId}/status`).send({ status: 'MAYBE' }).expect(400);
    });

    it('carries an admin note through to everyone', async () => {
      await admin
        .patch(`/requests/${requestId}/status`)
        .send({ status: 'NOT_AVAILABLE', adminNote: 'Cannot find a copy.' })
        .expect(200);

      const response = await grace.get('/requests').expect(200);
      expect(response.body.items[0].adminNote).toBe('Cannot find a copy.');
    });

    /**
     * Omitting the note must not wipe it. Otherwise moving a request from SEEN
     * to PROCESSING silently discards the explanation attached to it.
     */
    it('leaves an existing note alone when the note is omitted', async () => {
      await admin
        .patch(`/requests/${requestId}/status`)
        .send({ status: 'SEEN', adminNote: 'Looking.' })
        .expect(200);

      const response = await admin
        .patch(`/requests/${requestId}/status`)
        .send({ status: 'PROCESSING' })
        .expect(200);

      expect(response.body.adminNote).toBe('Looking.');
    });

    it('clears the note when one is explicitly sent empty', async () => {
      await admin
        .patch(`/requests/${requestId}/status`)
        .send({ status: 'SEEN', adminNote: 'Looking.' })
        .expect(200);

      const response = await admin
        .patch(`/requests/${requestId}/status`)
        .send({ status: 'SEEN', adminNote: '' })
        .expect(200);

      expect(response.body.adminNote).toBeNull();
    });

    it('404s an unknown request', async () => {
      await admin.patch('/requests/nope/status').send({ status: 'SEEN' }).expect(404);
    });
  });

  describe('withdrawing', () => {
    let requestId: string;

    beforeEach(async () => {
      const created = await ask(ada, { title: 'Stalker' }).expect(201);
      requestId = created.body.id;
    });

    it('lets the person who asked take it back', async () => {
      await ada.delete(`/requests/${requestId}`).expect(204);

      expect((await ada.get('/requests').expect(200)).body.total).toBe(0);
    });

    it('refuses another viewer', async () => {
      await grace.delete(`/requests/${requestId}`).expect(403);
    });

    it('lets an admin remove anyone’s', async () => {
      await admin.delete(`/requests/${requestId}`).expect(204);
    });

    it('404s an unknown request', async () => {
      await ada.delete('/requests/nope').expect(404);
    });
  });
});
