import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

/**
 * A cheap, stable fingerprint used to recognise a file that has moved.
 *
 * `sha256(first 1MB + last 1MB + size)`. Reading a whole 4 GB file to notice it
 * was dragged into another folder would make every scan cost a full disk read;
 * sampling both ends plus the size is enough to tell "the same file, somewhere
 * else" from "a different file".
 *
 * **This is not a content hash.** Two files with identical ends and the same
 * size collide even if their middles differ. That is fine for its one job —
 * matching a vanished `storageKey` to a newly appeared one — and would be
 * wrong for deduplication or integrity checking.
 */

export const CONTENT_TAG_WINDOW_BYTES = 1024 * 1024;

export async function computeContentTag(path: string, size: number): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');

  try {
    const headLength = Math.min(CONTENT_TAG_WINDOW_BYTES, size);
    if (headLength > 0) {
      const head = Buffer.alloc(headLength);
      await handle.read(head, 0, headLength, 0);
      hash.update(head);
    }

    // Only when there is a tail the head did not already cover — otherwise the
    // same bytes would be hashed twice, which is harmless but pointless.
    if (size > CONTENT_TAG_WINDOW_BYTES) {
      const tail = Buffer.alloc(CONTENT_TAG_WINDOW_BYTES);
      await handle.read(tail, 0, CONTENT_TAG_WINDOW_BYTES, size - CONTENT_TAG_WINDOW_BYTES);
      hash.update(tail);
    }
  } finally {
    // Reconcile walks thousands of files; a leaked descriptor per file would
    // exhaust the process.
    await handle.close();
  }

  // Size is part of the fingerprint, so a truncated or extended file never
  // matches its former self.
  hash.update(`:${size}`);

  return hash.digest('hex');
}
