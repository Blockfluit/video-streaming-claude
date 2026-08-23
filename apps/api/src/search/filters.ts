import { visibleStates } from '../common/publishing';
import type { Role } from '../prisma/generated/enums';

/**
 * The states this caller may be offered, as a Meilisearch filter expression.
 *
 * **Not an authorisation check.** Prisma runs `whereVisible` / `narrowToVisibleStates`
 * after every search, every time, and that is what decides who sees what. If this
 * function returned the empty string tomorrow, nobody would see anything they
 * should not; they would just get a worse answer.
 *
 * What it buys is the **candidate budget**. An engine is asked for the best five
 * hundred resemblances; on a library that is mostly drafts, a viewer's five
 * hundred could be almost entirely rows Prisma is about to discard, and the
 * answer comes back thin with nothing anywhere reporting why. Spending the budget
 * on rows the caller can see is the whole of it.
 *
 * Built from `visibleStates(role)` rather than from a list written here, so this
 * *renders* the one definition into a second language instead of restating it —
 * the same relationship `whereVisible` has to it. A state added to the enum
 * appears here for free; a state added here by hand would be the beginning of the
 * two-definitions problem this codebase keeps having to unpick.
 */
export function stateFilter(role: Role): string {
  /*
   * Emitted for an admin too, listing all four states, rather than skipped as an
   * optimisation. `whereVisible` returns `{}` for an admin because an absent
   * clause and a clause naming everything mean the same thing to Postgres and
   * one of them is free — but making that judgement *here* would mean this file
   * knowing which role sees everything, which is precisely the second definition
   * it exists to avoid. Rendering the list it is given cannot be wrong.
   */
  return `state IN [${visibleStates(role).join(', ')}]`;
}
