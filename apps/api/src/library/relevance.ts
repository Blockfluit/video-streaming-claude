/**
 * How well a catalogue entry answers what somebody typed.
 *
 * Pure, and the precision half of a two-part search. `candidates.ts` asks
 * Postgres a deliberately generous question — which rows *resemble* this text —
 * and this decides what the answer is worth. The two are allowed to disagree,
 * and that is the point of splitting them: SQL similarity and this scorer are
 * written in different languages, and the worst a disagreement can do is leave
 * a row that would have scored near zero out of the pool. A recall miss, not a
 * wrong page boundary.
 *
 * That is a far weaker seam than the one `merge.ts` guards, where the SQL order
 * and the JS comparator decide a page boundary *together* and must agree
 * exactly. Nothing here has to match anything Postgres computed.
 *
 * Two folded forms of every string are used, because the questions need
 * different ones (`packages/shared/src/title.ts`):
 *
 *   `normaliseTitle`  — whitespace removed, for the contiguous questions: is
 *                       this the title, does it start with it, does it contain
 *                       it. Spacing is noise there.
 *   `foldForSearch`   — whitespace kept, for the token questions: which of
 *                       these words were typed, in any order, spelled roughly.
 *
 * Scores run 0..1. Every indirect route — the cast, a genre, a video standing
 * on a shelf — is weighted **below one**, and that is load-bearing rather than
 * decorative: `merge.ts` breaks an equal score by putting a collection before a
 * film, and a shelf that could accumulate its way past a film it ties with
 * would quietly retire that rule. `relevance.spec.ts` pins it.
 */

import { foldForSearch, normaliseTitle } from '@video/shared';

/**
 * A query is capped at 200 characters, which is a great many one-letter words,
 * and every token costs an edit-distance pass over every word of every
 * candidate. Nobody searching a film library means more than a handful.
 */
const MAX_QUERY_TOKENS = 8;

/**
 * What each route to a match is worth, relative to the entry's own title.
 *
 * All below 1. See the note on indirect routes above — this is the invariant,
 * not the numbers.
 */
export const WEIGHTS = {
  /** A credited name. Real, but the film is not *called* that. */
  cast: 0.55,
  /** A genre the entry carries. The search box has always claimed to read these. */
  genre: 0.5,
  /** A shelf found only because a video standing on it matched. */
  viaVideo: 0.6,
  /**
   * A synopsis. Additive rather than competing, and small enough to break a tie
   * without ever lifting an entry past the tier above it — the gap between two
   * title tiers is 0.10, so this must stay under it.
   */
  description: 0.08,
} as const;

/** The contiguous tiers, on the whitespace-free form. */
const EXACT = 1;
const PREFIX = 0.9;
/** Every token accounted for, but as words rather than as one run of characters. */
const TOKENS = 0.8;
const CONTAINS = 0.55;

/** What one query token is worth against one word of the text. */
const TOKEN_EXACT = 1;
const TOKEN_PREFIX = 0.8;
const TOKEN_CONTAINS = 0.6;
const TOKEN_FUZZY = [0.45, 0.35];

/**
 * The tie-breaker between two texts that matched equally well.
 *
 * A hundredth: enough to order `The Matrix` before `The Matrix Reloaded`, small
 * enough that it and a description bonus together stay under the 0.10 that
 * separates one tier from the next.
 */
const BREVITY = 0.01;

/** A query, folded both ways once, rather than once per candidate. */
export interface Search {
  /** Whitespace-free, for the contiguous tiers. `''` matches nothing. */
  normalised: string;
  /** The words, folded, capped at `MAX_QUERY_TOKENS`. */
  tokens: string[];
}

export function prepareSearch(q: string): Search {
  const folded = foldForSearch(q);

  return {
    normalised: normaliseTitle(q),
    tokens: folded.length === 0 ? [] : folded.split(' ').slice(0, MAX_QUERY_TOKENS),
  };
}

