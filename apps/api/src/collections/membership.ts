/**
 * Reading videos through their membership of a collection.
 *
 * A video no longer carries `seasonId` or `orderIndex` — those describe where it
 * sits *in one collection*, and it may sit in several. They live on
 * `CollectionVideo`, which means every collection-shaped read now goes through
 * the join and has to put the two halves back together.
 *
 * Kept in one place because the flattened shape is the API's contract: callers
 * still receive a video with a season and an order on it, as they always did,
 * and the join is an implementation detail rather than something every screen
 * has to learn.
 */

/** The video columns a collection listing needs. */
export const MEMBER_VIDEO_COLUMNS = {
  id: true,
  slug: true,
  title: true,
  description: true,
  state: true,
  durationSec: true,
  width: true,
  height: true,
  bannerKey: true,
} as const;

/** Selects a membership row together with the video it points at. */
export const MEMBERSHIP_SELECT = {
  id: true,
  seasonId: true,
  orderIndex: true,
  video: { select: MEMBER_VIDEO_COLUMNS },
} as const;

/**
 * A total order over memberships.
 *
 * Season, then position, then title, then the membership id — which is unique,
 * so nothing is left to chance. Offset paging over a non-total order repeats and
 * skips rows between pages, and a panel that reshuffles between identical
 * requests reads as a rendering bug for weeks.
 */
export const MEMBERSHIP_ORDER = [
  { seasonId: 'asc' },
  { orderIndex: 'asc' },
  { video: { title: 'asc' } },
  { id: 'asc' },
] as const;

interface MembershipRow<TVideo> {
  id: string;
  seasonId: string | null;
  orderIndex: number | null;
  video: TVideo;
}

/**
 * Flattens a membership back into the video shape callers expect.
 *
 * Generic over the video so the selected columns survive: typed as a bag of
 * unknowns, the spread erases them and every caller loses `state` — which is
 * what the publish checklist reads.
 *
 * `membershipId` comes along because removing a video from a collection acts on
 * the membership, not on the video — and deleting the video instead is the kind
 * of mistake that has no undo.
 */
export function toMemberVideo<TVideo extends object>(row: MembershipRow<TVideo>) {
  return {
    ...row.video,
    seasonId: row.seasonId,
    orderIndex: row.orderIndex,
    membershipId: row.id,
  };
}
