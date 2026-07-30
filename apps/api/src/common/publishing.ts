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

/** What a publishable video must have. Credits, subtitles and markers never appear here. */
export interface VideoPublishFields {
  title: string | null;
  description: string | null;
  durationSec: number | null;
  thumbnailKey: string | null;
}

export interface CollectionPublishFields {
  title: string | null;
  description: string | null;
  posterKey: string | null;
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
  if (isBlank(video.description)) missing.push('description');
  // Zero means the probe found no usable stream, not a very short film.
  if (video.durationSec === null || video.durationSec <= 0) missing.push('durationSec');
  if (isBlank(video.thumbnailKey)) missing.push('thumbnailKey');

  return missing;
}

export function collectionMissingFields(collection: CollectionPublishFields): string[] {
  const missing: string[] = [];

  if (isBlank(collection.title)) missing.push('title');
  if (isBlank(collection.description)) missing.push('description');
  if (isBlank(collection.posterKey)) missing.push('posterKey');
  // An empty shelf is not a collection.
  if (collection.publishableVideoCount < 1) missing.push('videos');

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
