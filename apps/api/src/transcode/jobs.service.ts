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
import {
  convertedKeyVariant,
  convertingTemporaryKey,
  LEGACY_CONVERTED_PREFIX,
  playbackRoot,
} from './converted-key';
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
   * says what happened so Retry is an obvious next step.
   *
   * Their half-written output is swept too, which it never used to be. It sat
   * in `derived/tmp/` where nothing reached it and nobody looked; it now sits in
   * the admin's own media folders, where a killed encode would otherwise leave
   * a multi-gigabyte dotfile behind after every crash. The temporary name is
   * derived from `(storageKey, jobId)`, so it can be recomputed here without
   * having been recorded anywhere.
   */
  async onModuleInit(): Promise<void> {
    const interrupted = await this.prisma.mediaJob.findMany({
      where: { status: { in: ['RUNNING', 'QUEUED'] } },
      select: { id: true, type: true, video: { select: { storageKey: true } } },
    });

    const { count } = await this.prisma.mediaJob.updateMany({
      where: { status: { in: ['RUNNING', 'QUEUED'] } },
      data: {
        status: 'FAILED',
        error: 'The server restarted while this job was running. Retry to start it again.',
        finishedAt: new Date(),
      },
    });

    for (const job of interrupted) {
      if (job.type !== 'TRANSCODE' || !job.video) continue;
      await this.storage.delete(
        'media',
        convertingTemporaryKey(job.video.storageKey, job.id),
      );
    }

    if (count > 0) {
      this.logger.warn(`Failed ${count} job(s) left running by a previous process`);
    }

    /**
     * Rows still pointing at the pre-relocation layout.
     *
     * Only counted, never moved: relocating is a per-file copy across two
     * filesystems, and doing that in `onModuleInit` would hold the whole
     * bootstrap open — no health, no login — for as long as the library takes
     * to copy, which a container healthcheck reads as a hung start. It is
     * `POST /admin/jobs/relocate-conversions` instead, and this is the line
     * that stops a half-migrated install shipping silently.
     */
    const legacy = await this.prisma.video.count({
      where: { playbackKey: { startsWith: LEGACY_CONVERTED_PREFIX } },
    });

    if (legacy > 0) {
      this.logger.warn(
        `${legacy} converted file(s) still live under derived/converted/. `
          + 'POST /admin/jobs/relocate-conversions moves them beside their sources.',
      );
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
      select: {
        id: true,
        storageKey: true,
        durationSec: true,
        playbackKey: true,
        playbackMime: true,
        needsConversion: true,
      },
    });

    const source = this.storage.resolvePath('media', video.storageKey);

    /**
     * Written to a dot-prefixed neighbour of where it is going, and renamed into
     * place only on success.
     *
     * A partial file under its final name would be served to viewers and picked
     * up by the next probe as though it were finished — and now that the output
     * lands inside the watched tree, ingest would read it as a truncated video
     * as well. Both the scanner and the watcher pass over dotfiles, so the
     * encode is invisible until it is done. Same directory as the destination,
     * so the rename is within one filesystem and therefore atomic: staging
     * under `derived/` would make it a cross-root copy of the whole file.
     */
    const temporaryKey = convertingTemporaryKey(video.storageKey, jobId);

    let lastWrite = 0;

    try {
      await this.transcoder.convert({
        source,
        destination: this.storage.resolvePath('media', temporaryKey),
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

    } catch (error) {
      // Whether cancelled or failed, the half-written file goes.
      await this.storage.delete('media', temporaryKey);
      throw error;
    }

    /**
     * The name is chosen **after** the encode, not before it.
     *
     * A three-hour transcode is easily outlived by a new file appearing in the
     * folder, so a name reserved up front may be taken by the time it is used.
     * The temporary name is derived from the source and is stable throughout,
     * which is what the encode actually needs.
     */
    const finalKey = await this.freeConvertedKey(video);
    const previousKey = video.playbackKey;

    /**
     * Reserve the column, then rename. The order is the whole safety argument.
     *
     * Rename first and there is a window where a finished `.mp4` sits in a
     * watched folder that no row claims — and the rename is exactly what wakes
     * the watcher, so reconcile ingests it as a brand-new video. That damage is
     * permanent: the entry splits in two and the curation goes with the wrong
     * one.
     *
     * Reserve first and the window is the opposite: the column points at a file
     * that appears milliseconds later. Streaming 404s for that instant,
     * `reclaimSource` refuses because it stats the file, and the delete guard is
     * unreachable because `enqueue` will not convert a reclaimed video at all.
     * Every one of those is transient and none of them loses anything.
     *
     * It is also what lets reconcile read its rows *after* scanning and be sure
     * it has not missed a conversion that finished in between.
     */
    await this.prisma.video.update({
      where: { id: videoId },
      data: { playbackKey: finalKey, playbackMime: 'video/mp4' },
    });
    await this.prisma.mediaJob.update({ where: { id: jobId }, data: { outputKey: finalKey } });

    try {
      await this.storage.move('media', temporaryKey, finalKey);
    } catch (error) {
      // Put the row back exactly as it was — on a reconvert that is a previous
      // key rather than null, so clearing the column would strand the old file.
      await this.prisma.video.update({
        where: { id: videoId },
        data: {
          playbackKey: previousKey,
          playbackMime: video.playbackMime,
          needsConversion: video.needsConversion,
        },
      });
      await this.storage.delete('media', temporaryKey);
      throw error;
    }

    await this.prisma.video.update({
      where: { id: videoId },
      data: { needsConversion: false },
    });

    /**
     * The file the row used to point at.
     *
     * Usually there is none, and on a plain reconvert `finalKey` is the same
     * name — the rename overwrote it in place, so there is nothing to sweep.
     * It differs only when the source moved between conversions, and then the
     * old output is an orphan in the watched tree that nothing claims any more.
     *
     * Guarded against the source key: it cannot happen by construction, since
     * `convertedKeyFor` never returns its argument, but the cost of being wrong
     * is deleting the film and the check is one comparison.
     */
    if (previousKey !== null && previousKey !== finalKey && previousKey !== video.storageKey) {
      await this.storage.delete(playbackRoot(previousKey), previousKey);
    }

    // Re-probe so the recorded dimensions describe what actually plays.
    this.media.enqueue(videoId);
  }

  /**
   * A converted name nothing else is using.
   *
   * Modelled on `UploadsService.freeStorageKey`, and checking the same two
   * places for the same reason: a file can be on disk with no row yet, and
   * overwriting it would destroy something nobody asked to replace.
   *
   * The row being converted is excluded from the check. Without that, a plain
   * reconvert would find its own previous output in the way and pick
   * `Heat-2.mp4` — leaving `Heat.mp4` behind as an orphan in a watched folder,
   * which the next scan reads as a second video.
   */
  private async freeConvertedKey(video: {
    id: string;
    storageKey: string;
    playbackKey: string | null;
  }): Promise<string> {
    for (let index = 0; ; index += 1) {
      const candidate = convertedKeyVariant(video.storageKey, index);

      const claimed = await this.prisma.video.findFirst({
        where: {
          id: { not: video.id },
          OR: [{ storageKey: candidate }, { playbackKey: candidate }],
        },
        select: { id: true },
      });
      if (claimed) continue;

      // On disk but unclaimed — except when it is this row's own output, which
      // is precisely the file we mean to replace.
      if (candidate !== video.playbackKey && (await this.storage.exists('media', candidate))) {
        continue;
      }

      return candidate;
    }
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
    /**
     * The converted file cannot be the source, or reclaiming would delete the
     * very thing it claims to be replacing.
     *
     * `convertedKeyFor` never returns its argument — that is what the
     * `.converted` suffix on an mp4 source exists for — so this is unreachable
     * by construction. It is checked anyway because the failure is silent and
     * total, and the check is one comparison.
     */
    if (video.playbackKey === video.storageKey) {
      throw new BadRequestException('The converted file is the source; refusing to delete it');
    }
    // Refuse if the replacement is not actually there — deleting the only copy
    // because a row says otherwise is unrecoverable.
    if (!(await this.storage.exists(playbackRoot(video.playbackKey), video.playbackKey))) {
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
