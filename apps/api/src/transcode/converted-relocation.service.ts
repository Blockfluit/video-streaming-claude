import { Injectable, Logger } from '@nestjs/common';

import { StorageService } from '../common/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { convertedKeyVariant, isLegacyConvertedKey } from './converted-key';

export interface RelocationSummary {
  /** Rows whose converted file was not found under `MEDIA_ROOT`. */
  scanned: number;
  relocated: number;
  /** Already in the right place by the time we looked. */
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * Moves converted files out of `derived/converted/` and in beside their sources.
 *
 * A one-shot, run by an admin rather than by a migration or a boot hook.
 *
 * Not SQL, because SQL cannot move a file, and the files cannot simply be
 * abandoned the way `derived/thumbnails/` was when artwork moved: a transcode
 * costs hours of CPU rather than a re-probe, and for a video whose source has
 * been reclaimed the converted file is the only copy of the film.
 *
 * Not `onModuleInit` either, though the ordering would have worked — Nest runs
 * every `onModuleInit` before the watcher's `onApplicationBootstrap`. It would
 * hold the whole bootstrap open, answering nothing, for as long as it takes to
 * copy the library across two filesystems, which a container healthcheck reads
 * as a hung start and kills. The restart re-runs it, and that is a boot loop.
 * `JobsService.onModuleInit` logs a warning naming this endpoint instead.
 */
@Injectable()
export class ConvertedRelocationService {
  private readonly logger = new Logger(ConvertedRelocationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async run(): Promise<RelocationSummary> {
    const summary: RelocationSummary = {
      scanned: 0,
      relocated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    /**
     * Selected on the key, then re-checked against the disk.
     *
     * The prefix alone is not enough to resume a run interrupted between the
     * column write and the rename: that row already holds its *new* key while
     * its file is still staged, so it no longer matches. The `exists` check
     * below is what actually decides, and it is why this is safe to run twice.
     */
    const candidates = await this.prisma.video.findMany({
      where: { playbackKey: { not: null } },
      select: { id: true, storageKey: true, playbackKey: true },
    });

    for (const video of candidates) {
      const playbackKey = video.playbackKey as string;

      if (await this.storage.exists('media', playbackKey)) {
        // Already beside its source. Sweep the legacy copy if this is a rerun
        // that died after the rename but before the delete.
        if (isLegacyConvertedKey(playbackKey)) continue;
        await this.storage.delete('derived', legacyKeyFor(video.id));
        summary.skipped += 1;
        continue;
      }

      if (!isLegacyConvertedKey(playbackKey) && !(await this.storage.exists('derived', playbackKey))) {
        /**
         * A relocated key whose file is under neither root. Left exactly as it
         * is: clearing the column would open the "only copy" delete guard on a
         * reclaimed video, turning a missing file into a lost entry.
         */
        summary.failed += 1;
        summary.errors.push(`${video.id}: no converted file under either root`);
        continue;
      }

      summary.scanned += 1;

      try {
        await this.relocate(video, playbackKey);
        summary.relocated += 1;
      } catch (error) {
        summary.failed += 1;
        summary.errors.push(
          `${video.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (summary.relocated > 0) {
      // Only once everything that was in it has gone.
      await this.storage.deleteIfEmpty('derived', 'converted');
    }

    this.logger.log(
      `Relocated ${summary.relocated} converted file(s); `
        + `${summary.skipped} already in place, ${summary.failed} failed`,
    );

    return summary;
  }

  /**
   * One file, in the order that keeps a visible file in `MEDIA_ROOT` claimed at
   * every instant.
   *
   * The staging file is dot-prefixed, so the copy — which may be gigabytes
   * across two filesystems — is invisible to the scanner and the watcher for
   * its whole duration. The column is then written *before* the rename, exactly
   * as the transcoder does it, so the path is covered by reconcile's filter
   * before the file ever appears there. A crash in between leaves playback
   * 404ing until the next run, which the `exists` check above detects and
   * finishes; a crash the other way round would leave an unclaimed `.mp4` in a
   * watched folder, and the next scan would ingest it as a second video.
   */
  private async relocate(
    video: { id: string; storageKey: string; playbackKey: string | null },
    fromKey: string,
  ): Promise<void> {
    const target = await this.freeKey(video);
    const staged = stagingKeyFor(target, video.id);

    await this.storage.moveBetweenRoots('derived', fromKey, 'media', staged);

    await this.prisma.video.update({
      where: { id: video.id },
      data: { playbackKey: target },
    });

    await this.storage.move('media', staged, target);
  }

  /** As `JobsService.freeConvertedKey`, but for a row that is not converting. */
  private async freeKey(video: { id: string; storageKey: string }): Promise<string> {
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

      if (await this.storage.exists('media', candidate)) continue;

      return candidate;
    }
  }
}

function legacyKeyFor(videoId: string): string {
  return `converted/${videoId}.mp4`;
}

/** Deterministic per video, so a rerun overwrites its own partial copy. */
function stagingKeyFor(targetKey: string, videoId: string): string {
  const slash = targetKey.lastIndexOf('/');
  const directory = slash === -1 ? '' : targetKey.slice(0, slash);
  const name = `.relocating-${videoId}.mp4`;

  return directory === '' ? name : `${directory}/${name}`;
}
