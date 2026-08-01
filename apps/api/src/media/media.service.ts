import { extname } from 'node:path';

import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';

import { StorageService } from '../common/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { FfmpegService } from './ffmpeg.service';
import { needsConversion } from './needs-conversion';

/**
 * Probing and thumbnails.
 *
 * A small in-process queue at **concurrency 2**: probing is IO-bound and cheap,
 * so two at a time keeps a folder drop moving without competing with anything
 * else. Transcoding is a different matter and gets its own persistent queue in
 * step 12 — that one is CPU-saturating and runs one at a time.
 *
 * Nothing here throws at the caller. A probe that fails writes `probeError` to
 * the row, because one unreadable file must not stop a scan of two hundred.
 */

const CONCURRENCY = 2;

/** Where in the video to grab the poster frame. Far enough in to miss the black frames at the start. */
const THUMBNAIL_POSITION = 0.1;

@Injectable()
export class MediaService implements OnModuleDestroy {
  private readonly logger = new Logger(MediaService.name);

  private readonly queued = new Set<string>();
  private shuttingDown = false;
  private readonly waiting: string[] = [];
  private active = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
  ) {}

  /**
   * Stops the queue when the app shuts down.
   *
   * Without this the probes still in flight outlive `app.close()`: their
   * ffprobe children and Prisma writes keep the event loop alive, so Jest
   * reported "did not exit one second after the test run has completed" and
   * `test:db` exited non-zero **with all 399 tests passing**. The same
   * stragglers logged `No record was found for an update` when they landed on
   * rows the finished test had already deleted.
   *
   * Anything still waiting is dropped rather than run — nothing is watching for
   * the result any more — and the in-flight ones are given a bounded moment to
   * land so a half-written probe does not race the connection closing under it.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.waiting.length = 0;

    const deadline = Date.now() + 5_000;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  get pending(): number {
    return this.waiting.length + this.active;
  }

  /**
   * Queues a video for probing, unless it is already waiting.
   *
   * Deduplicated by id: reconcile runs repeatedly and would otherwise queue the
   * same file on every pass.
   */
  enqueue(videoId: string): void {
    if (this.queued.has(videoId)) return;

    this.queued.add(videoId);
    this.waiting.push(videoId);
    this.pump();
  }

  /** Resolves once everything queued so far has been processed — for tests and for `reprobe`. */
  async drain(): Promise<void> {
    while (this.pending > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private pump(): void {
    if (this.shuttingDown) return;

    while (this.active < CONCURRENCY && this.waiting.length > 0) {
      const videoId = this.waiting.shift() as string;
      this.active += 1;

      void this.processOne(videoId)
        .catch((error: unknown) => {
          // Already handled per-video below; this is the last resort.
          this.logger.error(`Probe of ${videoId} failed: ${describe(error)}`);
        })
        .finally(() => {
          this.active -= 1;
          this.queued.delete(videoId);
          this.pump();
        });
    }
  }

  private async processOne(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        storageKey: true,
        playbackKey: true,
        thumbnailKey: true,
        thumbnailSource: true,
      },
    });
    if (!video) return;

    // Probe what will actually be played, so a converted file reports its own
    // dimensions rather than the source's.
    const root = video.playbackKey ? 'derived' : 'media';
    const key = video.playbackKey ?? video.storageKey;
    const path = this.storage.resolvePath(root, key);

    try {
      const probe = await this.ffmpeg.probe(path);
      const extension = extname(key).replace('.', '').toLowerCase();

      const verdict = needsConversion({
        extension,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        pixelFormat: probe.pixelFormat,
        videoProfile: probe.videoProfile,
      });

      await this.prisma.video.update({
        where: { id: video.id },
        data: {
          durationSec: probe.durationSec,
          width: probe.width,
          height: probe.height,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          audioTracks: probe.audioTracks,
          // A converted file is by definition not awaiting conversion.
          needsConversion: video.playbackKey ? false : verdict.needed,
          probedAt: new Date(),
          probeError: null,
        },
      });

      await this.generateThumbnail(video, probe.durationSec);
    } catch (error) {
      // Recorded rather than thrown: one unreadable file must not stop a scan,
      // and the admin needs to see which file and why.
      this.logger.warn(`Probe failed for ${key}: ${describe(error)}`);
      await this.prisma.video.update({
        where: { id: video.id },
        data: { probeError: describe(error).slice(0, 1000), probedAt: new Date() },
      });
    }
  }

  /**
   * Generates the poster frame — **only** when the source is `AUTO`.
   *
   * A thumbnail someone chose by hand is never overwritten by a reprobe. That
   * is the difference between re-running a scan and losing an afternoon of
   * curation.
   */
  private async generateThumbnail(
    video: { id: string; storageKey: string; playbackKey: string | null; thumbnailSource: string },
    durationSec: number | null,
  ): Promise<void> {
    if (video.thumbnailSource !== 'AUTO') return;
    if (durationSec === null) return;

    const key = `thumbnails/${video.id}.jpg`;
    const source = this.storage.resolvePath(
      video.playbackKey ? 'derived' : 'media',
      video.playbackKey ?? video.storageKey,
    );

    // Into DERIVED_ROOT, never the watched media tree — generated output
    // landing there feeds the ingest watcher its own work.
    await this.storage.ensureDirectory('derived', 'thumbnails');
    const destination = this.storage.resolvePath('derived', key);

    await this.ffmpeg.captureFrame(source, durationSec * THUMBNAIL_POSITION, destination);

    await this.prisma.video.update({
      where: { id: video.id },
      data: { thumbnailKey: key, thumbnailSource: 'AUTO' },
    });
  }

  /** Re-runs a probe on demand, and waits for it — the admin clicked a button and expects an answer. */
  async reprobe(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true },
    });
    if (!video) throw new NotFoundException('No such video');

    this.enqueue(videoId);
    await this.drain();
  }

  /**
   * Captures a poster frame at a chosen timestamp and marks it MANUAL, so a
   * later reprobe leaves it alone.
   */
  async captureThumbnail(videoId: string, atSeconds: number): Promise<string> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, storageKey: true, playbackKey: true, durationSec: true },
    });
    if (!video) throw new NotFoundException('No such video');

    const key = `thumbnails/${video.id}.jpg`;
    const source = this.storage.resolvePath(
      video.playbackKey ? 'derived' : 'media',
      video.playbackKey ?? video.storageKey,
    );

    await this.storage.ensureDirectory('derived', 'thumbnails');
    await this.ffmpeg.captureFrame(source, atSeconds, this.storage.resolvePath('derived', key));

    await this.prisma.video.update({
      where: { id: video.id },
      data: { thumbnailKey: key, thumbnailSource: 'MANUAL' },
    });

    return key;
  }

  /** Stores an uploaded image as the poster. Also MANUAL — someone chose it. */
  async setThumbnail(videoId: string, image: Buffer, extension: string): Promise<string> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true },
    });
    if (!video) throw new NotFoundException('No such video');

    const key = `thumbnails/${video.id}.${extension}`;
    await this.storage.save('derived', key, image);

    await this.prisma.video.update({
      where: { id: video.id },
      data: { thumbnailKey: key, thumbnailSource: 'MANUAL' },
    });

    return key;
  }

  /**
   * Drops the poster and returns the video to automatic.
   *
   * Deliberately does not regenerate here — the next probe will, and doing both
   * would make "remove" mean "replace".
   */
  async clearThumbnail(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, thumbnailKey: true },
    });
    if (!video) throw new NotFoundException('No such video');

    if (video.thumbnailKey) {
      await this.storage.delete('derived', video.thumbnailKey);
    }

    await this.prisma.video.update({
      where: { id: video.id },
      data: { thumbnailKey: null, thumbnailSource: 'AUTO' },
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
