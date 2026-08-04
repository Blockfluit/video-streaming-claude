import { latest, rollUpAndRank, total, type ScoredVideo } from './rank';

/** A video in no collection — a film, in this model. */
const standalone = (videoId: string, score: number): ScoredVideo => ({
  videoId,
  collectionIds: [],
  score,
});

const episode = (videoId: string, collectionIds: string[], score: number): ScoredVideo => ({
  videoId,
  collectionIds,
  score,
});

describe('rollUpAndRank', () => {
  describe('VIDEOS', () => {
    it('ranks videos on their own score and rolls nothing up', () => {
      const ranked = rollUpAndRank(
        [episode('e1', ['show'], 5), episode('e2', ['show'], 9)],
        'VIDEOS',
        10,
        total,
      );

      expect(ranked).toEqual([
        { kind: 'video', id: 'e2', score: 9 },
        { kind: 'video', id: 'e1', score: 5 },
      ]);
    });

    it('keeps a standalone video, which has no collection to roll into', () => {
      const ranked = rollUpAndRank([standalone('film', 3)], 'VIDEOS', 10, total);

      expect(ranked).toEqual([{ kind: 'video', id: 'film', score: 3 }]);
    });
  });

  describe('COLLECTIONS', () => {
    it("sums an episode's score into its show", () => {
      const ranked = rollUpAndRank(
        [episode('e1', ['show'], 5), episode('e2', ['show'], 9)],
        'COLLECTIONS',
        10,
        total,
      );

      expect(ranked).toEqual([{ kind: 'collection', id: 'show', score: 14 }]);
    });

    it('drops a standalone video, which is no collection at all', () => {
      const ranked = rollUpAndRank(
        [standalone('film', 100), episode('e1', ['show'], 1)],
        'COLLECTIONS',
        10,
        total,
      );

      expect(ranked).toEqual([{ kind: 'collection', id: 'show', score: 1 }]);
    });

    it('lifts every collection an episode belongs to, not one of them', () => {
      const ranked = rollUpAndRank(
        [episode('e1', ['show', 'best-of'], 4)],
        'COLLECTIONS',
        10,
        total,
      );

      expect(ranked).toEqual([
        { kind: 'collection', id: 'best-of', score: 4 },
        { kind: 'collection', id: 'show', score: 4 },
      ]);
    });
  });

  describe('AUTO', () => {
    it('ranks collections and standalone videos together in one shelf', () => {
      const ranked = rollUpAndRank(
        [episode('e1', ['show'], 5), episode('e2', ['show'], 5), standalone('film', 8)],
        'AUTO',
        10,
        total,
      );

      // The show totals 10 and outranks the film, which no per-episode
      // comparison would have said.
      expect(ranked).toEqual([
        { kind: 'collection', id: 'show', score: 10 },
        { kind: 'video', id: 'film', score: 8 },
      ]);
    });

    it('never lists an episode beside the show it rolled into', () => {
      const ranked = rollUpAndRank([episode('e1', ['show'], 5)], 'AUTO', 10, total);

      expect(ranked).toEqual([{ kind: 'collection', id: 'show', score: 5 }]);
    });
  });

  describe('ordering', () => {
    it('breaks a score tie on id, so a shelf does not reshuffle between requests', () => {
      const ranked = rollUpAndRank(
        [standalone('b', 1), standalone('a', 1), standalone('c', 1)],
        'AUTO',
        10,
        total,
      );

      expect(ranked.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    });

    it('breaks a tie between a collection and a video on id too', () => {
      const ranked = rollUpAndRank(
        [standalone('z-film', 1), episode('e1', ['a-show'], 1)],
        'AUTO',
        10,
        total,
      );

      expect(ranked.map((entry) => entry.id)).toEqual(['a-show', 'z-film']);
    });

    it('takes the highest scoring entries, not the first ones found', () => {
      const ranked = rollUpAndRank(
        [standalone('a', 1), standalone('b', 9), standalone('c', 5)],
        'AUTO',
        2,
        total,
      );

      expect(ranked.map((entry) => entry.id)).toEqual(['b', 'c']);
    });

    it('drops an entry scoring nothing rather than padding the shelf with it', () => {
      const ranked = rollUpAndRank([standalone('a', 0), standalone('b', 3)], 'AUTO', 10, total);

      expect(ranked.map((entry) => entry.id)).toEqual(['b']);
    });
  });

  describe('combining', () => {
    it('totals views, so a show watched across many episodes ranks on all of them', () => {
      const ranked = rollUpAndRank(
        [episode('e1', ['show'], 3), episode('e2', ['show'], 4)],
        'COLLECTIONS',
        10,
        total,
      );

      expect(ranked[0]?.score).toBe(7);
    });

    it('takes the latest timestamp, so a new episode resurfaces an old show', () => {
      const ranked = rollUpAndRank(
        [episode('old', ['show'], 1000), episode('new', ['show'], 5000)],
        'COLLECTIONS',
        10,
        latest,
      );

      // Summing dates would rank a long-running show above a newer one for
      // having more episodes, which is not what "recently added" means.
      expect(ranked[0]?.score).toBe(5000);
    });
  });

  it('returns nothing when nothing scored', () => {
    expect(rollUpAndRank([], 'AUTO', 10, total)).toEqual([]);
  });
});
