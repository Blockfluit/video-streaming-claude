import { Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

import { toPersonDocument, toTitleDocument } from './documents';
import { MeilisearchClient } from './meilisearch.client';

/**
 * How long to wait for the library to stop moving before rebuilding.
 *
 * Reconcile writes one row at a time in unbounded loops, and a folder drop is
 * one event per file — so the interesting question is never "has this write
 * finished" but "has the *burst* finished". Coalescing behind a short wait turns
 * a season of twenty-four episodes into one rebuild.
 */
const SETTLE_MS = 2000;

/**
 * Keeping the engine's copy of the library close enough to the truth.
 *
 * **One rule: the index is rebuilt in full whenever the library may have changed,
 * and that is the only mechanism.** No per-write invalidation graph, no change
 * feed, no outbox.
 *
 * That is a choice made *because of* the size. At the scale this app is for —
 * hundreds to a few thousand titles — a rebuild is three `findMany`s and three
 * bulk pushes, which is seconds. Buying out of tracking writes is worth a great
 * deal here, because the writes are not tractable: `reconcile.service.ts` issues
 * unbounded single-row loops with no transaction and no completion event,
 * `metadata.service.ts` rewrites a whole show's episodes, and three cascade
 * deletes — a collection, a video, a person — silently invalidate documents they
 * never name. A collection deleted makes every video that stood on it a *film*,
 * and nothing anywhere emits a row-level event saying so.
 *
 * **What staleness costs is bounded, and it is the reason this is safe.** Every
 * id the engine returns is re-read through Prisma's filters and re-scored from
 * the row Prisma returned, so a stale index can only ever lose recall: a title
 * renamed a moment ago is briefly findable by its old name and shows its new one;
 * a video published a moment ago is briefly missing from a viewer's results; a
 * deleted one yields no card and no count. It can never show anybody anything.
 * `search.db-spec.ts` states each of those as a test.
 *
 * If this ever stops being cheap — a library where a rebuild is no longer
 * seconds — the answer is targeted upserts on the interactive writes, not a
 * bigger timeout. The place to start is the list above.
 */
@Injectable()
export class IndexerService {
  private readonly logger = new Logger(IndexerService.name);

  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private again = false;

  private lastBuiltAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: MeilisearchClient,
  ) {}

  get builtAt(): Date | null {
    return this.lastBuiltAt;
  }

  /**
   * The library may have changed. Rebuild soon, once, however many times this is
   * called in the meantime.
   *
   * Never awaited by a caller, and that is deliberate: `reconcile.run()` *is*
   * awaited by `uploads.service.ts`, so an upload that had to wait for a rebuild
   * would be an upload made slower by a search feature.
   */
  markDirty(): void {
    if (!this.engine.isConfigured) return;

    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.rebuild(), SETTLE_MS);
  }

  /**
   * Rebuild now, and answer when it is done.
   *
   * Coalesced rather than queued: a rebuild that arrives while one is running
   * sets a flag and the running one repeats itself once at the end. Two full
   * passes back to back are pointless, and the second reader would otherwise
   * wait for both.
   */
  async rebuild(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }

    this.running = this.run();
    try {
      await this.running;
    }
    finally {
      this.running = undefined;
    }

    if (this.again) {
      this.again = false;
      await this.rebuild();
    }
  }

  private async run(): Promise<void> {
    if (!this.engine.isConfigured) return;

    try {
      await this.engine.ensureSettings();

      /*
       * Read as three plain lists. No `whereVisible` here and none wanted: the
       * index holds every row with its state on it, and *who may see what* is
       * decided by the caller's filter and then again by Prisma. An index built
       * per role would be an index that has to be rebuilt when a role changes.
       */
      const [collections, videos, people] = await this.prisma.$transaction([
        this.prisma.collection.findMany({
          select: { id: true, title: true, description: true, genres: true, state: true },
        }),
        this.prisma.video.findMany({
          select: {
            id: true,
            title: true,
            description: true,
            genres: true,
            state: true,
            // `whereFilm`'s rule, read here rather than restated: a film is a
            // video no collection claims.
            _count: { select: { collections: true } },
          },
        }),
        this.prisma.person.findMany({ select: { id: true, name: true } }),
      ]);

      await this.engine.replaceAll(
        this.engine.indexes.collections,
        collections.map(row => toTitleDocument(row, false)),
      );
      await this.engine.replaceAll(
        this.engine.indexes.videos,
        videos.map(row => toTitleDocument(row, row._count.collections === 0)),
      );
      await this.engine.replaceAll(
        this.engine.indexes.people,
        people.map(row => toPersonDocument(row)),
      );

      this.lastBuiltAt = new Date();
      this.logger.log(
        `Search index rebuilt: ${videos.length} videos, ${collections.length} collections, ${people.length} people.`,
      );
    }
    catch (cause) {
      /*
       * Logged, never thrown. A rebuild runs from a timer and from boot, where
       * there is nobody to hand an error to — and a search engine that cannot be
       * reached is a thing the app is designed to carry on without.
       */
      this.logger.warn(`Search index rebuild failed: ${describeError(cause)}`);
    }
  }
}
