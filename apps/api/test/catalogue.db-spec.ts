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
 * `GET /library` — the catalogue as one list, against a real Postgres.
 *
 * Everything here is a database guarantee a stub could not have an opinion
 * about. The endpoint answers over two tables and merges the results, so the
 * question that matters most is whether a page of the union is *actually* a
 * page: no row repeated between pages, none skipped, and a total that counts
 * both halves. The rest is the visibility rules holding across a join — a video
 * on a shelf never standing as a card of its own, a draft video's title or
 * credits never pulling its shelf into a viewer's results, a `?state=` a USER
 * has no business honouring.
 */
describe('Catalogue (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  // Its own path: the token file is a live credential and two suites sharing
  // one delete each other's.
  const tokenFile = join(tmpdir(), 'video-streaming-catalogue-test.bootstrap-token');

  let workspace: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;

  async function startApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('json replacer', bigIntReplacer);
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
    prisma = app.get(PrismaService);
  }

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'catalogue-'));
    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = tokenFile;
    process.env.MEDIA_ROOT = join(workspace, 'media');
    process.env.DERIVED_ROOT = join(workspace, 'derived');
    await rm(tokenFile, { force: true });

    await startApp();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "InviteToken", "User", "session", "Collection", "Season", "Video", "Person", "Credit" RESTART IDENTITY CASCADE',
    );
    await app.close();
    await rm(tokenFile, { force: true });

    await startApp();

    admin = request.agent(app.getHttpServer());
    await admin
      .post('/auth/redeem')
      .send({
        token: (await readFile(tokenFile, 'utf8')).trim(),
        username: 'ada',
        password: PASSWORD,
      })
      .expect(201);
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

  /** A shelf. `PUBLISHED` unless a test is about drafts. */
  async function shelf(title: string, extra: Record<string, unknown> = {}) {
    const created = await admin.post('/collections').send({ title }).expect(201);
    await prisma.collection.update({
      where: { id: created.body.id },
      data: { state: 'PUBLISHED', ...extra },
    });
    return created.body as { id: string; slug: string };
  }

  /** What makes a shelf a *series* — the whole of the film rule. */
  async function season(collectionId: string, number = 1) {
    const created = await admin.post('/seasons').send({ collectionId, number }).expect(201);
    return created.body as { id: string };
  }

  let seq = 0;

  async function video(
    title: string,
    { collectionId, seasonId, ...extra }: Record<string, unknown> = {},
  ) {
    seq += 1;
    return prisma.video.create({
      data: {
        slug: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${seq}`,
        title,
        normalisedTitle: title.toLowerCase().replace(/[^a-z0-9]/g, ''),
        storageKey: `drive/${title}-${seq}.mp4`,
        contentTag: 'tag',
        originalName: `${title}.mp4`,
        mimeType: 'video/mp4',
        sizeBytes: BigInt(1024),
        fileMtime: new Date('2026-01-01T00:00:00Z'),
        state: 'PUBLISHED',
        ...(collectionId
          ? { collections: { create: { collectionId: collectionId as string, seasonId: seasonId as string | undefined } } }
          : {}),
        ...extra,
      },
      select: { id: true, slug: true, title: true },
    });
  }

  async function person(name: string): Promise<string> {
    const created = await admin.post('/people').send({ name }).expect(201);
    return created.body.id as string;
  }

  async function creditCollection(collectionId: string, personId: string) {
    await admin
      .post(`/collections/${collectionId}/credits`)
      .send({ personId, role: 'ACTOR' })
      .expect(201);
  }

  async function creditVideo(videoId: string, personId: string) {
    await admin.post(`/videos/${videoId}/credits`).send({ personId, role: 'ACTOR' }).expect(201);
  }

  /** Titles in the order the endpoint returned them — what a failure reads best in. */
  async function titles(agent: request.Agent, query = ''): Promise<string[]> {
    const response = await agent.get(`/library${query}`).expect(200);
    return response.body.items.map((item: { title: string }) => item.title);
  }

  describe('the two halves together', () => {
    it('lists shelves and films in one order, not one after the other', async () => {
      // The shelf and the film share a title but are unrelated — a film on the
      // shelf would not be a card at all, and this is about the merge.
      await shelf('Alien');
      await video('Alien');
      await video('Brazil');
      await video('Dune');

      // Interleaved by title: the shelf lands first, the two films around it.
      expect(await titles(admin, '?sort=title')).toEqual(['Alien', 'Alien', 'Brazil', 'Dune']);
    });

    it('counts both halves in the total', async () => {
      await shelf('Alien');
      await video('Alien');
      await video('Brazil');

      const response = await admin.get('/library').expect(200);

      expect(response.body).toMatchObject({ total: 3, limit: 50, offset: 0, hasMore: false });
    });

    it('says which kind each entry is, and what a shelf holds', async () => {
      const alien = await shelf('Alien');
      await season(alien.id);
      await video('Alien', { collectionId: alien.id });
      await video('Brazil');

      const response = await admin.get('/library?sort=title').expect(200);

      expect(response.body.items).toMatchObject([
        { kind: 'collection', title: 'Alien', seasonsHere: 1, videosHere: 1 },
        { kind: 'film', title: 'Brazil', durationSec: null },
      ]);
    });

    it('does not leak the sort keys it selected', async () => {
      await video('Brazil');

      const [film] = (await admin.get('/library').expect(200)).body.items;

      expect(film).not.toHaveProperty('normalisedTitle');
      expect(film).not.toHaveProperty('createdAt');
    });

    /**
     * The home hero reads this endpoint when there is no `RECENTLY_ADDED` row
     * to read instead, and plays the trailer of whatever it features.
     *
     * Asserted positively because the way this breaks is silent: `withoutSortKeys`
     * rebuilds the card field by field, so a field missing from *it* is
     * `undefined` in the response while the select, the row type and the mapper
     * all still carry it — and every other assertion here is a subset match that
     * would not notice. The symptom is a hero that never plays a trailer.
     */
    it('carries the trailer id the home hero plays', async () => {
      const alien = await shelf('Alien', { trailerYoutubeId: 'dQw4w9WgXcQ' });
      await season(alien.id);
      await video('Brazil', { trailerYoutubeId: 'aaaaaaaaaaa' });

      const { items } = (await admin.get('/library?sort=title').expect(200)).body;

      expect(items).toMatchObject([
        { kind: 'collection', title: 'Alien', trailerYoutubeId: 'dQw4w9WgXcQ' },
        { kind: 'film', title: 'Brazil', trailerYoutubeId: 'aaaaaaaaaaa' },
      ]);
    });

    /** Absent is the ordinary case, and it must arrive as null rather than missing. */
    it('says null for an entry with no trailer', async () => {
      await video('Brazil');

      const [film] = (await admin.get('/library').expect(200)).body.items;

      expect(film).toHaveProperty('trailerYoutubeId', null);
    });
  });

  describe('paging across the union', () => {
    /**
     * The one that matters. A page is assembled from two queries and a merge,
     * so a boundary that disagrees with itself repeats a row on one page and
     * drops another — which offset paging over a non-total order does silently.
     */
    it('walks the whole library once, with no repeat and no gap', async () => {
      await shelf('Alpha');
      await shelf('Charlie');
      await video('Alpha');
      await video('Bravo');
      await video('Delta');
      await video('Echo');

      const walked = [
        ...(await titles(admin, '?sort=title&limit=2&offset=0')),
        ...(await titles(admin, '?sort=title&limit=2&offset=2')),
        ...(await titles(admin, '?sort=title&limit=2&offset=4')),
      ];

      expect(walked).toEqual(['Alpha', 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
      expect(walked).toHaveLength((await titles(admin, '?sort=title&limit=100')).length);
    });

    it('reports hasMore from the combined total', async () => {
      await shelf('Alpha');
      await video('Bravo');
      await video('Charlie');

      const first = await admin.get('/library?limit=2&offset=0').expect(200);
      const last = await admin.get('/library?limit=2&offset=2').expect(200);

      expect(first.body).toMatchObject({ hasMore: true, total: 3 });
      expect(last.body).toMatchObject({ hasMore: false, total: 3 });
    });

    it('refuses a page deeper than the union is willing to read for', async () => {
      // The offset is what the work scales with here — both sides are read to
      // `offset + limit` — so it is bounded rather than left to the caller.
      await admin.get('/library?offset=10001').expect(400);
      await admin.get('/library?offset=10000').expect(200);
    });
  });

  describe('sorting', () => {
    it('orders by year, newest first, with an unknown year last', async () => {
      await video('Old', { year: 1979 });
      await video('New', { year: 2024 });
      await video('Undated');

      expect(await titles(admin, '?sort=year')).toEqual(['New', 'Old', 'Undated']);
    });

    it('orders by when a thing was added', async () => {
      await video('First', { createdAt: new Date('2026-01-01T00:00:00Z') });
      await video('Second', { createdAt: new Date('2026-06-01T00:00:00Z') });

      expect(await titles(admin, '?sort=added')).toEqual(['Second', 'First']);
    });

    it('sorts a shelf and a film with the same title deterministically', async () => {
      // Two right answers to one search. The order between them has to be
      // stable, or a card moves between pages on identical requests.
      await shelf('Dune');
      await video('Dune');

      const first = await admin.get('/library?sort=title').expect(200);
      const again = await admin.get('/library?sort=title').expect(200);

      expect(first.body.items.map((i: { kind: string }) => i.kind)).toEqual([
        'collection',
        'film',
      ]);
      expect(again.body.items).toEqual(first.body.items);
    });
  });

  describe('kind', () => {
    it('partitions the library between films and shows', async () => {
      const show = await shelf('Breaking Bad');
      const showSeason = await season(show.id);
      await video('Pilot', { collectionId: show.id, seasonId: showSeason.id });

      const saga = await shelf('Alien Saga');
      await video('Alien', { collectionId: saga.id });
      await video('Brazil');

      const films = await titles(admin, '?kind=FILM&sort=title');
      const shows = await titles(admin, '?kind=SHOW&sort=title');
      const everything = await titles(admin, '?sort=title');

      // A saga of films is films — its chip already says "1 film". `Alien` is
      // not among them: it is on that saga, and a video on a shelf is reached
      // through the shelf rather than listed beside it.
      expect(films).toEqual(['Alien Saga', 'Brazil']);
      expect(shows).toEqual(['Breaking Bad']);
      // Nothing falls between the two, which is what makes the filter safe to
      // offer: an entry cannot become unreachable by turning it on.
      expect([...films, ...shows].sort()).toEqual([...everything].sort());
    });

    it('keeps an episode out of both, since it is neither', async () => {
      const show = await shelf('Breaking Bad');
      const showSeason = await season(show.id);
      await video('Pilot', { collectionId: show.id, seasonId: showSeason.id });

      expect(await titles(admin, '?kind=FILM')).not.toContain('Pilot');
      expect(await titles(admin)).not.toContain('Pilot');
    });

    /**
     * The same for a shelf holding no seasons at all.
     *
     * This is the saga shape, and it is the case the rule used to let through:
     * eight films on one shelf were listed as eight cards beside it. Seasons
     * are no longer any part of the answer — a membership is.
     */
    it('keeps a video on a season-less shelf out of both as well', async () => {
      const saga = await shelf('Alien Saga');
      await video('Alien', { collectionId: saga.id });

      expect(await titles(admin, '?kind=FILM')).toEqual(['Alien Saga']);
      expect(await titles(admin)).toEqual(['Alien Saga']);
    });
  });

  describe('genres and tags', () => {
    it('narrows on several genres at once, rather than widening', async () => {
      await video('Both', { genres: ['Drama', 'Horror'] });
      await video('Only drama', { genres: ['Drama'] });

      expect(await titles(admin, '?genre=Drama&genre=Horror')).toEqual(['Both']);
      expect(await titles(admin, '?genre=Drama&sort=title')).toEqual(['Both', 'Only drama']);
    });

    it('filters shelves and films alike', async () => {
      const shelfWith = await shelf('Shelf', { genres: ['Horror'] });
      await video('Episode', { collectionId: shelfWith.id, genres: [] });
      await video('Film', { genres: ['Horror'] });

      expect((await titles(admin, '?genre=Horror&sort=title')).sort()).toEqual(['Film', 'Shelf']);
    });

    it('still honours the single curator-authored tag the chips link to', async () => {
      await video('Tagged', { tags: ['christmas'] });
      await video('Untagged');

      expect(await titles(admin, '?tag=christmas')).toEqual(['Tagged']);
    });

    describe('GET /library/genres', () => {
      it('counts the genres the visible library holds, commonest first', async () => {
        await video('One', { genres: ['Drama', 'Horror'] });
        await video('Two', { genres: ['Drama'] });

        const response = await admin.get('/library/genres').expect(200);

        expect(response.body).toMatchObject({ total: 2 });
        expect(response.body.items).toEqual([
          { genre: 'Drama', count: 2 },
          { genre: 'Horror', count: 1 },
        ]);
      });

      it('never offers a genre only a draft carries', async () => {
        await video('Draft', { genres: ['Secret'], state: 'DRAFT' });
        await video('Published', { genres: ['Drama'] });

        const response = await (await asUser()).get('/library/genres').expect(200);

        expect(response.body.items).toEqual([{ genre: 'Drama', count: 1 }]);
      });
    });
  });

  describe('searching', () => {
    it('matches a title or a description, as it always did', async () => {
      await video('Alien', { description: 'In space.' });
      await video('Brazil');

      expect(await titles(admin, '?q=space')).toEqual(['Alien']);
    });

    it('finds a film by an actor credited on it', async () => {
      const rickman = await person('Alan Rickman');
      const film = await video('Die Hard');
      await creditVideo(film.id, rickman);
      await video('Brazil');

      expect(await titles(admin, '?q=rickman')).toEqual(['Die Hard']);
    });

    it('finds a shelf by an actor credited on it', async () => {
      const rickman = await person('Alan Rickman');
      const potter = await shelf('Harry Potter');
      await creditCollection(potter.id, rickman);

      expect(await titles(admin, '?q=rickman')).toEqual(['Harry Potter']);
    });

    it('answers a name credited on a shelf with the shelf alone', async () => {
      // The video on it is not a separate answer: it is on that shelf, and the
      // shelf is how it is reached. Its own credits still pull the shelf in —
      // see the next case — so nothing on it becomes unfindable.
      const rickman = await person('Alan Rickman');
      const potter = await shelf('Harry Potter');
      await video('Philosophers Stone', { collectionId: potter.id });
      await creditCollection(potter.id, rickman);

      expect(await titles(admin, '?q=rickman')).toEqual(['Harry Potter']);
    });

    it('finds a shelf by an actor credited on one of its videos', async () => {
      const rickman = await person('Alan Rickman');
      const potter = await shelf('Harry Potter');
      const stone = await video('Philosophers Stone', { collectionId: potter.id });
      await creditVideo(stone.id, rickman);

      expect(await titles(admin, '?q=rickman')).toEqual(['Harry Potter']);
    });

    /**
     * The half that makes hiding a shelf's videos safe.
     *
     * Without it, publishing a saga puts every film on it out of reach of
     * search: the shelf is one card named something else, and the films are no
     * longer cards at all. That was a real report — "browse does not show my
     * films" — and this is what stops it recurring.
     */
    it('finds a shelf by the title of a video on it', async () => {
      const potter = await shelf('Harry Potter');
      await video('Prisoner of Azkaban', { collectionId: potter.id });
      await video('Brazil');

      expect(await titles(admin, '?q=azkaban')).toEqual(['Harry Potter']);
    });

    it('answers with the shelf alone, never the shelf and the video', async () => {
      const potter = await shelf('Harry Potter');
      await video('Prisoner of Azkaban', { collectionId: potter.id });

      // Searching does not re-admit what the unsearched grid leaves out.
      expect(await titles(admin, '?q=azkaban')).toEqual(['Harry Potter']);
      expect(await titles(admin, '?q=azkaban')).not.toContain('Prisoner of Azkaban');
    });

    it('does not reach a viewer through a draft video’s title', async () => {
      // The sibling of the credits rule below: a title is just as much a way to
      // learn that something unpublished exists.
      const potter = await shelf('Harry Potter');
      await video('Unreleased Sequel', { collectionId: potter.id, state: 'DRAFT' });

      expect(await titles(await asUser(), '?q=unreleased')).toEqual([]);
      expect(await titles(admin, '?q=unreleased')).toEqual(['Harry Potter']);
    });

    it('does not reach a viewer through a draft episode’s credits', async () => {
      // Otherwise a name is a way to learn who is in something not published.
      const rickman = await person('Alan Rickman');
      const potter = await shelf('Harry Potter');
      const secret = await video('Unreleased', { collectionId: potter.id, state: 'DRAFT' });
      await creditVideo(secret.id, rickman);

      expect(await titles(await asUser(), '?q=rickman')).toEqual([]);
      // The admin sees the shelf — the draft is on it, so it is not a card of
      // its own for anybody. That is the same rule, seen by someone allowed to.
      expect(await titles(admin, '?q=rickman')).toEqual(['Harry Potter']);
    });

    it('still finds a film standing on no shelf by its own title', async () => {
      await video('Brazil');

      expect(await titles(admin, '?q=brazil')).toEqual(['Brazil']);
    });
  });

  describe('visibility', () => {
    it('shows a viewer only what is published', async () => {
      await video('Published');
      await video('Hidden', { state: 'DRAFT' });

      expect(await titles(await asUser())).toEqual(['Published']);
      expect((await titles(admin)).sort()).toEqual(['Hidden', 'Published']);
    });

    it('answers a viewer asking for drafts with nothing, not with drafts', async () => {
      await video('Hidden', { state: 'DRAFT' });

      expect(await titles(await asUser(), '?state=DRAFT')).toEqual([]);
      expect(await titles(admin, '?state=DRAFT')).toEqual(['Hidden']);
    });

    it('does not offer a video on an invisible shelf as a film', async () => {
      // It is an instalment of something the caller cannot see. Now covered by
      // the rule itself rather than by a clause of its own: a membership
      // disqualifies a video whether or not the caller can see what holds it.
      const draftShow = await shelf('Secret Show', { state: 'DRAFT' });
      await video('Episode One', { collectionId: draftShow.id });

      expect(await titles(await asUser())).toEqual([]);
    });

    it('shows a viewer the shelf, not the video standing on it', async () => {
      const saga = await shelf('Alien Saga');
      await video('Alien', { collectionId: saga.id });

      expect(await titles(await asUser())).toEqual(['Alien Saga']);
    });

    it('still shows a viewer a film on no shelf at all', async () => {
      await video('Brazil');

      expect(await titles(await asUser())).toEqual(['Brazil']);
    });
  });
});
