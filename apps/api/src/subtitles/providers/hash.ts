import { open } from 'node:fs/promises';

/**
 * The OpenSubtitles file hash (OSDb), pure.
 *
 * It is the 64-bit sum of the file's size and every little-endian 64-bit word
 * in its first and last 64 KB. Cheap to compute over a 40 GB file, and specific
 * enough to identify one exact release — which is the whole point: a subtitle
 * matched by hash was timed against *this* file, where one matched by title was
 * timed against some other cut and may drift by seconds.
 *
 * Deliberately not a content hash. Like `contentTag` elsewhere in this codebase
 * it reads only the ends, so two files sharing both ends and a size collide by
 * design. Never use it for deduplication or integrity.
 */

/** The spec reads exactly this much from each end. Not a tunable. */
export const OSDB_CHUNK_BYTES = 65536;

/** Below two chunks the head and tail would overlap and the hash is undefined. */
export const OSDB_MIN_BYTES = OSDB_CHUNK_BYTES * 2;

const MASK_64 = (1n << 64n) - 1n;

export function osdbHash(sizeBytes: number, head: Buffer, tail: Buffer): string {
  if (sizeBytes < OSDB_MIN_BYTES) {
    throw new Error(`File is too small to hash: ${sizeBytes} bytes`);
  }
  for (const chunk of [head, tail]) {
    if (chunk.length !== OSDB_CHUNK_BYTES) {
      throw new Error(`Each chunk must be exactly 64 KB, got ${chunk.length} bytes`);
    }
  }

  let value = BigInt(sizeBytes);
  for (const chunk of [head, tail]) {
    for (let offset = 0; offset < OSDB_CHUNK_BYTES; offset += 8) {
      value = (value + chunk.readBigUInt64LE(offset)) & MASK_64;
    }
  }

  // Zero-padded to 16 digits: the API matches on the string, so a hash that
  // happens to be small must not arrive short.
  return value.toString(16).padStart(16, '0');
}

/**
 * The hash of a file on disk, or `null` when there cannot be one.
 *
 * Null rather than a throw: a file too short to hash, or one that has been
 * reclaimed, means "search by title instead" — not a failure worth surfacing to
 * an admin who only asked for subtitles.
 */
export async function osdbHashOfFile(absolutePath: string): Promise<string | null> {
  let file;
  try {
    file = await open(absolutePath, 'r');
  } catch {
    return null;
  }

  try {
    const { size } = await file.stat();
    if (size < OSDB_MIN_BYTES) return null;

    const head = Buffer.alloc(OSDB_CHUNK_BYTES);
    const tail = Buffer.alloc(OSDB_CHUNK_BYTES);
    await file.read(head, 0, OSDB_CHUNK_BYTES, 0);
    await file.read(tail, 0, OSDB_CHUNK_BYTES, size - OSDB_CHUNK_BYTES);

    return osdbHash(size, head, tail);
  } catch {
    return null;
  } finally {
    await file.close();
  }
}
