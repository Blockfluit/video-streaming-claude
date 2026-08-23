import type { INestApplication } from '@nestjs/common';
import { normaliseTitle } from '@video/shared';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service';
import {
  SEARCH_ENGINE,
  type SearchCandidateRequest,
  type SearchCandidates,
  type SearchEngine,
} from '../src/search/engine';

import { DbHarness, PASSWORD } from './db/harness';

/**
 * What an external search engine is allowed to decide, against a real database.
 *
 * The engine is the seam that gets replaced — `.overrideProvider`, the way the
 * subtitle and metadata suites replace their upstreams. Running Meilisearch here
 * would be testing its uptime; the interesting questions are all on this side of
 * it, and they are questions about **trust**.
 *
 * An engine is a second copy of the library, held by a process that knows
 * nothing about publish states, seasons, or who is asking. This suite states
 * exactly how much that copy is permitted to be wrong about, which is: it may
 * offer any id it likes, and the answer must still be one the caller was always
 * allowed to see. Every test here is a way of handing the service an id it
 * should not turn into a card.
 */
describe('Search engine (real database)', () => {
  /** What the engine was asked, so the request can be asserted rather than assumed. */
  let asked: SearchCandidateRequest[];
  let engine: SearchEngine;

  /** Ids the stub will offer next, whatever they are and whether or not they exist. */
  let offers: SearchCandidates;

  /**
   * How the stub is behaving right now.
   *
   * Mutable, and read through a getter, so a test can switch the engine off or
   * break it **without restarting the app**. That matters more than it looks:
   * `harness.restart()` re-runs the boot reconcile, which marks every fixture
   * video `MISSING` because its `storageKey` names a file no test ever wrote —
   * so two responses either side of a restart differ for a reason that has
   * nothing to do with what is being compared.
   */
  let behaviour: 'answers' | 'throws' | 'unconfigured';

  function stubEngine(overrides: Partial<SearchEngine> = {}): SearchEngine {
    return {
      name: 'Stub',
      get isConfigured() {
        return behaviour !== 'unconfigured';
      },
      async candidates(request_: SearchCandidateRequest) {
        asked.push(request_);
        if (behaviour === 'throws') throw new Error('engine is on fire');
        return offers;
      },
      ...overrides,
    };
  }

  const harness = new DbHarness({
    name: 'searchengine',
    admin: 'ada',
    // Read when the container is compiled, so the stub has to exist by then —
    // one assigned afterwards is a stub the app never saw.
    configure: builder => builder.overrideProvider(SEARCH_ENGINE).useValue(engine),
  });

  let app: INestApplication;
  let prisma: PrismaService;
  let admin: request.Agent;

  beforeEach(async () => {
    asked = [];
    offers = { collectionIds: [], videoIds: [], people: [] };
    behaviour = 'answers';
    engine = stubEngine();

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

  async function shelf(title: string, extra: Record<string, unknown> = {}) {
    const created = await admin.post('/collections').send({ title }).expect(201);
    await prisma.collection.update({
      where: { id: created.body.id },
      data: { state: 'PUBLISHED', ...extra },
    });
    return created.body as { id: string; slug: string };
  }

  let seq = 0;

  async function video(title: string, { collectionId, ...extra }: Record<string, unknown> = {}) {
    seq += 1;
    return prisma.video.create({
      data: {
        slug: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${seq}`,
        title,
        normalisedTitle: normaliseTitle(title),
        storageKey: `drive/${title}-${seq}.mp4`,
        contentTag: 'tag',
        originalName: `${title}.mp4`,
        mimeType: 'video/mp4',
        sizeBytes: BigInt(1024),
        fileMtime: new Date('2026-01-01T00:00:00Z'),
        state: 'PUBLISHED',
        ...(collectionId ? { collections: { create: { collectionId: collectionId as string } } } : {}),
        ...extra,
      },
      select: { id: true, title: true },
    });
  }

  async function titles(agent: request.Agent, query = ''): Promise<string[]> {
    const response = await agent.get(`/library${query}`).expect(200);
    return response.body.items.map((item: { title: string }) => item.title);
  }

  /**
   * The one that matters, and the reason the engine answers with ids.
   *
   * A shelf is findable by the titles of the videos standing on it, and a
   * published shelf may hold a draft episode. So an engine that offered "this
   * shelf, because something on it matched" would be making a visibility
   * decision with no idea of the episode's state — and the shelf's own state
   * passes every filter, so nothing downstream could catch it. The engine is
   * therefore only ever allowed to say *which videos matched*, and Prisma decides
   * whether that video is one this caller may be told about.
   */
  it('will not turn a draft episode into a visible shelf for a viewer', async () => {
    const potter = await shelf('Harry Potter');
    const draft = await video('Prisoner of Azkaban', {
      collectionId: potter.id,
      state: 'DRAFT',
    });

    // The engine insists this video matched. It is a draft, and it is on a
    // published shelf, which is the whole trap.
    offers = { collectionIds: [], videoIds: [draft.id], people: [] };

    expect(await titles(admin, '?q=azkaban')).toEqual(['Harry Potter']);
    expect(await titles(await asUser(), '?q=azkaban')).toEqual([]);
  });

  it('shows the shelf once that episode is published', async () => {
    const potter = await shelf('Harry Potter');
    const episode = await video('Prisoner of Azkaban', { collectionId: potter.id });

    offers = { collectionIds: [], videoIds: [episode.id], people: [] };

    expect(await titles(await asUser(), '?q=azkaban')).toEqual(['Harry Potter']);
  });

  /**
   * A stale index can only ever lose recall — it can never show anybody anything.
   *
   * Three ways for the copy to be out of date, and all three have to end in the
   * caller seeing nothing they should not, with a `total` that matches the cards
   * so `nextBrowsePage` still terminates.
   */
  describe('when the index is out of date', () => {
    it('offers a row that has since been deleted', async () => {
      const gone = await video('Deleted Film');
      await prisma.video.delete({ where: { id: gone.id } });
      offers = { collectionIds: [], videoIds: [gone.id], people: [] };

      const response = await admin.get('/library?q=deleted').expect(200);

      expect(response.body.items).toEqual([]);
      expect(response.body).toMatchObject({ total: 0, hasMore: false });
    });

    it('offers a row that has since become a draft', async () => {
      const drafted = await video('Secret Film', { state: 'DRAFT' });
      offers = { collectionIds: [], videoIds: [drafted.id], people: [] };

      expect(await titles(await asUser(), '?q=secret')).toEqual([]);
      expect(await titles(admin, '?q=secret')).toEqual(['Secret Film']);
    });

    it('offers a row that has since been renamed, and shows the name it has now', async () => {
      const renamed = await video('Old Name');
      await prisma.video.update({
        where: { id: renamed.id },
        data: { title: 'New Name', normalisedTitle: normaliseTitle('New Name') },
      });
      offers = { collectionIds: [], videoIds: [renamed.id], people: [] };

      // Scored on the row Prisma returned, so the old name earns nothing.
      expect(await titles(admin, '?q=new name')).toEqual(['New Name']);
    });
  });

  /**
   * The engine is told who is asking, so its candidate budget is spent on rows
   * the caller can see — not so that it can decide anything.
   */
  it('asks the engine on behalf of the caller', async () => {
    await video('Alien');
    await titles(await asUser(), '?q=alien');

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ q: 'alien', role: 'USER' });
  });

  /**
   * The fallback, asserted as sameness rather than as "it returned something".
   *
   * A search answered by Postgres and a search answered after the engine threw
   * have to be the same response, because everything downstream of the candidate
   * step is the same code either way. If these two ever diverge, something has
   * grown that only works when an engine is configured.
   */
  it('answers a failing engine exactly as it answers no engine at all', async () => {
    await video('Alien', { description: 'In space.' });
    await video('Brazil');

    behaviour = 'unconfigured';
    const withoutEngine = await admin.get('/library?q=space&sort=relevance').expect(200);

    behaviour = 'throws';
    const withBrokenEngine = await admin.get('/library?q=space&sort=relevance').expect(200);

    expect(withBrokenEngine.body).toEqual(withoutEngine.body);

    // And the answer is the right one, or the two could agree on being empty.
    // `space` is in the synopsis and in no title, so this is Postgres answering.
    expect(withoutEngine.body.items.map((item: { title: string }) => item.title)).toEqual(['Alien']);
  });

  it('stops asking an engine that has just failed, rather than paying for it per keystroke', async () => {
    await video('Alien', { description: 'In space.' });

    behaviour = 'throws';
    await admin.get('/library?q=space').expect(200);
    const afterFirstFailure = asked.length;

    // The breaker is open now, so this one must not reach the engine at all.
    await admin.get('/library?q=space').expect(200);

    expect(afterFirstFailure).toBe(1);
    expect(asked).toHaveLength(1);
  });
});
