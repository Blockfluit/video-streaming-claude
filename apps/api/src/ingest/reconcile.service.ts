import { Injectable, Logger } from '@nestjs/common';

import { freeSlug, seasonSlug, slugify, uniqueSlug } from '../common/slug';
import { StorageService } from '../common/storage.service';
import { titleData } from '../common/title';
import { MediaService } from '../media/media.service';
import { SubtitlesService } from '../subtitles/subtitles.service';
import type { IngestIssueKind, PublishState } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { computeContentTag } from './content-tag';
import { withoutConvertedOutput } from './converted-output';
import { scanMediaRoot, type ScannedFile } from './media-scanner';
import type { MediaPath } from './path-parser';
import { itemFolderKey, proposeStructure, type ProposedSeason } from './structure';
import { matchSubtitles, type SubtitleCandidate, type VideoCandidate } from './subtitle-matcher';
import { describeError } from '../common/errors';

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

/** Every reason the parser can refuse a path, and the issue an admin sees for it. */
const ISSUE_KIND_BY_REASON: Record<
  Extract<MediaPath, { kind: 'issue' }>['reason'],
  IngestIssueKind
> = {
  'root-level-file': 'ROOT_LEVEL_FILE',
  'loose-drive-file': 'LOOSE_DRIVE_FILE',
  'too-deep': 'PATH_TOO_DEEP',
  'empty-path': 'ROOT_LEVEL_FILE',
};

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
    const rawScan = await scanMediaRoot(root);

    /**
     * The rows are read **after** the scan, and that order is load-bearing.
     *
     * A converted file lives beside its source inside the watched tree, and the
     * only thing that marks it as ours is a row claiming it as `playbackKey`.
     * The writer sets that column *before* the file appears at the path (see
     * `transcode/jobs.service.ts`), so any converted file this scan could have
     * seen already had its key written — and a query issued afterwards cannot
     * miss it. Read the rows first and that guarantee is gone: a conversion
     * finishing in between would be ingested as a brand-new video.
     */
    const known = await this.prisma.video.findMany({
      select: {
        id: true,
        storageKey: true,
        contentTag: true,
        state: true,
        stateBeforeMissing: true,
        sourceDeletedAt: true,
        playbackKey: true,
        // To notice a file that is not what it was when the row was written.
        sizeBytes: true,
        fileMtime: true,
      },
    });

    /**
     * A job part-way through writing its output has no `playbackKey` yet if it
     * crashed between reserving and renaming, so its `outputKey` is the other
     * half of the same claim.
     */
    const writing = await this.prisma.mediaJob.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] }, outputKey: { not: null } },
      select: { outputKey: true },
    });

    const scan = withoutConvertedOutput(rawScan, [
      ...known.map((video) => video.playbackKey),
      ...writing.map((job) => job.outputKey),
    ]);

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
    let rescanned = 0;

    /**
     * Videos this pass created, by storage key.
     *
     * The folder layout is only ever an *initial* suggestion, so a proposal is
     * applied to a row exactly once — when it is first discovered. Anything
     * already in the library keeps whatever collections an admin put it in,
     * however its folder looks now.
     */
    const discovered = new Map<string, string>();

    for (const file of scan.videos) {
      const existing = byStorageKey.get(file.relPath);

      if (existing) {
        present.add(existing.id);

        /**
         * The file is not what it was, so what was read off it is not either.
         *
         * A scan has no `awaitWriteFinish` — the watcher does — so it will read
         * a file that is still being copied. ffprobe reads the moov atom at the
         * front of an MP4 and reports the whole duration while most of the
         * bytes are still arriving, which is how a 994 MB film was recorded at
         * 8 MB with a poster seeking 813 seconds into a file that had barely
         * started. Nothing looked at that row again, so it stayed wrong.
         *
         * Reconcile cannot tell a half-copied file from a finished one while it
         * is looking at it. It can notice next time, and read it again.
         */
        const changed =
          existing.sizeBytes !== BigInt(file.size)
          || existing.fileMtime.getTime() !== file.mtime.getTime();

        if (changed) {
          /**
           * The fingerprint is part of "what was read off it".
           *
           * `contentTag` hashes both ends of the file *and* its size, so a row
           * whose file has changed holds a tag those bytes can no longer
           * produce. Leaving it behind broke move detection for that row
           * permanently, and silently: nothing goes wrong until the file is
           * renamed much later, and then it is not recognised as itself. A
           * second video appears and the original is swept to MISSING, with its
           * title, artwork, markers, credits and watch history stranded on it
           * while the file stands in plain sight under a new name.
           *
           * Recomputed on any change rather than only a change of size: the tag
           * samples the first and last megabyte, and those can be rewritten
           * without the size moving at all.
           */
          const refreshedTag = await computeContentTag(
            this.storage.resolvePath('media', file.relPath),
            file.size,
          );

          await this.prisma.video.update({
            where: { id: existing.id },
            data: {
              sizeBytes: BigInt(file.size),
              fileMtime: file.mtime,
              contentTag: refreshedTag,
            },
          });
          // Duration, dimensions and the conversion verdict all came off the
          // old bytes, and the poster was taken from them.
          this.media.enqueue(existing.id);
          rescanned += 1;
        }

        if (existing.state === 'MISSING') {
          // It came back. Restore what it was, rather than quietly demoting a
          // published video to draft because a disk was unplugged for a day.
          //
          // No `contentTag` of its own: `changed` is exactly "size or mtime
          // differs", so a file that came back as something else has already
          // been through the branch above and had its tag refreshed there.
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
      if (createdId) {
        this.media.enqueue(createdId);
        // Only rows born in this pass are shaped by the folders they sit in.
        discovered.set(file.relPath, createdId);
      }
      created += 1;
    }

    await this.applyProposals(scan.videos, discovered);

    const markedMissing = await this.sweepMissing(known, present);

    const subtitles = await this.bindSubtitles(scan.videos, scan.subtitles, seenIssues);

    // Structural problems the parser refused outright.
    for (const file of scan.issues) {
      if (file.parsed.kind !== 'issue') continue;
      seenIssues.push({
        kind: ISSUE_KIND_BY_REASON[file.parsed.reason],
        path: file.relPath,
        detail:
          file.parsed.reason === 'loose-drive-file'
            ? 'Loose in a drive root. Put it in a folder, or place it from the media browser.'
            : undefined,
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
      `Reconcile: ${summary.scannedFiles} files, +${created} new, ${moved} moved, ${rescanned} re-read, ` +
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
    /**
     * Videos whose track list actually changed this pass.
     *
     * The auto default is re-derived only for these, rather than for every
     * video with a sidecar: a scan that bound nothing new is the normal case
     * and must not write anything.
     */
    const touched = new Set<string>();
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
          if (outcome !== 'unchanged') {
            bound += 1;
            touched.add(binding.videoId);
          }

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
            detail: describeError(error),
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

    /**
     * A sidecar-only library has never had a default track, because binding one
     * does not set the column and nothing else ever looked at the question.
     * This is where an ingested English subtitle becomes the selected one.
     *
     * After `forgetMissingSidecars`, which re-derives the videos it emptied —
     * running before it would decide from a list still holding rows whose files
     * are gone.
     */
    for (const videoId of touched) {
      await this.subtitles.refreshAutoDefault(videoId);
    }

    return { bound, removed };
  }

  private async applyMove(id: string, file: ScannedFile, contentTag: string): Promise<void> {
    if (file.parsed.kind !== 'video') return;

    /**
     * A move follows the file and changes nothing else.
     *
     * The row id survives, and with it every comment, progress row and
     * watchlist entry pointing at this video — that is the whole point of
     * detecting a move rather than deleting and recreating. Its collections
     * survive for the same reason: the folder was a suggestion when the video
     * was discovered, and re-reading it now would undo whatever an admin has
     * since arranged, on the strength of someone tidying up a disk.
     */
    await this.prisma.video.update({
      where: { id },
      data: {
        storageKey: file.relPath,
        contentTag,
        sizeBytes: BigInt(file.size),
        fileMtime: file.mtime,
        // A moved file is present again, so it is no longer missing.
        state: undefined,
        missingSince: null,
      },
    });
  }

  /**
   * Creates the video and nothing else.
   *
   * A video stands on its own; whether it also belongs to a collection is
   * decided per folder afterwards, by `applyProposals`, because that decision
   * needs every file in the folder at once.
   */
  private async createDraft(file: ScannedFile, contentTag: string): Promise<string | null> {
    if (file.parsed.kind !== 'video') return null;

    const slug = await this.freeVideoSlug(slugify(file.parsed.title));

    const created = await this.prisma.video.create({
      select: { id: true },
      data: {
        slug,
        ...titleData(file.parsed.title),
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

  /**
   * Turns each folder's proposed shape into collections and memberships, for
   * the videos this pass discovered.
   *
   * The suggestion is applied **once**, at discovery. A video already in the
   * library is skipped entirely, so an admin who moved an episode into a
   * different collection — or out of every collection — keeps that arrangement
   * through every later scan. A folder proposing `standalone` produces no
   * collection at all: the video is already complete on its own.
   */
  private async applyProposals(
    videos: ScannedFile[],
    discovered: Map<string, string>,
  ): Promise<void> {
    if (discovered.size === 0) return;

    for (const proposal of proposeStructure(videos.map((file) => file.parsed))) {
      if (proposal.kind === 'standalone') continue;

      const fresh = proposal.videos.filter((video) => discovered.has(video.storageKey));
      if (fresh.length === 0) continue;

      const collectionId = await this.ensureCollection(proposal.folderKey, proposal.title);
      const seasonIds = await this.ensureSeasons(collectionId, proposal.seasons);

      for (const video of fresh) {
        await this.prisma.collectionVideo.create({
          data: {
            collectionId,
            videoId: discovered.get(video.storageKey)!,
            seasonId: video.seasonFolder ? (seasonIds.get(video.seasonFolder) ?? null) : null,
            orderIndex: video.orderIndex,
          },
        });
      }
    }
  }

  private async ensureSeasons(
    collectionId: string,
    seasons: ProposedSeason[],
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();

    for (const season of seasons) {
      ids.set(season.folder, await this.ensureSeason(collectionId, season));
    }

    return ids;
  }

  private async ensureCollection(folderKey: string, title: string): Promise<string> {
    const existing = await this.prisma.collection.findUnique({
      where: { folderKey },
      select: { id: true },
    });
    if (existing) return existing.id;

    const taken = await this.prisma.collection.findMany({ select: { slug: true } });
    const created = await this.prisma.collection.create({
      data: {
        slug: uniqueSlug(
          slugify(title),
          taken.map((row) => row.slug),
        ),
        ...titleData(title),
        folderKey,
        state: 'DRAFT',
        origin: 'INGEST',
      },
      select: { id: true },
    });

    return created.id;
  }

  private async ensureSeason(collectionId: string, season: ProposedSeason): Promise<string> {
    const folderKey = season.folderKey;

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

  /** Library-wide: a video's slug is its own address, not one scoped to a parent. */
  private freeVideoSlug(base: string): Promise<string> {
    return freeSlug(this.prisma.video, base);
  }
}
