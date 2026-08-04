import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SessionStoreService } from '../src/auth/session-store.service';
import { bigIntReplacer } from '../src/common/json';
import { MOVIE, SEASON, SERIES } from '../src/metadata/tmdb.fixtures';
import { TmdbClient } from '../src/metadata/tmdb.client';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Importing metadata, against a real database.
 *
 * The mapping itself is unit-tested in `src/metadata/`. What belongs here is
 * everything a stub cannot have an opinion about: that a re-import updates
 * rather than duplicating, that it does not renumber billing an admin dragged
 * into place, that one person can hold two crew credits, and that the derived
 * `normalisedTitle` column is actually written.
 *
 * `TmdbClient` is replaced rather than mocked at the HTTP level. There is no
 * HTTP-mocking library in this project, and adding one to test a client this
 * thin would be testing the mock — the provider seam is the same one
 * `auth.e2e-spec.ts` uses for Prisma.
 */
describe('Metadata import (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-metadata-test.bootstrap-token');

  let workspace: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;
  let viewer: request.Agent;
  let collectionId: string;
  let videoId: string;

  /** Stands in for the provider. Counts calls, so "how many requests?" is testable. */
  const tmdbStub = {
    isConfigured: true,
    language: 'en-US',
    certificationCountry: 'US',
    imageUrl: (path: string) => `https://image.tmdb.org/t/p/w780${path}`,
    searchTitles: jest.fn(),
    titleDetail: jest.fn(),
    seasonDetail: jest.fn(),
    personImdbId: jest.fn(),
    fetchImage: jest.fn(),
  };

  async function startApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TmdbClient)
      .useValue(tmdbStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('json replacer', bigIntReplacer);
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
    prisma = app.get(PrismaService);
  }

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'metadata-'));
    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = tokenFile;
    process.env.MEDIA_ROOT = join(workspace, 'media');
    process.env.DERIVED_ROOT = join(workspace, 'derived');
    process.env.INGEST_WATCHER_ENABLED = 'false';
    await rm(tokenFile, { force: true });

    tmdbStub.isConfigured = true;
    tmdbStub.titleDetail.mockReset().mockResolvedValue(MOVIE);
    tmdbStub.seasonDetail.mockReset().mockResolvedValue(SEASON);
    tmdbStub.searchTitles.mockReset().mockResolvedValue({ results: [] });
    tmdbStub.personImdbId.mockReset().mockResolvedValue('nm0000001');
    tmdbStub.fetchImage
      .mockReset()
      .mockResolvedValue({ body: Buffer.from('not really a jpeg'), extension: '.jpg' });

    await startApp();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "InviteToken", "User", "session", "Collection", "Season", "Video", "Person" RESTART IDENTITY CASCADE',
    );
    await app.close();
    await rm(tokenFile, { force: true });

    await startApp();

    admin = request.agent(app.getHttpServer());
    await admin
      .post('/auth/redeem')
      .send({
        token: (await readFile(tokenFile, 'utf8')).trim(),
        username: 'root',
        password: PASSWORD,
      })
      .expect(201);

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

    const video = await prisma.video.create({
      data: {
        slug: 'arrival-2016-1080p',
        title: 'arrival.2016.1080p',
        storageKey: 'Films/arrival.2016.1080p.mkv',
        contentTag: 'tag',
        originalName: 'arrival.2016.1080p.mkv',
        mimeType: 'video/x-matroska',
        sizeBytes: BigInt(1024),
        fileMtime: new Date(),
        durationSec: 6960,
        state: 'PUBLISHED',
      },
      select: { id: true },
    });
    videoId = video.id;
  });

  afterEach(async () => {
    banner.mockRestore();
    await app?.close();
    await rm(tokenFile, { force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  const applyToVideo = (body: Record<string, unknown>) =>
    admin.post(`/admin/metadata/videos/${videoId}/apply`).send({
      tmdbId: 329865,
      type: 'movie',
      fields: [],
      ...body,
    });

  describe('access', () => {
    it('refuses a viewer', async () => {
      await viewer.get('/admin/metadata/search?title=Arrival').expect(403);
      await viewer.post(`/admin/metadata/videos/${videoId}/apply`).send({}).expect(403);
    });

    it('says so plainly when no token is configured, rather than failing oddly', async () => {
      tmdbStub.isConfigured = false;
      const response = await admin.get('/admin/metadata/status').expect(200);

      expect(response.body).toEqual({ configured: false });
    });
  });

  describe('applying fields', () => {
    it('writes only the fields that were named', async () => {
      await applyToVideo({ fields: ['description', 'year'] }).expect(201);

      const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(video.description).toContain('linguist');
      expect(video.year).toBe(2016);
      // Not named, so untouched — this is the whole provenance story.
      expect(video.tagline).toBeNull();
      expect(video.title).toBe('arrival.2016.1080p');
    });

    /**
     * The derived column, and the reason `titleUpdate()` exists. Written
     * directly, `normalisedTitle` silently stops matching and the "is this
     * already in the library?" check behind /requests starts missing this row.
     */
    it('keeps normalisedTitle in step when it writes a title', async () => {
      await applyToVideo({ fields: ['title'] }).expect(201);

      const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(video.title).toBe('Arrival');
      expect(video.normalisedTitle).toBe('arrival');
    });

    it('records the match itself even when no fields were chosen', async () => {
      await applyToVideo({ fields: [] }).expect(201);

      const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(video.tmdbId).toBe(329865);
      expect(video.imdbId).toBe('tt2543164');
      expect(video.metadataUpdatedAt).not.toBeNull();
    });

    it('never empties a field the provider knows nothing about', async () => {
      await prisma.video.update({
        where: { id: videoId },
        data: { description: 'Written by hand.' },
      });
      tmdbStub.titleDetail.mockResolvedValue({ ...MOVIE, overview: '' });

      await applyToVideo({ fields: ['description'] }).expect(201);

      const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(video.description).toBe('Written by hand.');
    });

    it('offers a diff without writing anything', async () => {
      const response = await admin
        .get(`/admin/metadata/videos/${videoId}/preview?tmdbId=329865&type=movie`)
        .expect(200);

      const title = response.body.fields.find((f: { field: string }) => f.field === 'title');
      expect(title).toMatchObject({ changed: true, suggested: false });

      const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(video.tmdbId).toBeNull();
    });

    /** A collection has a season count; a film does not, and must not be offered one. */
    it('offers the series-only fields on a collection and not on a video', async () => {
      const forVideo = await admin
        .get(`/admin/metadata/videos/${videoId}/preview?tmdbId=329865&type=movie`)
        .expect(200);
      expect(forVideo.body.fields.map((f: { field: string }) => f.field)).not.toContain('seasonCount');

      tmdbStub.titleDetail.mockResolvedValue(SERIES);
      const forCollection = await admin
        .get(`/admin/metadata/collections/${collectionId}/preview?tmdbId=95396&type=tv`)
        .expect(200);
      expect(forCollection.body.fields.map((f: { field: string }) => f.field)).toContain('seasonCount');
    });
  });

  describe('credits', () => {
    it('creates a person for every cast and crew member, not a top-billed few', async () => {
      await applyToVideo({ includeCredits: true }).expect(201);

      // Four cast and six crew in the fixture, with one person in both lists
      // deliberately absent — so ten distinct people.
      expect(await prisma.person.count()).toBe(10);
      expect(await prisma.credit.count({ where: { videoId } })).toBe(10);
    });

    it('gives an unmapped crew job OTHER, and keeps the job title', async () => {
      await applyToVideo({ includeCredits: true }).expect(201);

      const costume = await prisma.credit.findFirstOrThrow({
        where: { videoId, jobTitle: 'Costume Design' },
      });
      expect(costume.role).toBe('OTHER');
      expect(costume.department).toBe('Costume & Make-Up');
    });

    it('does not promote a job that merely contains a key job', async () => {
      await applyToVideo({ includeCredits: true }).expect(201);

      const directors = await prisma.credit.findMany({ where: { videoId, role: 'DIRECTOR' } });
      expect(directors).toHaveLength(1);
      expect(directors[0]!.jobTitle).toBe('Director');
    });

    /** The point of the whole feature: a second import is an update. */
    it('creates nothing the second time', async () => {
      await applyToVideo({ includeCredits: true }).expect(201);
      await applyToVideo({ includeCredits: true }).expect(201);

      expect(await prisma.credit.count({ where: { videoId } })).toBe(10);
      expect(await prisma.person.count()).toBe(10);
    });

    /**
     * Billing order is dragged into place by hand, and a re-import that
     * renumbered it would destroy that work silently — which is exactly the sort
     * of thing nobody notices until the panel is wrong.
     */
    it('leaves a billing order somebody rearranged alone', async () => {
      await applyToVideo({ includeCredits: true }).expect(201);

      const lead = await prisma.credit.findFirstOrThrow({
        where: { videoId, characterName: 'Louise Banks' },
      });
      await prisma.credit.update({ where: { id: lead.id }, data: { position: 99 } });

      await applyToVideo({ includeCredits: true }).expect(201);

      const after = await prisma.credit.findUniqueOrThrow({ where: { id: lead.id } });
      expect(after.position).toBe(99);
    });

    /**
     * All but six jobs collapse to OTHER, so one person doing two of them is
     * ordinary. Keyed on (person, role) alone the second credit is dropped.
     */
    it('lets one person hold two OTHER credits for different jobs', async () => {
      tmdbStub.titleDetail.mockResolvedValue({
        ...MOVIE,
        credits: {
          cast: [],
          crew: [
            { id: 42, name: 'Jo Both', job: 'Costume Design', department: 'Costume & Make-Up' },
            { id: 42, name: 'Jo Both', job: 'Stunt Coordinator', department: 'Crew' },
          ],
        },
      });

      await applyToVideo({ includeCredits: true }).expect(201);

      expect(await prisma.person.count()).toBe(1);
      const credits = await prisma.credit.findMany({ where: { videoId } });
      expect(credits.map((credit) => credit.jobTitle).sort()).toEqual([
        'Costume Design',
        'Stunt Coordinator',
      ]);
    });

    it('reuses a person an admin already entered by hand, whatever the case', async () => {
      await admin.post('/people').send({ name: 'denis villeneuve' }).expect(201);

      await applyToVideo({ includeCredits: true }).expect(201);

      const matches = await prisma.person.findMany({
        where: { name: { equals: 'denis villeneuve', mode: 'insensitive' } },
      });
      expect(matches).toHaveLength(1);
      // ...and the hand-made row adopts the TMDB id rather than a second row appearing.
      expect(matches[0]!.tmdbId).toBe(137427);
    });
  });

  describe('artwork', () => {
    it('stores a poster and a banner, and marks them chosen rather than generated', async () => {
      await applyToVideo({ includeArtwork: true }).expect(201);

      const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(video.posterKey).not.toBeNull();
      // MANUAL is what stops the next reprobe replacing real artwork with a
      // frame grabbed 10% into the file.
      expect(video.posterSource).toBe('MANUAL');
      expect(video.bannerSource).toBe('MANUAL');
    });

    it('fetches nothing when artwork was not asked for', async () => {
      await applyToVideo({ fields: ['description'] }).expect(201);

      expect(tmdbStub.fetchImage).not.toHaveBeenCalled();
    });
  });

  describe('episodes', () => {
    it('fills each episode from its number within its season', async () => {
      tmdbStub.titleDetail.mockResolvedValue(SERIES);

      const season = await prisma.season.create({
        data: { collectionId, number: 1, slug: 'season-1', title: 'Season 1' },
        select: { id: true },
      });
      const first = await prisma.video.create({
        data: {
          slug: 'ep1',
          title: 'ep01',
          storageKey: 'Show/ep01.mkv',
          contentTag: 't',
          originalName: 'ep01.mkv',
          mimeType: 'video/x-matroska',
          sizeBytes: BigInt(1),
          fileMtime: new Date(),
          collections: { create: { collectionId, seasonId: season.id, orderIndex: 1 } },
        },
        select: { id: true },
      });

      await admin
        .post(`/admin/metadata/collections/${collectionId}/apply`)
        .send({ tmdbId: 95396, type: 'tv', fields: [], includeEpisodes: true })
        .expect(201);

      const episode = await prisma.video.findUniqueOrThrow({ where: { id: first.id } });
      expect(episode.title).toBe('Good News About Hell');
      expect(episode.normalisedTitle).toBe('goodnewsabouthell');
      expect(episode.description).toContain('Mark');
    });

    it('leaves an episode ingest could not number alone', async () => {
      tmdbStub.titleDetail.mockResolvedValue(SERIES);

      const season = await prisma.season.create({
        data: { collectionId, number: 1, slug: 'season-1', title: 'Season 1' },
        select: { id: true },
      });
      const unnumbered = await prisma.video.create({
        data: {
          slug: 'extra',
          title: 'extra',
          storageKey: 'Show/extra.mkv',
          contentTag: 't',
          originalName: 'extra.mkv',
          mimeType: 'video/x-matroska',
          sizeBytes: BigInt(1),
          fileMtime: new Date(),
          collections: { create: { collectionId, seasonId: season.id, orderIndex: null } },
        },
        select: { id: true },
      });

      await admin
        .post(`/admin/metadata/collections/${collectionId}/apply`)
        .send({ tmdbId: 95396, type: 'tv', fields: [], includeEpisodes: true })
        .expect(201);

      const after = await prisma.video.findUniqueOrThrow({ where: { id: unnumbered.id } });
      expect(after.title).toBe('extra');
    });
  });

  describe('two collections cannot claim one title', () => {
    it('refuses the second match, and says why', async () => {
      tmdbStub.titleDetail.mockResolvedValue(SERIES);
      await admin
        .post(`/admin/metadata/collections/${collectionId}/apply`)
        .send({ tmdbId: 95396, type: 'tv', fields: [] })
        .expect(201);

      const other = await prisma.collection.create({
        data: { slug: 'other', title: 'Other', folderKey: 'Other' },
        select: { id: true },
      });

      await admin
        .post(`/admin/metadata/collections/${other.id}/apply`)
        .send({ tmdbId: 95396, type: 'tv', fields: [] })
        .expect(409);
    });
  });

  describe('person IMDb links', () => {
    /**
     * TMDB does not return a person's IMDb id with a title's credits, so
     * resolving them eagerly would cost one request per person. This is the
     * catch-up button.
     */
    it('fills them in on request, and records that it asked', async () => {
      await applyToVideo({ includeCredits: true }).expect(201);
      expect(tmdbStub.personImdbId).not.toHaveBeenCalled();

      const response = await admin.post('/admin/metadata/people/resolve-links').expect(201);

      expect(response.body.checked).toBe(10);
      const people = await prisma.person.findMany();
      expect(people.every((person) => person.imdbId === 'nm0000001')).toBe(true);
      expect(people.every((person) => person.imdbCheckedAt !== null)).toBe(true);
    });

    it('does not ask again about somebody who has no IMDb id', async () => {
      tmdbStub.personImdbId.mockResolvedValue(null);
      await applyToVideo({ includeCredits: true }).expect(201);

      await admin.post('/admin/metadata/people/resolve-links').expect(201);
      expect(tmdbStub.personImdbId).toHaveBeenCalledTimes(10);

      const second = await admin.post('/admin/metadata/people/resolve-links').expect(201);
      expect(second.body.checked).toBe(0);
      expect(tmdbStub.personImdbId).toHaveBeenCalledTimes(10);
    });
  });
});
