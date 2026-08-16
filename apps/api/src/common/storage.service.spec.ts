import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { StorageService } from './storage.service';

/**
 * Against a real temporary directory rather than a mocked `fs` — the whole
 * point of this service is what happens on a filesystem, and a mock would only
 * prove the mock.
 */
describe('StorageService', () => {
  let workspace: string;
  let media: string;
  let derived: string;
  let storage: StorageService;

  async function build(overrides: Record<string, string> = {}): Promise<StorageService> {
    const service = new StorageService(
      new ConfigService({ MEDIA_ROOT: media, DERIVED_ROOT: derived, ...overrides }),
    );
    await service.onModuleInit();
    return service;
  }

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'storage-'));
    media = join(workspace, 'media');
    derived = join(workspace, 'derived');
    storage = await build();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('startup', () => {
    it('creates both roots', async () => {
      await expect(storage.exists('media', 'anything')).resolves.toBe(false);
      expect(storage.rootPath('media')).toBe(media);
      expect(storage.rootPath('derived')).toBe(derived);
    });

    /**
     * The invariant behind the whole two-root split: generated files landing in
     * the watched tree would make the watcher ingest its own output forever.
     * Checked at boot because it is configuration, and configuration drifts.
     */
    it('refuses to start with DERIVED_ROOT inside MEDIA_ROOT', async () => {
      await expect(build({ DERIVED_ROOT: join(media, 'derived') })).rejects.toThrow(
        /inside MEDIA_ROOT/,
      );
    });

    it('refuses when the two roots are the same directory', async () => {
      await expect(build({ DERIVED_ROOT: media })).rejects.toThrow(/inside MEDIA_ROOT/);
    });
  });

  describe('resolvePath', () => {
    it('resolves inside the requested root', () => {
      expect(storage.resolvePath('media', 'a/b.mp4')).toBe(join(media, 'a/b.mp4'));
      expect(storage.resolvePath('derived', 'a/b.jpg')).toBe(join(derived, 'a/b.jpg'));
    });

    it('turns a traversal into a 400, not a 500', () => {
      expect(() => storage.resolvePath('media', '../derived/x')).toThrow(BadRequestException);
      expect(() => storage.resolvePath('media', '/etc/passwd')).toThrow(BadRequestException);
    });

    // The message goes to an HTTP client, so it must not disclose where the
    // library lives on disk.
    it('does not leak the absolute path in the error', () => {
      expect(() => storage.resolvePath('media', '../../etc/passwd')).toThrow('Invalid storage key');
      try {
        storage.resolvePath('media', '../../etc/passwd');
      } catch (error) {
        expect((error as Error).message).not.toContain(media);
      }
    });
  });

  describe('save', () => {
    it('writes a buffer, creating parent directories', async () => {
      await storage.save('media', 'Harry Potter/Season 1/film.mp4', Buffer.from('hello'));

      await expect(readFile(join(media, 'Harry Potter/Season 1/film.mp4'), 'utf8')).resolves.toBe(
        'hello',
      );
    });

    it('writes a stream', async () => {
      await storage.save('derived', 'thumb.jpg', Readable.from(['abc', 'def']));

      await expect(readFile(join(derived, 'thumb.jpg'), 'utf8')).resolves.toBe('abcdef');
    });

    it('overwrites an existing file', async () => {
      await storage.save('media', 'a.txt', Buffer.from('first'));
      await storage.save('media', 'a.txt', Buffer.from('second'));

      await expect(readFile(join(media, 'a.txt'), 'utf8')).resolves.toBe('second');
    });

    /**
     * Writes land on a temporary neighbour and are renamed into place, so a
     * failure part-way cannot leave a truncated file looking complete — which
     * matters most under `media`, where the watcher would ingest the wreckage.
     */
    it('leaves nothing behind when the source fails mid-write', async () => {
      const failing = new Readable({
        read() {
          this.push('partial');
          this.destroy(new Error('source exploded'));
        },
      });

      await expect(storage.save('media', 'broken.mp4', failing)).rejects.toThrow('source exploded');

      await expect(storage.exists('media', 'broken.mp4')).resolves.toBe(false);
      await expect(storage.exists('media', 'broken.mp4.incoming')).resolves.toBe(false);
    });

    it('refuses to write outside its root', async () => {
      await expect(storage.save('media', '../escape.txt', Buffer.from('x'))).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('exists and statOf', () => {
    it('reports a file that is there', async () => {
      await storage.save('media', 'a.txt', Buffer.from('12345'));

      await expect(storage.exists('media', 'a.txt')).resolves.toBe(true);
      await expect(storage.statOf('media', 'a.txt')).resolves.toMatchObject({ size: 5 });
    });

    it('reports a file that is not', async () => {
      await expect(storage.exists('media', 'nope.txt')).resolves.toBe(false);
      await expect(storage.statOf('media', 'nope.txt')).resolves.toBeNull();
    });

    // Separate roots: the same key in one is not the same file in the other.
    it('does not confuse the two roots', async () => {
      await storage.save('media', 'a.txt', Buffer.from('x'));

      await expect(storage.exists('derived', 'a.txt')).resolves.toBe(false);
    });

    it('answers false for a bad key rather than throwing', async () => {
      await expect(storage.exists('media', '../../etc/passwd')).resolves.toBe(false);
    });
  });

  describe('delete', () => {
    it('removes a file', async () => {
      await storage.save('media', 'a.txt', Buffer.from('x'));

      await storage.delete('media', 'a.txt');

      await expect(storage.exists('media', 'a.txt')).resolves.toBe(false);
    });

    it('removes a directory and its contents', async () => {
      await storage.save('media', 'Show/Season 1/a.mp4', Buffer.from('x'));

      await storage.delete('media', 'Show');

      await expect(storage.exists('media', 'Show/Season 1/a.mp4')).resolves.toBe(false);
    });

    // Reconcile deletes things it is not certain are there.
    it('treats an already-missing file as success', async () => {
      await expect(storage.delete('media', 'never-existed.txt')).resolves.toBeUndefined();
    });

    it('refuses to delete outside its root', async () => {
      await writeFile(join(workspace, 'precious.txt'), 'do not delete');

      await expect(storage.delete('media', '../precious.txt')).rejects.toThrow(BadRequestException);

      await expect(readFile(join(workspace, 'precious.txt'), 'utf8')).resolves.toBe(
        'do not delete',
      );
    });
  });

  describe('ensureDirectory and toKey', () => {
    it('creates a folder for a new collection', async () => {
      await storage.ensureDirectory('media', 'New Collection/Season 1');

      await expect(storage.exists('media', 'New Collection/Season 1')).resolves.toBe(true);
    });

    it('round-trips a key through an absolute path', () => {
      const absolute = storage.resolvePath('media', 'Show/a.mp4');

      expect(storage.toKey('media', absolute)).toBe('Show/a.mp4');
    });

    it('refuses to make a key out of a path outside the root', () => {
      expect(() => storage.toKey('media', join(workspace, 'outside.mp4'))).toThrow(
        BadRequestException,
      );
    });
  });

  /**
   * Moving a converted file out of `derived/` and in beside its source. The two
   * roots are separate mounts in production, so this is a copy far more often
   * than it is a rename.
   */
  describe('moveBetweenRoots', () => {
    it('carries a file from one root to the other', async () => {
      await storage.save('derived', 'converted/vid1.mp4', Buffer.from('body'));

      await storage.moveBetweenRoots('derived', 'converted/vid1.mp4', 'media', 'disk1/F/f.mp4');

      await expect(storage.exists('derived', 'converted/vid1.mp4')).resolves.toBe(false);
      await expect(
        readFile(storage.resolvePath('media', 'disk1/F/f.mp4'), 'utf8'),
      ).resolves.toBe('body');
    });

    it('creates the destination folder', async () => {
      await storage.save('derived', 'converted/vid1.mp4', Buffer.from('body'));

      await storage.moveBetweenRoots('derived', 'converted/vid1.mp4', 'media', 'a/b/c/f.mp4');

      await expect(storage.exists('media', 'a/b/c/f.mp4')).resolves.toBe(true);
    });

    it('leaves the source alone when the move cannot happen', async () => {
      await storage.save('derived', 'converted/vid1.mp4', Buffer.from('body'));

      await expect(
        storage.moveBetweenRoots('derived', 'converted/missing.mp4', 'media', 'disk1/F/f.mp4'),
      ).rejects.toThrow();
      await expect(storage.exists('derived', 'converted/vid1.mp4')).resolves.toBe(true);
      await expect(storage.exists('media', 'disk1/F/f.mp4')).resolves.toBe(false);
    });

    it('still refuses a key that escapes its root', async () => {
      await expect(
        storage.moveBetweenRoots('derived', 'converted/vid1.mp4', 'media', '../outside.mp4'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
