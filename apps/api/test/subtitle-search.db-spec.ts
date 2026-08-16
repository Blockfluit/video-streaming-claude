import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { StorageService } from '../src/common/storage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { DbHarness, PASSWORD } from './db/harness';
import { SUBTITLE_PROVIDER, type SubtitleProvider, type SubtitleQuery } from '../src/subtitles/providers/provider';

const run = promisify(execFile);

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello there.

2
00:00:04,000 --> 00:00:06,000
General Kenobi.
`;

/**
 * Finding and installing subtitles from a provider, against a real database,
 * real files and real ffmpeg.
 *
 * The provider itself is the seam that gets replaced — `.overrideProvider`, the
 * way the metadata suites replace TMDB. Talking to opensubtitles.com in a test
 * would be testing their uptime, and the interesting questions are all on this
 * side of it: does an SRT become servable WebVTT, does the row land where
 * reconcile cannot reap it, and is the whole thing shut to a USER.
 */
describe('Subtitle search (real database)', () => {
  const harness = new DbHarness({ name: 'subsearch', workspace: true, admin: 'ada', configure: builder => builder.overrideProvider(SUBTITLE_PROVIDER).useValue(provider) });


  let mediaRoot: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let admin: request.Agent;

  /** What the stub was asked, so the hash-before-title rule can be asserted. */
  let asked: SubtitleQuery[];
  let provider: SubtitleProvider;

  const http = () => request(app.getHttpServer());

  function stubProvider(overrides: Partial<SubtitleProvider> = {}): SubtitleProvider {
    return {
      name: 'Stub',
      isConfigured: true,
      async search(query: SubtitleQuery) {
        asked.push(query);
        return [
          {
            fileId: '12345',
            language: query.language,
            releaseName: 'Some.Release.1080p',
            fileName: 'Some.Release.1080p.srt',
            format: 'srt',
            downloadCount: 10,
            hearingImpaired: false,
            fromHash: query.movieHash !== undefined,
          },
        ];
      },
      async download() {
        return { bytes: Buffer.from(SRT, 'utf8'), format: 'srt' };
      },
      async quota() {
        return { remaining: 18, allowed: 20 };
      },
      ...overrides,
    } as SubtitleProvider;
  }

  async function makeVideo(relPath: string): Promise<void> {
    const absolute = join(mediaRoot, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '1',
      absolute,
    ]);
    /*
     * Padded past 128 KB so it can be hashed at all. A one-second test clip is
     * a few tens of kilobytes, and the OSDb hash is undefined below two 64 KB
     * chunks — without this the hash path silently never runs and the test
     * proves the title fallback twice.
     */
    await appendFile(absolute, Buffer.alloc(200_000));
  }


  const scan = () => admin.post('/admin/ingest/scan').expect(200);

  /** The one video every test works on. */
  async function ingestOne(): Promise<string> {
    await makeVideo('disk1/Show/Pilot.mp4');
    await scan();
    const video = await prisma.video.findFirstOrThrow({ select: { id: true } });
    return video.id;
  }

  beforeEach(async () => {
    // Both before the app is built: `configure` reads `provider` when the
    // container is compiled, so a stub assigned afterwards is a stub the app
    // never saw.
    asked = [];
    provider = stubProvider();

    await harness.start();
    ({ app, prisma, admin } = harness);
    storage = app.get(StorageService);

    mediaRoot = join(harness.workspace, 'media');
    await mkdir(mediaRoot, { recursive: true });
  });

  afterEach(() => harness.stop());

  describe('searching', () => {
    it('asks by file hash before asking by title', async () => {
      const id = await ingestOne();

      await admin.get(`/videos/${id}/subtitle-candidates?language=en`).expect(200);

      expect(asked).toHaveLength(1);
      expect(asked[0]?.movieHash).toMatch(/^[0-9a-f]{16}$/);
      expect(asked[0]?.query).toBeUndefined();
    });

    it('falls back to the title when the hash matches nothing', async () => {
      const id = await ingestOne();
      // Nothing for the hash, something for the title — the ordinary case for
      // a file that is not a release anyone else has.
      provider = stubProvider({
        async search(query: SubtitleQuery) {
          asked.push(query);
          return query.movieHash ? [] : [
            {
              fileId: '999', language: 'en', releaseName: 'By title', fileName: 'x.srt',
              format: 'srt', downloadCount: 1, hearingImpaired: false, fromHash: false,
            },
          ];
        },
      });
      // The provider stub has been swapped, so the container is rebuilt around
      // the new one. The database is left alone.
      await harness.restart();
      ({ app, prisma, admin } = harness);
      storage = app.get(StorageService);

      const response = await admin.get(`/videos/${id}/subtitle-candidates?language=en`).expect(200);

      expect(asked).toHaveLength(2);
      expect(asked[1]?.query).toBe('Pilot');
      expect(response.body.items).toHaveLength(1);
    });

    it('uses the words an admin typed instead of the hash', async () => {
      const id = await ingestOne();

      await admin
        .get(`/videos/${id}/subtitle-candidates?language=en&query=something%20else`)
        .expect(200);

      // One call only: typing a query means overriding the derived question,
      // and answering with hash matches would ignore what was asked.
      expect(asked).toHaveLength(1);
      expect(asked[0]?.query).toBe('something else');
      expect(asked[0]?.movieHash).toBeUndefined();
    });

    it('returns a Page, like every other list endpoint', async () => {
      const id = await ingestOne();

      const response = await admin.get(`/videos/${id}/subtitle-candidates?language=en`).expect(200);

      expect(response.body).toMatchObject({ items: expect.any(Array), total: 1 });
    });

    it('is 404 for a video that does not exist', async () => {
      await admin.get('/videos/nope/subtitle-candidates?language=en').expect(404);
    });
  });

  describe('when the server has no provider key', () => {
    beforeEach(async () => {
      provider = stubProvider({ isConfigured: false });
      // The provider stub has been swapped, so the container is rebuilt around
      // the new one. The database is left alone.
      await harness.restart();
      ({ app, prisma, admin } = harness);
      storage = app.get(StorageService);
    });

    it('says so rather than failing at the provider', async () => {
      const id = await ingestOne();

      const response = await admin.get(`/videos/${id}/subtitle-candidates?language=en`).expect(503);

      expect(response.body.message).toMatch(/not configured/i);
      expect(asked).toHaveLength(0);
    });

    it('reports itself as unconfigured, so the button can be hidden', async () => {
      const response = await admin.get('/subtitles/search/status').expect(200);
      expect(response.body).toEqual({ configured: false });
    });

    it('has no allowance to report either', async () => {
      await admin.get('/subtitles/search/quota').expect(503);
    });
  });

  describe('installing a candidate', () => {
    it('converts the SRT it downloaded and serves it as WebVTT', async () => {
      const id = await ingestOne();

      const created = await admin
        .post(`/videos/${id}/subtitles/fetch`)
        .send({ fileId: '12345', language: 'en' })
        .expect(201);

      expect(created.body).toMatchObject({ language: 'en', origin: 'DOWNLOADED', sourceFormat: 'srt' });

      const served = await admin.get(`/videos/${id}/subtitles/${created.body.id}.vtt`).expect(200);
      expect(served.text).toMatch(/^WEBVTT/);
      expect(served.text).toContain('General Kenobi');
    });

    it('writes only into DERIVED_ROOT, never the watched tree', async () => {
      const id = await ingestOne();

      await admin.post(`/videos/${id}/subtitles/fetch`).send({ fileId: '12345', language: 'en' }).expect(201);

      const subtitle = await prisma.subtitle.findFirstOrThrow();
      expect(subtitle.storageKey).toMatch(/^subtitles\//);
      await expect(storage.exists('derived', subtitle.storageKey)).resolves.toBe(true);
      // The whole watcher-feedback rule in one assertion.
      await expect(storage.exists('media', subtitle.storageKey)).resolves.toBe(false);
    });

    it('leaves no staging file behind in tmp', async () => {
      const id = await ingestOne();

      await admin.post(`/videos/${id}/subtitles/fetch`).send({ fileId: '12345', language: 'en' }).expect(201);

      await expect(storage.listFiles('derived', 'tmp')).resolves.toEqual([]);
    });

    /**
     * The invariant this feature could most easily get wrong. `origin: INGEST`
     * would look right and work perfectly until the next scan quietly deleted
     * every downloaded subtitle in the library.
     */
    it('survives a rescan, having no sidecar to go missing', async () => {
      const id = await ingestOne();
      await admin.post(`/videos/${id}/subtitles/fetch`).send({ fileId: '12345', language: 'en' }).expect(201);

      await scan();

      const subtitles = await prisma.subtitle.findMany();
      expect(subtitles).toHaveLength(1);
      await expect(storage.exists('derived', subtitles[0]!.storageKey)).resolves.toBe(true);
    });

    it('names the track after its language when the caller does not', async () => {
      const id = await ingestOne();

      const created = await admin
        .post(`/videos/${id}/subtitles/fetch`)
        .send({ fileId: '12345', language: 'nl' })
        .expect(201);

      expect(created.body.label).toBe('Dutch');
    });

    it('refuses a download that claims to be WebVTT and is not', async () => {
      const id = await ingestOne();
      provider = stubProvider({
        async download() {
          // An SRT with a .vtt name loads as a track that lists a language and
          // never displays anything.
          return { bytes: Buffer.from(SRT, 'utf8'), format: 'vtt' };
        },
      });
      // The provider stub has been swapped, so the container is rebuilt around
      // the new one. The database is left alone.
      await harness.restart();
      ({ app, prisma, admin } = harness);
      storage = app.get(StorageService);

      const response = await admin
        .post(`/videos/${id}/subtitles/fetch`)
        .send({ fileId: '12345', language: 'en' })
        .expect(400);

      expect(response.body.message).toMatch(/WebVTT/i);
      await expect(prisma.subtitle.count()).resolves.toBe(0);
    });

    it('refuses a second track with the same language and label', async () => {
      const id = await ingestOne();
      await admin.post(`/videos/${id}/subtitles/fetch`).send({ fileId: '12345', language: 'en' }).expect(201);

      await admin
        .post(`/videos/${id}/subtitles/fetch`)
        .send({ fileId: '54321', language: 'en' })
        .expect(400);

      await expect(prisma.subtitle.count()).resolves.toBe(1);
    });

    it('takes the file with the row when the track is deleted', async () => {
      const id = await ingestOne();
      const created = await admin
        .post(`/videos/${id}/subtitles/fetch`)
        .send({ fileId: '12345', language: 'en' })
        .expect(201);

      await admin.delete(`/subtitles/${created.body.id}`).expect(204);

      await expect(storage.exists('derived', created.body.storageKey)).resolves.toBe(false);
      await expect(prisma.subtitle.count()).resolves.toBe(0);
    });
  });

  describe('access', () => {
    let viewer: request.Agent;

    beforeEach(async () => {
      const invite = await admin.post('/admin/invites').send({ role: 'USER' }).expect(201);
      viewer = request.agent(app.getHttpServer());
      await viewer
        .post('/auth/redeem')
        .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
        .expect(201);
    });

    it('will not let a USER search', async () => {
      const id = await ingestOne();
      await viewer.get(`/videos/${id}/subtitle-candidates?language=en`).expect(403);
      expect(asked).toHaveLength(0);
    });

    it('will not let a USER install', async () => {
      const id = await ingestOne();
      await viewer
        .post(`/videos/${id}/subtitles/fetch`)
        .send({ fileId: '12345', language: 'en' })
        .expect(403);
    });

    it('will not let a signed-out caller search', async () => {
      const id = await ingestOne();
      await http().get(`/videos/${id}/subtitle-candidates?language=en`).expect(401);
    });
  });

  describe('the download allowance', () => {
    it('reports what is left today', async () => {
      const response = await admin.get('/subtitles/search/quota').expect(200);

      expect(response.body).toEqual({ quota: { remaining: 18, allowed: 20 } });
    });

    /**
     * Wrapped rather than bare: a handler returning `null` sends an empty 200
     * body, and the picker could not then tell "this server has no such number"
     * from "the response went missing".
     */
    it('says so explicitly when there is no such number', async () => {
      provider = stubProvider({ async quota() { return null; } });
      // The provider stub has been swapped, so the container is rebuilt around
      // the new one. The database is left alone.
      await harness.restart();
      ({ app, prisma, admin } = harness);
      storage = app.get(StorageService);

      const response = await admin.get('/subtitles/search/quota').expect(200);

      expect(response.body).toEqual({ quota: null });
    });

    it('is shut to a USER, like the rest of it', async () => {
      const invite = await admin.post('/admin/invites').send({ role: 'USER' }).expect(201);
      const viewer = request.agent(app.getHttpServer());
      await viewer
        .post('/auth/redeem')
        .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
        .expect(201);

      await viewer.get('/subtitles/search/quota').expect(403);
    });
  });

  describe('the language list', () => {
    it('comes back as a Page of codes and names', async () => {
      const response = await admin.get('/subtitles/languages').expect(200);

      expect(response.body.items).toContainEqual(
        expect.objectContaining({ code: 'nl', name: 'Dutch' }),
      );
      // ISO 639-1 only: the full set runs to thousands nobody subtitles in.
      expect(response.body.items.length).toBeGreaterThan(100);
      expect(response.body.items.length).toBeLessThan(300);
    });
  });
});
