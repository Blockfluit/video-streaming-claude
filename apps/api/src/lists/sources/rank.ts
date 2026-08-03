/**
 * Turning per-video scores into the entries a home-page row shows.
 *
 * Every computed row reduces to the same three steps — score each video, roll
 * those scores up to whatever the row is meant to show, rank what comes out —
 * so this is the one place that decides what a shelf actually contains. Pure,
 * because the rules only bite in combination: a show whose episodes were each
 * watched a little should outrank a film watched once, and "recently added"
 * must not mean "has the most episodes".
 *
 * A video belongs to any number of collections through `CollectionVideo`, or to
 * none at all — a film, in this model. Both of those are ordinary here rather
 * than edge cases, which is most of why the roll-up is worth testing on its own.
 */

import type { RowKind } from '../../prisma/generated/enums';

export interface ScoredVideo {
  videoId: string;
  /** Every collection it is in. Empty means standalone, which is what a film is. */
  collectionIds: string[];
  score: number;
}

export interface RankedEntry {
  kind: 'collection' | 'video';
  id: string;
  score: number;
}

/**
 * How two scores for the same collection combine.
 *
 * Passed in rather than derived from the row's source, because it is the one
 * thing that genuinely differs between them and naming it at the call site is
 * clearer than a flag this function would have to interpret.
 */
export type Combine = (a: number, b: number) => number;

/** Views and seconds add up: a show is watched across its episodes. */
export const total: Combine = (a, b) => a + b;

/**
 * Recency does not. A show is as recent as its newest episode — summing
 * timestamps would rank a long-running show above a newer one for having more
 * of them, which is not what "recently added" means to anyone.
 */
export const latest: Combine = (a, b) => Math.max(a, b);

export function rollUpAndRank(
  rows: ScoredVideo[],
  kind: RowKind,
  limit: number,
  combine: Combine,
): RankedEntry[] {
  const entries = kind === 'VIDEOS' ? asVideos(rows) : rollUp(rows, kind, combine);

  return (
    entries
      // A zero means the video was never watched, or the window found nothing.
      // Padding a shelf out to its limit with entries that scored nothing
      // renders a "most watched" row full of things nobody watched.
      .filter((entry) => entry.score > 0)
      // `id` last makes the order total. Ties are the norm rather than the
      // exception here — every entry in a fresh trending row scores the same —
      // and a shelf that reshuffles between requests reads as a rendering bug
      // for weeks before anyone works out it is the sort.
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit)
  );
}

/** No roll-up at all: the row is about episodes, so episodes are what it shows. */
function asVideos(rows: ScoredVideo[]): RankedEntry[] {
  return rows.map((row) => ({ kind: 'video' as const, id: row.videoId, score: row.score }));
}

function rollUp(rows: ScoredVideo[], kind: RowKind, combine: Combine): RankedEntry[] {
  const collections = new Map<string, number>();
  const standalone: RankedEntry[] = [];

  for (const row of rows) {
    if (row.collectionIds.length === 0) {
      // Nothing to roll into. Under AUTO it stands as itself — that is what a
      // film is here — and under COLLECTIONS there is simply no entry for it.
      if (kind === 'AUTO') {
        standalone.push({ kind: 'video', id: row.videoId, score: row.score });
      }
      continue;
    }

    // Every collection it is in, not one of them. The same episode can be
    // episode 3 of a show and item 1 of a best-of row, and there is no honest
    // rule for which of those a view belongs to.
    for (const collectionId of row.collectionIds) {
      const running = collections.get(collectionId);
      collections.set(
        collectionId,
        running === undefined ? row.score : combine(running, row.score),
      );
    }
  }

  return [
    ...[...collections].map(([id, score]) => ({ kind: 'collection' as const, id, score })),
    ...standalone,
  ];
}
