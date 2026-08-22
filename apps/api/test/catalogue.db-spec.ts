import type { INestApplication } from '@nestjs/common';
import { normaliseTitle } from '@video/shared';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service';
import { DbHarness, PASSWORD } from './db/harness';

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
  // Its own token path: the file is a live credential and two suites sharing one
  // delete each other's.
  const harness = new DbHarness({ name: 'catalogue', workspace: true, admin: 'ada' });

  let app: INestApplication;
  let prisma: PrismaService;
  let admin: request.Agent;

  beforeEach(async () => {
    await harness.start();
    ({ app, prisma, admin } = harness);
  });

  afterEach(() => harness.stop());

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
        // `normaliseTitle`, not a hand-rolled version of it. The one this
        // replaced did not fold accents, so `Amélie` was stored as `mlie` — and
        // every trigram query in the searching block runs against this column,
        // so an accent test would have failed for a reason nothing to do with
        // the code it was testing. The service writes this through `titleData()`.
        normalisedTitle: normaliseTitle(title),
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

  /**
   * The four things a search has to tolerate, end to end.
   *
   * Pinned here as well as in `relevance.spec.ts` because they are the only
   * cases that prove the *recall* half: the scorer can rank a misspelling
   * perfectly and still never see the row, because whether `intersteller` ever
   * reaches it is a question about `pg_trgm`, an index and a threshold. A unit
   * test cannot fail for that reason, and this one can.
   */
  describe('fuzzy searching', () => {
    it('finds a title through a misspelling', async () => {
      await video('Interstellar');
      await video('Brazil');

      expect(await titles(admin, '?q=intersteller')).toEqual(['Interstellar']);
    });

    it('finds a title from a word typed only partly', async () => {
      await video('Star Wars: Episode IV');
      await video('Brazil');

      expect(await titles(admin, '?q=star wa')).toEqual(['Star Wars: Episode IV']);
    });

    it('finds a title with the words in the wrong order', async () => {
      await video('The Matrix Reloaded');
      await video('Brazil');

      expect(await titles(admin, '?q=reloaded matrix')).toEqual(['The Matrix Reloaded']);
    });

    it('finds a title whose accent nobody typed', async () => {
      await video('Amélie');
      await video('Brazil');

      expect(await titles(admin, '?q=amelie')).toEqual(['Amélie']);
    });

    it('finds a title by a genre, which the search box has always claimed to read', async () => {
      await video('Alien', { genres: ['Horror'] });
      await video('Brazil', { genres: ['Comedy'] });

      expect(await titles(admin, '?q=horror')).toEqual(['Alien']);
    });

    /**
     * The half that keeps fuzzy search from being worse than none.
     *
     * Recall is deliberately generous — Postgres is asked which rows *resemble*
     * the text — so the thing worth pinning is that generosity stops somewhere.
     * A search that answers everything has not been made cleverer.
     */
    it('does not answer a query nothing resembles', async () => {
      await video('Brazil');
      await video('Alien', { description: 'A creature.' });

      expect(await titles(admin, '?q=zzzznothing')).toEqual([]);
    });

    it('does not fuzz a short word into a different one', async () => {
      await video('Wax');

      expect(await titles(admin, '?q=war')).toEqual([]);
    });

    /** The leak, under fuzz. The exact rule the direct-title case pins, misspelled. */
    it('does not reach a viewer through a misspelling of a draft video’s title', async () => {
      const potter = await shelf('Harry Potter');
      await video('Unreleased Sequel', { collectionId: potter.id, state: 'DRAFT' });

      expect(await titles(await asUser(), '?q=unreleesed')).toEqual([]);
      expect(await titles(admin, '?q=unreleesed')).toEqual(['Harry Potter']);
    });

    it('does not reach a viewer through a misspelling of a draft episode’s credits', async () => {
      const rickman = await person('Alan Rickman');
      const potter = await shelf('Harry Potter');
      const secret = await video('Unreleased', { collectionId: potter.id, state: 'DRAFT' });
      await creditVideo(secret.id, rickman);

      expect(await titles(await asUser(), '?q=rickmann')).toEqual([]);
      expect(await titles(admin, '?q=rickmann')).toEqual(['Harry Potter']);
    });
  });

  describe('ranking', () => {
    it('answers with the best match first', async () => {
      await video('The Matrix Reloaded');
      await video('Matrix');
      await video('Alien', { description: 'Shot on a matrix of soundstages.' });

      // Exact title, then the one that starts with it, then the synopsis.
      expect(await titles(admin, '?q=matrix&sort=relevance')).toEqual([
        'Matrix',
        'The Matrix Reloaded',
        'Alien',
      ]);
    });

    it('ranks a film named for the query above one merely credited to it', async () => {
      const rickman = await person('Alan Rickman');
      const film = await video('Die Hard');
      await creditVideo(film.id, rickman);
      await video('Rickman');

      expect(await titles(admin, '?q=rickman&sort=relevance')).toEqual(['Rickman', 'Die Hard']);
    });

    it('ranks a shelf named for the query above one reached through a video on it', async () => {
      const potter = await shelf('Harry Potter');
      await video('Prisoner of Azkaban', { collectionId: potter.id });
      await shelf('Azkaban');

      expect(await titles(admin, '?q=azkaban&sort=relevance')).toEqual([
        'Azkaban',
        'Harry Potter',
      ]);
    });

    it('still puts a shelf before a film it ties with exactly', async () => {
      // The tie-break `relevance.ts` weights every indirect route below one to
      // protect — a shelf must not be able to accumulate past the film.
      await shelf('Dune');
      await video('Dune');

      const { items } = (await admin.get('/library?q=dune&sort=relevance').expect(200)).body;

      expect(items.map((item: { kind: string }) => item.kind)).toEqual(['collection', 'film']);
    });

    it('answers a search with no sort exactly as it answers Best match', async () => {
      // `q` means one thing whatever order the answer is shown in: the fuzzy
      // recall and the dropping of unmatched rows happen for every sort. Only
      // the order differs.
      await video('Interstellar');
      await video('Brazil');

      expect(await titles(admin, '?q=intersteller')).toEqual(
        await titles(admin, '?q=intersteller&sort=relevance'),
      );
    });

    it('reads relevance with no query as the plain title order', async () => {
      // A bookmark, or a search box cleared while Best match was selected. It
      // answers rather than refusing — the browser suite fails any 4xx.
      await video('Brazil');
      await video('Alien');

      expect(await titles(admin, '?sort=relevance')).toEqual(['Alien', 'Brazil']);
    });

    /**
     * Infinite scroll concatenates offset pages, and `browse-paging.ts` says in
     * as many words that this is sound only because the order is total. A score
     * gives whole groups of entries the same number, so ties are the norm here
     * rather than the exception — which makes this the one place a
     * non-total relevance order would show up as a duplicated card.
     */
    it('walks a whole search once, with no repeat and no gap', async () => {
      await shelf('Matrix Alpha');
      await shelf('Matrix Charlie');
      await video('Matrix Bravo');
      await video('Matrix Delta');
      await video('Matrix Echo');
      await video('Matrix Foxtrot');

      const walked = [
        ...(await titles(admin, '?q=matrix&sort=relevance&limit=2&offset=0')),
        ...(await titles(admin, '?q=matrix&sort=relevance&limit=2&offset=2')),
        ...(await titles(admin, '?q=matrix&sort=relevance&limit=2&offset=4')),
      ];

      expect(new Set(walked).size).toBe(6);
      expect(walked).toEqual(await titles(admin, '?q=matrix&sort=relevance&limit=100'));
    });

    it('counts exactly what paging can reach', async () => {
      /*
       * The total comes from the scored pool rather than a `count()`, and it has
       * to: Postgres is asked a generous question, so a count taken from it
       * would promise cards that scored nothing and were dropped.
       * `nextBrowsePage` walks until `loaded >= total`, so a total that
       * overcounts is a browse page that scrolls forever waiting for a page
       * that never comes.
       */
      await video('Matrix');
      await video('Brazil');
      await video('Alien');

      const response = await admin.get('/library?q=matrix&sort=relevance').expect(200);

      expect(response.body).toMatchObject({ total: 1, hasMore: false });
      expect(response.body.items).toHaveLength(1);
    });

    it('does not leak the score it sorted on', async () => {
      await video('Brazil');

      const [film] = (await admin.get('/library?q=brazil&sort=relevance').expect(200)).body.items;

      expect(film).not.toHaveProperty('score');
      expect(film).not.toHaveProperty('normalisedTitle');
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