/**
 * How far apart two words are, giving up once the answer stops mattering.
 *
 * Damerau rather than plain Levenshtein: transposing two letters is the
 * commonest typing mistake there is, and charging two for it puts `teh` out of
 * reach of a tolerance of one.
 *
 * Returns `max + 1` rather than the true distance once the bound is passed —
 * every caller only ever asks "is this within `max`", so computing how unalike
 * two unrelated words are is work nobody reads.
 *
 * Hand-written on purpose. The one dependency that would do this is a package,
 * and this file is forty lines; `useDebounced.ts` made the same call about
 * VueUse.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  // Two words of very different lengths cannot be close, and the check is free.
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length <= max ? b.length : max + 1;
  if (b.length === 0) return a.length <= max ? a.length : max + 1;

  const width = b.length + 1;
  // Three rows, not two: the transposition case reaches back two rows.
  let twoBack: number[] = new Array<number>(width).fill(0);
  let previous: number[] = Array.from({ length: width }, (_, index) => index);
  let current: number[] = new Array<number>(width).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowBest = i;

    for (let j = 1; j <= width - 1; j += 1) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;

      let best = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + substitution,
      );

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (twoBack[j - 2] as number) + 1);
      }

      current[j] = best;
      if (best < rowBest) rowBest = best;
    }

    // Nothing in this row is close enough, and rows only ever grow.
    if (rowBest > max) return max + 1;

    twoBack = previous;
    previous = current;
    current = new Array<number>(width).fill(0);
  }

  const distance = previous[width - 1] as number;

  return distance <= max ? distance : max + 1;
}

/**
 * How wrong a word of this length is allowed to be.
 *
 * Zero below four characters, and that is the single most important number
 * here. Three letters is two edits from most of the dictionary, so fuzzing them
 * turns `the` into `she` and `war` into `wax` — the failure mode where a search
 * returns junk, which is worse than one that returns nothing.
 */
function tolerance(token: string): number {
  if (token.length <= 3) return 0;
  if (token.length <= 6) return 1;

  return 2;
}

/** The best any one word of the text does against one query token. */
function scoreToken(token: string, words: string[]): number {
  let best = 0;

  for (const word of words) {
    if (word === token) return TOKEN_EXACT;

    if (word.startsWith(token)) {
      best = Math.max(best, TOKEN_PREFIX);
      continue;
    }

    if (word.includes(token)) {
      best = Math.max(best, TOKEN_CONTAINS);
      continue;
    }

    const allowed = tolerance(token);
    if (allowed === 0) continue;

    const distance = editDistance(token, word, allowed);
    if (distance >= 1 && distance <= allowed) {
      best = Math.max(best, TOKEN_FUZZY[distance - 1] ?? 0);
    }
  }

  return best;
}

/**
 * Every token, scaled by how many of them were found at all.
 *
 * The coverage factor is applied twice over — once as the mean, once as the
 * multiplier — so a query half of whose words are missing scores a quarter, not
 * a half. That is what makes `reloaded matrix` prefer *The Matrix Reloaded* to
 * *The Matrix* by a margin nobody has to squint at, while still leaving the
 * partial answer above nothing.
 */
function scoreTokens(search: Search, words: string[]): number {
  if (search.tokens.length === 0 || words.length === 0) return 0;

  let total = 0;
  let matched = 0;

  for (const token of search.tokens) {
    const score = scoreToken(token, words);
    total += score;
    if (score > 0) matched += 1;
  }

  const mean = total / search.tokens.length;
  const coverage = matched / search.tokens.length;

  return mean * coverage;
}

/**
 * A name-shaped piece of text — a title, a person, a genre — scored 0..1.
 *
 * `normalised` is passed in where the caller already has it stored; every entry
 * carries `normalisedTitle` as a column, and recomputing it per request would
 * be work the database already did.
 */
