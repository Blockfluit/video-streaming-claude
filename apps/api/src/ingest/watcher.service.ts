import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import chokidar, { type FSWatcher } from 'chokidar';

import { StorageService } from '../common/storage.service';
import { ReconcileService } from './reconcile.service';
import { isHiddenEntry } from './watch-ignore';

/**
 * Watches `MEDIA_ROOT` and reconciles after things settle.
 *
 * Gated behind `INGEST_WATCHER_ENABLED` so that if the API is ever run as more
 * than one process, only one of them watches — two watchers reconciling the
 * same tree would race on every row.
 */
@Injectable()
export class WatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WatcherService.name);
  private watcher: FSWatcher | null = null;
  private pending: NodeJS.Timeout | null = null;

  /**
   * How long to wait after the last event before reconciling. Dropping a
   * folder of twenty files fires twenty events; this collapses them into one
   * pass rather than twenty competing ones.
   */
  private readonly settleMs = 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    private readonly reconcile: ReconcileService,
  ) {}

  get isWatching(): boolean {
    return this.watcher !== null;
  }

  async onApplicationBootstrap(): Promise<void> {
    // The startup pass owns the first look at the tree, watcher or not.
    await this.reconcile.run().catch((error: unknown) => {
      this.logger.error(`Startup reconcile failed: ${describe(error)}`);
    });

    if (this.config.get<string>('INGEST_WATCHER_ENABLED') === 'false') {
      this.logger.log('Watcher disabled by INGEST_WATCHER_ENABLED=false');
      return;
    }

    const root = this.storage.rootPath('media');

    this.watcher = chokidar.watch(root, {
      // Essential. Without it a 4 GB copy is ingested while it is still being
      // written, and the row records a truncated file.
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
      // The startup reconcile above has already seen everything that is there.
      ignoreInitial: true,
      // Judged relative to the root — see `isHiddenEntry`. Matching a dot
      // segment anywhere in the absolute path made the root ignore itself
      // wherever the library sat under one, and a watcher that watches nothing
      // reports that exactly as it reports a tree nobody has touched.
      ignored: (candidate) => isHiddenEntry(root, candidate),
    });

    this.watcher
      .on('add', () => this.schedule())
      .on('unlink', () => this.schedule())
      .on('addDir', () => this.schedule())
      .on('unlinkDir', () => this.schedule())
      .on('error', (error) => this.logger.error(`Watcher error: ${describe(error)}`));

    this.logger.log(`Watching ${root}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pending) clearTimeout(this.pending);
    await this.watcher?.close();
    this.watcher = null;
  }

  /** Debounce: restart the timer on every event, reconcile once it goes quiet. */
  private schedule(): void {
    if (this.pending) clearTimeout(this.pending);

    this.pending = setTimeout(() => {
      this.pending = null;
      // `run()` joins an in-flight pass rather than starting a second one, so
      // this cannot pile up even if events keep arriving.
      void this.reconcile.run().catch((error: unknown) => {
        this.logger.error(`Reconcile after watcher event failed: ${describe(error)}`);
      });
    }, this.settleMs);

    // Not keeping the event loop alive for a scan nobody is waiting on.
    this.pending.unref?.();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
