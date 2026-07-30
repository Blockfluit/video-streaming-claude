import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The containment check every storage key goes through.
 *
 * Split out from `StorageService` and kept pure so the traversal cases can be
 * enumerated without a filesystem. A `storageKey` comes from the database, and
 * rows are created from disk scans and uploads — so treating it as untrusted is
 * not paranoia about the schema, it is the last line between a crafted filename
 * and reading `/etc/passwd`.
 */

export class StoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoragePathError';
  }
}

/**
 * True when `candidate` sits strictly inside `root`.
 *
 * Uses `path.relative` rather than `startsWith`: `/srv/media-backup` starts with
 * `/srv/media` while being a completely different directory. A relative path
 * that is empty means the root itself, one starting `..` means outside it, and
 * an absolute one means a different volume.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const difference = relative(resolve(root), resolve(candidate));

  return (
    difference.length > 0 &&
    !difference.startsWith(`..${sep}`) &&
    difference !== '..' &&
    !isAbsolute(difference)
  );
}

/**
 * Resolves a storage key against its root, or throws.
 *
 * Note this is lexical: it does not follow symlinks. A symlink planted inside
 * the media tree pointing outside it would pass. That is acceptable here
 * because the media roots are operator-controlled directories, and the threat
 * being defended against is a crafted *key*, not a hostile filesystem.
 */
export function resolveWithinRoot(root: string, key: string): string {
  if (typeof key !== 'string') {
    throw new StoragePathError('Storage key must be a string');
  }

  // A NUL truncates the path in some syscalls, so `a\0.txt` could open `a`.
  if (key.includes('\0')) {
    throw new StoragePathError('Storage key contains a null byte');
  }

  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, key);

  if (!isInsideRoot(absoluteRoot, candidate)) {
    throw new StoragePathError(`Storage key escapes its root: ${key}`);
  }

  return candidate;
}