export function scoreText(search: Search, text: string, normalised?: string): number {
  if (search.normalised.length === 0) return 0;

  const folded = normalised ?? normaliseTitle(text);

  const contiguous =
    folded === search.normalised
      ? EXACT
      : folded.startsWith(search.normalised)
        ? PREFIX
        : folded.includes(search.normalised)
          ? CONTAINS
          : 0;

  const words = foldForSearch(text).split(' ').filter(Boolean);

  /*
   * How much of the *text* the query accounted for, worth a hair.
   *
   * Searching "matrix" matches `The Matrix` and `The Matrix Reloaded` equally
   * on every tier above — one whole word found in both — and the shorter one is
   * the better answer. Without this the two tie and the order falls through to
   * the title, which happens to be right here and would not be for `Zulu
   * Matrix`.
   *
   * Deliberately tiny. Added inside the token branch so it cannot lift an exact
   * title past 1, and small enough that it plus a description bonus stays under
   * the 0.10 gap between two tiers — it settles ties, it never creates them.
   */
  const tokens = scoreTokens(search, words);

  // Nothing matched, so there is no tie to settle — and a text that scores on
  // density alone would be a card returned for a query it has no word of.
  if (tokens === 0) return contiguous;

  const density = Math.min(search.tokens.length, words.length) / words.length;

  return Math.max(contiguous, TOKENS * tokens + BREVITY * density);
}

/**
 * A synopsis, scored on its plain words only.
 *
 * No contiguous tier and, more importantly, **no fuzz**. A description is long
 * prose, and edit distance across a few hundred words finds a near-match for
 * almost any query — which is exactly how a fuzzy search starts returning
 * things nobody asked for. Words it actually contains are evidence; words it
 * nearly contains are not.
 */
function scoreProse(search: Search, text: string): number {
  if (search.tokens.length === 0) return 0;

  const words = foldForSearch(text).split(' ').filter(Boolean);
  if (words.length === 0) return 0;

  let total = 0;
  let matched = 0;

  for (const token of search.tokens) {
    // Exact and prefix only — the fuzzy tier is deliberately unreachable here.
    const score = words.includes(token)
      ? TOKEN_EXACT
      : words.some((word) => word.startsWith(token))
        ? TOKEN_PREFIX
        : 0;

    total += score;
    if (score > 0) matched += 1;
  }

  return (total / search.tokens.length) * (matched / search.tokens.length);
}

/** Everything one card can be found by. Only `title` is ever certain. */
export interface Evidence {
  title: string;
  normalisedTitle: string;
  description?: string | null;
  /** Names of credited people the candidate step already matched. */
  castNames?: string[];
  genres?: string[];
  /**
   * The best `scoreText` of a visible video standing on this shelf.
   *
   * Already scored by the caller, because only the service knows which videos
   * the viewer may see — and that filter is the one thing between a draft
   * episode's title and somebody who may not know it exists.
   */
  viaVideo?: number;
}

export function scoreEntry(search: Search, evidence: Evidence): number {
  if (search.tokens.length === 0 && search.normalised.length === 0) return 0;

  const own = scoreText(search, evidence.title, evidence.normalisedTitle);

  const cast = (evidence.castNames ?? []).reduce(
    (best, name) => Math.max(best, scoreText(search, name)),
    0,
  );

  const genre = (evidence.genres ?? []).reduce(
    (best, name) => Math.max(best, scoreText(search, name)),
    0,
  );

  // `max`, not a sum: the strongest reason an entry is here decides its tier,
  // and a card cannot accumulate its way up on weak evidence.
  const best = Math.max(
    own,
    WEIGHTS.cast * cast,
    WEIGHTS.genre * genre,
    WEIGHTS.viaVideo * (evidence.viaVideo ?? 0),
  );

  if (best === 0 && !evidence.description) return 0;

  const prose = evidence.description ? scoreProse(search, evidence.description) : 0;

  return best + WEIGHTS.description * prose;
}
