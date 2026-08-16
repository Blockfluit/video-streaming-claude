import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OSDB_CHUNK_BYTES, OSDB_MIN_BYTES, osdbHash, osdbHashOfFile } from './hash';

/**
 * A filler that is deterministic and not symmetric, so the head and the tail of
 * a file differ. Reproduced byte for byte by the Python reference these vectors
 * came from — the point of the exercise is that two implementations written
 * from the spec agree, not that this one agrees with itself.
 */
function filler(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 7 + 11) % 256;
  return bytes;
}

function chunksOf(data: Buffer): { head: Buffer; tail: Buffer } {
  return {
    head: data.subarray(0, OSDB_CHUNK_BYTES),
    tail: data.subarray(data.length - OSDB_CHUNK_BYTES),
  };
}

function hashOf(data: Buffer): string {
  const { head, tail } = chunksOf(data);
  return osdbHash(data.length, head, tail);
}

describe('osdbHash', () => {
  it.each([
    [131072, '60a0df1f5fa1c000'],
    [200000, '60a0df1f5fa2cd40'],
    [1048577, '4080bfff3f8fa001'],
  ])('matches the independent reference implementation at %i bytes', (size, expected) => {
    expect(hashOf(filler(size))).toBe(expected);
  });

  it('hashes a file of nothing but zero bytes to its own size', () => {
    // The one case that can be reasoned about without running anything: every
    // 64-bit word contributes nothing, so only the size is left.
    expect(hashOf(Buffer.alloc(131072))).toBe('0000000000020000');
  });

  it('reads each word little-endian', () => {
    const data = Buffer.alloc(131072);
    data[0] = 1;

    // 131072 + 1. Read big-endian the same byte would contribute 2^56.
    expect(hashOf(data)).toBe('0000000000020001');
  });

  it('wraps at 64 bits rather than growing without bound', () => {
    const data = Buffer.alloc(131072);
    data.fill(0xff, 0, 8);

    // 131072 + (2^64 - 1) is 2^64 + 131071, which truncates to 131071.
    expect(hashOf(data)).toBe('000000000001ffff');
  });

  it('always renders 16 hex digits, zero-padded', () => {
    expect(hashOf(Buffer.alloc(131072))).toHaveLength(16);
    expect(hashOf(filler(200000))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reads the tail from the end of the file, not from the second chunk', () => {
    // Two files sharing a head and differing only in their last bytes must not
    // hash alike, or the "exact release" match is worthless for anything whose
    // opening is identical.
    const a = filler(400000);
    const b = Buffer.from(a);
    b[b.length - 1] = (b[b.length - 1] as number) ^ 0xff;

    expect(hashOf(b)).not.toBe(hashOf(a));
  });

  it('refuses a chunk that is not exactly 64 KB', () => {
    const short = Buffer.alloc(OSDB_CHUNK_BYTES - 1);
    expect(() => osdbHash(131072, short, Buffer.alloc(OSDB_CHUNK_BYTES))).toThrow(/64 KB/);
  });

  it('refuses a file below the minimum size', () => {
    // OpenSubtitles does not define the hash below two chunks, and a made-up
    // answer would match nothing while looking like a real one.
    expect(OSDB_MIN_BYTES).toBe(OSDB_CHUNK_BYTES * 2);
    expect(() =>
      osdbHash(OSDB_MIN_BYTES - 1, Buffer.alloc(OSDB_CHUNK_BYTES), Buffer.alloc(OSDB_CHUNK_BYTES)),
    ).toThrow(/too small/);
  });
});

describe('osdbHashOfFile', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'osdb-hash-'));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads the first and last chunk off disk and agrees with the pure function', async () => {
    const data = filler(200000);
    const path = join(directory, 'sample.mkv');
    await writeFile(path, data);

    await expect(osdbHashOfFile(path)).resolves.toBe('60a0df1f5fa2cd40');
  });

  it('returns null for a file too small to hash, rather than throwing', async () => {
    // A short file is a reason to fall back to searching by title, not an error
    // that should fail the whole search.
    const path = join(directory, 'tiny.mkv');
    await writeFile(path, Buffer.alloc(1024));

    await expect(osdbHashOfFile(path)).resolves.toBeNull();
  });

  it('returns null when the file is not there', async () => {
    await expect(osdbHashOfFile(join(directory, 'absent.mkv'))).resolves.toBeNull();
  });
});
