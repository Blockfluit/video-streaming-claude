import { readFile } from 'node:fs/promises';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { toPage, type Page } from '@video/shared';

import { isKnownLanguage } from '../common/language';
import { StorageService } from '../common/storage.service';
import { FfmpegService } from '../media/ffmpeg.service';
import { PrismaService } from '../prisma/prisma.service';
import { isProbablyUtf8, isWebVtt } from './vtt';

/** A video with more tracks than this has a problem the picker cannot fix. */
const MAX_SUBTITLE_TRACKS = 100;

/**
 * Sidecar subtitles: binding them to videos, converting them to WebVTT, and
 * serving them.
 *
 * Two things shape the design.
 *
 * **Everything served lives in `DERIVED_ROOT`, including sidecars that were
 * already `.vtt`.** Copying a few kilobytes is cheaper than carrying a
 * "which root is this in?" question through every read, and it means a served
 * subtitle survives its source being moved or reclaimed.
 *
 * **`sourceKey` is the media-relative path of the sidecar that produced it**,
 * for ingested subtitles. That is what lets reconcile notice a sidecar was
 * deleted — a `.vtt` copied without one would be unremovable.
 */

export const SUBTITLE_SELECT = {
  id: true,
  videoId: true,
  language: true,
  label: true,
  storageKey: true,
  sourceKey: true,
  sourceFormat: true,
  isDefault: true,
  origin: true,
  createdAt: true,
} as const;

export interface SidecarBinding {
  videoId: string;
  /** Media-relative path of the sidecar. */
  sourceKey: string;
  language: string;
  label: string;
  /** `vtt`, `srt`, `ass`, … */
  format: string;
}

@Injectable()
export class SubtitlesService {
  private readonly logger = new Logger(SubtitlesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
  ) {}

  /**
   * A `Page`, like every other list endpoint, even though a video's tracks are
   * few. This returned a bare array until a `<track>` list silently came back
   * empty in the player, which reads `.items` because everything else does —
   * the convention exists precisely so no caller has to check which shape a
   * given endpoint chose.
   *
   * Unpaged in practice: the whole set comes back in one page, because a track
   * picker showing half the languages is worse than a long list.
   */
  async list(videoId: string): Promise<Page<unknown>> {
    const subtitles = await this.prisma.subtitle.findMany({
      where: { videoId },
      select: SUBTITLE_SELECT,
      // Default first, then alphabetically — the order a track picker reads best.
      orderBy: [{ isDefault: 'desc' }, { language: 'asc' }, { label: 'asc' }],
      take: MAX_SUBTITLE_TRACKS,
    });

    return toPage(subtitles, subtitles.length, { limit: MAX_SUBTITLE_TRACKS, offset: 0 });
  }

  /** The WebVTT bytes to serve, or a 404. */
  async read(videoId: string, subtitleId: string): Promise<Buffer> {
    const subtitle = await this.prisma.subtitle.findFirst({
      where: { id: subtitleId, videoId },
      select: { storageKey: true },
    });
    if (!subtitle) throw new NotFoundException('No such subtitle');

    try {
      return await readFile(this.storage.resolvePath('derived', subtitle.storageKey));
    } catch {
      // The row survived something that removed the file. Say so rather than 500.
      throw new NotFoundException('The file for this subtitle is not on disk');
    }
  }

