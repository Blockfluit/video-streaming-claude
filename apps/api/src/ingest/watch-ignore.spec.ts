import { isHiddenEntry } from './watch-ignore';

/**
 * The predicate chokidar is given. Pure, because the bug it exists to prevent is
 * invisible at runtime: an over-broad match watches nothing at all and reports
 * that state exactly as it reports an empty folder.
 */
describe('isHiddenEntry', () => {
  const root = '/srv/media';

  it('ignores a dotfile inside the tree', () => {
    expect(isHiddenEntry(root, '/srv/media/disk1/Inception/.DS_Store')).toBe(true);
  });

  it('ignores the upload staging directory', () => {
    expect(isHiddenEntry(root, '/srv/media/.uploads')).toBe(true);
  });

  it('leaves ordinary content alone', () => {
    expect(isHiddenEntry(root, '/srv/media/disk1/Inception/Inception.mp4')).toBe(false);
    expect(isHiddenEntry(root, '/srv/media/disk1')).toBe(false);
  });

  /**
   * The bug this was written for.
   *
   * Matching a dot segment anywhere in the *absolute* path means the watcher's
   * verdict depends on where the library happens to live rather than on what is
   * in it. Every worktree checkout sits under `.claude/worktrees/<name>`, so the
   * root itself matched and chokidar watched nothing — no error, no log, and a
   * media tree that never reacts to anything dropped into it.
   */
  it('watches a tree whose root sits under a dot directory', () => {
    const worktree = '/home/u/project/.claude/worktrees/demo/media';

    expect(isHiddenEntry(worktree, worktree)).toBe(false);
    expect(isHiddenEntry(worktree, `${worktree}/disk1`)).toBe(false);
    expect(isHiddenEntry(worktree, `${worktree}/disk1/Inception/Inception.mp4`)).toBe(false);
  });

  it('still ignores a dot entry under such a root', () => {
    const worktree = '/home/u/project/.claude/worktrees/demo/media';

    expect(isHiddenEntry(worktree, `${worktree}/.uploads/half.mp4`)).toBe(true);
  });

  /** Watching nothing is the one outcome with no recoverable symptom. */
  it('never ignores the root itself, even when the root is a dot directory', () => {
    expect(isHiddenEntry('/srv/.media', '/srv/.media')).toBe(false);
  });

  /**
   * A backslash is a legal character in a Linux filename, never a separator.
   * The old pattern read `[/\\]\.` as one, so this file was invisible.
   */
  it('does not read a backslash in a filename as a separator', () => {
    expect(isHiddenEntry(root, '/srv/media/disk1/Movie/Back\\.slash.mp4')).toBe(false);
  });
});
