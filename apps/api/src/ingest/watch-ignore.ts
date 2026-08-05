import { relative, resolve, sep } from 'node:path';

/**
 * Whether the watcher should pass over `candidate`.
 *
 * Only the part of the path **below `MEDIA_ROOT`** decides. The obvious form —
 * matching a dot segment anywhere in the absolute path — makes the answer depend
 * on where the library happens to live rather than on what is in it: a root
 * under any dot directory matched itself, so chokidar was handed a root it had
 * been told to ignore and watched nothing at all.
 *
 * That failure is silent in both directions. Nothing is logged, and a tree that
 * never reacts looks exactly like a tree nobody has touched — the drive symlink
 * that prompted this was ingested correctly by every scan while appearing not to
 * work, because only the startup scan ever ran. Every worktree checkout
 * (`.claude/worktrees/<name>/media`) runs that way.
 *
 * Segments are split on the platform separator alone. A backslash is a legal
 * character in a Linux filename and never a separator, so `Back\.slash.mp4` is
 * an ordinary file — the old pattern read it as a hidden one.
 */
export function isHiddenEntry(root: string, candidate: string): boolean {
  const difference = relative(resolve(root), resolve(candidate));

  // The root itself is never ignored, whatever it is called: a watcher watching
  // nothing is the one outcome with no symptom to trace back.
  if (difference === '') return false;

  // Outside the root entirely. Not this predicate's business to hide, and
  // guessing wrong here means watching nothing rather than watching too much.
  if (difference === '..' || difference.startsWith(`..${sep}`)) return false;

  return difference.split(sep).some((segment) => segment.startsWith('.'));
}
