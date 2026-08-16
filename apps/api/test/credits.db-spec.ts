
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service';
import { DbHarness, PASSWORD } from './db/harness';

/**
 * People, credits, and the merge of a video's credits with its collection's.
 *
 * The merge arithmetic is unit-tested in `src/credits/merge.spec.ts`. What is
 * worth testing here is what a stub cannot have an opinion about: that the
 * duplicate rule holds where Postgres cannot express it, that a reorder cannot
 * reach credits the caller did not name, and that a filmography does not become
 * a way to read the draft library.
 */
describe('People and credits (real database)', () => {
  const harness = new DbHarness({ name: 'credits', workspace: true });

  
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: request.Agent;
  let viewer: request.Agent;
  let collectionId: string;
  let videoId: string;
  let ada: string;
  let grace: string;


  let seeded = 0;

  async function seedVideo(overrides: Record<string, unknown> = {}): Promise<string> {
    seeded += 1;
    const video = await prisma.video.create({
      data: {
        collections: { create: { collectionId, orderIndex: seeded } },
        slug: `episode-${seeded}`,
        title: `Episode ${seeded}`,
        storageKey: `Show/episode-${seeded}.mkv`,
        contentTag: 'tag',
        originalName: `episode-${seeded}.mkv`,
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

  const addPerson = async (name: string): Promise<string> => {
    const response = await admin.post('/people').send({ name }).expect(201);
    return response.body.id;
  };

  beforeEach(async () => {
    await harness.start();
    ({ app, prisma, admin } = harness);

    const invite = await admin.post('/admin/invites').send({}).expect(201);
    viewer = request.agent(app.getHttpServer());
    await viewer
      .post('/auth/redeem')
      .send({ token: invite.body.token, username: 'viewer', password: PASSWORD })
      .expect(201);

    const collection = await prisma.collection.create({
      data: { slug: 'show', title: 'Show', folderKey: 'Show', state: 'PUBLISHED' },
      select: { id: true },
    });
    collectionId = collection.id;
    seeded = 0;
    videoId = await seedVideo();
    ada = await addPerson('Ada Lovelace');
    grace = await addPerson('Grace Hopper');
  });

  afterEach(() => harness.stop());

  describe('people', () => {
    it('creates a person with a slug derived from the name', async () => {
      const response = await admin.post('/people').send({ name: 'Alan Turing' }).expect(201);

      expect(response.body).toMatchObject({ name: 'Alan Turing', slug: 'alan-turing' });
    });

    /**
     * The schema's unique index is case-sensitive, so it would happily hold
     * both "ada lovelace" and "Ada Lovelace" as two people.
     */
    it('refuses a duplicate name regardless of case', async () => {
      await admin.post('/people').send({ name: 'ada lovelace' }).expect(409);
    });

    it('keeps the slug when the name is corrected, since links would break', async () => {
      const before = await admin.get('/people?q=Ada').expect(200);

      await admin.patch(`/people/${ada}`).send({ name: 'Ada Byron Lovelace' }).expect(200);

      const after = await admin.get('/people?q=Ada').expect(200);
      expect(after.body.items[0].slug).toBe(before.body.items[0].slug);
    });

    it('moves the slug when asked explicitly', async () => {
      const response = await admin
        .patch(`/people/${ada}`)
        .send({ name: 'Ada Byron', regenerateSlug: true })
        .expect(200);

      expect(response.body.slug).toBe('ada-byron');
    });

    it('pages, and searches by name', async () => {
      const response = await viewer.get('/people?q=hopper').expect(200);

      expect(response.body).toMatchObject({ total: 1, limit: 50 });
      expect(response.body.items[0].name).toBe('Grace Hopper');
    });

    it('is read by anyone and written only by an admin', async () => {
      await viewer.get('/people').expect(200);
      await viewer.post('/people').send({ name: 'Nobody' }).expect(403);
      await viewer.patch(`/people/${ada}`).send({ name: 'Nobody' }).expect(403);
      await viewer.delete(`/people/${ada}`).expect(403);
    });

    it('404s an unknown slug', async () => {
      await viewer.get('/people/nobody').expect(404);
    });
  });

  describe('a filmography', () => {
    it('lists what they worked on', async () => {
      await admin
        .post(`/videos/${videoId}/credits`)
        .send({ personId: ada, role: 'DIRECTOR' })
        .expect(201);

      const response = await viewer.get('/people/ada-lovelace').expect(200);

      expect(response.body.credits).toHaveLength(1);
      expect(response.body.credits[0]).toMatchObject({
        role: 'DIRECTOR',
        video: { id: videoId, title: 'Episode 1' },
      });
    });

    /**
     * A director's page must not become a way to read the draft library — the
     * video is hidden on the browse page for the same reason.
     */
    it('hides a draft from a viewer but shows it to an admin', async () => {
      const draft = await seedVideo({ state: 'DRAFT' });
      await admin
        .post(`/videos/${draft}/credits`)
        .send({ personId: ada, role: 'DIRECTOR' })
        .expect(201);

      await expect(viewer.get('/people/ada-lovelace').expect(200)).resolves.toMatchObject({
        body: { credits: [] },
      });
      const asAdmin = await admin.get('/people/ada-lovelace').expect(200);
      expect(asAdmin.body.credits).toHaveLength(1);
    });
  });

  describe('adding a credit', () => {
    it('attaches a person to a video', async () => {
      const response = await admin
        .post(`/videos/${videoId}/credits`)
        .send({ personId: ada, role: 'ACTOR', characterName: 'The Countess' })
        .expect(201);

      expect(response.body).toMatchObject({
        role: 'ACTOR',
        characterName: 'The Countess',
        position: 0,
        person: { name: 'Ada Lovelace' },
      });
    });

    /**
     * The parent columns are nullable and Postgres treats NULLs as distinct, so
     * a composite unique index cannot catch this — the service has to.
     */
    it('refuses the same person in the same role on the same video', async () => {
      await admin.post(`/videos/${videoId}/credits`).send({ personId: ada, role: 'ACTOR' }).expect(201);

      await admin.post(`/videos/${videoId}/credits`).send({ personId: ada, role: 'ACTOR' }).expect(409);
    });

    it('allows the same person in a different role', async () => {
      await admin.post(`/videos/${videoId}/credits`).send({ personId: ada, role: 'ACTOR' }).expect(201);

      await admin
        .post(`/videos/${videoId}/credits`)
        .send({ personId: ada, role: 'DIRECTOR' })
        .expect(201);
    });

    it('allows the same person and role on a different parent', async () => {
      await admin.post(`/videos/${videoId}/credits`).send({ personId: ada, role: 'ACTOR' }).expect(201);

      await admin
        .post(`/collections/${collectionId}/credits`)
        .send({ personId: ada, role: 'ACTOR' })
        .expect(201);
    });

    // Billing order is per role, so a first director is not the third actor.
    it('appends to the end of its own role’s billing order', async () => {
      await admin.post(`/videos/${videoId}/credits`).send({ personId: ada, role: 'ACTOR' }).expect(201);
      const second = await admin
        .post(`/videos/${videoId}/credits`)
        .send({ personId: grace, role: 'ACTOR' })
        .expect(201);
      const director = await admin
        .post(`/videos/${videoId}/credits`)
        .send({ personId: ada, role: 'DIRECTOR' })
        .expect(201);

      expect(second.body.position).toBe(1);
      expect(director.body.position).toBe(0);
    });

    it('404s an unknown person', async () => {
      await admin.post(`/videos/${videoId}/credits`).send({ personId: 'nope', role: 'ACTOR' }).expect(404);
    });

    it('is admin-only', async () => {
      await viewer.post(`/videos/${videoId}/credits`).send({ personId: ada, role: 'ACTOR' }).expect(403);
    });
  });

  describe('the merged panel under an episode', () => {
    it('shows the show’s cast on an episode with none of its own', async () => {
      await admin
        .post(`/collections/${collectionId}/credits`)
        .send({ personId: ada, role: 'ACTOR' })
        .expect(201);

      const response = await viewer.get(`/videos/${videoId}/credits`).expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({ inherited: true, person: { name: 'Ada Lovelace' } });
    });

    it('puts the show’s regulars before the episode’s guests', async () => {
      await admin
        .post(`/collections/${collectionId}/credits`)
        .send({ personId: ada, role: 'ACTOR' })
        .expect(201);
      await admin
        .post(`/videos/${videoId}/credits`)
        .send({ personId: grace, role: 'ACTOR' })
        .expect(201);

      const response = await viewer.get(`/videos/${videoId}/credits`).expect(200);

      expect(response.body.items.map((c: { person: { name: string } }) => c.person.name)).toEqual([
        'Ada Lovelace',
        'Grace Hopper',
      ]);
    });

    // The episode's credit is more specific and can carry its own character name.
    it('lets an episode’s credit replace the show’s for the same person and role', async () => {
      await admin
        .post(`/collections/${collectionId}/credits`)
        .send({ personId: ada, role: 'ACTOR', characterName: 'The Countess' })
        .expect(201);
      await admin
        .post(`/videos/${videoId}/credits`)
        .send({ personId: ada, role: 'ACTOR', characterName: 'The Countess, older' })
        .expect(201);

      const response = await viewer.get(`/videos/${videoId}/credits`).expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        characterName: 'The Countess, older',
        inherited: false,
      });
    });

    it('does not leak the credits of a draft video to a viewer', async () => {
      const draft = await seedVideo({ state: 'DRAFT' });

      await viewer.get(`/videos/${draft}/credits`).expect(404);
      await admin.get(`/videos/${draft}/credits`).expect(200);
    });
  });

  describe('editing and removing', () => {
    let creditId: string;

    beforeEach(async () => {
      const response = await admin
        .post(`/videos/${videoId}/credits`)
        .send({ personId: ada, role: 'ACTOR' })
        .expect(201);
      creditId = response.body.id;
    });

    it('changes a character name', async () => {
      const response = await admin
        .patch(`/credits/${creditId}`)
        .send({ characterName: 'The Countess' })
        .expect(200);

      expect(response.body.characterName).toBe('The Countess');
    });

    // The role change is what creates the clash, so it is checked on update too.
    it('refuses a role change that collides with an existing credit', async () => {
      await admin
        .post(`/videos/${videoId}/credits`)
        .send({ personId: ada, role: 'DIRECTOR' })
        .expect(201);

      await admin.patch(`/credits/${creditId}`).send({ role: 'DIRECTOR' }).expect(409);
    });

    it('deletes a credit without touching the person', async () => {
      await admin.delete(`/credits/${creditId}`).expect(204);

      await admin.get('/people/ada-lovelace').expect(200);
    });

    it('404s an unknown credit', async () => {
      await admin.patch('/credits/nope').send({ characterName: 'x' }).expect(404);
      await admin.delete('/credits/nope').expect(404);
    });
  });

  describe('reordering the billing', () => {
    let first: string;
    let second: string;

    beforeEach(async () => {
      const a = await admin
        .post(`/videos/${videoId}/credits`)
        .send({ personId: ada, role: 'ACTOR' })
        .expect(201);
      const b = await admin
        .post(`/videos/${videoId}/credits`)
        .send({ personId: grace, role: 'ACTOR' })
        .expect(201);
      first = a.body.id;
      second = b.body.id;
    });

    it('rewrites the order from the list it is given', async () => {
      const response = await admin
        .patch('/credits/reorder')
        .send({ videoId, creditIds: [second, first] })
        .expect(200);

      expect(response.body.items.map((c: { person: { name: string } }) => c.person.name)).toEqual([
        'Grace Hopper',
        'Ada Lovelace',
      ]);
    });

    /**
     * Reordering by ids alone would be a way to renumber credits on a video the
     * caller never named.
     */
    it('refuses an id belonging to a different parent', async () => {
      const elsewhere = await admin
        .post(`/collections/${collectionId}/credits`)
        .send({ personId: ada, role: 'ACTOR' })
        .expect(201);

      await admin
        .patch('/credits/reorder')
        .send({ videoId, creditIds: [first, second, elsewhere.body.id] })
        .expect(400);
    });

    // A caller that sends half the list gets a numbering it did not intend.
    it('refuses a partial list', async () => {
      await admin.patch('/credits/reorder').send({ videoId, creditIds: [first] }).expect(400);
    });

    it('refuses the same credit listed twice', async () => {
      await admin
        .patch('/credits/reorder')
        .send({ videoId, creditIds: [first, first] })
        .expect(400);
    });

    it('refuses naming both a collection and a video', async () => {
      await admin
        .patch('/credits/reorder')
        .send({ videoId, collectionId, creditIds: [first, second] })
        .expect(400);
    });

    /**
     * `reorder` is declared before `credits/:id`; the other way round Express
     * matches it as an id and the endpoint is unreachable.
     */
    it('is not mistaken for a credit id', async () => {
      await admin
        .patch('/credits/reorder')
        .send({ videoId, creditIds: [first, second] })
        .expect(200);
    });

    it('is admin-only', async () => {
      await viewer
        .patch('/credits/reorder')
        .send({ videoId, creditIds: [first, second] })
        .expect(403);
    });
  });
});
