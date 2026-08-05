/**
 * What an import would change, field by field.
 *
 * Pure. This is what the admin actually approves, so it is the whole of the
 * feature's provenance story: rather than a `metadataSource` column per field
 * recording who last wrote it, a person looks at both values and says which to
 * keep. That only works if the comparison is honest, which is what these rules
 * are for.
 */

import { METADATA_FIELDS, type MetadataField } from '@video/shared';

import type { MetadataProposal } from './tmdb.mapper';

export interface FieldDiff {
  field: MetadataField;
  current: unknown;
  proposed: unknown;
  /** False when the proposal offers nothing new — see `wouldChange`. */
  changed: boolean;
  /** Whether the checkbox starts ticked. */
  suggested: boolean;
}

/** Everything a collection can carry, including the series-only fields. */
export const COLLECTION_FIELDS: readonly MetadataField[] = METADATA_FIELDS;

/**
 * A video carries the same fields minus the ones that describe a whole show.
 * Offering an admin a season count for a film is a checkbox with no column
 * behind it.
 */
export const VIDEO_FIELDS: readonly MetadataField[] = METADATA_FIELDS.filter(
  (field) => field !== 'seriesStatus' && field !== 'seasonCount' && field !== 'episodeCount',
);

/**
 * The title is deliberately never suggested.
 *
 * It is usually the first thing an admin fixes by hand — ingest names a video
 * from its filename — so proposing to overwrite it is the most annoying possible
 * default. A slug does not follow a rename either, so an accepted rename leaves
 * the shared link and the name disagreeing.
 */
const NEVER_SUGGESTED: readonly MetadataField[] = ['title'];

export type CurrentMetadata = Partial<Record<MetadataField, unknown>>;

/**
 * Indexed directly rather than through a cast, so that adding a name to
 * `METADATA_FIELDS` that the proposal does not actually carry is a compile
 * error here rather than a checkbox that silently writes undefined.
 */
export function buildDiff(
  current: CurrentMetadata,
  proposal: MetadataProposal,
  fields: readonly MetadataField[],
): FieldDiff[] {
  return fields.map((field) => {
    const currentValue = current[field] ?? null;
    const proposedValue: unknown = proposal[field] ?? null;
    const changed = wouldChange(currentValue, proposedValue);

    return {
      field,
      current: currentValue,
      proposed: proposedValue,
      changed,
      suggested: changed && !NEVER_SUGGESTED.includes(field),
    };
  });
}

/**
 * Whether applying this field would actually be an improvement.
 *
 * "The proposal has nothing" is never a change. TMDB not knowing a tagline is
 * not a reason to delete the one somebody wrote, and without this rule, ticking
 * everything on a well-curated title empties half of it.
 */
function wouldChange(current: unknown, proposed: unknown): boolean {
  if (isEmpty(proposed)) return false;
  return !same(current, proposed);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function same(a: unknown, b: unknown): boolean {
  // Two dates naming one moment are the same value; `===` says otherwise, and a
  // release date would then be "changed" on every single preview.
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    // Order is part of a genre list — TMDB's own ordering puts the primary genre
    // first, which is what a card shows when it has room for one.
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  }

  return a === b;
}
