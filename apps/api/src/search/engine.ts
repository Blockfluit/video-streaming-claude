import type { Role } from '../prisma/generated/enums';

/**
 * Which rows resemble what somebody typed — asked of whatever is answering.
 *
 * The **recall** half of search, and nothing else. `relevance.ts` still decides
 * what a match is worth and `library.service.ts` still decides who may see it;
 * an engine behind this interface only says which rows are worth looking at.
 *
 * That boundary is not tidiness, it is the whole safety argument, and it is
 * inherited verbatim from `library/candidates.ts`: **an engine never crosses a
 * relation.** It is asked about one table's own text and it answers with ids.
 * It does not know what a film is, that a shelf can be found through a video
 * standing on it, or who may see a draft.
 *
 * The tempting version of this interface hands back ranked, paged *results* so
 * the caller can stop scoring in JavaScript. It is wrong here, and the reason
 * is worth writing down because it will look like an obvious improvement again:
 * a shelf is findable by the titles of the videos on it, that route is what
 * keeps a saga's films reachable at all (`common/films.ts` has the scar), and
 * whether a given video may be seen is a question about *that video's* state.
 * An engine can only answer it by holding a copy of its members' titles, and a
 * copy is a thing that can be stale — at which point a viewer types a draft
 * episode's title and gets its shelf, which is published, so Prisma re-reads it
 * happily and shows it. The re-read cannot catch that one, because the shelf is
 * genuinely visible. So the shelf-via-video route stays in Prisma, where
 * `whereVisible(role)` still runs against the episode itself.
 *
 * What the engine is therefore allowed to be wrong about is bounded: it can
 * offer a row that is gone, or miss one that is new. Both cost recall for a few
 * seconds and neither shows anybody anything, because every id it returns is
 * re-read through the filters that have always applied.
 */
export interface SearchCandidateRequest {
  /** Exactly what was typed, for the engines that keep spacing and word order. */
  q: string;

  /** `normaliseTitle(q)` — accent- and case-folded, for the engines that want it. */
  normalised: string;

  /**
   * Whose search this is.
   *
   * Not an authorisation check — Prisma does that, afterwards, every time. It is
   * how the candidate budget gets spent on rows the caller can actually see: a
   * viewer whose best five hundred resemblances are mostly drafts otherwise gets
   * a thin answer with nothing anywhere reporting why.
   */
  role: Role;

  /** The most ids worth having. See `CANDIDATE_LIMIT`. */
  limit: number;
}

/** Ids only. Nothing here has been filtered for who may see it. */
export interface SearchCandidates {
  collectionIds: string[];
  videoIds: string[];
  /** Names come back because `relevance.ts` scores them; the ids do the joining. */
  people: { id: string; name: string }[];
}

export interface SearchEngine {
  /** Shown to an admin when something goes wrong, so name the thing. */
  readonly name: string;

  /**
   * False when the operator has not configured this engine.
   *
   * Read rather than thrown, exactly as `SubtitleProvider.isConfigured` is and
   * for the same reason: a screen that has to catch an error to draw itself is a
   * screen that flickers. Here it carries a second job — it is also the switch
   * that sends every search down the built-in Postgres path instead, which is
   * why an unconfigured server is a fully working server and not a degraded one.
   */
  readonly isConfigured: boolean;

  candidates(request: SearchCandidateRequest): Promise<SearchCandidates>;
}

/** Nest injection token — the interface is a type and cannot be one itself. */
export const SEARCH_ENGINE = Symbol('SEARCH_ENGINE');
