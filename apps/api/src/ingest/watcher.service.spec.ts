import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { StorageService } from '../common/storage.service';
import type { ReconcileService } from './reconcile.service';
import { WatcherService } from './watcher.service';

/**
 * Against a real chokidar and a real directory.
 *
 * The bug these cover was entirely in the options object: the predicate was
 * correct about dotfiles and wrong about where the library lives, and a stubbed
 * watcher would have agreed with it. Only chokidar can say what it actually
 * watched.
 */
describe('WatcherService', () => {
  jest.setTimeout(30_000);

  let workspace: string;
  let root: string;
  let watcher: WatcherService;
  let reconcile: { run: jest.Mock };
  let banner: jest.SpyInstance;

  /** Boots the watcher against `root` and returns once the startup pass is done. */
  async function start(): Promise<void> {
    const storage = { rootPath: () => root } as unknown as StorageService;

    watcher = new WatcherService(
      new ConfigService({}),
      storage,
      reconcile as unknown as ReconcileService,
    );

    await watcher.onApplicationBootstrap();
    expect(watcher.isWatching).toBe(true);
    reconcile.run.mockClear();

    /**
     * `ignoreInitial` suppresses everything chokidar finds during its opening
     * scan, and that scan is still running when `onApplicationBootstrap`
     * resolves. A file written into the gap is discovered by the scan rather
     * than reported as an event, so the wait is what separates "the watcher is
     * deaf" from "the test got there first". These trees hold two entries, so
     * the scan takes milliseconds and this is three orders of margin.
     */
    await new Promise((done) => setTimeout(done, 1_000));
  }

  /**
   * Waits for a reconcile that a filesystem event should have caused.
   *
   * `awaitWriteFinish` holds an event back for two seconds and the debounce adds
   * another, so this polls rather than sleeping a guessed amount — and returns
   * false rather than hanging when the watcher is dead, which is the case under
   * test.
   */
  async function reconciled(within = 12_000): Promise<boolean> {
    const deadline = Date.now() + within;

    while (Date.now() < deadline) {
      if (reconcile.run.mock.calls.length > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
  }

  beforeEach(async () => {
    banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    reconcile = { run: jest.fn().mockResolvedValue(undefined) };
    workspace = await mkdtemp(join(tmpdir(), 'watcher-'));
  });

  afterEach(async () => {
    await watcher?.onModuleDestroy();
    banner.mockRestore();
    await rm(workspace, { recursive: true, force: true });
  });

  it('reconciles when a file appears in the tree', async () => {
    root = join(workspace, 'media');
    await mkdir(join(root, 'disk1', 'Inception'), { recursive: true });
    await start();

    await writeFile(join(root, 'disk1/Inception/Inception.mp4'), 'video-bytes');

    await expect(reconciled()).resolves.toBe(true);
  });

  /**
   * The bug, in the shape it was met in: a checkout under `.claude/worktrees/`.
   *
   * Ignoring any path containing a dot segment ignored the root, so chokidar
   * watched nothing and every drop into the media tree was invisible until the
   * next restart — which runs a scan and so appeared to fix it.
   */
  it('reconciles when the media root itself sits under a dot directory', async () => {
    root = join(workspace, '.claude', 'worktrees', 'demo', 'media');
    await mkdir(join(root, 'disk1', 'Inception'), { recursive: true });
    await start();

    await writeFile(join(root, 'disk1/Inception/Inception.mp4'), 'video-bytes');

    await expect(reconciled()).resolves.toBe(true);
  });

  /** A drive is a link to another disk, and writes land on the far side of it. */
  it('reconciles when a file appears through a symlinked drive', async () => {
    root = join(workspace, '.claude', 'worktrees', 'demo', 'media');
    const disk = join(workspace, 'disk-a');
    await mkdir(join(disk, 'Inception'), { recursive: true });
    await mkdir(root, { recursive: true });
    await symlink(disk, join(root, 'disk1'), 'dir');
    await start();

    await writeFile(join(disk, 'Inception/Inception.mp4'), 'video-bytes');

    await expect(reconciled()).resolves.toBe(true);
  });

  /**
   * The other half of the predicate, and the reason it cannot simply be dropped:
   * an upload is staged inside the media tree and renamed into place, so a
   * watcher that saw `.uploads` would ingest half a file.
   */
  it('stays quiet for a file staged in .uploads', async () => {
    root = join(workspace, 'media');
    await mkdir(join(root, '.uploads'), { recursive: true });
    await start();

    await writeFile(join(root, '.uploads/half-written.mp4'), 'partial');

    await expect(reconciled(6_000)).resolves.toBe(false);
  });
});
