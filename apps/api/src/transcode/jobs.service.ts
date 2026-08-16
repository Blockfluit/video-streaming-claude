import { basename, extname } from 'node:path';

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { StorageService } from '../common/storage.service';
import { FfmpegService } from '../media/ffmpeg.service';
import { MediaService } from '../media/media.service';
import type { JobType } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SubtitlesService } from '../subtitles/subtitles.service';
import { classifySubtitleStreams } from './subtitle-streams';
import { CancelledError, Transcoder } from './transcoder';

/**
 * The persistent job queue: conversions and subtitle extraction.
 *
 * Separate from the probe queue, and at **concurrency 1**. Transcoding
 * saturates a CPU, so running several at once makes them all slower rather than
 * finishing sooner — while probing is cheap and IO-bound and happily runs two.
 *
 * **Nothing starts on its own.** A 200-file drop marks videos as needing
 * conversion and stops there; an admin decides when to spend the CPU.
 */
@Injectable()
export class JobsService implements OnModuleInit {
  private readonly logger = new Logger(JobsService.name);

  /** One at a time — the whole point of a separate queue. */
  private running: Promise<void> | null = null;
  private readonly cancellations = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly transcoder: Transcoder,
    private readonly ffmpeg: FfmpegService,
    private readonly subtitles: SubtitlesService,
    private readonly media: MediaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Clears jobs the previous process was in the middle of.
   *
   * A job's RUNNING state lives in a database row and its actual work lives in
   * a child process. Restart the API — a crash, a deploy, a file change in dev
   * — and the child dies while the row does not, leaving a job that claims to
   * be running forever, a progress bar frozen mid-encode, and a Cancel button
   * that resolves against a `cancellations` map the new process knows nothing
   * about.
   *
   * They are marked FAILED rather than requeued, because **nothing transcodes
   * on its own** here: an admin decides when to spend the CPU, and that applies
   * just as much to work the machine has already thrown away once. The message
   * says what happened so Retry is an obvious next step. The half-written
   * output is already unreachable — transcoding writes to derived/tmp/ and only
   * renames into place on success.
   */
  async onModuleInit(): Promise<void> {
    const { count } = await this.prisma.mediaJob.updateMany({
      where: { status: { in: ['RUNNING', 'QUEUED'] } },
      data: {
        status: 'FAILED',
        error: 'The server restarted while this job was running. Retry to start it again.',
        finishedAt: new Date(),
      },
    });

    if (count > 0) {
      this.logger.warn(`Failed ${count} job(s) left running by a previous process`);
    }
  }

