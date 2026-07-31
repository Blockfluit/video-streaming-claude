import { toCommentView, type StoredComment } from './serialize';

const stored: StoredComment = {
  id: 'c1',
  videoId: 'v1',
  body: 'The bit at 2:14 is wonderful.',
  timestampSec: 134,
  editedAt: null,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  user: { id: 'u1', username: 'ada', displayName: 'Ada' },
};

describe('toCommentView', () => {
  it('passes a live comment through with its author', () => {
    expect(toCommentView(stored)).toMatchObject({
      id: 'c1',
      body: 'The bit at 2:14 is wonderful.',
      timestampSec: 134,
      deleted: false,
      user: { displayName: 'Ada' },
    });
  });

  it('reports an edit, which the UI shows next to the timestamp', () => {
    const edited = { ...stored, editedAt: new Date('2026-01-02T00:00:00Z') };

    expect(toCommentView(edited).editedAt).toEqual(edited.editedAt);
  });

  /**
   * A soft-deleted comment keeps its place so replies around it still read, but
   * it must carry neither its text nor its author — the row is retained for the
   * audit trail, not to be served.
   */
  describe('a deleted comment', () => {
    const deleted = { ...stored, deletedAt: new Date('2026-01-03T00:00:00Z') };

    it('becomes a tombstone with no body and no author', () => {
      expect(toCommentView(deleted)).toMatchObject({
        id: 'c1',
        deleted: true,
        body: null,
        user: null,
      });
    });

    it('drops the pinned timestamp too, since there is nothing to seek to', () => {
      expect(toCommentView(deleted).timestampSec).toBeNull();
    });

    // Its position in the thread is the only reason the row is still served.
    it('keeps when it was posted', () => {
      expect(toCommentView(deleted).createdAt).toEqual(stored.createdAt);
    });

    it('never leaks the text through any field', () => {
      expect(JSON.stringify(toCommentView(deleted))).not.toContain('wonderful');
    });
  });
});
