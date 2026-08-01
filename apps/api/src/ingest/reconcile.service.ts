import { Injectable, Logger } from '@nestjs/common';

import { seasonSlug, slugify, uniqueSlug } from '../common/slug';
import { StorageService } from '../common/storage.service';
import { titleData } from '../common/title';
import { MediaService } from '../media/media.service';
import { SubtitlesService } from '../subtitles/subtitles.service';
import type { IngestIssueKind, PublishState } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { computeContentTag } from './content-tag';
import { scanMediaRoot, type ScannedFile } from './media-scanner';
import type { SeasonInfo } from './path-parser';
import { itemFolderKey } from './structure';
import { matchSubtitles, type SubtitleCandidate, type VideoCandidate } from './subtitle-matcher';

/**
 * Brings the database in line with what is actually on disk.
 *
 * Runs at startup, on demand, and after watcher events. **Idempotent and keyed
 * on `storageKey`** — that is exactly what stops an upload writing into the
 * watched tree from creating a second row for a file that is already known.
 *
 * The one rule that matters throughout: a row is never deleted because its file
 * went away. Watch history, progress and comments outlive the file, and a file
 * that comes back restores the state it had.
 */

export interface ReconcileSummary {
  scannedFiles: number;
  created: number;
  moved: number;
  markedMissing: number;
  restored: number;
  issues: number;
  subtitlesBound: number;
  subtitlesRemoved: number;
  startedAt: Date;
  finishedAt: Date;
}

/** A guessed MIME type. Probing (step 10) replaces this with what the file really is. */
const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  webm: 'video/webm',
};

