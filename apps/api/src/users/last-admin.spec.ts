import { DELETED, wouldRemoveLastActiveAdmin } from './last-admin';

/**
 * The self-lockout rule, as pure logic. Whether the numbers it is given are
 * read under a lock is the service's problem; whether they mean "locked out"
 * is this function's.
 */
describe('wouldRemoveLastActiveAdmin', () => {
  const admin = { role: 'ADMIN', isActive: true } as const;
  const inactiveAdmin = { role: 'ADMIN', isActive: false } as const;
  const user = { role: 'USER', isActive: true } as const;

  describe('the sole active admin', () => {
    it('cannot be demoted', () => {
      expect(wouldRemoveLastActiveAdmin(admin, { role: 'USER', isActive: true }, 0)).toBe(true);
    });

    it('cannot be deactivated', () => {
      expect(wouldRemoveLastActiveAdmin(admin, { role: 'ADMIN', isActive: false }, 0)).toBe(true);
    });

    it('cannot be deleted', () => {
      expect(wouldRemoveLastActiveAdmin(admin, DELETED, 0)).toBe(true);
    });

    it('cannot be demoted and deactivated at once', () => {
      expect(wouldRemoveLastActiveAdmin(admin, { role: 'USER', isActive: false }, 0)).toBe(true);
    });

    // Renames and password resets must still work — they leave the role alone.
    it('can still be edited in ways that keep them an active admin', () => {
      expect(wouldRemoveLastActiveAdmin(admin, { role: 'ADMIN', isActive: true }, 0)).toBe(false);
    });
  });

  describe('when another active admin remains', () => {
    it('allows demotion', () => {
      expect(wouldRemoveLastActiveAdmin(admin, { role: 'USER', isActive: true }, 1)).toBe(false);
    });

    it('allows deactivation', () => {
      expect(wouldRemoveLastActiveAdmin(admin, { role: 'ADMIN', isActive: false }, 1)).toBe(false);
    });

    it('allows deletion', () => {
      expect(wouldRemoveLastActiveAdmin(admin, DELETED, 1)).toBe(false);
    });
  });

  describe('accounts that are not holding the library open', () => {
    it('ignores a plain user entirely', () => {
      expect(wouldRemoveLastActiveAdmin(user, DELETED, 0)).toBe(false);
      expect(wouldRemoveLastActiveAdmin(user, { role: 'USER', isActive: false }, 0)).toBe(false);
    });

    // Already deactivated, so removing them takes nothing away — and the rule
    // is about *active* admins, which is why deactivation is guarded in the
    // first place.
    it('ignores a deactivated admin', () => {
      expect(wouldRemoveLastActiveAdmin(inactiveAdmin, DELETED, 0)).toBe(false);
      expect(wouldRemoveLastActiveAdmin(inactiveAdmin, { role: 'USER', isActive: false }, 0)).toBe(
        false,
      );
    });

    // Promoting somebody is never a lockout, whatever the counts say.
    it('ignores a user being promoted', () => {
      expect(wouldRemoveLastActiveAdmin(user, { role: 'ADMIN', isActive: true }, 0)).toBe(false);
    });
  });

  it('counts only *other* admins — a lone admin editing themselves is still alone', () => {
    expect(wouldRemoveLastActiveAdmin(admin, DELETED, 0)).toBe(true);
    expect(wouldRemoveLastActiveAdmin(admin, DELETED, 1)).toBe(false);
  });
});
