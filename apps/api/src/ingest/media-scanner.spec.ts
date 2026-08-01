import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanMediaRoot } from './media-scanner';

/**
 * A real directory with a real symlink in it.
 *
 * The whole point of these tests is what the filesystem reports for a symlinked
 * directory — `readdir` says it is neither a file nor a directory — so a stubbed
 * filesystem would prove nothing.
 */
describe('scanMediaRoot', () => {
  let root: string;
  let elsewhere: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'scan-root-'));
    elsewhere = await mkdtemp(join(tmpdir(), 'scan-disk-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });

  async function file(base: string, relPath: string): Promise<void> {
    const absolute = join(base, relPath);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, 'not really a video');
  }

  it('finds a video in an item folder on a plain drive folder', async () => {
    await file(root, 'disk1/Inception/Inception.mp4');

    const scan = await scanMediaRoot(root);

    expect(scan.videos.map((video) => video.relPath)).toEqual(['disk1/Inception/Inception.mp4']);
  });

  /**
   * The production layout: every drive under MEDIA_ROOT is a symlink to a
   * different physical disk.
   *
   * `readdir(withFileTypes)` reports a symlinked directory as neither
   * `isDirectory()` nor `isFile()`, so a walk that only recurses into the first
   * and only records the second skips the entire disk — silently, with an empty
   * scan that looks like an empty library.
   */
  it('follows a drive that is a symlink to another filesystem location', async () => {
    await file(elsewhere, 'Inception/Inception.mp4');
    await symlink(elsewhere, join(root, 'disk1'), 'dir');

    const scan = await scanMediaRoot(root);

    expect(scan.videos.map((video) => video.relPath)).toEqual(['disk1/Inception/Inception.mp4']);
  });

  it('reads seasons through a symlinked drive too', async () => {
    await file(elsewhere, 'Chernobyl/Season 01/Episode 1.mp4');
    await symlink(elsewhere, join(root, 'videos'), 'dir');

    const scan = await scanMediaRoot(root);

    expect(scan.videos[0].parsed).toMatchObject({
      kind: 'video',
      driveFolder: 'videos',
      itemFolder: 'Chernobyl',
      season: expect.objectContaining({ number: 1 }),
    });
  });

  /**
   * Only the drive level is followed. Deeper links are the ones that point
   * somewhere unexpected — and a link back up its own tree is how a walk that
   * follows everything spins until the process dies.
   */
  it('does not follow a symlinked directory below the drive level', async () => {
    await file(elsewhere, 'Inception.mp4');
    await mkdir(join(root, 'disk1'), { recursive: true });
    await symlink(elsewhere, join(root, 'disk1', 'Inception'), 'dir');

    const scan = await scanMediaRoot(root);

    expect(scan.videos).toEqual([]);
  });

  it('survives a drive symlink pointing at nothing', async () => {
    await symlink(join(elsewhere, 'gone'), join(root, 'disk1'), 'dir');

    await expect(scanMediaRoot(root)).resolves.toMatchObject({ videos: [] });
  });

  it('still skips a symlinked file rather than ingesting it', async () => {
    await file(elsewhere, 'Inception.mp4');
    await mkdir(join(root, 'disk1', 'Inception'), { recursive: true });
    await symlink(join(elsewhere, 'Inception.mp4'), join(root, 'disk1/Inception/Inception.mp4'));

    const scan = await scanMediaRoot(root);

    expect(scan.videos).toEqual([]);
  });

  it('reports a video loose in a drive root as an issue rather than ingesting it', async () => {
    await file(root, 'night-films/Chinatown.mp4');

    const scan = await scanMediaRoot(root);

    expect(scan.videos).toEqual([]);
    expect(scan.issues.map((issue) => issue.parsed)).toEqual([
      expect.objectContaining({ kind: 'issue', reason: 'loose-drive-file' }),
    ]);
  });

  it('skips dot directories, including upload staging on a drive', async () => {
    await file(root, 'disk1/.uploads/half-written.mp4');

    const scan = await scanMediaRoot(root);

    expect(scan.videos).toEqual([]);
    expect(scan.issues).toEqual([]);
  });
});
