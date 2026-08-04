/**
 * Merging a video's credits with its collection's.
 *
 * A series' main cast is entered once on the show and an episode carries only
 * its guest stars, so the panel under an episode is the two lists combined.
 * Pure, because the combining rules — who wins a clash, and what order the
 * result comes out in — are exactly the part that is wrong quietly: a panel
 * that reshuffles between requests looks like a rendering bug for weeks.
 */

import { CreditRole } from '../prisma/generated/enums';

export interface MergeableCredit {
  id: string;
  personId: string;
  role: CreditRole;
  characterName: string | null;
  /** Billing order within a role. */
  position: number;
  /**
   * TMDB's raw job, where there is one. Part of a credit's identity rather than
   * decoration: all but six jobs collapse to `OTHER`, so two genuinely different
   * crew credits for one person are distinguishable only by this.
   */
  jobTitle: string | null;
  department: string | null;
  person: {
    id: string;
    slug: string;
    name: string;
    photoKey: string | null;
    imdbId: string | null;
    knownFor: string | null;
  };
}

export interface MergedCredit extends MergeableCredit {
  /**
   * True when the credit came from the collection rather than the video. The
   * admin UI needs it: an inherited credit is edited on the show, and editing
   * it from an episode would silently change every other episode.
   */
  inherited: boolean;
}

/**
 * Role display order, taken from the enum's own declaration order so the two
 * cannot drift apart.
 */
const ROLE_ORDER: readonly CreditRole[] = Object.values(CreditRole);

export function mergeCredits(
  collectionCredits: MergeableCredit[],
  videoCredits: MergeableCredit[],
): MergedCredit[] {
  // The episode's credit is the more specific one — it can carry a character
  // name for this episode — so it replaces the show's rather than joining it.
  const own = new Set(videoCredits.map((credit) => key(credit)));

  const merged: MergedCredit[] = [
    ...collectionCredits
      .filter((credit) => !own.has(key(credit)))
      .map((credit) => ({ ...credit, inherited: true })),
    ...videoCredits.map((credit) => ({ ...credit, inherited: false })),
  ];

  return merged.sort(
    (a, b) =>
      ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
      a.position - b.position ||
      // The two parents number their positions independently, so a tie is
      // normal. Main cast before guest stars is the convention.
      Number(a.inherited === false) - Number(b.inherited === false) ||
      // Without a last resort the order is not total, and a panel that
      // reshuffles between requests reads as a rendering bug.
      a.person.name.localeCompare(b.person.name) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * What makes two credits *the same credit*, so that an episode's replaces the
 * show's rather than joining it.
 *
 * `jobTitle` is in the key, and has to be. An import stores every crew member,
 * and all but six jobs map to `OTHER` — so on `personId:role` alone, one person
 * credited on the show as Costume Designer and on an episode as Stunt
 * Coordinator collides with themselves, and the show's credit disappears from
 * that episode's panel. Acting credits have no job title, which leaves them
 * keyed exactly as they were.
 */
const key = (credit: MergeableCredit): string =>
  `${credit.personId}:${credit.role}:${credit.jobTitle ?? ''}`;