  /**
   * Creates or updates the subtitle a sidecar implies, converting when needed.
   *
   * Idempotent on `(videoId, sourceKey)`: reconcile runs repeatedly and must not
   * produce a second row, nor reconvert a file that has not changed.
   */
  async bindSidecar(binding: SidecarBinding): Promise<'created' | 'updated' | 'unchanged'> {
    const existing = await this.prisma.subtitle.findFirst({
      where: { videoId: binding.videoId, sourceKey: binding.sourceKey },
      select: { id: true, storageKey: true, label: true, language: true },
    });

    const storageKey = `subtitles/${binding.videoId}/${slugForTrack(binding)}.vtt`;

    if (existing) {
      // Already converted and still present: nothing to do. Re-running ffmpeg on
      // every scan would be pure waste.
      if (existing.storageKey === storageKey && (await this.storage.exists('derived', storageKey))) {
        if (existing.label === binding.label && existing.language === binding.language) {
          return 'unchanged';
        }
      }
    }

    await this.materialise(binding, storageKey);

    if (existing) {
      await this.prisma.subtitle.update({
        where: { id: existing.id },
        data: {
          language: binding.language,
          label: binding.label,
          storageKey,
          sourceFormat: binding.format,
        },
      });
      return 'updated';
    }

    // A video may legitimately have the same label twice only if the language
    // differs; the composite unique enforces that. A clash means two sidecars
    // describe the same track, which is a duplicate rather than an error worth
    // failing a scan over.
    try {
      await this.prisma.subtitle.create({
        data: {
          videoId: binding.videoId,
          language: binding.language,
          label: binding.label,
          storageKey,
          sourceKey: binding.sourceKey,
          sourceFormat: binding.format,
          origin: 'INGEST',
        },
      });
      return 'created';
    } catch (error) {
      this.logger.warn(
        `Could not bind ${binding.sourceKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'unchanged';
    }
  }

  /** Writes the servable `.vtt` into DERIVED_ROOT, converting if the source is not already one. */
  private async materialise(binding: SidecarBinding, storageKey: string): Promise<void> {
    const source = this.storage.resolvePath('media', binding.sourceKey);
    const destination = this.storage.resolvePath('derived', storageKey);
    await this.storage.ensureDirectory('derived', `subtitles/${binding.videoId}`);

    if (binding.format === 'vtt') {
      // Copied rather than referenced, so everything served sits in one root.
      await this.storage.save('derived', storageKey, await readFile(source));
      return;
    }

    /**
     * The charset is settled **before** converting, not after.
     *
     * Legacy `.srt` files are very often Windows-1252. Handing one to ffmpeg as
     * UTF-8 either fails outright or produces mojibake, depending on which
     * bytes it contains — and a conversion that already failed cannot be
     * rescued by a retry it never reaches.
     */
    const charset = isProbablyUtf8(await readFile(source)) ? undefined : 'CP1252';
    if (charset) {
      this.logger.log(`${binding.sourceKey} is not UTF-8; converting as ${charset}`);
    }

    try {
      await this.ffmpeg.convertSubtitle(source, destination, charset);
    } catch (error) {
      throw new BadRequestException(
        `Could not convert ${binding.sourceKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Records a track pulled out of a container by the extraction job.
   *
   * `origin: EXTRACTED` rather than `INGEST`, so reconcile never removes it —
   * it has no sidecar on disk to go missing, and `forgetMissingSidecars` looks
   * only at ingested rows.
   */
  async registerExtracted(track: {
    videoId: string;
    storageKey: string;
    language: string;
    label: string;
    isDefault: boolean;
  }): Promise<void> {
    const existing = await this.prisma.subtitle.findFirst({
      where: { videoId: track.videoId, storageKey: track.storageKey },
      select: { id: true },
    });

    if (existing) {
      // Re-running extraction overwrites the file; the row just needs its
      // labels refreshed rather than a duplicate alongside it.
      await this.prisma.subtitle.update({
        where: { id: existing.id },
        data: { language: track.language, label: track.label },
      });
      return;
    }

    try {
      const created = await this.prisma.subtitle.create({
        data: {
          videoId: track.videoId,
          language: track.language,
          label: track.label,
          storageKey: track.storageKey,
          sourceFormat: 'vtt',
          origin: 'EXTRACTED',
        },
        select: { id: true },
      });

      if (track.isDefault) await this.setDefault(created.id);
    } catch (error) {
      // A sidecar may already claim this language and label. That is a
      // duplicate, not a reason to fail the extraction job.
      this.logger.warn(
        `Could not register extracted track: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Removes rows whose sidecar has gone from disk, and the files they served. */
  async forgetMissingSidecars(presentSourceKeys: Set<string>): Promise<number> {
    const ingested = await this.prisma.subtitle.findMany({
      where: { origin: 'INGEST', sourceKey: { not: null } },
      select: { id: true, sourceKey: true, storageKey: true },
    });

    const gone = ingested.filter((subtitle) => !presentSourceKeys.has(subtitle.sourceKey as string));

    for (const subtitle of gone) {
      // Unlike a video, a subtitle row carries no history worth keeping — no
      // progress, no comments — so removing it is right rather than marking it.
      await this.storage.delete('derived', subtitle.storageKey);
      await this.prisma.subtitle.delete({ where: { id: subtitle.id } });
    }

    return gone.length;
  }

  /** An admin uploading a track by hand. Stored under `UPLOAD`, so reconcile never removes it. */
  async upload(
    videoId: string,
    file: Buffer,
    input: { language: string; label: string; isDefault?: boolean },
  ) {
    const video = await this.prisma.video.findUnique({ where: { id: videoId }, select: { id: true } });
    if (!video) throw new NotFoundException('No such video');

    // A file claiming to be a subtitle but holding an SRT loads as an empty
    // track: the viewer sees the language listed and nothing appears.
    if (!isWebVtt(file)) {
      throw new BadRequestException('That file is not WebVTT. Convert it first, or upload a .vtt.');
    }

    const language = input.language.trim().toLowerCase();
    const storageKey = `subtitles/${videoId}/upload-${Date.now()}.vtt`;
    await this.storage.save('derived', storageKey, file);

    const created = await this.prisma.subtitle.create({
      data: {
        videoId,
        language,
        label: input.label,
        storageKey,
        sourceFormat: 'vtt',
        origin: 'UPLOAD',
        isDefault: false,
      },
      select: SUBTITLE_SELECT,
    });

    if (input.isDefault) await this.setDefault(created.id);

    return { ...created, languageKnown: isKnownLanguage(language) };
  }

  async update(
    id: string,
    input: { language?: string; label?: string; isDefault?: boolean },
  ) {
    const subtitle = await this.prisma.subtitle.findUnique({ where: { id }, select: { id: true } });
    if (!subtitle) throw new NotFoundException('No such subtitle');

    if (input.isDefault === true) await this.setDefault(id);

    return this.prisma.subtitle.update({
      where: { id },
      data: {
        language: input.language?.trim().toLowerCase(),
        label: input.label,
        ...(input.isDefault === false ? { isDefault: false } : {}),
      },
      select: SUBTITLE_SELECT,
    });
  }

  async remove(id: string): Promise<void> {
    const subtitle = await this.prisma.subtitle.findUnique({
      where: { id },
      select: { id: true, storageKey: true },
    });
    if (!subtitle) throw new NotFoundException('No such subtitle');

    await this.storage.delete('derived', subtitle.storageKey);
    await this.prisma.subtitle.delete({ where: { id } });
  }

  /**
   * Exactly one default per video.
   *
   * `<track default>` on two tracks is undefined behaviour — the browser picks
   * one, and which it picks is not something to leave to chance.
   */
  private async setDefault(id: string): Promise<void> {
    const subtitle = await this.prisma.subtitle.findUniqueOrThrow({
      where: { id },
      select: { videoId: true },
    });

    await this.prisma.$transaction([
      this.prisma.subtitle.updateMany({
        where: { videoId: subtitle.videoId },
        data: { isDefault: false },
      }),
      this.prisma.subtitle.update({ where: { id }, data: { isDefault: true } }),
    ]);
  }
}

/** A stable, filesystem-safe name per track, so re-binding overwrites rather than accumulating. */
function slugForTrack(binding: SidecarBinding): string {
  const label = binding.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${binding.language}-${label || 'track'}`;
}