@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  /** Reconcile is serialised: two passes at once would race on the same rows. */
  private running: Promise<ReconcileSummary> | null = null;
  private lastSummary: ReconcileSummary | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly media: MediaService,
    private readonly subtitles: SubtitlesService,
  ) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  get last(): ReconcileSummary | null {
    return this.lastSummary;
  }

  /**
   * Runs a pass, or joins the one already in flight.
   *
   * A watcher dropping twenty files fires twenty events; without this they
   * would each start a scan and fight over the same rows.
   */
  run(): Promise<ReconcileSummary> {
    if (this.running) return this.running;

    this.running = this.reconcile()
      .then((summary) => {
        this.lastSummary = summary;
        return summary;
      })
      .finally(() => {
        this.running = null;
      });

    return this.running;
  }

  private async reconcile(): Promise<ReconcileSummary> {
    const startedAt = new Date();
    const root = this.storage.rootPath('media');
    const scan = await scanMediaRoot(root);

    const known = await this.prisma.video.findMany({
      select: {
        id: true,
        storageKey: true,
        contentTag: true,
        state: true,
        stateBeforeMissing: true,
        sourceDeletedAt: true,
        playbackKey: true,
      },
    });

    const byStorageKey = new Map(known.map((video) => [video.storageKey, video]));
    const onDisk = new Set(scan.videos.map((file) => file.relPath));

    /**
     * Rows accounted for by a file that exists.
     *
     * The sweep below runs against the snapshot taken above, which still holds
     * pre-move storage keys — without this, a row that was just followed to its
     * new path would be marked MISSING in the same pass for no longer being at
     * its old one.
     */
    const present = new Set<string>();

    const seenIssues: { kind: IngestIssueKind; path: string; detail?: string }[] = [];
    let created = 0;
    let moved = 0;
    let restored = 0;

    for (const file of scan.videos) {
      const existing = byStorageKey.get(file.relPath);

      if (existing) {
        present.add(existing.id);

        if (existing.state === 'MISSING') {
          // It came back. Restore what it was, rather than quietly demoting a
          // published video to draft because a disk was unplugged for a day.
          await this.prisma.video.update({
            where: { id: existing.id },
            data: {
              state: existing.stateBeforeMissing ?? 'DRAFT',
              stateBeforeMissing: null,
              missingSince: null,
              fileMtime: file.mtime,
              sizeBytes: BigInt(file.size),
            },
          });
          restored += 1;
        }
        continue;
      }

      const contentTag = await computeContentTag(this.storage.resolvePath('media', file.relPath), file.size);

      // A row with these bytes whose own file is gone: the same file, moved.
      const candidate = known.find(
        (video) => video.contentTag === contentTag && !onDisk.has(video.storageKey),
      );

      if (candidate) {
        await this.applyMove(candidate.id, file, contentTag);
        byStorageKey.set(file.relPath, { ...candidate, storageKey: file.relPath });
        present.add(candidate.id);
        // A move can change which file plays, so its probe is no longer trusted.
        this.media.enqueue(candidate.id);
        moved += 1;
        continue;
      }

      const createdId = await this.createDraft(file, contentTag);
      if (createdId) this.media.enqueue(createdId);
      created += 1;
    }

    const markedMissing = await this.sweepMissing(known, present);

    const subtitles = await this.bindSubtitles(scan.videos, scan.subtitles, seenIssues);

    // Structural problems the parser refused outright.
    for (const file of scan.issues) {
      if (file.parsed.kind !== 'issue') continue;
      seenIssues.push({
        kind: file.parsed.reason === 'too-deep' ? 'PATH_TOO_DEEP' : 'ROOT_LEVEL_FILE',
        path: file.relPath,
      });
    }

    for (const file of scan.videos) {
      // Ingested, but the season number needs a human. Recorded as an issue
      // rather than refused — the episode is still watchable.
      if (file.parsed.kind === 'video' && file.parsed.season?.needsReview) {
        seenIssues.push({
          kind: 'UNREADABLE_SEASON',
          path: `${itemFolderKey(file.parsed)}/${file.parsed.season.folder}`,
          detail: `Could not read a season number from "${file.parsed.season.folder}"`,
        });
      }
    }

    for (const entry of scan.unreadable) {
      seenIssues.push({ kind: 'UNREADABLE_FILE', path: entry.relPath, detail: entry.reason });
    }

    await this.recordIssues(seenIssues);

    const summary: ReconcileSummary = {
      scannedFiles: scan.videos.length + scan.subtitles.length,
      created,
      moved,
      markedMissing,
      restored,
      issues: seenIssues.length,
      subtitlesBound: subtitles.bound,
      subtitlesRemoved: subtitles.removed,
      startedAt,
      finishedAt: new Date(),
    };

    this.logger.log(
      `Reconcile: ${summary.scannedFiles} files, +${created} new, ${moved} moved, ` +
        `${markedMissing} missing, ${restored} restored, ${subtitles.bound} subtitles, ` +
        `${seenIssues.length} issues`,
    );

    return summary;
  }

  /**
   * Binds sidecar subtitles to the videos beside them, **per folder**.
   *
   * Per folder because that is the scope the matcher is defined over: a
   * `Pilot_en_English.srt` belongs to the `Pilot.mp4` next to it, not to a
   * `Pilot.mp4` in another season. Matching library-wide would make every
   * show with a "Pilot" ambiguous.
   */
  private async bindSubtitles(
    videoFiles: ScannedFile[],
    subtitleFiles: ScannedFile[],
    seenIssues: { kind: IngestIssueKind; path: string; detail?: string }[],
  ): Promise<{ bound: number; removed: number }> {
    const rows = await this.prisma.video.findMany({ select: { id: true, storageKey: true } });
    const idByStorageKey = new Map(rows.map((row) => [row.storageKey, row.id]));

    const byFolder = new Map<string, { videos: ScannedFile[]; subtitles: ScannedFile[] }>();
    const folderOf = (relPath: string): string => relPath.split('/').slice(0, -1).join('/');

    for (const file of videoFiles) {
      const folder = folderOf(file.relPath);
      if (!byFolder.has(folder)) byFolder.set(folder, { videos: [], subtitles: [] });
      byFolder.get(folder)!.videos.push(file);
    }
    for (const file of subtitleFiles) {
      const folder = folderOf(file.relPath);
      if (!byFolder.has(folder)) byFolder.set(folder, { videos: [], subtitles: [] });
      byFolder.get(folder)!.subtitles.push(file);
    }

    const boundSourceKeys = new Set<string>();
    let bound = 0;

    for (const [, group] of byFolder) {
      if (group.subtitles.length === 0) continue;

      const candidates: VideoCandidate[] = group.videos.flatMap((file) => {
        const id = idByStorageKey.get(file.relPath);
        // A video that failed to ingest has no row to bind to.
        return id && file.parsed.kind === 'video' ? [{ id, basename: file.parsed.basename }] : [];
      });

      const sidecars: SubtitleCandidate[] = group.subtitles.flatMap((file) =>
        file.parsed.kind === 'subtitle'
          ? [{ basename: file.parsed.basename, extension: file.parsed.extension }]
          : [],
      );

      const { bindings, unmatched } = matchSubtitles(candidates, sidecars);

      for (const binding of bindings) {
        const source = group.subtitles.find(
          (file) => file.parsed.kind === 'subtitle' && file.parsed.basename === binding.basename,
        );
        if (!source) continue;

        try {
          const outcome = await this.subtitles.bindSidecar({
            videoId: binding.videoId,
            sourceKey: source.relPath,
            language: binding.lang,
            label: binding.label,
            format: binding.extension,
          });
          boundSourceKeys.add(source.relPath);
          if (outcome !== 'unchanged') bound += 1;

          // Accepted, but the code is not one we recognise — worth an admin's
          // attention without refusing a subtitle that probably works.
          if (!binding.langKnown) {
            seenIssues.push({
              kind: 'ORPHAN_SUBTITLE',
              path: source.relPath,
              detail: `Unrecognised language code "${binding.lang}"`,
            });
          }
        } catch (error) {
          seenIssues.push({
            kind: 'ORPHAN_SUBTITLE',
            path: source.relPath,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      for (const orphan of unmatched) {
        const source = group.subtitles.find(
          (file) => file.parsed.kind === 'subtitle' && file.parsed.basename === orphan.basename,
        );
        if (!source) continue;

        seenIssues.push({
          kind: orphan.reason === 'ambiguous' ? 'AMBIGUOUS_SUBTITLE' : 'ORPHAN_SUBTITLE',
          path: source.relPath,
          detail:
            orphan.reason === 'ambiguous'
              ? 'Matches more than one video by title; rename it to the exact filename'
              : `Could not bind this sidecar (${orphan.reason})`,
        });
      }
    }

    const removed = await this.subtitles.forgetMissingSidecars(boundSourceKeys);

    return { bound, removed };
  }

  private async applyMove(id: string, file: ScannedFile, contentTag: string): Promise<void> {
    if (file.parsed.kind !== 'video') return;

    const { collectionId, seasonId } = await this.ensureParents(itemFolderKey(file.parsed), file.parsed.season);

    // The row id survives, and with it every comment, progress row and
    // watchlist entry pointing at this video. That is the whole point of
    // detecting a move rather than deleting and recreating.
    await this.prisma.video.update({
      where: { id },
      data: {
        storageKey: file.relPath,
        contentTag,
        collectionId,
        seasonId,
        orderIndex: file.parsed.orderIndex,
        sizeBytes: BigInt(file.size),
        fileMtime: file.mtime,
        // A moved file is present again, so it is no longer missing.
        state: undefined,
        missingSince: null,
      },
    });
  }

  private async createDraft(file: ScannedFile, contentTag: string): Promise<string | null> {
    if (file.parsed.kind !== 'video') return null;

    const { collectionId, seasonId } = await this.ensureParents(itemFolderKey(file.parsed), file.parsed.season);

    const slug = await this.freeVideoSlug(collectionId, slugify(file.parsed.title));

    const created = await this.prisma.video.create({
      select: { id: true },
      data: {
        collectionId,
        seasonId,
        slug,
        ...titleData(file.parsed.title),
        orderIndex: file.parsed.orderIndex,
        storageKey: file.relPath,
        contentTag,
        originalName: `${file.parsed.basename}.${file.parsed.extension}`,
        mimeType: MIME_BY_EXTENSION[file.parsed.extension] ?? 'application/octet-stream',
        sizeBytes: BigInt(file.size),
        fileMtime: file.mtime,
        state: 'DRAFT',
        origin: 'INGEST',
      },
    });

    return created.id;
  }

  /**
   * Marks rows whose files are gone, without deleting anything.
   *
   * The exemption matters: a video whose source was reclaimed after conversion
   * has no file under `media` by design. Without this, freeing disk space would
   * mark half the library MISSING.
   */
  private async sweepMissing(
    known: {
      id: string;
      storageKey: string;
      state: PublishState;
      sourceDeletedAt: Date | null;
      playbackKey: string | null;
    }[],
    present: Set<string>,
  ): Promise<number> {
    let count = 0;

    for (const video of known) {
      // Keyed on the row, not its old path — a row followed to a new location
      // is present even though its former storageKey is not.
      if (present.has(video.id)) continue;
      if (video.state === 'MISSING') continue;

      if (video.sourceDeletedAt !== null && video.playbackKey !== null) {
        // Reclaimed on purpose, and still playable from the converted file.
        continue;
      }

      await this.prisma.video.update({
        where: { id: video.id },
        data: {
          // Remembered so a file that comes back is restored, not demoted.
          stateBeforeMissing: video.state,
          state: 'MISSING',
          missingSince: new Date(),
        },
      });
      count += 1;
    }

    return count;
  }

  /**
   * Upserts what this pass found and resolves what it did not.
   *
   * Keyed on (kind, path) so a rescan updates rather than duplicates, and an
   * issue that has gone away is marked resolved instead of deleted — the record
   * of what was once wrong is worth keeping.
   */
  private async recordIssues(
    found: { kind: IngestIssueKind; path: string; detail?: string }[],
  ): Promise<void> {
    const now = new Date();

    for (const issue of found) {
      await this.prisma.ingestIssue.upsert({
        where: { kind_path: { kind: issue.kind, path: issue.path } },
        create: { kind: issue.kind, path: issue.path, detail: issue.detail ?? null },
        update: { detail: issue.detail ?? null, resolvedAt: null },
      });
    }

    const seen = found.map((issue) => `${issue.kind}:${issue.path}`);
    const open = await this.prisma.ingestIssue.findMany({
      where: { resolvedAt: null },
      select: { id: true, kind: true, path: true },
    });

    const goneAway = open
      .filter((issue) => !seen.includes(`${issue.kind}:${issue.path}`))
      .map((issue) => issue.id);

    if (goneAway.length > 0) {
      await this.prisma.ingestIssue.updateMany({
        where: { id: { in: goneAway } },
        data: { resolvedAt: now },
      });
    }
  }

  /** Creates the collection and season a file implies, if they are not there yet. */
  private async ensureParents(
    collectionFolder: string,
    season: SeasonInfo | null,
  ): Promise<{ collectionId: string; seasonId: string | null }> {
    const collection = await this.ensureCollection(collectionFolder);
    if (!season) return { collectionId: collection, seasonId: null };

    const seasonId = await this.ensureSeason(collection, collectionFolder, season);
    return { collectionId: collection, seasonId };
  }

  private async ensureCollection(folder: string): Promise<string> {
    const existing = await this.prisma.collection.findUnique({
      where: { folderKey: folder },
      select: { id: true },
    });
    if (existing) return existing.id;

    const taken = await this.prisma.collection.findMany({ select: { slug: true } });
    const created = await this.prisma.collection.create({
      data: {
        slug: uniqueSlug(
          slugify(folder),
          taken.map((row) => row.slug),
        ),
        ...titleData(folder),
        folderKey: folder,
        state: 'DRAFT',
        origin: 'INGEST',
      },
      select: { id: true },
    });

    return created.id;
  }

  private async ensureSeason(
    collectionId: string,
    collectionFolder: string,
    season: SeasonInfo,
  ): Promise<string> {
    const folderKey = `${collectionFolder}/${season.folder}`;

    const existing = await this.prisma.season.findUnique({
      where: { folderKey },
      select: { id: true },
    });
    if (existing) return existing.id;

    const taken = await this.prisma.season.findMany({
      where: { collectionId },
      select: { slug: true },
    });

    const created = await this.prisma.season.create({
      data: {
        collectionId,
        number: season.number,
        slug: uniqueSlug(
          seasonSlug(season.number, season.folder),
          taken.map((row) => row.slug),
        ),
        title: season.title,
        folderKey,
      },
      select: { id: true },
    });

    return created.id;
  }

  private async freeVideoSlug(collectionId: string, base: string): Promise<string> {
    const taken = await this.prisma.video.findMany({
      where: { collectionId },
      select: { slug: true },
    });

    return uniqueSlug(
      base,
      taken.map((row) => row.slug),
    );
  }
}
