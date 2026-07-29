import type { Role } from '../prisma/generated/enums';

/**
 * The caller, as every guard and controller sees them. Deliberately narrow — a
 * password hash must never ride along on the request object.
 */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  isActive: boolean;
}

/** What `SessionGuard` selects, kept next to AuthUser so the two cannot drift. */
export const AUTH_USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  isActive: true,
} as const;

declare module 'express-session' {
  interface SessionData {
    /** The only thing we persist. The user is re-read per request. */
    userId?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
