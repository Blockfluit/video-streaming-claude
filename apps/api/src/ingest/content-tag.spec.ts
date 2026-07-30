import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONTENT_TAG_WINDOW_BYTES, computeContentTag } from './content-tag';

describe('computeContentTag', () => {
  let workspace: string;

  const write = async (name: string, body: Buffer): Promise<string> => {
    const path = join(workspace, name);
    await writeFile(path, body);
    return path;
  };

  const tagOf = async (name: string, body: Buffer): Promise<string> =>
    computeContentTag(await write(name, body), body.length);

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'content-tag-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('is stable for the same file', async () => {
    const path = await write('a.mp4', Buffer.from('hello world'));

    expect(await computeContentTag(path, 11)).toBe(await computeContentTag(path, 11));
  });

  it('gives identical files identical tags — this is what move detection rests on', async () => {
    const body = Buffer.from('the same bytes');

    expect(await tagOf('a.mp4', body)).toBe(await tagOf('b.mp4', body));
  });

  it('separates files that differ at the front', async () => {
    expect(await tagOf('a.mp4', Buffer.from('aaaa'))).not.toBe(
      await tagOf('b.mp4', Buffer.from('baaa')),
    );
  });

  it('separates files that differ only in length', async () => {
    expect(await tagOf('a.mp4', Buffer.from('aaaa'))).not.toBe(
      await tagOf('b.mp4', Buffer.from('aaaaa')),
    );
  });

  it('separates files that differ only at the very end', async () => {
    const head = Buffer.alloc(2048, 'x');

    expect(await tagOf('a.mp4', Buffer.concat([head, Buffer.from('A')]))).not.toBe(
      await tagOf('b.mp4', Buffer.concat([head, Buffer.from('B')])),
    );
  });

  it('handles an empty file without throwing', async () => {
    await expect(tagOf('empty.mp4', Buffer.alloc(0))).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles a file smaller than one window', async () => {
    await expect(tagOf('small.mp4', Buffer.from('tiny'))).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  describe('files larger than the sampled windows', () => {
    const window = CONTENT_TAG_WINDOW_BYTES;

    /**
     * The deliberate tradeoff. Only the first and last megabyte are read, so
     * two files with identical ends and the same size collide even if their
     * middles differ.
     *
     * That is acceptable for what this is for: deciding whether a file that
     * appeared at a new path is the one that vanished from an old one. It is
     * NOT a content hash and must never be used as one — re-encoding a video
     * changes its size, and a genuine duplicate is what we want to match.
     */
    it('does not notice a change in the middle of a large file', async () => {
      const head = Buffer.alloc(window, 'h');
      const tail = Buffer.alloc(window, 't');
      const middleA = Buffer.alloc(1024, 'a');
      const middleB = Buffer.alloc(1024, 'b');

      const first = await tagOf('a.mp4', Buffer.concat([head, middleA, tail]));
      const second = await tagOf('b.mp4', Buffer.concat([head, middleB, tail]));

      expect(first).toBe(second);
    });

    it('notices a change inside the sampled head', async () => {
      const tail = Buffer.alloc(window, 't');
      const headA = Buffer.alloc(window, 'h');
      const headB = Buffer.alloc(window, 'h');
      headB[500] = 0x21;

      expect(await tagOf('a.mp4', Buffer.concat([headA, tail]))).not.toBe(
        await tagOf('b.mp4', Buffer.concat([headB, tail])),
      );
    });

    it('notices a change inside the sampled tail', async () => {
      const head = Buffer.alloc(window, 'h');
      const tailA = Buffer.alloc(window, 't');
      const tailB = Buffer.alloc(window, 't');
      tailB[window - 100] = 0x21;

      expect(await tagOf('a.mp4', Buffer.concat([head, tailA]))).not.toBe(
        await tagOf('b.mp4', Buffer.concat([head, tailB])),
      );
    });
  });

  it('is a hex sha256', async () => {
    await expect(tagOf('a.mp4', Buffer.from('x'))).resolves.toMatch(/^[a-f0-9]{64}$/);
  });
});
