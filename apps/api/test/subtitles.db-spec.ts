import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SessionStoreService } from '../src/auth/session-store.service';
import { bigIntReplacer } from '../src/common/json';
import { StorageService } from '../src/common/storage.service';
import { MediaService } from '../src/media/media.service';
import { PrismaService } from '../src/prisma/prisma.service';

const run = promisify(execFile);

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello there.

2
00:00:04,000 --> 00:00:06,000
General Kenobi.
`;

/**
 * Sidecar discovery, conversion and serving — against real files and real
 * ffmpeg, since "does a browser get valid WebVTT" is the entire feature.
 */
describe('Subtitles (real database)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-subs-test.bootstrap-token');

  let workspace: string;
  let mediaRoot: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let media: MediaService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;

  const http = () => request(app.getHttpServer());

  async function put(relPath: string, body: string | Buffer): Promise<void> {
    const absolute = join(mediaRoot, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body);
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
  }

  async function startApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('json replacer', bigIntReplacer);
    app.use(app.get(SessionStoreService).createMiddleware());
    await app.init();
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
    media = app.get(MediaService);
  }

  const scan = () => admin.post('/admin/ingest/scan').expect(200);

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'subs-'));
    mediaRoot = join(workspace, 'media');
    await mkdir(mediaRoot, { recursive: true });

    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = tokenFile;
    process.env.MEDIA_ROOT = mediaRoot;
    process.env.DERIVED_ROOT = join(workspace, 'derived');
    process.env.INGEST_WATCHER_ENABLED = 'false';
    await rm(tokenFile, { force: true });

    await startApp();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "InviteToken", "User", "session", "Collection", "Season", "Video", "IngestIssue", "Subtitle" RESTART IDENTITY CASCADE',
    );
    await app.close();
    await rm(tokenFile, { force: true });

    await startApp();

    admin = request.agent(app.getHttpServer());
    await admin
      .post('/auth/redeem')
      .send({ token: (await readFile(tokenFile, 'utf8')).trim(), username: 'ada', password: PASSWORD })
      .expect(201);
  });

  afterEach(async () => {
    banner.mockRestore();
    await app?.close();
    await rm(tokenFile, { force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  const openIssues = () => prisma.ingestIssue.findMany({ where: { resolvedAt: null } });

  describe('binding sidecars during a scan', () => {
    it('binds a sidecar named after the video file', async () => {
      await makeVideo('Show/Pilot.mp4');
      await put('Show/Pilot_en_English.srt', SRT);

      await scan();

      const subtitles = await prisma.subtitle.findMany();
      expect(subtitles).toHaveLength(1);
      expect(subtitles[0]).toMatchObject({
        language: 'en',
        label: 'English',
        sourceFormat: 'srt',
        origin: 'INGEST',
      });
    });

    // The plan's second rule: a sidecar downloaded separately is usually named
    // after the title rather than the full filename.
    it('binds a sidecar named after the cleaned title', async () => {
      await makeVideo('Show/01 - Pilot.mp4');
      await put('Show/Pilot_nl_Nederlands.srt', SRT);

      await scan();

      await expect(prisma.subtitle.findMany()).resolves.toHaveLength(1);
    });

    it('binds several languages to one video', async () => {
      await makeVideo('Show/Pilot.mp4');
      await put('Show/Pilot_en_English.srt', SRT);
      await put('Show/Pilot_nl_Nederlands.srt', SRT);

      await scan();

      await expect(prisma.subtitle.findMany()).resolves.toHaveLength(2);
    });

    /**
     * Per folder, not library-wide. Every show has a "Pilot", and matching
     * across folders would make all of them ambiguous.
     */
    it('does not bind a sidecar to a same-named video in another folder', async () => {
      await makeVideo('Show A/Pilot.mp4');
      await makeVideo('Show B/Pilot.mp4');
      await put('Show A/Pilot_en_English.srt', SRT);

      await scan();

      const subtitles = await prisma.subtitle.findMany({ include: { video: true } });
      expect(subtitles).toHaveLength(1);
      expect(subtitles[0].video.storageKey).toBe('Show A/Pilot.mp4');
    });

    it('reports a sidecar that matches nothing', async () => {
      await makeVideo('Show/Pilot.mp4');
      await put('Show/Something Else_en_English.srt', SRT);

      await scan();

      await expect(prisma.subtitle.findMany()).resolves.toHaveLength(0);
      expect(await openIssues()).toEqual([
        expect.objectContaining({ kind: 'ORPHAN_SUBTITLE', path: 'Show/Something Else_en_English.srt' }),
      ]);
    });

    // Binding the wrong language to the wrong episode is worse than an issue.
    it('reports an ambiguous sidecar rather than guessing', async () => {
      await makeVideo('Show/01 - Pilot.mp4');
      await makeVideo('Show/02 - Pilot.mp4');
      await put('Show/Pilot_en_English.srt', SRT);

      await scan();

      await expect(prisma.subtitle.findMany()).resolves.toHaveLength(0);
      expect(await openIssues()).toEqual([
        expect.objectContaining({ kind: 'AMBIGUOUS_SUBTITLE' }),
      ]);
    });

    it('flags an unrecognised language code but still binds it', async () => {
      await makeVideo('Show/Pilot.mp4');
      await put('Show/Pilot_zz_Klingon.srt', SRT);

      await scan();

      await expect(prisma.subtitle.findMany()).resolves.toHaveLength(1);
      expect(await openIssues()).toEqual([
        expect.objectContaining({ detail: expect.stringContaining('zz') }),
      ]);
    });

    it('does not duplicate on a rescan', async () => {
      await makeVideo('Show/Pilot.mp4');
      await put('Show/Pilot_en_English.srt', SRT);

      await scan();
      await scan();
      await scan();

      await expect(prisma.subtitle.count()).resolves.toBe(1);
    });

    it('removes the row when the sidecar is deleted', async () => {
      await makeVideo('Show/Pilot.mp4');
      await put('Show/Pilot_en_English.srt', SRT);
      await scan();
      const [before] = await prisma.subtitle.findMany();

      await rm(join(mediaRoot, 'Show/Pilot_en_English.srt'));
      await scan();

      await expect(prisma.subtitle.count()).resolves.toBe(0);
      // The served file goes with it.
      await expect(storage.exists('derived', before.storageKey)).resolves.toBe(false);
    });
  });

  describe('conversion', () => {
    it('converts an srt into real WebVTT', async () => {
      await makeVideo('Show/Pilot.mp4');
      await put('Show/Pilot_en_English.srt', SRT);

      await scan();

      const [subtitle] = await prisma.subtitle.findMany();
      const body = await readFile(storage.resolvePath('derived', subtitle.storageKey), 'utf8');

      expect(body.startsWith('WEBVTT')).toBe(true);
      expect(body).toContain('General Kenobi.');
      /**
       * The real difference from SRT: a dot before the milliseconds rather than
       * a comma. The hours field is optional in WebVTT and ffmpeg omits it for
       * short cues, so the pattern must not insist on it.
       */
      expect(body).toMatch(/(?:\d{2}:)?00:01\.000 --> (?:\d{2}:)?00:03\.000/);
      expect(body).not.toContain(',000');
    });

    it('writes the servable file into DERIVED_ROOT, never the watched tree', async () => {
      await makeVideo('Show/Pilot.mp4');
      await put('Show/Pilot_en_English.srt', SRT);

      await scan();

      const [subtitle] = await prisma.subtitle.findMany();
      await expect(storage.exists('derived', subtitle.storageKey)).resolves.toBe(true);
      await expect(storage.exists('media', subtitle.storageKey)).resolves.toBe(false);
    });

    // Copied rather than referenced, so everything served sits in one root and
    // survives its source being moved.
    it('copies a sidecar that is already vtt', async () => {
      await makeVideo('Show/Pilot.mp4');
      await put('Show/Pilot_en_English.vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n');

      await scan();

      const [subtitle] = await prisma.subtitle.findMany();
      expect(subtitle.sourceFormat).toBe('vtt');
      await expect(storage.exists('derived', subtitle.storageKey)).resolves.toBe(true);
    });

    /**
     * Legacy `.srt` files are very often Windows-1252. ffmpeg does not fail on
     * those — it produces mojibake — so the charset has to be decided rather
     * than left to chance.
     */
    it('reconverts a Windows-1252 srt so the accents survive', async () => {
      await makeVideo('Show/Pilot.mp4');
      // "Café" and "naïve" in CP1252, which is invalid UTF-8.
      const cp1252 = Buffer.concat([
        Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nCaf', 'latin1'),
        Buffer.from([0xe9]),
        Buffer.from(' na', 'latin1'),
        Buffer.from([0xef]),
        Buffer.from('ve\n', 'latin1'),
      ]);
      await put('Show/Pilot_fr_Francais.srt', cp1252);

      await scan();

      const [subtitle] = await prisma.subtitle.findMany();
      const body = await readFile(storage.resolvePath('derived', subtitle.storageKey), 'utf8');

      expect(body).toContain('Café');
      expect(body).toContain('naïve');
      expect(body).not.toContain('�');
    });
  });

  describe('serving', () => {
    let videoId: string;
    let subtitleId: string;

    beforeEach(async () => {
      await makeVideo('Show/Pilot.mp4');
      await put('Show/Pilot_en_English.srt', SRT);
      await scan();
      const [subtitle] = await prisma.subtitle.findMany();
      videoId = subtitle.videoId;
      subtitleId = subtitle.id;
    });

    it('serves the vtt with the content type a track element needs', async () => {
      const response = await admin.get(`/videos/${videoId}/subtitles/${subtitleId}.vtt`).expect(200);

      expect(response.headers['content-type']).toContain('text/vtt');
      expect(response.text.startsWith('WEBVTT')).toBe(true);
    });

    it('does not let a cache keep private media', async () => {
      const response = await admin.get(`/videos/${videoId}/subtitles/${subtitleId}.vtt`).expect(200);

      expect(response.headers['cache-control']).toBe('private, no-store');
    });

    it('lists the tracks for a video', async () => {
      const response = await admin.get(`/videos/${videoId}/subtitles`).expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({ language: 'en', label: 'English' });
    });

    it('401s an anonymous caller — a subtitle URL is not public', async () => {
      await http().get(`/videos/${videoId}/subtitles/${subtitleId}.vtt`).expect(401);
      await http().get(`/videos/${videoId}/subtitles`).expect(401);
    });

    // A USER must not learn what subtitles a draft has, let alone read them.
    it('404s a USER on a draft video', async () => {
      const invite = await admin.post('/admin/invites').send({}).expect(201);
      const user = request.agent(app.getHttpServer());
      await user
        .post('/auth/redeem')
        .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
        .expect(201);

      await user.get(`/videos/${videoId}/subtitles`).expect(404);
      await user.get(`/videos/${videoId}/subtitles/${subtitleId}.vtt`).expect(404);
    });

    it('404s a subtitle that belongs to another video', async () => {
      await makeVideo('Show/Other.mp4');
      await scan();
      const other = await prisma.video.findFirstOrThrow({ where: { title: 'Other' } });

      await admin.get(`/videos/${other.id}/subtitles/${subtitleId}.vtt`).expect(404);
    });
  });

  describe('manual upload and editing', () => {
    let videoId: string;

    beforeEach(async () => {
      await makeVideo('Show/Pilot.mp4');
      await scan();
      videoId = (await prisma.video.findFirstOrThrow()).id;
    });

    it('accepts a WebVTT upload', async () => {
      const response = await admin
        .post(`/videos/${videoId}/subtitles`)
        .field('language', 'en')
        .field('label', 'English (SDH)')
        .attach('file', Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n'), {
          filename: 'x.vtt',
          contentType: 'text/vtt',
        })
        .expect(201);

      expect(response.body).toMatchObject({ language: 'en', label: 'English (SDH)', origin: 'UPLOAD' });
    });

    /**
     * An SRT uploaded as a subtitle loads as an empty track: the viewer sees
     * the language listed and nothing ever appears. Refusing it at the door is
     * the only way they find out.
     */
    it('refuses an srt pretending to be a vtt', async () => {
      await admin
        .post(`/videos/${videoId}/subtitles`)
        .field('language', 'en')
        .field('label', 'English')
        .attach('file', Buffer.from(SRT), { filename: 'x.vtt', contentType: 'text/vtt' })
        .expect(400);
    });

    it('leaves an uploaded track alone when a scan runs', async () => {
      await admin
        .post(`/videos/${videoId}/subtitles`)
        .field('language', 'en')
        .field('label', 'English')
        .attach('file', Buffer.from('WEBVTT\n'), { filename: 'x.vtt', contentType: 'text/vtt' })
        .expect(201);

      await scan();

      await expect(prisma.subtitle.count()).resolves.toBe(1);
    });

    it('renames a track', async () => {
      const created = await admin
        .post(`/videos/${videoId}/subtitles`)
        .field('language', 'en')
        .field('label', 'English')
        .attach('file', Buffer.from('WEBVTT\n'), { filename: 'x.vtt', contentType: 'text/vtt' })
        .expect(201);

      const response = await admin
        .patch(`/subtitles/${created.body.id}`)
        .send({ label: 'English (Forced)' })
        .expect(200);

      expect(response.body.label).toBe('English (Forced)');
    });

    /**
     * `<track default>` on two tracks is undefined behaviour — the browser
     * picks one, and which is not something to leave to chance.
     */
    it('keeps exactly one default per video', async () => {
      const first = await admin
        .post(`/videos/${videoId}/subtitles`)
        .field('language', 'en')
        .field('label', 'English')
        .field('isDefault', 'true')
        .attach('file', Buffer.from('WEBVTT\n'), { filename: 'a.vtt', contentType: 'text/vtt' })
        .expect(201);
      const second = await admin
        .post(`/videos/${videoId}/subtitles`)
        .field('language', 'nl')
        .field('label', 'Nederlands')
        .attach('file', Buffer.from('WEBVTT\n'), { filename: 'b.vtt', contentType: 'text/vtt' })
        .expect(201);

      await admin.patch(`/subtitles/${second.body.id}`).send({ isDefault: true }).expect(200);

      const all = await prisma.subtitle.findMany();
      expect(all.filter((subtitle) => subtitle.isDefault)).toHaveLength(1);
      expect(all.find((subtitle) => subtitle.isDefault)?.id).toBe(second.body.id);
      expect(first.body.id).not.toBe(second.body.id);
    });

    it('deletes a track and its file', async () => {
      const created = await admin
        .post(`/videos/${videoId}/subtitles`)
        .field('language', 'en')
        .field('label', 'English')
        .attach('file', Buffer.from('WEBVTT\n'), { filename: 'x.vtt', contentType: 'text/vtt' })
        .expect(201);

      await admin.delete(`/subtitles/${created.body.id}`).expect(204);

      await expect(prisma.subtitle.count()).resolves.toBe(0);
      await expect(storage.exists('derived', created.body.storageKey)).resolves.toBe(false);
    });

    it('is admin-only', async () => {
      const invite = await admin.post('/admin/invites').send({}).expect(201);
      const user = request.agent(app.getHttpServer());
      await user
        .post('/auth/redeem')
        .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
        .expect(201);

      await user
        .post(`/videos/${videoId}/subtitles`)
        .field('language', 'en')
        .field('label', 'English')
        .attach('file', Buffer.from('WEBVTT\n'), { filename: 'x.vtt', contentType: 'text/vtt' })
        .expect(403);
      await user.delete('/subtitles/whatever').expect(403);
    });
  });

  describe('the scan summary', () => {
    it('counts what it bound', async () => {
      await makeVideo('Show/Pilot.mp4');
      await put('Show/Pilot_en_English.srt', SRT);
      await put('Show/Pilot_nl_Nederlands.srt', SRT);

      const response = await scan();

      expect(response.body).toMatchObject({ subtitlesBound: 2 });
      await media.drain();
    });
  });
});
