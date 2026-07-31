import { nextEpisode, type EpisodeProgress, type OrderedVideo } from './next-episode';

const episodes: OrderedVideo[] = [
  { id: 'e1', orderIndex: 0 },
  { id: 'e2', orderIndex: 1 },
  { id: 'e3', orderIndex: 2 },
];

const watched = (...ids: string[]): Map<string, EpisodeProgress> =>
  new Map(ids.map((id) => [id, { completed: true, lastPositionSec: 0 }]));

describe('nextEpisode', () => {
  it('has nothing to offer for an empty collection', () => {
    expect(nextEpisode([], new Map())).toBeNull();
  });

  it('starts at the first episode when nothing has been watched', () => {
    expect(nextEpisode(episodes, new Map())?.id).toBe('e1');
  });

  it('moves on once an episode is finished', () => {
    expect(nextEpisode(episodes, watched('e1'))?.id).toBe('e2');
  });

  /**
   * An episode started but not finished is the one to resume, and it is already
   * the first not-completed one — so the ordinary rule covers it.
   */
  it('returns to an episode left half-watched', () => {
    const progress = new Map([['e2', { completed: false, lastPositionSec: 300 }]]);

    expect(nextEpisode(episodes, new Map([...watched('e1'), ...progress]))?.id).toBe('e2');
  });

  /**
   * Watching ahead does not skip what was missed. Someone who jumped to the
   * finale still has episode two waiting.
   */
  it('does not skip an unwatched episode because a later one was finished', () => {
    expect(nextEpisode(episodes, watched('e1', 'e3'))?.id).toBe('e2');
  });

  // Nothing left to continue, so the card offers a rewatch from the start.
  it('goes back to the beginning once the whole thing is finished', () => {
    expect(nextEpisode(episodes, watched('e1', 'e2', 'e3'))?.id).toBe('e1');
  });

  it('carries the progress, so the card can show where to resume', () => {
    const progress = new Map([['e1', { completed: false, lastPositionSec: 42 }]]);

    expect(nextEpisode(episodes, progress)?.progress).toMatchObject({ lastPositionSec: 42 });
  });

  it('reports no progress for an episode never started', () => {
    expect(nextEpisode(episodes, new Map())?.progress).toBeNull();
  });

  describe('order', () => {
    it('follows orderIndex, not the order the rows arrived in', () => {
      const shuffled: OrderedVideo[] = [
        { id: 'c', orderIndex: 2 },
        { id: 'a', orderIndex: 0 },
        { id: 'b', orderIndex: 1 },
      ];

      expect(nextEpisode(shuffled, new Map())?.id).toBe('a');
    });

    // Ingest gives every video in a flat collection the same orderIndex.
    it('breaks a tie by id, so the answer does not move between requests', () => {
      const flat: OrderedVideo[] = [
        { id: 'b', orderIndex: 0 },
        { id: 'a', orderIndex: 0 },
      ];

      expect(nextEpisode(flat, new Map())?.id).toBe('a');
    });

    /**
     * A null orderIndex is "ingest could not tell", not episode zero — sorting
     * it first would offer an unnumbered extra ahead of a real episode one.
     */
    it('puts an unnumbered video after the numbered ones', () => {
      const mixed: OrderedVideo[] = [
        { id: 'extra', orderIndex: null },
        { id: 'episode', orderIndex: 1 },
      ];

      expect(nextEpisode(mixed, new Map())?.id).toBe('episode');
    });

    it('still answers when nothing is numbered at all', () => {
      const shelf: OrderedVideo[] = [
        { id: 'b', orderIndex: null },
        { id: 'a', orderIndex: null },
      ];

      expect(nextEpisode(shelf, new Map())?.id).toBe('a');
    });
  });
});
