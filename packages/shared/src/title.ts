/**
 * Comparing a title someone typed against a title already in the library.
 *
 * A request form asks for a title in free text, and "does this already exist?"
 * has to be answered before the request is worth making. Raw string equality
 * answers it badly: `The Matrix`, `the matrix` and `The Matrix (1999)` are one
 * film to a person and three to Postgres.
 *
 * This is deliberately **not** `slugify`. A slug is a URL component that is
 * stable once created — renaming a title never moves it — so a slug drifts away
 * from the title it came from and is exactly the wrong thing to match on. This
 * is a comparison key, recomputed from the title every time one is written.
 *
 * Pure, and shared, so the column the API stores and the check the API runs can
 * never disagree about what "the same title" means.
 */

/**
 * A year in trailing brackets, the way people write a film title into a form.
 *
 * Stripped before normalising so `The Matrix (1999)` and `The Matrix` compare
 * equal — the request carries the year in its own field, and a library row
 * carries it in `year`, so keeping it in the comparison key would make the two
 * spellings of one film into two films.
 *
 * Only *trailing* and only *bracketed*: `Blade Runner 2049` and `2001: A Space
 * Odyssey` keep every digit, because there the number is the title.
 */
const TRAILING_BRACKETED_YEAR = /[([]\s*(?:1[5-9]\d{2}|2[01]\d{2})\s*[)\]]\s*$/;

/**
 * The comparison key for a title.
 *
 * Folds accents, drops case, and removes everything that is not a letter or a
 * digit — so punctuation, spacing and separators stop mattering:
 *
 *     "The Matrix"        "The Matrix (1999)"     -> "thematrix"
 *     "Amélie"            "Amelie"                -> "amelie"
 *     "WALL·E"            "Wall-E"                -> "walle"
 *     "Se7en"                                     -> "se7en"
 *
 * Leading articles are deliberately **kept**. Dropping them would match `The
 * Thing` to `Thing`, which is usually right, and `The Others` to `Others`,
 * which is not — and the cost of a false match here is refusing a legitimate
 * request, which is worse than letting a near-duplicate through to an admin who
 * can see both.
 *
 * Never returns an empty string for a title that has any content: a name made
 * entirely of punctuation falls back to its lowercased self, so two rows spelled
 * `???` still compare equal while `???` and `!!!` do not. Only genuinely blank
 * input yields `''`, which callers treat as "not comparable" rather than as a
 * key that matches every other blank.
 */
export function normaliseTitle(raw: string): string {
  const withoutYear = raw.replace(TRAILING_BRACKETED_YEAR, '');

  const folded = withoutYear
    // NFKD splits an accented character into its base plus a combining mark…
    .normalize('NFKD')
    // …which this then drops, leaving the base letter behind.
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

  if (folded.length > 0) return folded;

  // Nothing survived — the title is punctuation, or another script entirely.
  // Its lowercased self still distinguishes it from a different one, which is
  // all a comparison key has to do.
  return withoutYear.trim().toLowerCase();
}
