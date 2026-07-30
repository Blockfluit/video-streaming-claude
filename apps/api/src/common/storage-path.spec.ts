import { StoragePathError, isInsideRoot, resolveWithinRoot } from './storage-path';

const ROOT = '/srv/library/media';

describe('resolveWithinRoot', () => {
  it('resolves an ordinary key', () => {
    expect(resolveWithinRoot(ROOT, 'Harry Potter/film.mp4')).toBe(
      '/srv/library/media/Harry Potter/film.mp4',
    );
  });

  it('resolves a key that is just a folder', () => {
    expect(resolveWithinRoot(ROOT, 'Harry Potter')).toBe('/srv/library/media/Harry Potter');
  });

  it('normalises redundant segments', () => {
    expect(resolveWithinRoot(ROOT, './Harry Potter/./film.mp4')).toBe(
      '/srv/library/media/Harry Potter/film.mp4',
    );
    expect(resolveWithinRoot(ROOT, 'Harry Potter/Season 1/../film.mp4')).toBe(
      '/srv/library/media/Harry Potter/film.mp4',
    );
  });

  describe('refuses to escape the root', () => {
    it('rejects a traversal', () => {
      expect(() => resolveWithinRoot(ROOT, '../secrets.txt')).toThrow(StoragePathError);
      expect(() => resolveWithinRoot(ROOT, '../../etc/passwd')).toThrow(StoragePathError);
      expect(() => resolveWithinRoot(ROOT, 'Harry Potter/../../etc/passwd')).toThrow(
        StoragePathError,
      );
    });

    it('rejects an absolute key', () => {
      expect(() => resolveWithinRoot(ROOT, '/etc/passwd')).toThrow(StoragePathError);
    });

    // The bug a naive `startsWith(root)` check has: /srv/library/media-backup
    // starts with /srv/library/media but is a different directory.
    it('rejects a sibling directory whose name starts with the root', () => {
      expect(() => resolveWithinRoot(ROOT, '../media-backup/film.mp4')).toThrow(StoragePathError);
      expect(() => resolveWithinRoot(ROOT, '../mediaevil/film.mp4')).toThrow(StoragePathError);
    });

    it('rejects the root itself — a key has to name something inside it', () => {
      expect(() => resolveWithinRoot(ROOT, '')).toThrow(StoragePathError);
      expect(() => resolveWithinRoot(ROOT, '.')).toThrow(StoragePathError);
      expect(() => resolveWithinRoot(ROOT, '/')).toThrow(StoragePathError);
    });

    it('rejects a key that is not a string', () => {
      expect(() => resolveWithinRoot(ROOT, undefined as unknown as string)).toThrow(
        StoragePathError,
      );
    });
  });

  // A NUL byte truncates the path in some syscalls, so it must never reach one.
  it('rejects a key containing a null byte', () => {
    expect(() => resolveWithinRoot(ROOT, 'film.mp4\0.txt')).toThrow(StoragePathError);
  });

  it('allows names that merely look alarming', () => {
    expect(resolveWithinRoot(ROOT, '..film.mp4')).toBe('/srv/library/media/..film.mp4');
    expect(resolveWithinRoot(ROOT, 'Harry Potter/...mp4')).toBe(
      '/srv/library/media/Harry Potter/...mp4',
    );
    // Backslash is a legal filename character on Linux, not a separator.
    expect(resolveWithinRoot(ROOT, 'a\\b.mp4')).toBe('/srv/library/media/a\\b.mp4');
  });
});

describe('isInsideRoot', () => {
  it('accepts a path below the root', () => {
    expect(isInsideRoot(ROOT, '/srv/library/media/a/b.mp4')).toBe(true);
  });

  it('rejects the root itself and anything outside it', () => {
    expect(isInsideRoot(ROOT, ROOT)).toBe(false);
    expect(isInsideRoot(ROOT, '/srv/library')).toBe(false);
    expect(isInsideRoot(ROOT, '/srv/library/media-backup/a.mp4')).toBe(false);
  });
});
