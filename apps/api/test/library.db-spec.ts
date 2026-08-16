
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { StorageService } from '../src/common/storage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { DbHarness, PASSWORD } from './db/harness';

/**
 * Collections, seasons, videos and slug resolution against a real Postgres.
 *
 * The things worth testing here are the ones a stub cannot have an opinion
 * about: uniqueness scoping (two collections may both contain a `pilot`),
 * resolution precedence, and whether the visibility filter actually reaches the
 * nested rows.
 */
describe('Library (real database)', () => {
  const harness = new DbHarness({ name: 'library', workspace: true, admin: 'ada' });


  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let admin: request.Agent;



  /** A video row, which only ingest or upload would normally create. */
  async function seedVideo(
    collectionId: string,
    title: string,
    overrides: Record<string, unknown> = {},
    /** Membership fields — where the video sits in *this* collection. */
    membership: Record<string, unknown> = {},
  ): Promise<{ id: string; slug: string }> {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return prisma.video.create({
      data: {
        collections: { create: { collectionId, ...membership } },
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

  /**
   * A video in no collection at all, which is what a folder holding one video
   * becomes. It is an ordinary row with no membership, not a special kind of
   * video — and it is *one* way to be a film rather than the definition of one:
   * a film on a season-less shelf is equally a film.
   */
  async function seedStandaloneVideo(
    title: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; slug: string }> {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return prisma.video.create({
      data: {
        slug,
        title,
        storageKey: `loose/${title}-${Math.round(performance.now() * 1000)}.mp4`,
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
    bannerKey: 'thumbs/a.jpg',
  };

  async function createCollection(title: string, extra: Record<string, unknown> = {}) {
    const response = await admin.post('/collections').send({ title, ...extra }).expect(201);
    return response.body;
  }

  /**
   * A season on a collection, which is what makes it a *series*.
   *
   * Worth a helper because it is the whole of the film rule: a collection with
   * one of these holds instalments, and a collection without one holds films.
   */
  async function addSeason(collectionId: string, number: number) {
    const response = await admin.post('/seasons').send({ collectionId, number }).expect(201);
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
    await harness.start();
    ({ app, prisma, admin } = harness);
    storage = app.get(StorageService);



  });

  afterEach(() => harness.stop());

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

  /**
   * What a card needs to say whether it is a shelf of seasons or of films.
   *
   * `seasonCount` is TMDB's count of the whole show and is routinely larger
   * than what we hold — "3 of 5 seasons here" is a sentence only because they
   * are two different numbers — so it cannot answer this.
   */
  describe('how much a collection holds', () => {
    it('counts the seasons and videos it actually holds', async () => {
      const show = await createCollection('South Park');
      await addSeason(show.id, 1);
      const season = await addSeason(show.id, 2);
      await seedVideo(show.id, 'Cartman', {}, { seasonId: season.id });

      const saga = await createCollection('Harry Potter');
      await seedVideo(saga.id, 'Chamber of Secrets');
      await seedVideo(saga.id, 'Philosophers Stone');

      const listed = await admin.get('/collections').expect(200);
      const byTitle = new Map(
        listed.body.items.map((collection: { title: string }) => [collection.title, collection]),
      );

      expect(byTitle.get('South Park')).toMatchObject({ seasonsHere: 2, videosHere: 1 });
      expect(byTitle.get('Harry Potter')).toMatchObject({ seasonsHere: 0, videosHere: 2 });

      // Prisma's shape is not the API's, and TMDB's count is a different fact.
      expect(byTitle.get('South Park')).not.toHaveProperty('_count');
      expect(byTitle.get('South Park')).toMatchObject({ seasonCount: null });
    });

    it('counts them on the collection page too', async () => {
      const saga = await createCollection('Harry Potter');
      await seedVideo(saga.id, 'Goblet of Fire');

      const page = await admin.get(`/collections/${saga.slug}`).expect(200);
      expect(page.body).toMatchObject({ seasonsHere: 0, videosHere: 1 });
      expect(page.body).not.toHaveProperty('_count');
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

    /**
     * Read back, not just accepted.
     *
     * `update` builds its `data` field by field rather than spreading the DTO —
     * deliberately, so a column added later cannot be written by anyone who
     * guesses its name — and the cost is that a *new* field is silently dropped
     * until it is added there too. That is exactly what happened: the PATCH
     * answered 200, the response looked right, and the column stayed empty.
     * Asserting the round trip is the only thing that catches it.
     */
    it('stores a trailer, as the id rather than the pasted URL', async () => {
      const collection = await createCollection('Harry Potter');

      await admin
        .patch(`/collections/${collection.id}`)
        .send({ trailerYoutubeId: 'https://www.youtube.com/watch?v=dQw4w9Wg-_Q&list=PLx&t=9' })
        .expect(200);

      const read = await admin.get('/collections/harry-potter').expect(200);
      expect(read.body.trailerYoutubeId).toBe('dQw4w9Wg-_Q');
    });

    it('clears the trailer when given an empty value', async () => {
      const collection = await createCollection('Harry Potter');

      await admin
        .patch(`/collections/${collection.id}`)
        .send({ trailerYoutubeId: 'https://youtu.be/dQw4w9Wg-_Q' })
        .expect(200);
      await admin.patch(`/collections/${collection.id}`).send({ trailerYoutubeId: '' }).expect(200);

      const read = await admin.get('/collections/harry-potter').expect(200);
      expect(read.body.trailerYoutubeId).toBeNull();
    });

    /** Omitting it must not wipe it — "leave alone" and "clear" are different. */
    it('leaves the trailer alone when the field is not sent', async () => {
      const collection = await createCollection('Harry Potter');

      await admin
        .patch(`/collections/${collection.id}`)
        .send({ trailerYoutubeId: 'https://youtu.be/dQw4w9Wg-_Q' })
        .expect(200);
      await admin.patch(`/collections/${collection.id}`).send({ title: 'Renamed' }).expect(200);

      const read = await admin.get('/collections/harry-potter').expect(200);
      expect(read.body.trailerYoutubeId).toBe('dQw4w9Wg-_Q');
    });

    it('refuses a link it cannot read rather than storing it', async () => {
      const collection = await createCollection('Harry Potter');

      await admin
        .patch(`/collections/${collection.id}`)
        .send({ trailerYoutubeId: 'https://vimeo.com/12345' })
        .expect(400);
    });
  });

  /**
   * Every imported field, on both parents.
   *
   * These assert the **round trip** rather than the status code, because the
   * failure mode here is silent: `update()` builds its `data` field by field, so
   * a field added to the zod schema and forgotten in the service is dropped and
   * the PATCH still answers 200 with a response that looks right. That is
   * exactly what happened with `trailerYoutubeId`.
   */
  describe('imported metadata, edited by hand', () => {
    const EDITS = {
      tagline: 'What is the cost of lies?',
      genres: ['Drama', 'History'],
      certification: 'TV-MA',
      originalTitle: 'Chernobyl',
      originalLanguage: 'en',
      releaseDate: '2019-05-06',
      imdbId: 'tt7366338',
    };

    it('round-trips every field on a collection', async () => {
      const collection = await createCollection('Harry Potter');

      await admin.patch(`/collections/${collection.id}`).send(EDITS).expect(200);

      const read = await admin.get('/collections/harry-potter').expect(200);
      expect(read.body).toMatchObject({
        tagline: EDITS.tagline,
        genres: EDITS.genres,
        certification: EDITS.certification,
        originalTitle: EDITS.originalTitle,
        originalLanguage: EDITS.originalLanguage,
        imdbId: EDITS.imdbId,
      });
      // A day, not a moment: read back as UTC midnight rather than shifted by
      // whatever zone the server happens to be in.
      expect(read.body.releaseDate).toBe('2019-05-06T00:00:00.000Z');
    });

    it('round-trips every field on a video', async () => {
      const collection = await createCollection('Harry Potter');
      const video = await seedVideo(collection.id, 'Philosophers Stone');

      await admin.patch(`/videos/${video.id}`).send(EDITS).expect(200);

      const read = await admin.get(`/videos/${video.id}`).expect(200);
      expect(read.body).toMatchObject({
        tagline: EDITS.tagline,
        genres: EDITS.genres,
        certification: EDITS.certification,
        originalLanguage: EDITS.originalLanguage,
        imdbId: EDITS.imdbId,
      });
    });

    it('clears a field on an explicit empty value, and leaves it alone when omitted', async () => {
      const collection = await createCollection('Harry Potter');
      await admin.patch(`/collections/${collection.id}`).send(EDITS).expect(200);

      await admin.patch(`/collections/${collection.id}`).send({ title: 'Renamed' }).expect(200);
      let read = await admin.get('/collections/harry-potter').expect(200);
      expect(read.body.tagline).toBe(EDITS.tagline);

      await admin
        .patch(`/collections/${collection.id}`)
        .send({ tagline: '', imdbId: '', releaseDate: '' })
        .expect(200);
      read = await admin.get('/collections/harry-potter').expect(200);
      expect(read.body.tagline).toBeNull();
      expect(read.body.imdbId).toBeNull();
      expect(read.body.releaseDate).toBeNull();
    });

    /** Parsed at the edge, like a trailer: what an admin pastes is a URL. */
    it('reads an IMDb id out of a pasted URL, and refuses what it cannot read', async () => {
      const collection = await createCollection('Harry Potter');

      await admin
        .patch(`/collections/${collection.id}`)
        .send({ imdbId: 'https://www.imdb.com/title/tt7366338/?ref_=nv_sr_1' })
        .expect(200);
      const read = await admin.get('/collections/harry-potter').expect(200);
      expect(read.body.imdbId).toBe('tt7366338');

      // A person id is a different namespace and would be a dead link.
      await admin.patch(`/collections/${collection.id}`).send({ imdbId: 'nm0000158' }).expect(400);
      await admin.patch(`/collections/${collection.id}`).send({ releaseDate: 'last May' }).expect(400);
    });
  });

  describe('slug scoping', () => {
    // The plan's manual check: two collections may both contain a `pilot`.
    /**
     * Video slugs are library-wide now, where they used to be scoped to a
     * collection so two shows could each have a `pilot`.
     *
     * A video is addressed at `/v/<slug>` on its own — it may be in several
     * collections, so there is no one collection for a scope to mean. The
     * numbering that has always deduplicated within a scope now does it across
     * the library, and the second `pilot` becomes `pilot-2`.
     */
    it('refuses the same video slug anywhere in the library', async () => {
      const south = await createCollection('South Park');
      const simpsons = await createCollection('The Simpsons');

      await seedVideo(south.id, 'Pilot');

      await expect(seedVideo(simpsons.id, 'Pilot')).rejects.toThrow();
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
      const video = await seedVideo(south.id, 'Pilot', {}, { seasonId: season.body.id });

      await admin.delete(`/seasons/${season.body.id}`).expect(204);

      // The membership survives with no season: the video is still in the
      // collection, just not in a season of it.
      const survivor = await prisma.collectionVideo.findUniqueOrThrow({
        where: { collectionId_videoId: { collectionId: south.id, videoId: video.id } },
      });
      expect(survivor).toMatchObject({ seasonId: null });
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

      // Read from the membership: season and order say where a video sits in
      // *this* collection, and the video may sit in others.
      const rows = await prisma.collectionVideo.findMany({
        where: { collectionId: show.id },
        select: { videoId: true, seasonId: true, orderIndex: true },
      });
      const byId = new Map(rows.map((row) => [row.videoId, row]));

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
      const video = await seedVideo(show.id, 'Ep A', {}, { seasonId: season.body.id });

      await admin
        .patch(`/collections/${show.id}/videos/order`)
        .send({ seasonId: null, videoIds: [video.id] })
        .expect(200);

      const after = await prisma.collectionVideo.findUniqueOrThrow({
        where: { collectionId_videoId: { collectionId: show.id, videoId: video.id } },
      });
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

      const untouched = await prisma.collectionVideo.findMany({
        where: { videoId: elsewhere.id },
        select: { collectionId: true },
      });
      expect(untouched).toEqual([{ collectionId: theirs.id }]);
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

      await seedVideo(south.id, 'Cartman Gets an Anal Probe', { ...publishable }, { seasonId });
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
   * The title page's hero button and every row's resume bar, in one read.
   *
   * Order comes through the membership, which is the point: the same video can
   * be episode three of a show and item one of a best-of row, and this endpoint
   * has to answer about *this* collection.
   */
  describe('GET /collections/:slug/progress', () => {
    let show: { id: string; slug: string };
    let first: { id: string; slug: string };
    let second: { id: string; slug: string };

    const beat = (id: string, positionSec: number) =>
      admin
        .post(`/videos/${id}/heartbeat`)
        .send({
          playSessionId: '11111111-1111-4111-8111-111111111111',
          positionSec,
          deltaSec: 30,
        })
        .expect(200);

    beforeEach(async () => {
      show = await createCollection('South Park');
      first = await seedVideo(show.id, 'One', publishable, { orderIndex: 1 });
      second = await seedVideo(show.id, 'Two', publishable, { orderIndex: 2 });
      await admin.post(`/videos/${first.id}/publish`).expect(200);
      await admin.post(`/videos/${second.id}/publish`).expect(200);
      await publishCollection(show.id);
    });

    it('offers the first video when nothing has been watched', async () => {
      const response = await admin.get(`/collections/${show.slug}/progress`).expect(200);

      expect(response.body.next).toMatchObject({
        videoId: first.id,
        slug: first.slug,
        lastPositionSec: 0,
      });
      expect(response.body.items).toEqual([]);
    });

    it('offers the next unfinished one, and reports how far each got', async () => {
      // 119 of 120 seconds is past the completion threshold.
      await beat(first.id, 119);

      const response = await admin.get(`/collections/${show.slug}/progress`).expect(200);

      expect(response.body.next.videoId).toBe(second.id);
      expect(response.body.items).toEqual([
        { videoId: first.id, lastPositionSec: 119, maxPositionSec: 119, completed: true },
      ]);
    });

    it('resumes a half-watched video rather than skipping it', async () => {
      await beat(first.id, 30);

      const response = await admin.get(`/collections/${show.slug}/progress`).expect(200);

      expect(response.body.next).toMatchObject({ videoId: first.id, lastPositionSec: 30 });
    });

    /** One person's positions are not another's. */
    it('is scoped to the caller', async () => {
      await beat(first.id, 30);
      const user = await asUser();

      const response = await user.get(`/collections/${show.slug}/progress`).expect(200);

      expect(response.body.items).toEqual([]);
      expect(response.body.next).toMatchObject({ videoId: first.id, lastPositionSec: 0 });
    });

    /**
     * The collection's My List button reads this, for the same reason the
     * video's page reads it off `/videos/:id/stats`: it is the per-caller read
     * the title page already makes, so the button can say "in my list" on the
     * first paint rather than after a round trip nobody asked for.
     */
    it('says whether the collection is on the caller’s list', async () => {
      const before = await admin.get(`/collections/${show.slug}/progress`).expect(200);
      expect(before.body.inMyList).toBe(false);

      await admin.post('/me/watchlist').send({ collectionId: show.id }).expect(200);

      const after = await admin.get(`/collections/${show.slug}/progress`).expect(200);
      expect(after.body.inMyList).toBe(true);
    });

    it('reports another caller’s saved collection as unsaved', async () => {
      await admin.post('/me/watchlist').send({ collectionId: show.id }).expect(200);
      const user = await asUser();

      const response = await user.get(`/collections/${show.slug}/progress`).expect(200);

      expect(response.body.inMyList).toBe(false);
    });

    it('never offers a draft video to a USER', async () => {
      const draft = await seedVideo(show.id, 'Zero', publishable, { orderIndex: 0 });
      const user = await asUser();

      const asAdmin = await admin.get(`/collections/${show.slug}/progress`).expect(200);
      const asViewer = await user.get(`/collections/${show.slug}/progress`).expect(200);

      // The admin can see it, so the draft really is first in order.
      expect(asAdmin.body.next.videoId).toBe(draft.id);
      expect(asViewer.body.next.videoId).toBe(first.id);
    });

    /**
     * The membership is what carries the order, so a video sitting in two
     * collections is answered about differently by each.
     */
    it('answers about the collection asked for, not the video', async () => {
      const bestOf = await createCollection('Best Of');
      await prisma.collectionVideo.create({
        data: { collectionId: bestOf.id, videoId: second.id, orderIndex: 1 },
      });
      await publishCollection(bestOf.id);

      const inShow = await admin.get(`/collections/${show.slug}/progress`).expect(200);
      const inBestOf = await admin.get(`/collections/${bestOf.slug}/progress`).expect(200);

      expect(inShow.body.next.videoId).toBe(first.id);
      // The only member of the other collection, so it is what that one offers.
      expect(inBestOf.body.next.videoId).toBe(second.id);
    });

    it('404s a collection the caller cannot see', async () => {
      const hidden = await createCollection('Hidden');
      const user = await asUser();

      await user.get(`/collections/${hidden.slug}/progress`).expect(404);
    });

    it('has nothing to offer for an empty collection', async () => {
      const empty = await createCollection('Empty');

      const response = await admin.get(`/collections/${empty.slug}/progress`).expect(200);

      expect(response.body).toEqual({ next: null, items: [], inMyList: false });
    });
  });

  describe('publish gating', () => {
    it('refuses a video that is not ready, and says what is missing', async () => {
      const collection = await createCollection('Harry Potter');
      const video = await seedVideo(collection.id, 'Philosophers Stone');

      const response = await admin.post(`/videos/${video.id}/publish`).expect(400);

      expect(response.body.missingFields).toEqual(
        expect.arrayContaining(['durationSec', 'bannerKey']),
      );
    });

    /**
     * A description used to be required and made the library unpublishable:
     * ingest cannot write one, so every episode needed a person to type
     * something before any of them could go out — and a collection needs a
     * publishable video, so the collection was blocked too.
     */
    it('publishes a video that has no description', async () => {
      const collection = await createCollection('Harry Potter');
      const video = await seedVideo(collection.id, 'Philosophers Stone', {
        ...publishable,
        description: null,
      });

      const response = await admin.post(`/videos/${video.id}/publish`).expect(200);
      expect(response.body.state).toBe('PUBLISHED');
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

      expect(response.body.missingFields).toContain('bannerKey');
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

    /**
     * The guard moved with the field.
     *
     * A video no longer carries a season — a *membership* does — so this is no
     * longer something `PATCH /videos/:id` could get wrong. The endpoint that
     * puts a video in a collection is where a foreign season has to be refused,
     * and it names the collection it is acting on, which is what makes the check
     * possible at all.
     */
    it("refuses a season belonging to another collection when adding a video", async () => {
      const south = await createCollection('South Park');
      const simpsons = await createCollection('The Simpsons');
      const foreign = await admin
        .post('/seasons')
        .send({ collectionId: simpsons.id, number: 1 })
        .expect(201);
      const video = await seedVideo(south.id, 'Pilot');

      await admin
        .post(`/collections/${south.id}/videos`)
        .send({ videoId: video.id, seasonId: foreign.body.id })
        .expect(400);
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

    /**
     * The filter a catalogue listing needs.
     *
     * Browse shows collections, so a video on one has nowhere to appear: the
     * shelf is a single card and the video is on it. A film is therefore a video
     * that **no collection claims** — anything on a shelf is reached through the
     * shelf, whether that shelf holds seasons or is a folder of eight films.
     *
     * Only the join can answer that. There is no column saying so, which is the
     * whole point of memberships.
     */
    it('lists the films: the videos no collection claims', async () => {
      const show = await createCollection('South Park');
      const season = await addSeason(show.id, 1);
      await seedVideo(show.id, 'Cartman', {}, { seasonId: season.id });

      // A shelf with no seasons is still a shelf: the films on it are reached
      // through it, and searching one of their titles returns it.
      const saga = await createCollection('Harry Potter');
      await seedVideo(saga.id, 'Chamber of Secrets');
      await seedVideo(saga.id, 'Philosophers Stone');

      await seedStandaloneVideo('Chinatown');

      const films = await admin.get('/videos?film=true').expect(200);
      expect(films.body.items.map((video: { title: string }) => video.title)).toEqual([
        'Chinatown',
      ]);
      expect(films.body.total).toBe(1);

      // The opposite has to mean the opposite. `z.coerce.boolean()` would read
      // "false" as true and hand back the films as well.
      const episodes = await admin.get('/videos?film=false').expect(200);
      expect(episodes.body.items.map((video: { title: string }) => video.title)).toEqual([
        'Cartman',
        'Chamber of Secrets',
        'Philosophers Stone',
      ]);

      // Omitted is not the same as false: it means "do not filter".
      const everything = await admin.get('/videos').expect(200);
      expect(everything.body.items).toHaveLength(4);
    });

    /**
     * The case that fails if the rule is ever written as "the membership has no
     * `seasonId`". A null season says only that nobody filed it — an extra
     * sitting beside three seasons of a show is part of that show, not a film.
     * The current rule never looks at `seasonId`; this holds it to that.
     */
    it('keeps a special filed straight under a show out of the films', async () => {
      const show = await createCollection('South Park');
      await addSeason(show.id, 1);
      await seedVideo(show.id, 'Behind the Scenes');

      const films = await admin.get('/videos?film=true').expect(200);
      expect(films.body.items).toEqual([]);
      expect(films.body.total).toBe(0);
    });

    /**
     * A film is only interesting to browse once it is published, and the
     * visibility rule is not something the new filter may weaken.
     */
    it('keeps the visibility rule when filtering to films', async () => {
      await seedStandaloneVideo('Draft Film');
      const live = await seedStandaloneVideo('Live Film', publishable);
      await admin.post(`/videos/${live.id}/publish`).expect(200);

      const user = await asUser();
      const visible = await user.get('/videos?film=true').expect(200);
      expect(visible.body.items.map((video: { title: string }) => video.title)).toEqual([
        'Live Film',
      ]);
    });

    /**
     * A video on a hidden shelf is withheld, and now for a simpler reason.
     *
     * It used to need a clause of its own: a published film whose only shelf was
     * a draft had to be withheld as an instalment of something hidden, while a
     * film on a *visible* shelf stood as one. Membership alone answers both now,
     * so the leak that clause guarded is closed by the rule itself — and it is
     * closed for the admin too, who simply reaches it through the shelf.
     */
    it('withholds a video whose only shelf is one the viewer cannot see', async () => {
      const unreleased = await createCollection('Unreleased Saga');
      const film = await seedVideo(unreleased.id, 'Secret Film', publishable);
      await admin.post(`/videos/${film.id}/publish`).expect(200);

      const user = await asUser();
      const theirs = await user.get('/videos?film=true').expect(200);
      expect(theirs.body.items).toEqual([]);
      expect(theirs.body.total).toBe(0);

      // The admin can see the shelf — which is exactly how they reach the video.
      const mine = await admin.get('/videos?film=true').expect(200);
      expect(mine.body.items).toEqual([]);
    });

    /** The other half: a shelf the viewer *can* see is still the way in. */
    it('keeps a video on a visible shelf out of the films too', async () => {
      const saga = await createCollection('Harry Potter');
      const film = await seedVideo(saga.id, 'Goblet of Fire', publishable);
      await admin.post(`/videos/${film.id}/publish`).expect(200);
      await publishCollection(saga.id);

      const user = await asUser();
      const films = await user.get('/videos?film=true').expect(200);
      expect(films.body.items).toEqual([]);

      // Not hidden — reached through the shelf. `film=false` is the other half
      // of the partition and is where it turns up.
      const onShelves = await user.get('/videos?film=false').expect(200);
      expect(onShelves.body.items.map((video: { title: string }) => video.title)).toEqual([
        'Goblet of Fire',
      ]);
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

    /**
     * A collection is a shelf, and emptying a shelf does not burn the books.
     *
     * This used to delete the videos, which followed from a video having exactly
     * one parent. It no longer does: a video stands on its own, may sit in other
     * collections, and carries watch history and comments that deleting it would
     * take with it. The seasons go, because a season only exists inside its
     * collection, and the memberships go with them.
     */
    it('takes its seasons and memberships, and leaves the videos standing', async () => {
      const collection = await createCollection('Harry Potter');
      await admin.post('/seasons').send({ collectionId: collection.id, number: 1 }).expect(201);
      const video = await seedVideo(collection.id, 'Philosophers Stone');

      await admin.delete(`/collections/${collection.id}`).expect(204);

      await expect(prisma.season.count()).resolves.toBe(0);
      await expect(prisma.collectionVideo.count()).resolves.toBe(0);

      const survivor = await prisma.video.findUnique({ where: { id: video.id } });
      expect(survivor).not.toBeNull();
    });
  });

  describe('DELETE /videos/:id', () => {
    /**
     * A video with every kind of file it can own, actually written to disk.
     *
     * Seeding the row alone would let a service that deletes nothing pass every
     * assertion below, since `storage.delete` forces and an absent file is a
     * success.
     */
    async function seedVideoWithFiles(overrides: Record<string, unknown> = {}) {
      const video = await seedStandaloneVideo('Arrival', {
        posterKey: 'posters/arrival.jpg',
        bannerKey: 'banners/arrival.jpg',
        playbackKey: 'loose/arrival.converted.mp4',
        ...overrides,
      });

      const row = await prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { storageKey: true, posterKey: true, bannerKey: true, playbackKey: true },
      });

      await prisma.subtitle.create({
        data: {
          videoId: video.id,
          language: 'en',
          label: 'English',
          storageKey: `subtitles/${video.id}/en.vtt`,
          sourceKey: 'loose/arrival.en.srt',
          sourceFormat: 'srt',
        },
      });

      await storage.save('media', row.storageKey, Buffer.from('source'));
      await storage.save('media', 'loose/arrival.en.srt', Buffer.from('sidecar'));
      await storage.save('derived', 'posters/arrival.jpg', Buffer.from('poster'));
      await storage.save('derived', 'banners/arrival.jpg', Buffer.from('banner'));
      await storage.save('media', 'loose/arrival.converted.mp4', Buffer.from('mp4'));
      await storage.save('derived', `subtitles/${video.id}/en.vtt`, Buffer.from('WEBVTT'));

      return { ...video, storageKey: row.storageKey };
    }

    it('keeps the source file unless asked', async () => {
      const video = await seedVideoWithFiles();

      await admin.delete(`/videos/${video.id}`).expect(204);

      await expect(storage.exists('media', video.storageKey)).resolves.toBe(true);
      await expect(prisma.video.count()).resolves.toBe(0);
    });

    it('takes the source file, and its sidecars, when asked explicitly', async () => {
      const video = await seedVideoWithFiles();

      await admin.delete(`/videos/${video.id}?deleteFiles=true`).expect(204);

      await expect(storage.exists('media', video.storageKey)).resolves.toBe(false);
      // Leaving this behind is how the next scan raises an orphaned-subtitle
      // issue for a video nobody can look at.
      await expect(storage.exists('media', 'loose/arrival.en.srt')).resolves.toBe(false);
    });

    /**
     * The half with no precedent anywhere else, and the one most likely to rot.
     *
     * Derived output belongs to a row that no longer exists. Nothing sweeps it,
     * so leaving it means every delete leaks files nobody can reach again.
     */
    it('always removes generated output, asked or not', async () => {
      const video = await seedVideoWithFiles();

      await admin.delete(`/videos/${video.id}`).expect(204);

      await expect(storage.exists('derived', 'posters/arrival.jpg')).resolves.toBe(false);
      await expect(storage.exists('derived', 'banners/arrival.jpg')).resolves.toBe(false);
      await expect(storage.exists('derived', `subtitles/${video.id}/en.vtt`)).resolves.toBe(false);
      // The directory too — nothing has ever cleaned it up.
      await expect(storage.exists('derived', `subtitles/${video.id}`)).resolves.toBe(false);
    });

    /**
     * The converted file lives in `MEDIA_ROOT` now, beside its source, and this
     * is the reason it cannot wait for `deleteFiles` like the source does.
     *
     * Ingest skips it only because a row claims it as `playbackKey`. Leave it
     * behind when the row goes and the next scan finds an unclaimed `.mp4` in a
     * watched folder — and rebuilds the entry the admin just deleted, under a
     * new id and with none of its history.
     */
    it('takes the converted file out of the media tree even on the recoverable delete', async () => {
      const video = await seedVideoWithFiles();

      await admin.delete(`/videos/${video.id}`).expect(204);

      // The source stays, because that one *is* recoverable.
      await expect(storage.exists('media', video.storageKey)).resolves.toBe(true);
      await expect(storage.exists('media', 'loose/arrival.converted.mp4')).resolves.toBe(false);
    });

    /**
     * Every key lives on the row or on a `Subtitle` row, and the cascade takes
     * both. Reading them after the delete finds nothing, and this is the test
     * that says so: reorder the service and the tracks survive their video.
     */
    it('collects the subtitle keys before the cascade takes them', async () => {
      const video = await seedVideoWithFiles();

      await admin.delete(`/videos/${video.id}`).expect(204);

      await expect(prisma.subtitle.count()).resolves.toBe(0);
      await expect(storage.exists('derived', `subtitles/${video.id}/en.vtt`)).resolves.toBe(false);
    });

    /**
     * Deleting the row under a live job leaves ffmpeg writing to a path whose
     * row is gone, and the job's own bookkeeping then fails against a row that
     * no longer exists.
     */
    it.each(['QUEUED', 'RUNNING'] as const)('refuses while a %s job exists', async (status) => {
      const video = await seedVideoWithFiles();
      await prisma.mediaJob.create({ data: { videoId: video.id, type: 'TRANSCODE', status } });

      await admin.delete(`/videos/${video.id}`).expect(400);

      await expect(prisma.video.count()).resolves.toBe(1);
      await expect(storage.exists('media', 'loose/arrival.converted.mp4')).resolves.toBe(true);
    });

    it.each(['SUCCEEDED', 'FAILED', 'CANCELLED'] as const)(
      'is not blocked by a %s job',
      async (status) => {
        const video = await seedVideoWithFiles();
        await prisma.mediaJob.create({ data: { videoId: video.id, type: 'TRANSCODE', status } });

        await admin.delete(`/videos/${video.id}`).expect(204);
      },
    );

    /**
     * Reclaiming a source is allowed *because* the converted file replaces it.
     * Sweeping that up as derived output would destroy the only copy of a film
     * through the branch labelled as the recoverable one.
     */
    it('refuses the recoverable delete when the converted file is the only copy', async () => {
      const video = await seedVideoWithFiles({ sourceDeletedAt: new Date() });

      await admin.delete(`/videos/${video.id}`).expect(400);

      await expect(prisma.video.count()).resolves.toBe(1);
      await expect(storage.exists('media', 'loose/arrival.converted.mp4')).resolves.toBe(true);
    });

    it('deletes a reclaimed video when the caller means it', async () => {
      const video = await seedVideoWithFiles({ sourceDeletedAt: new Date() });
      // A reclaimed source is already gone; the delete must not trip over it.
      await storage.delete('media', video.storageKey);

      await admin.delete(`/videos/${video.id}?deleteFiles=true`).expect(204);

      await expect(prisma.video.count()).resolves.toBe(0);
      await expect(storage.exists('media', 'loose/arrival.converted.mp4')).resolves.toBe(false);
    });

    /** Nothing to lose, so nothing to refuse — a reclaim that never converted. */
    it('deletes a reclaimed video with no converted file at all', async () => {
      const video = await seedVideoWithFiles({ sourceDeletedAt: new Date(), playbackKey: null });

      await admin.delete(`/videos/${video.id}`).expect(204);
    });

    /**
     * Everything hanging off a video goes with it — which is a real cost, not a
     * detail, and is why the admin screen names it before doing it.
     *
     * `Person` is deliberately not truncated between cases in this file, so the
     * name is made unique the same way `seedVideo` makes storage keys unique.
     */
    it('takes the watch history, comments and credits with it', async () => {
      const video = await seedVideoWithFiles();
      const person = await prisma.person.create({
        data: {
          name: `Denis Villeneuve ${Math.round(performance.now() * 1000)}`,
          slug: `denis-${Math.round(performance.now() * 1000)}`,
        },
      });
      await prisma.credit.create({
        data: { videoId: video.id, personId: person.id, role: 'DIRECTOR' },
      });
      await admin
        .post(`/videos/${video.id}/comments`)
        .send({ body: 'The one about the heptapods.' })
        .expect(201);

      await admin.delete(`/videos/${video.id}`).expect(204);

      await expect(prisma.comment.count()).resolves.toBe(0);
      await expect(prisma.credit.count({ where: { personId: person.id } })).resolves.toBe(0);
    });

    it('is 404 for an id that never existed', async () => {
      await admin.delete('/videos/nope').expect(404);
    });

    /** A query flag must never be a way round the role gate. */
    it('is 403 for a USER, flag or no flag', async () => {
      const video = await seedVideoWithFiles();
      const user = await asUser();

      await user.delete(`/videos/${video.id}`).expect(403);
      await user.delete(`/videos/${video.id}?deleteFiles=true`).expect(403);

      await expect(prisma.video.count()).resolves.toBe(1);
      await expect(storage.exists('media', video.storageKey)).resolves.toBe(true);
    });

    it('rejects a deleteFiles value that is not a boolean', async () => {
      const video = await seedVideoWithFiles();

      await admin.delete(`/videos/${video.id}?deleteFiles=maybe`).expect(400);

      await expect(prisma.video.count()).resolves.toBe(1);
    });
  });
});
