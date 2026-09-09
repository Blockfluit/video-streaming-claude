/**
 * Turning a stored feedback row into what a client is allowed to see.
 *
 * Built field by field, like `toCommentView` — even though there is no
 * tombstone case here, a column added to the row later must not ride along
 * into the response unnoticed.
 */

export interface StoredFeedback {
  id: string;
  message: string;
  pageUrl: string;
  userAgent: string;
  viewportWidth: number;
  viewportHeight: number;
  hasScreenshot: boolean;
  createdAt: Date;
  user: { id: string; displayName: string };
}

export type FeedbackView = StoredFeedback;

export function toFeedbackView(row: StoredFeedback): FeedbackView {
  return {
    id: row.id,
    message: row.message,
    pageUrl: row.pageUrl,
    userAgent: row.userAgent,
    viewportWidth: row.viewportWidth,
    viewportHeight: row.viewportHeight,
    hasScreenshot: row.hasScreenshot,
    createdAt: row.createdAt,
    user: row.user,
  };
}
