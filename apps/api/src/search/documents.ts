import type { PublishState } from '@video/shared';

/**
 * What an engine is told about a row, and — far more importantly — what it is
 * not.
 *
 * **The index boundary is the table boundary.** A document holds one row's own
 * text and nothing reached across a relation: no collection document carries the
 * titles of the videos standing on it, and no title document carries the names
 * of the people credited on it. That is not a normalisation preference, it is
 * the only thing standing between a viewer and a draft episode's title.
 *
 * The argument, because somebody will propose the other thing and it will look
 * like an obvious improvement: a shelf is findable by the titles of the videos on
 * it, so flattening those titles into the shelf's document makes that route fast
 * and local. It also makes it *undecidable* — whether a given member's title may
 * be shown depends on that member's `state`, and the document has no idea, while
 * the shelf's own state passes every filter downstream. So Prisma would re-read
 * the shelf, find it published, and show it. **That is the one leak the re-read
 * cannot catch.** `search.db-spec.ts` pins it; `engine.ts` explains the seam.
 *
 * The same goes for cast. A person is a document in its own index, and the join
 * from people to titles stays where it has always been — `credits: { some: … }`
 * in Prisma. Two dividends beyond the safety: a person renamed is one document
 * rewritten rather than a fan-out to every title they are credited on, and every
 * write in `credits.service.ts` becomes one this never has to hear about.
 *
 * **Index only what `relevance.ts` can score.** Recall the scorer will throw away
 * is worse than useless — it spends the candidate budget and then drops the row,
 * so a real match further down the list loses its place to something that was
 * never going to be shown. Today that means title, description and genres, which
 * is exactly the set `postgres.candidates.ts` asks about. `originalTitle`, `tags`
 * and `tagline` are all populated, all searchable in principle, and all pointless
 * to index until the scorer reads them — which is a deliberate change to what a
 * search *means*, not a setting.
 */
export interface TitleDocument {
  id: string;
  title: string;
  description: string;
  genres: string[];
  /** Filterable, so the candidate budget is spent on rows the caller may see. */
  state: PublishState;
  /**
   * Whether no collection claims this video — `whereFilm`'s rule, denormalised.
   *
   * Filterable and, for the catalogue, deliberately **unused**: the shelf-via-video
   * route needs the ids of videos that are *on* shelves, so filtering them out
   * here would break the thing this file spends its header protecting. It earns
   * its place for `/videos?film=true`, which the row picker asks.
   */
  isFilm: boolean;
}

export interface PersonDocument {
  id: string;
  name: string;
}

export interface TitleRow {
  id: string;
  title: string;
  description: string | null;
  genres: string[];
  state: PublishState;
}

export function toTitleDocument(row: TitleRow, isFilm: boolean): TitleDocument {
  return {
    id: row.id,
    title: row.title,
    // `''` rather than null: Meilisearch indexes the field either way, and a
    // null makes the document's shape depend on the data, which shows up later
    // as a settings mismatch nobody can explain.
    description: row.description ?? '',
    genres: row.genres,
    state: row.state,
    isFilm,
  };
}

export function toPersonDocument(row: { id: string; name: string }): PersonDocument {
  return { id: row.id, name: row.name };
}

/**
 * The index settings, and the two that are decisions rather than defaults.
 *
 * `searchableAttributes` is **ordered**, and the order is the ranking:
 * Meilisearch's `attribute` rule prefers a hit in an earlier field, so a synopsis
 * can never outrank a title. That mirrors `WEIGHTS.description` being additive
 * and small, and `WEIGHTS.genre` sitting between the two.
 *
 * `typoTolerance` is aligned to `relevance.ts`'s `tolerance()` — zero below four
 * characters, one to six, two above — and **must stay at least as permissive**,
 * because a row the engine declines to offer is a row the scorer never gets to
 * credit. More permissive costs nothing: `pool.filter(score > 0)` removes what
 * the scorer will not vouch for.
 *
 * `disableOnAttributes: ['description']` is `scoreProse`'s "no fuzz on a synopsis,
 * ever" written in the engine's language, and it is the single most important
 * quality setting here. A synopsis is long prose where edit distance finds a
 * near-match for almost anything.
 *
 * **`stopWords` is empty on purpose.** A Dutch and English list is two chances to
 * make a title unfindable, and it contradicts `normaliseTitle`'s documented
 * refusal to drop leading articles — a library holding a film called *Het* is not
 * hypothetical.
 */
export const TITLE_INDEX_SETTINGS = {
  searchableAttributes: ['title', 'genres', 'description'],
  filterableAttributes: ['state', 'isFilm'],
  stopWords: [],
  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: { oneTypo: 4, twoTypos: 7 },
    disableOnAttributes: ['description'],
  },
} as const;

export const PERSON_INDEX_SETTINGS = {
  searchableAttributes: ['name'],
  filterableAttributes: [],
  stopWords: [],
  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: { oneTypo: 4, twoTypos: 7 },
  },
} as const;
