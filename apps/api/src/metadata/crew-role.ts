/**
 * TMDB's crew job → the library's `CreditRole`.
 *
 * Pure, and tested before the importer that calls it, because getting this
 * wrong is quiet: a crew member lands under the wrong heading and nothing
 * anywhere reports a problem.
 *
 * An import stores **every** crew member, so this is a promotion table rather
 * than a filter. A film has six or so jobs worth a heading of their own and two
 * hundred that are not; the latter become `OTHER` and keep their job title, so
 * nothing is lost and the panel still leads with the names people look for.
 */

import { CreditRole } from '../prisma/generated/enums';

/**
 * Matched on the **whole** job string, never as a substring.
 *
 * TMDB's crew is full of jobs that contain one of these — "Assistant Director",
 * "Second Unit Director", "Music Editor", "Casting Director" — and a substring
 * match promotes all of them. That is the same trap as release-tag stripping in
 * the path parser, where matching `aac` inside "Aachen" eats real titles.
 */
const JOB_ROLES: ReadonlyMap<string, CreditRole> = new Map([
  ['director', CreditRole.DIRECTOR],
  ['writer', CreditRole.WRITER],
  ['screenplay', CreditRole.WRITER],
  ['story', CreditRole.WRITER],
  // Television's word for the same job.
  ['teleplay', CreditRole.WRITER],
  ['producer', CreditRole.PRODUCER],
  ['executive producer', CreditRole.PRODUCER],
  ['original music composer', CreditRole.COMPOSER],
  ['composer', CreditRole.COMPOSER],
  ['director of photography', CreditRole.CINEMATOGRAPHER],
  ['editor', CreditRole.EDITOR],
]);

/**
 * The jobs that earn a heading of their own, in TMDB's spelling.
 *
 * Exported so the credits panel and this table cannot disagree about which crew
 * are shown before the "show everything" toggle is pressed.
 */
export const KEY_CREW_JOBS: readonly string[] = [...JOB_ROLES.keys()];

export function creditRoleForJob(job: string): CreditRole {
  return JOB_ROLES.get(job.trim().toLowerCase()) ?? CreditRole.OTHER;
}
