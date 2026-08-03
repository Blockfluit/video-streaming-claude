import type { PublishState, Role } from '../prisma/generated/enums';

/**
 * Publish gating and visibility — the two rules that decide what exists as far
 * as a given caller is concerned.
 *
 * Pure, and in one place, because both are the sort of rule that rots when it
 * is restated per endpoint: a visibility check missing from one query is a
 * silent leak of unpublished material, and a publish requirement checked only
 * at the publish endpoint means the admin UI has to guess what is still needed.
 */

/**
 * What a publishable video must have. Credits, subtitles and markers never
 * appear here — and neither, deliberately, does a **description**.
 *
 * Requiring one made the whole library unpublishable and said so in a way nobody
 * could act on. Ingest cannot write a synopsis, so every one of a hundred
 * episodes needed a person to type something before *any* of them could go out;
 * and because a collection needs at least one publishable video, the collection
 * was blocked too, reporting a missing `videos` while plainly holding five. That
 * was the reported bug: "why can't I publish collections".
 *
 * What is left is what a probe produces on its own — a title, a real duration,
 * and a banner. A synopsis is worth writing and is not worth blocking on.
 */
export interface VideoPublishFields {
  title: string | null;
  durationSec: number | null;
  bannerKey: string | null;
}

export interface CollectionPublishFields {
  title: string | null;
  /** Videos in this collection that are published, or ready to be. */
  publishableVideoCount: number;
}

/** Blank is missing: a title of spaces satisfies NOT NULL and satisfies nobody else. */
function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

/**
 * What still stands between this video and being published.
 *
 * Returned on rejection *and* on every draft read, so the admin UI can render a
 * live checklist instead of submitting and hoping.
 */
export function videoMissingFields(video: VideoPublishFields): string[] {
  const missing: string[] = [];

  if (isBlank(video.title)) missing.push('title');
  // Zero means the probe found no usable stream, not a very short film.
  if (video.durationSec === null || video.durationSec <= 0) missing.push('durationSec');
  if (isBlank(video.bannerKey)) missing.push('bannerKey');

  return missing;
}

/**
 * How many of a collection's videos would go out with it.
 *
 * One function because there were two, and they disagreed. `publish()` counted
 * the videos that were *ready*; the detail read — the one that draws the admin's
 * checklist — passed the total instead. So the screen said a collection needed
 * only a description, and pressing the button returned "description **and**
 * videos". A checklist that contradicts the action it describes is worse than no
 * checklist, and the only reliable fix is for both to call the same thing.
 *
 * Already-published videos count: re-publishing a collection whose episodes went
 * out individually must not report an empty shelf.
 */
export function publishableVideoCount(
  videos: (VideoPublishFields & { state: string })[],
): number {
  return videos.filter(
    (video) => video.state === 'PUBLISHED' || videoMissingFields(video).length === 0,
  ).length;
}

export function collectionMissingFields(collection: CollectionPublishFields): string[] {
  const missing: string[] = [];

  if (isBlank(collection.title)) missing.push('title');
  // An empty shelf is not a collection.
  if (collection.publishableVideoCount < 1) missing.push('videos');

  /*
   * `posterKey` is deliberately **not** required.
   *
   * It used to be, and the rule was unsatisfiable: nothing generated a
   * collection poster and no endpoint accepted one, so the only collections that
   * could ever be published were those whose ingest folder happened to contain a
   * poster file. Every collection in the real library sat in DRAFT because of
   * it, and the error named a field with no way to fill it.
   *
   * It is also no longer meaningful. A collection's `posterKey` is the admin's
   * *override*; with none it shows its first video's artwork, and the check
   * above already guarantees there is a video. Artwork is not a thing a
   * collection can now lack, so it is not a thing to block publishing on.
   */

  return missing;
}

/** The states a role may see at all. */
export function visibleStates(role: Role): PublishState[] {
  return role === 'ADMIN'
    ? ['DRAFT', 'PUBLISHED', 'ARCHIVED', 'MISSING']
    : ['PUBLISHED'];
}

/**
 * A Prisma `where` fragment restricting a query to what `role` may see.
 *
 * Spread into a service's own filter — `{ collectionId, ...whereVisible(role) }`.
 * Returns `{}` for an admin rather than listing every state, so admin queries
 * carry no needless condition.
 */
export function whereVisible(role: Role): { state?: { in: PublishState[] } } {
  return role === 'ADMIN' ? {} : { state: { in: visibleStates(role) } };
}

/**
 * A caller's `state` filter **intersected** with what their role may see.
 *
 * This exists because the obvious spelling is wrong in a way that reads fine:
 *
 *     where: { ...whereVisible(role), ...(state ? { state } : {}) }
 *
 * The second spread overwrites the first, so `?state=DRAFT` hands a USER every
 * draft in the library. Filters narrow what a role may see; they never widen
 * it. A USER asking for DRAFT gets an empty list rather than an error — the
 * question is answerable, the answer is just nothing.
 *
 * Use this instead of `whereVisible` on any endpoint that accepts a state
 * filter, and spread it **last** so nothing can overwrite it.
 */
export function narrowToVisibleStates(
  role: Role,
  requested?: PublishState,
): { state?: { in: PublishState[] } } {
  const allowed = visibleStates(role);

  if (requested === undefined) {
    // An admin with no filter needs no condition at all.
    return role === 'ADMIN' ? {} : { state: { in: allowed } };
  }

  return { state: { in: allowed.filter((state) => state === requested) } };
}
