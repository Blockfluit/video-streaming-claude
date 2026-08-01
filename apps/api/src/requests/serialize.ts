import type { RequestStatus } from '@video/shared';

import type { Role } from '../prisma/generated/enums';

/**
 * Turning a stored request into what a given caller is allowed to see.
 *
 * A request row knows who asked for it. Other viewers must not, and that single
 * rule is the whole reason this feature is more than a table — so it lives in a
 * pure function with its own tests rather than in whichever query happens to be
 * running. The same shape is returned to everyone; what changes is what is
 * filled in.
 *
 * What is hidden is **identity**, not the request. A viewer sees the title, the
 * year, the requester's own comment, the status and the admin's note, because
 * all of that is the request and hiding it would leave a page listing nothing.
 * They do not see who asked, or which admin answered.
 *
 * `mine` is the deliberate exception: telling you which entry is yours reveals
 * nothing you did not already know, and without it you cannot find your own
 * request on a page that has hidden every name including yours.
 */

export interface StoredRequest {
  id: string;
  userId: string;
  title: string;
  year: number | null;
  comment: string | null;
  status: RequestStatus;
  adminNote: string | null;
  statusChangedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  user: { id: string; username: string; displayName: string };
  statusChangedBy: { id: string; displayName: string } | null;
}

/** Something already in the library with the same normalised title. Admin-only. */
export interface LibraryMatch {
  kind: 'video' | 'collection';
  id: string;
  slug: string;
  title: string;
  state: string;
  /** Present for a video, so the frontend can build a watch link. */
  collection?: { slug: string; title: string } | null;
  season?: { slug: string } | null;
}

export interface RequestView {
  id: string;
  title: string;
  year: number | null;
  comment: string | null;
  status: RequestStatus;
  adminNote: string | null;
  createdAt: Date;
  /** Whether the caller is the one who asked. */
  mine: boolean;
  /** ADMIN only. Null for everyone else — this is the anonymisation. */
  requestedBy: { id: string; username: string; displayName: string } | null;
  /** ADMIN only, for the same reason. */
  statusChangedBy: { id: string; displayName: string } | null;
  /** ADMIN only. */
  statusChangedAt: Date | null;
  updatedAt: Date | null;
  /**
   * ADMIN only, and null unless something matches.
   *
   * A request whose title is already in the library as a draft is the normal
   * case for a request that was accepted anyway: the existence check a viewer
   * runs is scoped to what a viewer can see, so it cannot refuse them on the
   * strength of a record they are not allowed to know exists. The admin can see
   * both, so the admin is where the two are put side by side.
   */
  libraryMatch: LibraryMatch | null;
}

export interface Viewer {
  id: string;
  role: Role;
}

export function toRequestView(
  request: StoredRequest,
  viewer: Viewer,
  libraryMatch: LibraryMatch | null = null,
): RequestView {
  /*
   * Listed field by field rather than spread from the row, so a column added to
   * VideoRequest later cannot ride along into a response nobody meant to widen.
   * `toCommentView` builds its tombstone the same way and for the same reason.
   */
  const common = {
    id: request.id,
    title: request.title,
    year: request.year,
    comment: request.comment,
    status: request.status,
    adminNote: request.adminNote,
    createdAt: request.createdAt,
    mine: request.userId === viewer.id,
  };

  if (viewer.role !== 'ADMIN') {
    return {
      ...common,
      requestedBy: null,
      statusChangedBy: null,
      statusChangedAt: null,
      updatedAt: null,
      libraryMatch: null,
    };
  }

  return {
    ...common,
    requestedBy: request.user,
    statusChangedBy: request.statusChangedBy,
    statusChangedAt: request.statusChangedAt,
    updatedAt: request.updatedAt,
    libraryMatch,
  };
}