  /** Queues a job and starts the pump. Returns immediately — the work is long. */
  async enqueue(videoId: string, type: JobType, createdById: string | null) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, storageKey: true, sourceDeletedAt: true },
    });
    if (!video) throw new NotFoundException('No such video');

    if (video.sourceDeletedAt !== null) {
      // There is nothing left to convert from.
      throw new BadRequestException('The source file for this video has been reclaimed');
    }

    const alreadyQueued = await this.prisma.mediaJob.findFirst({
      where: { videoId, type, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
    });
    // Clicking Convert twice should not queue two conversions of the same file.
    if (alreadyQueued) return this.get(alreadyQueued.id);

    const job = await this.prisma.mediaJob.create({
      data: { videoId, type, status: 'QUEUED', createdById },
    });

    this.pump();

    return job;
  }

  async get(id: string) {
    const job = await this.prisma.mediaJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('No such job');
    return job;
  }

  /**
   * Cancels a job. A running one has its child killed; a queued one never starts.
   */
  async cancel(id: string) {
    const job = await this.get(id);

    if (job.status === 'RUNNING') {
      this.cancellations.get(id)?.abort();
    } else if (job.status !== 'QUEUED') {
      throw new BadRequestException(`A ${job.status.toLowerCase()} job cannot be cancelled`);
    }

    return this.prisma.mediaJob.update({
      where: { id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
  }

  /** Re-queues a job that failed or was cancelled, as a new one. */
  async retry(id: string, createdById: string | null) {
    const job = await this.get(id);

    if (job.status === 'QUEUED' || job.status === 'RUNNING') {
      throw new BadRequestException('That job has not finished yet');
    }

    return this.enqueue(job.videoId, job.type, createdById);
  }

  /** Starts the next queued job, unless one is already running. */
  private pump(): void {
    if (this.running) return;

    this.running = this.drainQueue().finally(() => {
      this.running = null;
    });
  }

  private async drainQueue(): Promise<void> {
    for (;;) {
      const next = await this.prisma.mediaJob.findFirst({
        where: { status: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
      });
      if (!next) return;

      await this.runJob(next.id);
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const controller = new AbortController();
    this.cancellations.set(jobId, controller);

    await this.prisma.mediaJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date(), progress: 0 },
    });

    try {
      const job = await this.prisma.mediaJob.findUniqueOrThrow({ where: { id: jobId } });

      if (job.type === 'TRANSCODE') {
        await this.transcode(jobId, job.videoId, controller.signal);
      } else if (job.type === 'SUBTITLE_EXTRACT') {
        await this.extractSubtitles(jobId, job.videoId);
      }

      await this.prisma.mediaJob.update({
        where: { id: jobId },
        data: { status: 'SUCCEEDED', progress: 1, finishedAt: new Date(), etaSeconds: 0 },
      });
    } catch (error) {
      const cancelled = error instanceof CancelledError || controller.signal.aborted;

      await this.prisma.mediaJob.update({
        where: { id: jobId },
        data: {
          status: cancelled ? 'CANCELLED' : 'FAILED',
          error: cancelled ? null : describe(error).slice(0, 2000),
          finishedAt: new Date(),
        },
      });

      if (!cancelled) this.logger.error(`Job ${jobId} failed: ${describe(error)}`);
    } finally {
      this.cancellations.delete(jobId);
    }
  }

  private async transcode(jobId: string, videoId: string, signal: AbortSignal): Promise<void> {
    const video = await this.prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      select: { id: true, storageKey: true, durationSec: true },
    });

    const source = this.storage.resolvePath('media', video.storageKey);

    /**
     * Written to `tmp/` and renamed into place only on success.
     *
     * A partial file under its final name would be served to viewers and picked
     * up by the next probe as though it were finished.
     */
    const temporaryKey = `tmp/${jobId}.mp4`;
    const finalKey = `converted/${videoId}.mp4`;
    await this.storage.ensureDirectory('derived', 'tmp');
    await this.storage.ensureDirectory('derived', 'converted');

    let lastWrite = 0;

    try {
      await this.transcoder.convert({
        source,
        destination: this.storage.resolvePath('derived', temporaryKey),
        durationSec: video.durationSec,
        crf: Number(this.config.get<string>('TRANSCODE_CRF') ?? 25),
        preset: this.config.get<string>('TRANSCODE_PRESET') ?? 'medium',
        signal,
        onProgress: ({ percent, etaSeconds, logTail }) => {
          // Throttled: ffmpeg reports several times a second, and a write per
          // report would spend the transcode hammering Postgres.
          const now = Date.now();
          if (now - lastWrite < 1000) return;
          lastWrite = now;

          void this.prisma.mediaJob
            .update({
              where: { id: jobId },
              data: {
                progress: percent ?? 0,
                etaSeconds: etaSeconds ?? null,
                // Already bounded to 8KB by the transcoder; carried on the same
                // throttled write rather than one of its own.
                logTail,
              },
            })
            .catch(() => undefined);
        },
      });

      await this.storage.move('derived', temporaryKey, finalKey);
    } catch (error) {
      // Whether cancelled or failed, the half-written file goes.
      await this.storage.delete('derived', temporaryKey);
      throw error;
    }

    await this.prisma.video.update({
      where: { id: videoId },
      data: {
        playbackKey: finalKey,
        playbackMime: 'video/mp4',
        needsConversion: false,
      },
    });

    await this.prisma.mediaJob.update({ where: { id: jobId }, data: { outputKey: finalKey } });

    // Re-probe so the recorded dimensions describe what actually plays.
    this.media.enqueue(videoId);
  }

  /**
   * Pulls text subtitle tracks out of the container into WebVTT sidecars.
   *
   * Bitmap tracks are counted and reported rather than failing the job — they
   * are images, and converting them would need OCR.
   */
  private async extractSubtitles(jobId: string, videoId: string): Promise<void> {
    const video = await this.prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      select: { id: true, storageKey: true },
    });

    const source = this.storage.resolvePath('media', video.storageKey);
    const probe = await this.ffmpeg.probeStreams(source);
    const { extractable, skipped } = classifySubtitleStreams(probe);

    await this.storage.ensureDirectory('derived', `subtitles/${videoId}`);

    let extracted = 0;
    for (const track of extractable) {
      const storageKey = `subtitles/${videoId}/embedded-${track.index}-${track.language}.vtt`;

      try {
        await this.transcoder.extractSubtitle(
          source,
          track.index,
          this.storage.resolvePath('derived', storageKey),
        );
        await this.subtitles.registerExtracted({
          videoId,
          storageKey,
          language: track.language,
          label: track.label,
        });
        extracted += 1;
      } catch (error) {
        // One bad track must not lose the others.
        this.logger.warn(`Could not extract stream ${track.index}: ${describe(error)}`);
      }
    }

    /**
     * Once, after the whole set — not per track.
     *
     * The rule reads every track to decide, so running it inside the loop would
     * have it answer from a half-registered list and settle on whichever
     * English track happened to be extracted first.
     */
    await this.subtitles.refreshAutoDefault(videoId);

    const notes = [`${extracted} track${extracted === 1 ? '' : 's'} extracted`];
    if (skipped.length > 0) {
      // Surfaced per file rather than silently vanishing: if these matter, the
      // honest options are burning them in or running OCR.
      notes.push(`${skipped.length} image-based track${skipped.length === 1 ? '' : 's'} skipped`);
    }

    await this.prisma.mediaJob.update({
      where: { id: jobId },
      data: { message: notes.join('; ') },
    });
  }

  /**
   * Reclaims a source file after a successful conversion.
   *
   * The row keeps `sourceDeletedAt` and its `playbackKey`, which is exactly what
   * exempts it from the missing-file sweep — otherwise freeing disk space would
   * mark half the library MISSING.
   */
  async reclaimSource(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, storageKey: true, playbackKey: true, sourceDeletedAt: true },
    });
    if (!video) throw new NotFoundException('No such video');

    if (!video.playbackKey) {
      throw new BadRequestException('There is no converted file to play instead of the source');
    }
    if (video.sourceDeletedAt !== null) {
      throw new BadRequestException('That source has already been reclaimed');
    }
    // Refuse if the replacement is not actually there — deleting the only copy
    // because a row says otherwise is unrecoverable.
    if (!(await this.storage.exists('derived', video.playbackKey))) {
      throw new BadRequestException('The converted file is missing; refusing to delete the source');
    }

    await this.storage.delete('media', video.storageKey);
    await this.prisma.video.update({
      where: { id: videoId },
      data: { sourceDeletedAt: new Date() },
    });

    this.logger.log(`Reclaimed source for ${basename(video.storageKey)}${extname('')}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
