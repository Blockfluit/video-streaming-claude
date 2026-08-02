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
 * Comments under the player.
 *
 * The tombstone shape is unit-tested in `src/comments/serialize.spec.ts`. What
 * matters here is who may do what: an admin moderates by removing, never by
 * rewriting, and a comment must not become a way to learn that a draft video
 * exists.
 */
describe('Comments (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-comments-test.bootstrap-token');

  let workspace: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;
  let ada: request.Agent;
  let grace: request.Agent;
  let collectionId: string;
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

  async function seedVideo(overrides: Record<string, unknown> = {}): Promise<string> {
    seeded += 1;
    const video = await prisma.video.create({
      data: {
        collections: { create: { collectionId } },
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

  async function invite(username: string): Promise<request.Agent> {
    const minted = await admin.post('/admin/invites').send({}).expect(201);
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/auth/redeem')
      .send({ token: minted.body.token, username, password: PASSWORD })
      .expect(201);
    return agent;
  }

  const post = (agent: request.Agent, body: Record<string, unknown>, id: string = videoId) =>
    agent.post(`/videos/${id}/comments`).send(body);

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'comments-'));
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

    ada = await invite('ada');
    grace = await invite('grace');

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

  describe('posting', () => {
    it('records a comment with its author', async () => {
      const response = await post(ada, { body: 'Wonderful.' }).expect(201);

      expect(response.body).toMatchObject({
        body: 'Wonderful.',
        deleted: false,
        editedAt: null,
        user: { username: 'ada', displayName: 'ada' },
      });
    });

    it('pins a comment to the moment it was written at', async () => {
      const response = await post(ada, { body: 'This shot.', timestampSec: 134 }).expect(201);

      expect(response.body.timestampSec).toBe(134);
    });

    /**
     * The UI renders the timestamp as a link that seeks there, so a pin past the
     * end is a link with no target.
     */
    it('refuses a pin past the end of the video', async () => {
      const response = await post(ada, { body: 'Nowhere.', timestampSec: 601 }).expect(400);

      expect(response.body.errors[0].message).toContain('600');
    });

    it('accepts a pin on a video that was never probed', async () => {
      const unprobed = await seedVideo({ durationSec: null });

      await post(ada, { body: 'Somewhere.', timestampSec: 5000 }, unprobed).expect(201);
    });

    it('refuses an empty comment', async () => {
      await post(ada, { body: '   ' }).expect(400);
    });

    it('404s a video a viewer may not see', async () => {
      const draft = await seedVideo({ state: 'DRAFT' });

      await post(ada, { body: 'Hello.' }, draft).expect(404);
    });
  });

  describe('reading the thread', () => {
    it('is newest first and paged', async () => {
      await post(ada, { body: 'First.' }).expect(201);
      await post(grace, { body: 'Second.' }).expect(201);

      const response = await ada.get(`/videos/${videoId}/comments`).expect(200);

      expect(response.body).toMatchObject({ total: 2, limit: 50, hasMore: false });
      expect(response.body.items.map((c: { body: string }) => c.body)).toEqual([
        'Second.',
        'First.',
      ]);
    });

    it('pages without repeating', async () => {
      await post(ada, { body: 'First.' }).expect(201);
      await post(grace, { body: 'Second.' }).expect(201);

      const first = await ada.get(`/videos/${videoId}/comments?limit=1`).expect(200);
      const second = await ada.get(`/videos/${videoId}/comments?limit=1&offset=1`).expect(200);

      expect(first.body.items[0].id).not.toBe(second.body.items[0].id);
      expect(first.body.hasMore).toBe(true);
    });

    it('404s a video a viewer may not see', async () => {
      const draft = await seedVideo({ state: 'DRAFT' });

      await ada.get(`/videos/${draft}/comments`).expect(404);
    });
  });

  describe('editing', () => {
    let commentId: string;

    beforeEach(async () => {
      const response = await post(ada, { body: 'Wonderful.' }).expect(201);
      commentId = response.body.id;
    });

    it('rewrites the body and marks it edited', async () => {
      const response = await ada
        .patch(`/comments/${commentId}`)
        .send({ body: 'Wonderful, actually.' })
        .expect(200);

      expect(response.body.body).toBe('Wonderful, actually.');
      expect(response.body.editedAt).not.toBeNull();
    });

    it('refuses another user', async () => {
      await grace.patch(`/comments/${commentId}`).send({ body: 'No.' }).expect(403);
    });

    /**
     * An admin moderates by *removing* a comment. Rewriting someone's words and
     * leaving their name on it is not moderation, and `editedAt` would make it
     * look like they had done it themselves.
     */
    it('refuses an admin too', async () => {
      await admin.patch(`/comments/${commentId}`).send({ body: 'Edited by staff.' }).expect(403);
    });

    it('refuses to edit a deleted comment', async () => {
      await ada.delete(`/comments/${commentId}`).expect(204);

      await ada.patch(`/comments/${commentId}`).send({ body: 'Back again.' }).expect(400);
    });

    /**
     * The comment is reached through its video's visibility, so a comment id
     * is not a way to act on — or confirm the existence of — a video the caller
     * can no longer see. 404 rather than 403, for the same reason.
     */
    it('404s once the video is no longer visible to the caller', async () => {
      await admin.post(`/videos/${videoId}/archive`).expect(200);

      await ada.patch(`/comments/${commentId}`).send({ body: 'Still here?' }).expect(404);
    });
  });

  describe('the moderation queue', () => {
    it('is admin-only', async () => {
      await ada.get('/admin/comments').expect(403);
      await admin.get('/admin/comments').expect(200);
    });

    it('returns a Page, like every other list endpoint', async () => {
      await post(ada, { body: 'One' }).expect(201);

      const response = await admin.get('/admin/comments').expect(200);

      expect(response.body).toMatchObject({ total: 1, limit: 50, offset: 0 });
      expect(response.body.items).toHaveLength(1);
    });

    /**
     * The deliberate difference from the thread endpoint. A comment worth
     * removing is most likely on a video nobody is watching, so the moderation
     * listing does *not* apply the visibility filter — otherwise the one place
     * that can find it is the one place that hides it.
     */
    it('reaches comments on a draft, which the thread endpoint hides', async () => {
      const draftId = await seedVideo({ state: 'DRAFT' });
      await admin.post(`/videos/${draftId}/comments`).send({ body: 'On a draft' }).expect(201);

      // A viewer cannot even see the video.
      await ada.get(`/videos/${draftId}/comments`).expect(404);

      const response = await admin.get('/admin/comments').expect(200);
      const bodies = response.body.items.map((c: { body: string | null }) => c.body);
      expect(bodies).toContain('On a draft');
    });

    it('hides removed comments by default and never returns their text', async () => {
      const created = await post(ada, { body: 'Regrettable' }).expect(201);
      await admin.delete(`/comments/${created.body.id}`).expect(204);

      const byDefault = await admin.get('/admin/comments').expect(200);
      expect(byDefault.body.items).toHaveLength(0);

      const withDeleted = await admin.get('/admin/comments?includeDeleted=true').expect(200);
      expect(withDeleted.body.items).toHaveLength(1);
      // toCommentView is the only thing between a deleted comment and its text.
      expect(withDeleted.body.items[0]).toMatchObject({ deleted: true, body: null });
    });

    /** booleanParam, not z.coerce.boolean() — the latter makes "false" true. */
    it('treats includeDeleted=false as false', async () => {
      const created = await post(ada, { body: 'Gone' }).expect(201);
      await admin.delete(`/comments/${created.body.id}`).expect(204);

      const response = await admin.get('/admin/comments?includeDeleted=false').expect(200);
      expect(response.body.items).toHaveLength(0);
    });

    it('searches the body', async () => {
      await post(ada, { body: 'A remark about herons' }).expect(201);
      await post(ada, { body: 'Something else entirely' }).expect(201);

      const response = await admin.get('/admin/comments?q=HERONS').expect(200);
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].body).toMatch(/herons/);
    });
  });

  describe('deleting', () => {
    let commentId: string;

    beforeEach(async () => {
      const response = await post(ada, { body: 'Wonderful.' }).expect(201);
      commentId = response.body.id;
    });

    it('lets the author remove their own', async () => {
      await ada.delete(`/comments/${commentId}`).expect(204);
    });

    it('lets an admin remove anyone’s', async () => {
      await admin.delete(`/comments/${commentId}`).expect(204);
    });

    it('refuses another user', async () => {
      await grace.delete(`/comments/${commentId}`).expect(403);
    });

    /**
     * Soft delete: the row stays so the thread reads around the gap, but it must
     * carry neither the text nor the author.
     */
    it('leaves a tombstone in the thread', async () => {
      await ada.delete(`/comments/${commentId}`).expect(204);

      const response = await grace.get(`/videos/${videoId}/comments`).expect(200);

      expect(response.body.total).toBe(1);
      expect(response.body.items[0]).toMatchObject({
        id: commentId,
        deleted: true,
        body: null,
        user: null,
      });
    });

    it('never serves the text of a deleted comment', async () => {
      await ada.delete(`/comments/${commentId}`).expect(204);

      const response = await grace.get(`/videos/${videoId}/comments`).expect(200);

      expect(JSON.stringify(response.body)).not.toContain('Wonderful');
    });

    // The audit trail is the reason the row is kept at all.
    it('records who removed it, without serving that either', async () => {
      await admin.delete(`/comments/${commentId}`).expect(204);

      const row = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
      expect(row.deletedById).not.toBeNull();
      expect(row.body).toBe('Wonderful.');
    });

    // The second caller wanted it gone, and it is.
    it('is idempotent', async () => {
      await ada.delete(`/comments/${commentId}`).expect(204);
      await ada.delete(`/comments/${commentId}`).expect(204);
    });

    it('404s an unknown comment', async () => {
      await ada.delete('/comments/nope').expect(404);
    });

    it('404s once the video is no longer visible to the caller', async () => {
      await admin.post(`/videos/${videoId}/archive`).expect(200);

      await ada.delete(`/comments/${commentId}`).expect(404);
    });
  });
});
