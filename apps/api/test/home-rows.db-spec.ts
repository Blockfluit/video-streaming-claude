
import { randomUUID } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service';
import { DbHarness, PASSWORD } from './db/harness';

/**
 * Rows whose contents are computed rather than chosen.
 *
 * What is worth a real database here is what a stub cannot lose: that the
 * visibility filter runs *before* the limit rather than after it, that an
 * episode of a hidden show never surfaces as though it were a film, and that
 * the partial unique stopping a second personal row is actually in the schema.
 * The ranking itself is `sources/rank.spec.ts`, which needs no database at all.
 */
describe('Computed home-page rows (real database)', () => {
  const harness = new DbHarness({ name: 'home-rows', workspace: true });

  
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: request.Agent;
  let viewer: request.Agent;
  let viewerId: string;
  let showId: string;


  let seeded = 0;

  /** `createdAt` is explicit so "recently added" has something unambiguous to order on. */
  async function seedVideo(
    collectionId: string | null,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    seeded += 1;
    const video = await prisma.video.create({
      data: {
        ...(collectionId ? { collections: { create: { collectionId, orderIndex: seeded } } } : {}),
        slug: `video-${seeded}`,
        title: `Video ${seeded}`,
        storageKey: `Show/video-${seeded}.mkv`,
        contentTag: 'tag',
        originalName: `video-${seeded}.mkv`,
        mimeType: 'video/x-matroska',
        sizeBytes: BigInt(1024),
        fileMtime: new Date(),
        durationSec: 600,
        state: 'PUBLISHED',
        createdAt: new Date(2026, 0, seeded),
        ...overrides,
      },
      select: { id: true },
    });
    return video.id;
  }

  async function createRow(body: Record<string, unknown>): Promise<string> {
    const response = await admin.post('/lists').send(body).expect(201);
    return response.body.id;
  }

  /** The entries a row resolves to, named so a failure reads as titles rather than ids. */
  async function titlesOf(agent: request.Agent, rowId: string): Promise<string[]> {
    const response = await agent.get('/lists?includeHidden=true&limit=50').expect(200);
    const row = response.body.items.find((item: { id: string }) => item.id === rowId);

    return (row?.items ?? []).map(
      (item: { collection?: { title: string }; video?: { title: string } }) =>
        item.collection?.title ?? item.video?.title,
    );
  }

  beforeEach(async () => {
    await harness.start();
    ({ app, prisma, admin } = harness);

    const invite = await admin.post('/admin/invites').send({}).expect(201);
    viewer = request.agent(app.getHttpServer());
    const redeemed = await viewer
      .post('/auth/redeem')
      .send({ token: invite.body.token, username: 'viewer', password: PASSWORD })
      .expect(201);
    viewerId = redeemed.body.id ?? (await prisma.user.findFirstOrThrow({
      where: { username: 'viewer' },
      select: { id: true },
    })).id;

    const show = await prisma.collection.create({
      data: { slug: 'show', title: 'Show', folderKey: 'Show', state: 'PUBLISHED' },
      select: { id: true },
    });
    showId = show.id;
    seeded = 0;
  });

  afterEach(() => harness.stop());

  describe('recently added', () => {
    it('rolls episodes up to their show and leaves a standalone film standing', async () => {
      await seedVideo(showId);
      await seedVideo(showId);
      await seedVideo(null, { title: 'A Film', slug: 'a-film', storageKey: 'A Film.mkv' });

      const rowId = await createRow({ title: 'New', source: 'RECENTLY_ADDED', kind: 'AUTO' });

      // The film is newest, so it leads; the show appears once rather than twice.
      expect(await titlesOf(admin, rowId)).toEqual(['A Film', 'Show']);
    });

    it('lists episodes individually when the row asks for videos', async () => {
      await seedVideo(showId);
      await seedVideo(showId);

      const rowId = await createRow({ title: 'New', source: 'RECENTLY_ADDED', kind: 'VIDEOS' });

      expect(await titlesOf(admin, rowId)).toEqual(['Video 2', 'Video 1']);
    });

    it('drops a standalone film when the row asks for collections only', async () => {
      await seedVideo(showId);
      await seedVideo(null, { title: 'A Film', slug: 'a-film', storageKey: 'A Film.mkv' });

      const rowId = await createRow({
        title: 'New',
        source: 'RECENTLY_ADDED',
        kind: 'COLLECTIONS',
      });

      expect(await titlesOf(admin, rowId)).toEqual(['Show']);
    });

    it('counts a show as recent as its newest episode, not its oldest', async () => {
      const other = await prisma.collection.create({
        data: { slug: 'other', title: 'Other', folderKey: 'Other', state: 'PUBLISHED' },
        select: { id: true },
      });
      // An old show that just got a new episode beats a show whose only episode
      // is older — which summing timestamps would get backwards.
      await seedVideo(showId, { createdAt: new Date(2020, 0, 1) });
      await seedVideo(other.id, { createdAt: new Date(2026, 0, 5) });
      await seedVideo(showId, { createdAt: new Date(2026, 0, 9) });

      const rowId = await createRow({ title: 'New', source: 'RECENTLY_ADDED', kind: 'AUTO' });

      expect(await titlesOf(admin, rowId)).toEqual(['Show', 'Other']);
    });

    /**
     * The home hero features the first entry of this row and plays its trailer,
     * so the card has to carry the id.
     *
     * Asserted on both halves because they are two selects: a shelf's card and
     * an episode's card are built separately, and a hero that features a
     * collection one moment and a film the next would otherwise play a trailer
     * for only one of them. Every other assertion in this file maps to titles
     * and would not see the difference.
     */
    it('carries the trailer id on both a shelf card and a video card', async () => {
      await prisma.collection.update({
        where: { id: showId },
        data: { trailerYoutubeId: 'dQw4w9WgXcQ' },
      });
      await seedVideo(showId);
      await seedVideo(null, {
        title: 'A Film',
        slug: 'a-film',
        storageKey: 'A Film.mkv',
        trailerYoutubeId: 'aaaaaaaaaaa',
      });

      const rowId = await createRow({ title: 'New', source: 'RECENTLY_ADDED', kind: 'AUTO' });
      const response = await admin.get('/lists?includeHidden=true&limit=50').expect(200);
      const row = response.body.items.find((item: { id: string }) => item.id === rowId);

      expect(row.items).toMatchObject([
        { video: { title: 'A Film', trailerYoutubeId: 'aaaaaaaaaaa' } },
        { collection: { title: 'Show', trailerYoutubeId: 'dQw4w9WgXcQ' } },
      ]);
    });

    /**
     * `ITEM_SELECT` used to hand-copy the video half of `VIDEO_CARD_SELECT`, so
     * a field added to the shared shape reached a computed row's cards and not a
     * hand-picked row's. Both read the imported select now, and this is what
     * says so.
     */
    it('carries it on a hand-picked row too, not only a computed one', async () => {
      const videoId = await seedVideo(null, {
        title: 'A Film',
        slug: 'a-film',
        storageKey: 'A Film.mkv',
        trailerYoutubeId: 'aaaaaaaaaaa',
      });

      const rowId = await createRow({ title: 'Picked', source: 'MANUAL' });
      await admin.post(`/lists/${rowId}/items`).send({ videoId }).expect(200);

      const response = await admin.get('/lists?includeHidden=true&limit=50').expect(200);
      const row = response.body.items.find((item: { id: string }) => item.id === rowId);

      expect(row.items).toMatchObject([
        { video: { title: 'A Film', trailerYoutubeId: 'aaaaaaaaaaa' } },
      ]);
    });
  });

  describe('visibility', () => {
    /**
     * The bug this exists for: filtering after the limit hands a viewer three
     * entries when they asked for three and two of the newest were drafts.
     */
    it('fills a limited row with what the viewer may see, not with what is left', async () => {
      await seedVideo(null, { title: 'Published', slug: 'p1', storageKey: 'p1.mkv' });
      await seedVideo(null, {
        title: 'Draft A',
        slug: 'd1',
        storageKey: 'd1.mkv',
        state: 'DRAFT',
      });
      await seedVideo(null, {
        title: 'Draft B',
        slug: 'd2',
        storageKey: 'd2.mkv',
        state: 'DRAFT',
      });
      await seedVideo(null, { title: 'Also published', slug: 'p2', storageKey: 'p2.mkv' });

      const rowId = await createRow({
        title: 'New',
        source: 'RECENTLY_ADDED',
        kind: 'AUTO',
        maxItems: 2,
      });

      expect(await titlesOf(viewer, rowId)).toEqual(['Also published', 'Published']);
    });

    it('never offers an episode of a draft show as though it were a film', async () => {
      const hidden = await prisma.collection.create({
        data: { slug: 'hidden', title: 'Hidden', folderKey: 'Hidden', state: 'DRAFT' },
        select: { id: true },
      });
      await seedVideo(hidden.id, { title: 'Secret episode' });

      const rowId = await createRow({ title: 'New', source: 'RECENTLY_ADDED', kind: 'AUTO' });

      expect(await titlesOf(viewer, rowId)).toEqual([]);
      // The admin, who may see the show, gets the show rather than the episode.
      expect(await titlesOf(admin, rowId)).toEqual(['Hidden']);
    });

    it('narrows a row by tag without letting the tag reach a draft', async () => {
      await seedVideo(null, { title: 'Noir film', slug: 'n1', storageKey: 'n1.mkv', tags: ['noir'] });
      await seedVideo(null, {
        title: 'Draft noir',
        slug: 'n2',
        storageKey: 'n2.mkv',
        tags: ['noir'],
        state: 'DRAFT',
      });
      await seedVideo(null, { title: 'Comedy', slug: 'c1', storageKey: 'c1.mkv', tags: ['comedy'] });

      const rowId = await createRow({
        title: 'Noir',
        source: 'RECENTLY_ADDED',
        kind: 'AUTO',
        tags: ['noir'],
      });

      expect(await titlesOf(viewer, rowId)).toEqual(['Noir film']);
    });
  });

  describe('most viewed', () => {
    it("totals a show's episodes rather than ranking them one by one", async () => {
      const film = await seedVideo(null, {
        title: 'A Film',
        slug: 'a-film',
        storageKey: 'A Film.mkv',
      });
      const episodeOne = await seedVideo(showId);
      const episodeTwo = await seedVideo(showId);

      await prisma.watchProgress.createMany({
        data: [
          { userId: viewerId, videoId: film, viewCount: 5 },
          { userId: viewerId, videoId: episodeOne, viewCount: 3 },
          { userId: viewerId, videoId: episodeTwo, viewCount: 4 },
        ],
      });

      const rowId = await createRow({ title: 'Popular', source: 'MOST_VIEWED', kind: 'AUTO' });

      // Seven between the two episodes beats the film's five, which no
      // per-episode comparison would have said.
      expect(await titlesOf(admin, rowId)).toEqual(['Show', 'A Film']);
    });

    it('leaves out what nobody has watched rather than padding the row', async () => {
      const watched = await seedVideo(null, { title: 'Watched', slug: 'w', storageKey: 'w.mkv' });
      await seedVideo(null, { title: 'Ignored', slug: 'i', storageKey: 'i.mkv' });

      await prisma.watchProgress.create({
        data: { userId: viewerId, videoId: watched, viewCount: 1 },
      });

      const rowId = await createRow({ title: 'Popular', source: 'MOST_VIEWED', kind: 'AUTO' });

      expect(await titlesOf(admin, rowId)).toEqual(['Watched']);
    });
  });

  describe('trending', () => {
    it('counts what was watched inside the window and ignores what was not', async () => {
      const recent = await seedVideo(null, { title: 'Recent', slug: 'r', storageKey: 'r.mkv' });
      const stale = await seedVideo(null, { title: 'Stale', slug: 's', storageKey: 's.mkv' });

      const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      await prisma.watchEvent.createMany({
        data: [
          { userId: viewerId, videoId: recent, playSessionId: 'a', positionSec: 60, deltaSec: 60 },
          {
            userId: viewerId,
            videoId: stale,
            playSessionId: 'b',
            positionSec: 600,
            deltaSec: 600,
            createdAt: longAgo,
          },
        ],
      });

      const rowId = await createRow({
        title: 'Trending',
        source: 'TRENDING',
        kind: 'AUTO',
        windowDays: 7,
      });

      // Stale was watched ten times as long, but outside the window.
      expect(await titlesOf(admin, rowId)).toEqual(['Recent']);
    });
  });

  /**
   * The one computed source that is *also* personal — it goes through the same
   * `score()`/`rollUpAndRank` machinery as trending and most-viewed, but ranks
   * on a per-viewer taste profile rather than a library-wide total. The
   * scoring math itself is `common/match/taste-profile.spec.ts`; what is worth
   * a real database here is that the row disappears below the threshold, that
   * a candidate already known to the viewer is never offered as new, and that
   * visibility is still applied before the limit like every other source.
   */
  describe('recommended', () => {
    /** Five completed, distinctly-genred videos — enough to clear MIN_STRONG_SIGNALS. */
    async function clearThreshold(genres: string[] = ['Drama']): Promise<void> {
      for (const genre of genres) {
        const filler = await seedVideo(null, { genres: [genre] });
        await viewer
          .post(`/videos/${filler}/heartbeat`)
          .send({ playSessionId: randomUUID(), positionSec: 600, deltaSec: 30 })
          .expect(200);
      }
    }

    it('hides the row entirely for a viewer with too little watch history', async () => {
      await seedVideo(null, { title: 'A Drama', slug: 'a-drama', storageKey: 'ad.mkv', genres: ['Drama'] });

      const rowId = await createRow({ title: 'For You', source: 'RECOMMENDED' });

      expect(await titlesOf(viewer, rowId)).toEqual([]);
    });

    it('shows a video sharing genres with the viewer’s watch history', async () => {
      await clearThreshold(['Drama', 'Drama', 'Drama', 'Drama', 'Drama']);
      await seedVideo(null, { title: 'A Drama', slug: 'a-drama', storageKey: 'ad.mkv', genres: ['Drama'] });
      await seedVideo(null, { title: 'A Comedy', slug: 'a-comedy', storageKey: 'ac.mkv', genres: ['Comedy'] });

      const rowId = await createRow({ title: 'For You', source: 'RECOMMENDED', kind: 'AUTO' });

      expect(await titlesOf(viewer, rowId)).toEqual(['A Drama']);
    });

    it('excludes a video the viewer has already completed — it is confirmed, not a recommendation', async () => {
      await clearThreshold(['Drama', 'Drama', 'Drama', 'Drama', 'Drama']);
      const alreadySeen = await seedVideo(null, {
        title: 'Already Seen',
        slug: 'already-seen',
        storageKey: 'seen.mkv',
        genres: ['Drama'],
      });
      await viewer
        .post(`/videos/${alreadySeen}/heartbeat`)
        .send({ playSessionId: randomUUID(), positionSec: 600, deltaSec: 30 })
        .expect(200);

      const rowId = await createRow({ title: 'For You', source: 'RECOMMENDED' });

      expect(await titlesOf(viewer, rowId)).not.toContain('Already Seen');
    });

    it('excludes a video the viewer has already saved to My List', async () => {
      await clearThreshold(['Drama', 'Drama', 'Drama', 'Drama', 'Drama']);
      const saved = await seedVideo(null, {
        title: 'Saved',
        slug: 'saved',
        storageKey: 'saved.mkv',
        genres: ['Drama'],
      });
      await viewer.post('/me/watchlist').send({ videoId: saved }).expect(200);

      const rowId = await createRow({ title: 'For You', source: 'RECOMMENDED' });

      expect(await titlesOf(viewer, rowId)).not.toContain('Saved');
    });

    it('never offers an episode of a draft show as though it were a film, however well it matches', async () => {
      await clearThreshold(['Drama', 'Drama', 'Drama', 'Drama', 'Drama']);
      const hidden = await prisma.collection.create({
        data: { slug: 'hidden-drama', title: 'Hidden Drama', folderKey: 'HiddenDrama', state: 'DRAFT' },
        select: { id: true },
      });
      await seedVideo(hidden.id, { title: 'Secret Drama Episode', genres: ['Drama'] });

      const rowId = await createRow({ title: 'For You', source: 'RECOMMENDED' });

      expect(await titlesOf(viewer, rowId)).toEqual([]);
      // The admin, who may see the show, is a different viewer with no watch
      // history at all — so even for them the row stays hidden below the
      // threshold. This asserts the visibility rule, not the threshold.
      expect(await titlesOf(admin, rowId)).toEqual([]);
    });

    it('excludes a video whose overlap is too small to count as a real recommendation', async () => {
      // Five completed videos, each its own genre: a candidate sharing only
      // one of the five scores 0.3 * (1/5) = 0.06, under the 0.15 floor.
      await clearThreshold(['Drama', 'Comedy', 'Horror', 'Romance', 'Western']);

      await seedVideo(null, {
        title: 'Weak Match',
        slug: 'weak-match',
        storageKey: 'weak.mkv',
        genres: ['Drama'],
      });
      await seedVideo(null, {
        title: 'Strong Match',
        slug: 'strong-match',
        storageKey: 'strong.mkv',
        genres: ['Drama', 'Comedy', 'Horror', 'Romance', 'Western'],
      });

      const rowId = await createRow({ title: 'For You', source: 'RECOMMENDED' });
      const titles = await titlesOf(viewer, rowId);

      expect(titles).toContain('Strong Match');
      expect(titles).not.toContain('Weak Match');
    });

    it('excludes an entire show once the viewer has substantially watched any one of its episodes, even if none are marked completed', async () => {
      await clearThreshold(['Drama', 'Drama', 'Drama', 'Drama', 'Drama']);
      const episodeOne = await seedVideo(showId, { genres: ['Drama'] });
      await seedVideo(showId, { genres: ['Drama'] });
      // Half the video, well past MIN_PARTIAL_FRACTION but short of the
      // app-wide 90% "completed" line — Continue Watching already covers
      // this show, so it must not also compete for a Recommended slot.
      await viewer
        .post(`/videos/${episodeOne}/heartbeat`)
        .send({ playSessionId: randomUUID(), positionSec: 300, deltaSec: 30 })
        .expect(200);

      const rowId = await createRow({ title: 'For You', source: 'RECOMMENDED' });

      expect(await titlesOf(viewer, rowId)).not.toContain('Show');
    });

    it('excludes a standalone video the viewer has substantially watched but not completed', async () => {
      await clearThreshold(['Drama', 'Drama', 'Drama', 'Drama', 'Drama']);
      const partiallySeen = await seedVideo(null, {
        title: 'Partially Seen',
        slug: 'partially-seen',
        storageKey: 'partial.mkv',
        genres: ['Drama'],
      });
      await viewer
        .post(`/videos/${partiallySeen}/heartbeat`)
        .send({ playSessionId: randomUUID(), positionSec: 300, deltaSec: 30 })
        .expect(200);

      const rowId = await createRow({ title: 'For You', source: 'RECOMMENDED' });

      expect(await titlesOf(viewer, rowId)).not.toContain('Partially Seen');
    });
  });

  describe('personal rows', () => {
    it('resolves continue watching for the caller, not for everyone', async () => {
      const film = await seedVideo(null, { title: 'A Film', slug: 'a-film', storageKey: 'f.mkv' });
      await prisma.watchProgress.create({
        data: { userId: viewerId, videoId: film, lastPositionSec: 60, maxPositionSec: 60 },
      });

      const rowId = await createRow({ title: 'Continue', source: 'CONTINUE_WATCHING' });

      expect(await titlesOf(viewer, rowId)).toEqual(['A Film']);
      expect(await titlesOf(admin, rowId)).toEqual([]);
    });

    // The bug this row exists to avoid: two unfinished films of one show
    // must not draw two cards.
    it('shows one card for a show with two unfinished videos, not one per video', async () => {
      const first = await seedVideo(showId, { title: 'Episode One', slug: 'episode-one' });
      const second = await seedVideo(showId, { title: 'Episode Two', slug: 'episode-two' });
      // Real heartbeats, in order, so `lastWatchedAt` reflects which was
      // actually watched more recently rather than a hand-set timestamp.
      await viewer
        .post(`/videos/${first}/heartbeat`)
        .send({ playSessionId: randomUUID(), positionSec: 60, deltaSec: 60 })
        .expect(200);
      await viewer
        .post(`/videos/${second}/heartbeat`)
        .send({ playSessionId: randomUUID(), positionSec: 60, deltaSec: 60 })
        .expect(200);

      const rowId = await createRow({ title: 'Continue', source: 'CONTINUE_WATCHING' });

      expect(await titlesOf(viewer, rowId)).toEqual(['Episode Two']);
    });

    it('resolves my list for the caller', async () => {
      const film = await seedVideo(null, { title: 'A Film', slug: 'a-film', storageKey: 'f.mkv' });
      await viewer.post('/me/watchlist').send({ videoId: film }).expect(200);

      const rowId = await createRow({ title: 'Saved', source: 'MY_LIST' });

      expect(await titlesOf(viewer, rowId)).toEqual(['A Film']);
      expect(await titlesOf(admin, rowId)).toEqual([]);
    });

    /** The hand-written partial unique. Two identical shelves is a double-click, not a setting. */
    it('refuses a second continue watching row', async () => {
      await createRow({ title: 'Continue', source: 'CONTINUE_WATCHING' });

      await admin.post('/lists').send({ title: 'Again', source: 'CONTINUE_WATCHING' }).expect(409);
    });

    it('allows a second trending row, which is a different question', async () => {
      await createRow({ title: 'This week', source: 'TRENDING', windowDays: 7 });
      await createRow({ title: 'This month', source: 'TRENDING', windowDays: 30 });
    });
  });

  describe('what a computed row refuses', () => {
    it('refuses items on a row that computes its own', async () => {
      const film = await seedVideo(null, { title: 'A Film', slug: 'a-film', storageKey: 'f.mkv' });
      const rowId = await createRow({ title: 'New', source: 'RECENTLY_ADDED' });

      await admin.post(`/lists/${rowId}/items`).send({ videoId: film }).expect(400);
    });

    it('refuses a reorder of entries nobody arranged', async () => {
      const rowId = await createRow({ title: 'New', source: 'RECENTLY_ADDED' });

      await admin.patch(`/lists/${rowId}/reorder`).send({ itemIds: ['x'] }).expect(400);
    });

    it('refuses a window on a source that has none', async () => {
      await admin
        .post('/lists')
        .send({ title: 'Popular', source: 'MOST_VIEWED', windowDays: 7 })
        .expect(400);
    });

    it('refuses a window added later by a patch that does not name the source', async () => {
      const rowId = await createRow({ title: 'Popular', source: 'MOST_VIEWED' });

      await admin.patch(`/lists/${rowId}`).send({ windowDays: 7 }).expect(400);
    });

    it('still lets a hand-picked row be built by hand', async () => {
      const film = await seedVideo(null, { title: 'A Film', slug: 'a-film', storageKey: 'f.mkv' });
      const rowId = await createRow({ title: 'Staff picks', source: 'MANUAL' });

      await admin.post(`/lists/${rowId}/items`).send({ videoId: film }).expect(200);

      expect(await titlesOf(admin, rowId)).toEqual(['A Film']);
    });
  });
});
