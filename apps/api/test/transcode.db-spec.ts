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
import { JobsService } from '../src/transcode/jobs.service';

const run = promisify(execFile);

/**
 * Transcoding against real ffmpeg — the plan's checkpoint is "convert a real
 * MKV, watch progress reach 100%, then play the MP4 with its extracted tracks",
 * and none of that means anything against a mock.
 */
describe('Transcoding (real ffmpeg)', () => {
  const PASSWORD = 'correct horse battery staple';
  const tokenFile = join(tmpdir(), 'video-streaming-transcode-test.bootstrap-token');

  let workspace: string;
  let mediaRoot: string;
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let media: MediaService;
  let banner: jest.SpyInstance;
  let admin: request.Agent;

  /** An MKV with H.265 video and, optionally, embedded subtitle tracks. */
  async function makeMkv(
    relPath: string,
    options: { seconds?: number; subtitles?: { language: string; title: string }[] } = {},
  ): Promise<void> {
    const { seconds = 2, subtitles = [] } = options;
    const absolute = join(mediaRoot, relPath);
    await mkdir(dirname(absolute), { recursive: true });

    const srtPaths: string[] = [];
    for (const [index, track] of subtitles.entries()) {
      const srtPath = join(workspace, `track-${index}.srt`);
      await writeFile(
        srtPath,
        `1\n00:00:00,500 --> 00:00:01,500\n${track.title} line one\n\n2\n00:00:01,600 --> 00:00:02,000\n${track.title} line two\n`,
      );
      srtPaths.push(srtPath);
    }

    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=10:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      ...srtPaths.flatMap((path) => ['-i', path]),
      '-map', '0:v', '-map', '1:a',
      ...srtPaths.flatMap((_, index) => ['-map', `${index + 2}:s`]),
      // H.265 in Matroska: exactly the combination the conversion exists for.
      '-c:v', 'libx265', '-x265-params', 'log-level=none',
      '-c:a', 'aac', '-c:s', 'srt',
      ...subtitles.flatMap((track, index) => [
        `-metadata:s:s:${index}`, `language=${track.language}`,
        `-metadata:s:s:${index}`, `title=${track.title}`,
      ]),
      '-t', String(seconds),
      absolute,
    ]);
  }

  async function seedVideo(relPath: string, title: string): Promise<string> {
    const stats = await storage.statOf('media', relPath);
    const collection = await prisma.collection.upsert({
      where: { folderKey: 'Films' },
      create: { slug: 'films', title: 'Films', folderKey: 'Films' },
      update: {},
      select: { id: true },
    });

    const video = await prisma.video.create({
      data: {
        collections: { create: { collectionId: collection.id } },
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        title,
        storageKey: relPath,
        contentTag: `tag-${title}`,
        originalName: relPath,
        mimeType: 'video/x-matroska',
        sizeBytes: BigInt(stats?.size ?? 0),
        fileMtime: new Date(),
        state: 'DRAFT',
      },
      select: { id: true },
    });

    // Probe first — the conversion needs a duration to report progress against.
    media.enqueue(video.id);
    await media.drain();

    return video.id;
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

  /** Polls a job until it stops running. */
  async function waitForJob(jobId: string, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const job = await prisma.mediaJob.findUniqueOrThrow({ where: { id: jobId } });
      if (job.status !== 'QUEUED' && job.status !== 'RUNNING') return job;
      if (Date.now() > deadline) throw new Error(`Job ${jobId} still ${job.status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Waits for a derived file to disappear. Cleanup after a cancel is ordered
   * against ffmpeg's death rather than against the job's status write, so
   * "gone" is eventually true rather than immediately true. Still fails if it
   * never happens — a leaked temp file is a real fault, just not a fast one.
   */
  async function waitUntilGone(root: 'media' | 'derived', key: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (!(await storage.exists(root, key))) return;
      if (Date.now() > deadline) throw new Error(`${key} was never cleaned up`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    workspace = await mkdtemp(join(tmpdir(), 'transcode-'));
    mediaRoot = join(workspace, 'media');
    await mkdir(mediaRoot, { recursive: true });

    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = tokenFile;
    process.env.MEDIA_ROOT = mediaRoot;
    process.env.DERIVED_ROOT = join(workspace, 'derived');
    process.env.INGEST_WATCHER_ENABLED = 'false';
    // Fastest encode that still exercises the real pipeline.
    process.env.TRANSCODE_PRESET = 'ultrafast';
    await rm(tokenFile, { force: true });

    await startApp();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "InviteToken", "User", "session", "Collection", "Season", "Video", "IngestIssue", "Subtitle", "MediaJob" RESTART IDENTITY CASCADE',
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

  describe('the plan checkpoint — convert a real MKV', () => {
    it('flags the mkv, converts it, and plays the result', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');

      // Probing flagged it: H.265 in Matroska plays on almost nothing.
      await expect(
        prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
      ).resolves.toMatchObject({ needsConversion: true });

      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      const job = await waitForJob(queued.body.id);

      expect(job.status).toBe('SUCCEEDED');
      expect(job.progress).toBe(1);

      const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(video).toMatchObject({
        playbackKey: `converted/${videoId}.mp4`,
        playbackMime: 'video/mp4',
        needsConversion: false,
      });

      // And the converted file actually streams.
      const response = await admin
        .get(`/videos/${videoId}/stream`)
        .set('Range', 'bytes=0-99')
        .expect(206);
      expect(response.headers['content-type']).toContain('video/mp4');
    }, 180_000);

    it('produces an h264 mp4 the browser can decode', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');

      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      await waitForJob(queued.body.id);
      await media.drain();

      const converted = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      // Re-probed, so the recorded codecs describe what actually plays.
      expect(converted.videoCodec).toBe('h264');
      expect(converted.audioCodec).toBe('aac');
    }, 180_000);

    /**
     * `-movflags +faststart` moves the moov atom to the front. Without it,
     * progressive playback cannot begin until the whole file downloads, which
     * would defeat the Range streaming this app is built on.
     */
    it('writes the moov atom at the front', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');

      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      await waitForJob(queued.body.id);

      const head = (
        await readFile(storage.resolvePath('derived', `converted/${videoId}.mp4`))
      ).subarray(0, 1024).toString('latin1');

      expect(head).toContain('moov');
    }, 180_000);
  });

  describe('the job record', () => {
    it('reports progress while it runs and ends at 100%', async () => {
      await makeMkv('Films/show.mkv', { seconds: 4 });
      const videoId = await seedVideo('Films/show.mkv', 'Show');

      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      const job = await waitForJob(queued.body.id);

      expect(job.progress).toBe(1);
      expect(job.startedAt).not.toBeNull();
      expect(job.finishedAt).not.toBeNull();
      expect(job.outputKey).toBe(`converted/${videoId}.mp4`);
    }, 180_000);

    it('does not queue a second conversion of the same video', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');

      const first = await admin.post(`/videos/${videoId}/convert`).expect(202);
      const second = await admin.post(`/videos/${videoId}/convert`).expect(202);

      expect(second.body.id).toBe(first.body.id);
      await waitForJob(first.body.id);
    }, 180_000);

    it('lists and filters jobs', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');
      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      await waitForJob(queued.body.id);

      const all = await admin.get('/admin/jobs').expect(200);
      expect(all.body.items.length).toBeGreaterThan(0);

      const succeeded = await admin.get('/admin/jobs?status=SUCCEEDED').expect(200);
      expect(succeeded.body.items).toHaveLength(1);

      const byVideo = await admin.get(`/admin/jobs?videoId=${videoId}`).expect(200);
      expect(byVideo.body.total).toBe(1);
    }, 180_000);

    it('records a failure rather than throwing', async () => {
      await mkdir(join(mediaRoot, 'Films'), { recursive: true });
      await writeFile(join(mediaRoot, 'Films/broken.mkv'), 'not a video at all');
      const videoId = await seedVideo('Films/broken.mkv', 'Broken');

      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      const job = await waitForJob(queued.body.id);

      expect(job.status).toBe('FAILED');
      expect(job.error).toContain('ffmpeg failed');
      // No half-written file left behind.
      await expect(storage.exists('derived', `tmp/${job.id}.mp4`)).resolves.toBe(false);
    }, 180_000);

    it('retries a failed job as a new one', async () => {
      await mkdir(join(mediaRoot, 'Films'), { recursive: true });
      await writeFile(join(mediaRoot, 'Films/broken.mkv'), 'not a video');
      const videoId = await seedVideo('Films/broken.mkv', 'Broken');
      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      const failed = await waitForJob(queued.body.id);

      const retried = await admin.post(`/admin/jobs/${failed.id}/retry`).expect(200);

      expect(retried.body.id).not.toBe(failed.id);
      await waitForJob(retried.body.id);
      // The original record survives, so the history is not rewritten.
      await expect(prisma.mediaJob.count()).resolves.toBe(2);
    }, 180_000);
  });

  describe('cancellation', () => {
    /**
     * A cancelled transcode must leave nothing behind. The temp file is
     * deliberately not renamed into place until the encode succeeds, so there
     * is never a partial file under the name a viewer would be served.
     */
    it('kills the encode and cleans up', async () => {
      await makeMkv('Films/long.mkv', { seconds: 20 });
      const videoId = await seedVideo('Films/long.mkv', 'Long');

      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);

      // Let it actually start before cancelling.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await admin.post(`/admin/jobs/${queued.body.id}/cancel`).expect(200);

      const job = await waitForJob(queued.body.id);
      expect(job.status).toBe('CANCELLED');

      // Polled, not asserted outright. `cancel` writes CANCELLED to the row
      // before it answers the request, while the SIGKILL and the temp-file
      // delete happen on the job's own rejection path — so waitForJob returns
      // with ffmpeg possibly still dying. The guarantee is that the temp file
      // goes, not that it goes before the status flips, and asserting the
      // stronger thing fails whenever the machine is loaded enough to slow the
      // teardown down. It did exactly that on a 2-core CI runner.
      await waitUntilGone('derived', `tmp/${job.id}.mp4`);

      // No polling here, and deliberately so: the converted file is only ever
      // renamed into place on success, so a cancelled job must never produce
      // one at any point. That is the invariant worth failing over.
      await expect(storage.exists('derived', `converted/${videoId}.mp4`)).resolves.toBe(false);
      // The video is untouched — still needing conversion, still playable from source.
      await expect(prisma.video.findUniqueOrThrow({ where: { id: videoId } })).resolves.toMatchObject(
        { playbackKey: null, needsConversion: true },
      );
    }, 180_000);

    it('refuses to cancel a job that already finished', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');
      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      await waitForJob(queued.body.id);

      await admin.post(`/admin/jobs/${queued.body.id}/cancel`).expect(400);
    }, 180_000);
  });

  describe('embedded subtitle extraction', () => {
    it('pulls text tracks out into servable vtt', async () => {
      await makeMkv('Films/subbed.mkv', {
        subtitles: [
          { language: 'eng', title: 'English' },
          { language: 'nld', title: 'Nederlands' },
        ],
      });
      const videoId = await seedVideo('Films/subbed.mkv', 'Subbed');

      const queued = await admin.post(`/videos/${videoId}/extract-subtitles`).expect(202);
      const job = await waitForJob(queued.body.id);

      expect(job.status).toBe('SUCCEEDED');
      expect(job.message).toContain('2 tracks extracted');

      const subtitles = await prisma.subtitle.findMany({ where: { videoId } });
      expect(subtitles).toHaveLength(2);
      expect(subtitles.map((subtitle) => subtitle.language).sort()).toEqual(['eng', 'nld']);
      expect(subtitles.every((subtitle) => subtitle.origin === 'EXTRACTED')).toBe(true);

      // And they serve as real WebVTT.
      const response = await admin
        .get(`/videos/${videoId}/subtitles/${subtitles[0].id}.vtt`)
        .expect(200);
      expect(response.text.startsWith('WEBVTT')).toBe(true);
      expect(response.text).toContain('line one');
    }, 180_000);

    it('keeps the track titles from the container', async () => {
      await makeMkv('Films/subbed.mkv', { subtitles: [{ language: 'nld', title: 'Nederlands' }] });
      const videoId = await seedVideo('Films/subbed.mkv', 'Subbed');

      const queued = await admin.post(`/videos/${videoId}/extract-subtitles`).expect(202);
      await waitForJob(queued.body.id);

      await expect(prisma.subtitle.findFirstOrThrow({ where: { videoId } })).resolves.toMatchObject({
        label: 'Nederlands',
      });
    }, 180_000);

    it('does not duplicate on a second extraction', async () => {
      await makeMkv('Films/subbed.mkv', { subtitles: [{ language: 'eng', title: 'English' }] });
      const videoId = await seedVideo('Films/subbed.mkv', 'Subbed');

      const first = await admin.post(`/videos/${videoId}/extract-subtitles`).expect(202);
      await waitForJob(first.body.id);
      const second = await admin.post(`/videos/${videoId}/extract-subtitles`).expect(202);
      await waitForJob(second.body.id);

      await expect(prisma.subtitle.count({ where: { videoId } })).resolves.toBe(1);
    }, 180_000);

    it('reports a file with no subtitles rather than failing', async () => {
      await makeMkv('Films/plain.mkv');
      const videoId = await seedVideo('Films/plain.mkv', 'Plain');

      const queued = await admin.post(`/videos/${videoId}/extract-subtitles`).expect(202);
      const job = await waitForJob(queued.body.id);

      expect(job.status).toBe('SUCCEEDED');
      expect(job.message).toContain('0 tracks extracted');
    }, 180_000);
  });

  describe('reclaiming the source', () => {
    it('deletes the source and exempts the video from the missing sweep', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');
      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      await waitForJob(queued.body.id);

      await admin.delete(`/videos/${videoId}/source`).expect(204);

      await expect(storage.exists('media', 'Films/show.mkv')).resolves.toBe(false);
      const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(video.sourceDeletedAt).not.toBeNull();

      // The sweep must leave it alone, or freeing disk space marks the library MISSING.
      await admin.post('/admin/ingest/scan').expect(200);
      await expect(prisma.video.findUniqueOrThrow({ where: { id: videoId } })).resolves.toMatchObject(
        { state: 'DRAFT' },
      );
    }, 180_000);

    it('still streams from the converted file afterwards', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');
      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      await waitForJob(queued.body.id);
      await admin.delete(`/videos/${videoId}/source`).expect(204);

      await admin.get(`/videos/${videoId}/stream`).set('Range', 'bytes=0-99').expect(206);
    }, 180_000);

    /** Deleting the only copy because a row says otherwise is unrecoverable. */
    it('refuses when there is no converted file to fall back on', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');

      await admin.delete(`/videos/${videoId}/source`).expect(400);
      await expect(storage.exists('media', 'Films/show.mkv')).resolves.toBe(true);
    }, 180_000);

    it('refuses when the converted file has gone missing', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');
      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      await waitForJob(queued.body.id);
      await storage.delete('derived', `converted/${videoId}.mp4`);

      await admin.delete(`/videos/${videoId}/source`).expect(400);
      await expect(storage.exists('media', 'Films/show.mkv')).resolves.toBe(true);
    }, 180_000);

    it('refuses to convert a video whose source is already gone', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');
      const queued = await admin.post(`/videos/${videoId}/convert`).expect(202);
      await waitForJob(queued.body.id);
      await admin.delete(`/videos/${videoId}/source`).expect(204);

      await admin.post(`/videos/${videoId}/convert`).expect(400);
    }, 180_000);
  });

  describe('jobs left behind by a restart', () => {
    /**
     * A job's RUNNING state lives in a row; its work lives in a child process.
     * A restart kills the child and leaves the row, so the queue shows a job
     * running forever and Cancel resolves against a map the new process knows
     * nothing about. This shipped as a real bug and was hit by hand.
     *
     * Calls the lifecycle hook directly: the alternative is restarting a Nest
     * app mid-suite, which proves the same thing far more slowly.
     */
    it('fails them on boot so they can be retried', async () => {
      const videoId = await seedVideo('Films/show.mkv', 'Show');

      const stranded = await prisma.mediaJob.create({
        data: { videoId, type: 'TRANSCODE', status: 'RUNNING', progress: 0.42 },
      });
      const queued = await prisma.mediaJob.create({
        data: { videoId, type: 'SUBTITLE_EXTRACT', status: 'QUEUED' },
      });

      await app.get(JobsService).onModuleInit();

      const after = await prisma.mediaJob.findMany({
        where: { id: { in: [stranded.id, queued.id] } },
        select: { id: true, status: true, error: true, finishedAt: true },
      });

      for (const job of after) {
        expect(job.status).toBe('FAILED');
        expect(job.error).toMatch(/restarted/i);
        expect(job.finishedAt).not.toBeNull();
      }
    });

    it('leaves finished jobs alone', async () => {
      const videoId = await seedVideo('Films/show.mkv', 'Show');
      const done = await prisma.mediaJob.create({
        data: { videoId, type: 'TRANSCODE', status: 'SUCCEEDED', progress: 1 },
      });

      await app.get(JobsService).onModuleInit();

      const after = await prisma.mediaJob.findUniqueOrThrow({ where: { id: done.id } });
      expect(after.status).toBe('SUCCEEDED');
      expect(after.error).toBeNull();
    });
  });

  describe('access control', () => {
    it('is admin-only', async () => {
      await makeMkv('Films/show.mkv');
      const videoId = await seedVideo('Films/show.mkv', 'Show');
      const invite = await admin.post('/admin/invites').send({}).expect(201);
      const user = request.agent(app.getHttpServer());
      await user
        .post('/auth/redeem')
        .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
        .expect(201);

      await user.post(`/videos/${videoId}/convert`).expect(403);
      await user.post(`/videos/${videoId}/extract-subtitles`).expect(403);
      await user.delete(`/videos/${videoId}/source`).expect(403);
      await user.get('/admin/jobs').expect(403);
    }, 180_000);
  });
});
