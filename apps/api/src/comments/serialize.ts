/**
 * Turning a stored comment into what a client is allowed to see.
 *
 * Deletion is soft, so the row outlives the comment: it keeps the thread
 * readable around the gap and leaves an audit trail of who removed what. That
 * makes the serializer the only thing standing between a deleted comment and
 * its text, which is why it is a pure function with its own tests rather than a
 * spread in a service.
 */

export interface StoredComment {
  id: string;
  videoId: string;
  body: string;
  timestampSec: number | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  user: { id: string; username: string; displayName: string };
}

export interface CommentView {
  id: string;
  videoId: string;
  body: string | null;
  timestampSec: number | null;
  editedAt: Date | null;
  deleted: boolean;
  createdAt: Date;
  user: { id: string; username: string; displayName: string } | null;
}

export function toCommentView(comment: StoredComment): CommentView {
  if (comment.deletedAt !== null) {
    // Built from nothing rather than spread-and-overwrite: a field added to the
    // row later would otherwise ride along into a tombstone unnoticed.
    return {
      id: comment.id,
      videoId: comment.videoId,
      body: null,
      // Nothing to seek to, so the link the UI would render has no target.
      timestampSec: null,
      editedAt: null,
      deleted: true,
      // The only reason the row is still served: its place in the thread.
      createdAt: comment.createdAt,
      user: null,
    };
  }

  return {
    id: comment.id,
    videoId: comment.videoId,
    body: comment.body,
    timestampSec: comment.timestampSec,
    editedAt: comment.editedAt,
    deleted: false,
    createdAt: comment.createdAt,
    user: comment.user,
  };
}
