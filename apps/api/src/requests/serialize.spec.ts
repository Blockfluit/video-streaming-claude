import { toRequestView, type LibraryMatch, type StoredRequest } from './serialize';

/**
 * The anonymisation boundary.
 *
 * This function is the only thing standing between a request row and the name
 * of the person who wrote it, which is the same job `toCommentView` does for a
 * deleted comment — and the same reason it is pure and tested directly rather
 * than asserted through an HTTP round trip.
 */

const ASKER = { id: 'user-asker', username: 'asker', displayName: 'Asker' };
const ADMIN_USER = { id: 'user-admin', displayName: 'Admin' };

const stored: StoredRequest = {
  id: 'request-1',
  userId: ASKER.id,
  title: 'The Matrix',
  year: 1999,
  comment: 'The first one, not the sequels.',
  status: 'SEEN',
  adminNote: 'Looking into it.',
  statusChangedAt: new Date('2026-07-02T10:00:00Z'),
  createdAt: new Date('2026-07-01T10:00:00Z'),
  updatedAt: new Date('2026-07-02T10:00:00Z'),
  user: ASKER,
  statusChangedBy: ADMIN_USER,
};

const match: LibraryMatch = {
  kind: 'collection',
  id: 'collection-1',
  slug: 'the-matrix',
  title: 'The Matrix',
  state: 'DRAFT',
};

const asker = { id: ASKER.id, role: 'USER' as const };
const stranger = { id: 'user-other', role: 'USER' as const };
const admin = { id: ADMIN_USER.id, role: 'ADMIN' as const };

describe('toRequestView', () => {
  describe('for a normal user', () => {
    it('hides who asked and who answered', () => {
      const view = toRequestView(stored, stranger);

      expect(view.requestedBy).toBeNull();
      expect(view.statusChangedBy).toBeNull();
      expect(view.statusChangedAt).toBeNull();
    });

    it('still shows the request itself and its status', () => {
      const view = toRequestView(stored, stranger);

      expect(view.title).toBe('The Matrix');
      expect(view.year).toBe(1999);
      expect(view.comment).toBe('The first one, not the sequels.');
      expect(view.status).toBe('SEEN');
      expect(view.adminNote).toBe('Looking into it.');
      expect(view.createdAt).toEqual(stored.createdAt);
    });

    it('marks the caller\'s own request, and only theirs', () => {
      expect(toRequestView(stored, asker).mine).toBe(true);
      expect(toRequestView(stored, stranger).mine).toBe(false);
    });

    /*
     * The requester is not exempt from anonymisation — knowing it is yours is
     * `mine`, and does not extend to seeing which admin answered it.
     */
    it('does not show the author their own row in full', () => {
      const view = toRequestView(stored, asker);

      expect(view.requestedBy).toBeNull();
      expect(view.statusChangedBy).toBeNull();
    });

    /*
     * The match is computed from the whole library, drafts included, so handing
     * it to a non-admin would leak exactly what `whereVisible` exists to hide.
     */
    it('never carries a library match, even when one is passed in', () => {
      expect(toRequestView(stored, stranger, match).libraryMatch).toBeNull();
      expect(toRequestView(stored, asker, match).libraryMatch).toBeNull();
    });

    /*
     * Built field by field rather than spread from the row: a column added to
     * VideoRequest later must not appear in a viewer's response by default.
     * This asserts the shape, so widening it has to be deliberate.
     */
    it('returns no field beyond the agreed shape', () => {
      const rowWithASecret = {
        ...stored,
        internalNote: 'added to the table later',
      } as StoredRequest;

      expect(Object.keys(toRequestView(rowWithASecret, stranger)).sort()).toEqual(
        [
          'adminNote',
          'comment',
          'createdAt',
          'id',
          'libraryMatch',
          'mine',
          'requestedBy',
          'status',
          'statusChangedAt',
          'statusChangedBy',
          'title',
          'updatedAt',
          'year',
        ].sort(),
      );
      expect(toRequestView(rowWithASecret, stranger)).not.toHaveProperty('internalNote');
      expect(toRequestView(rowWithASecret, stranger)).not.toHaveProperty('userId');
      expect(toRequestView(rowWithASecret, stranger)).not.toHaveProperty('normalisedTitle');
    });
  });

  describe('for an admin', () => {
    it('shows who asked and who answered, and when', () => {
      const view = toRequestView(stored, admin);

      expect(view.requestedBy).toEqual(ASKER);
      expect(view.statusChangedBy).toEqual(ADMIN_USER);
      expect(view.statusChangedAt).toEqual(stored.statusChangedAt);
      expect(view.updatedAt).toEqual(stored.updatedAt);
    });

    it('carries the library match when there is one', () => {
      expect(toRequestView(stored, admin, match).libraryMatch).toEqual(match);
      expect(toRequestView(stored, admin).libraryMatch).toBeNull();
    });

    it('marks an admin\'s own request as theirs like anyone else\'s', () => {
      const ownRequest = { ...stored, userId: ADMIN_USER.id };

      expect(toRequestView(ownRequest, admin).mine).toBe(true);
      expect(toRequestView(stored, admin).mine).toBe(false);
    });

    it('never leaks the row\'s internal columns either', () => {
      const view = toRequestView(stored, admin);

      expect(view).not.toHaveProperty('userId');
      expect(view).not.toHaveProperty('normalisedTitle');
    });
  });
});
