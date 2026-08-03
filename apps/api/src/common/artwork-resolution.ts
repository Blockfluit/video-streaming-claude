/**
 * Which picture to serve, given the candidates in order of preference.
 *
 * A collection's own key is an **admin override**, not the whole answer: null
 * there means "nobody has chosen one", and the shelf should then show what is on
 * it — the first video's artwork — rather than nothing. Only when there is no
 * video either does the stock image apply.
 *
 * Deriving rather than copying the first episode's file at ingest is what makes
 * that self-healing: the artwork follows the episodes when they are added,
 * reordered or removed, and there is no second copy to go stale. From outside it
 * looks like "the collection took its first episode's picture", without a
 * snapshot that rots the moment the episode changes.
 *
 * Pure, and separate from the service, because the interesting part is the
 * precedence and that deserves testing without a database.
 */

export type ArtworkResolution = { kind: 'stored'; key: string } | { kind: 'fallback' };

/**
 * The first candidate that is actually a key.
 *
 * Empty strings are treated as absent alongside null and undefined. A key of
 * `''` resolves to the root of `DERIVED_ROOT`, which is a directory — the read
 * fails in a way that reports nothing useful, and it is never what anyone meant.
 */
export function resolveArtwork(
  ...candidates: (string | null | undefined)[]
): ArtworkResolution {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return { kind: 'stored', key: candidate };
    }
  }

  return { kind: 'fallback' };
}
