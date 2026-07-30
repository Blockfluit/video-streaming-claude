import type { Role } from '../prisma/generated/enums';

/**
 * The self-lockout rule: an admin must never be able to remove the last way
 * back in. Pure, so the awkward combinations are cheap to enumerate — the
 * service's job is to read the numbers under a lock and hand them here.
 */

export interface AccountState {
  role: Role;
  isActive: boolean;
}

/** What the account becomes when the operation is a delete. */
export const DELETED = null;

function holdsTheDoorOpen(account: AccountState): boolean {
  return account.role === 'ADMIN' && account.isActive;
}

/**
 * @param current what the account is now
 * @param next what it would become, or `DELETED`
 * @param otherActiveAdmins active admins **excluding this account**
 */
export function wouldRemoveLastActiveAdmin(
  current: AccountState,
  next: AccountState | typeof DELETED,
  otherActiveAdmins: number,
): boolean {
  // Not currently holding the library open, so nothing done to them can close it.
  if (!holdsTheDoorOpen(current)) return false;
  if (otherActiveAdmins > 0) return false;

  return next === DELETED || !holdsTheDoorOpen(next);
}
