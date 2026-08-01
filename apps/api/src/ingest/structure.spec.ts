import { parseMediaPath, type MediaPath } from './path-parser';
import { proposeStructure, type Proposal } from './structure';

/** Parses a list of paths the way a scan would, keeping only what it would keep. */
function propose(paths: string[]): Proposal[] {
  const parsed: MediaPath[] = paths.map((path) => parseMediaPath(path));
  return proposeStructure(parsed);
}

function only(paths: string[]): Proposal {
  const proposals = propose(paths);
  if (proposals.length !== 1) {
    throw new Error(`expected exactly one proposal, got ${proposals.length}`);
  }
  return proposals[0];
}

describe('proposeStructure', () => {
  /**
   * The whole point of the module: the shape of an item folder decides whether
   * a collection exists, and that decision needs the *set* of files in the
   * folder — which the per-path parser cannot see.
   */
  describe('one video in a folder is a standalone video', () => {
    const proposal = only(['videos1/10 Cloverfield Lane/10 Cloverfield Lane.mp4']);

    it('makes no collection', () => {
      expect(proposal.kind).toBe('standalone');
    });

    it('takes its title from the folder rather than the filename', () => {
      expect(proposal.title).toBe('10 Cloverfield Lane');
      expect(proposal.videos[0].title).toBe('10 Cloverfield Lane');
    });

    it('remembers where it came from', () => {
      expect(proposal).toMatchObject({
        driveFolder: 'videos1',
        folderKey: 'videos1/10 Cloverfield Lane',
      });
      expect(proposal.videos[0].storageKey).toBe(
        'videos1/10 Cloverfield Lane/10 Cloverfield Lane.mp4',
      );
    });

    it('has no seasons', () => {
      expect(proposal.seasons).toEqual([]);
    });

    /**
     * The folder is the deliberate name; the filename is whatever the release
     * was called. A standalone video takes the folder's.
     */
    it('prefers the folder name even when the filename is scene noise', () => {
      const proposal = only(['disk1/Some Film (2019)/some.film.2019.1080p.web-dl.x264.mkv']);
      expect(proposal.videos[0].title).toBe('Some Film (2019)');
    });
  });

  describe('two or more videos in a folder make a collection', () => {
    const proposal = only([
      'videos1/Avatar/Avatar.mp4',
      'videos1/Avatar/Avatar The Way Of Water.mp4',
    ]);

    it('is a collection named after the folder', () => {
      expect(proposal.kind).toBe('collection');
      expect(proposal.title).toBe('Avatar');
    });

    it('keeps every video, titled from its own filename', () => {
      expect(proposal.videos.map((video) => video.title)).toEqual([
        'Avatar',
        'Avatar The Way Of Water',
      ]);
    });

    it('has no seasons — the videos sit directly in the collection', () => {
      expect(proposal.seasons).toEqual([]);
      expect(proposal.videos.every((video) => video.seasonFolder === null)).toBe(true);
    });
  });

  describe('season folders make a series, whatever the video count', () => {
    const proposal = only([
      'videos/Chernobyl/Season 01/Chernobyl - Aflevering 1.mp4',
      'videos/Chernobyl/Season 01/Chernobyl - Aflevering 2.mp4',
    ]);

    it('is a collection', () => {
      expect(proposal.kind).toBe('collection');
      expect(proposal.title).toBe('Chernobyl');
    });

    it('carries the season through', () => {
      expect(proposal.seasons).toEqual([
        expect.objectContaining({
          folder: 'Season 01',
          number: 1,
          folderKey: 'videos/Chernobyl/Season 01',
          needsReview: false,
        }),
      ]);
    });

    it('binds each video to its season folder', () => {
      expect(proposal.videos.every((video) => video.seasonFolder === 'Season 01')).toBe(true);
    });

    /**
     * A single episode in a season folder is still a series. Someone who has
     * ripped one episode so far has a show, not a film, and the next scan must
     * not have to undo a standalone video.
     */
    it('is a collection even with one episode in the season', () => {
      const proposal = only(['videos/Chernobyl/Season 01/Chernobyl - Aflevering 1.mp4']);
      expect(proposal.kind).toBe('collection');
      expect(proposal.seasons).toHaveLength(1);
    });

    it('keeps a season it could not number, flagged for review', () => {
      const proposal = only(['disk1/South Park/Specials/Pilot.mp4']);
      expect(proposal.seasons[0]).toMatchObject({ number: null, needsReview: true });
    });

    it('sorts seasons by number, with an unnumbered one last', () => {
      const proposal = only([
        'disk1/Show/Specials/x.mp4',
        'disk1/Show/Season 02/b.mp4',
        'disk1/Show/Season 01/a.mp4',
      ]);

      expect(proposal.seasons.map((season) => season.folder)).toEqual([
        'Season 01',
        'Season 02',
        'Specials',
      ]);
    });
  });

  /**
   * A folder holding both loose videos and season folders is a series with
   * extras beside it — still one collection, and nothing gets dropped.
   */
  it('keeps videos that sit beside season folders in the same collection', () => {
    const proposal = only(['disk1/Show/Season 01/a.mp4', 'disk1/Show/trailer.mp4']);

    expect(proposal.kind).toBe('collection');
    expect(proposal.videos).toHaveLength(2);
    expect(proposal.videos.filter((video) => video.seasonFolder === null)).toHaveLength(1);
  });

  describe('what it refuses to consider', () => {
    it('ignores loose drive files — those are triage, not structure', () => {
      expect(propose(['night-films/Chinatown (1974).mp4'])).toEqual([]);
    });

    it('ignores root-level files and anything too deep', () => {
      expect(propose(['loose.mp4', 'disk1/A/B/C/d.mp4'])).toEqual([]);
    });

    it('ignores dotfiles, partials and unknown extensions', () => {
      expect(
        propose([
          'disk1/Film/.DS_Store',
          'disk1/Film/film.mp4.part',
          'disk1/Film/notes.txt',
          'disk1/.uploads/staged.mp4',
        ]),
      ).toEqual([]);
    });

    /**
     * Subtitles are bound to videos by the subtitle matcher, which runs per
     * folder. A folder holding only sidecars proposes nothing at all — it has
     * no video to be about.
     */
    it('ignores sidecars when deciding shape', () => {
      expect(propose(['disk1/Film/film_en_English.srt'])).toEqual([]);

      const proposal = only(['disk1/Film/film.mp4', 'disk1/Film/film_en_English.srt']);
      expect(proposal.kind).toBe('standalone');
      expect(proposal.videos).toHaveLength(1);
    });
  });

  describe('several folders at once', () => {
    const proposals = propose([
      'videos1/Avatar/Avatar.mp4',
      'videos1/Avatar/Avatar The Way Of Water.mp4',
      'videos1/10 Cloverfield Lane/10 Cloverfield Lane.mp4',
      'videos/Chernobyl/Season 01/Chernobyl - Aflevering 1.mp4',
      'night-films/Chinatown (1974).mp4',
    ]);

    it('proposes one per item folder, and nothing for the loose file', () => {
      expect(proposals).toHaveLength(3);
    });

    it('decides each folder on its own contents', () => {
      const byFolder = new Map(proposals.map((proposal) => [proposal.folderKey, proposal.kind]));

      expect(byFolder.get('videos1/Avatar')).toBe('collection');
      expect(byFolder.get('videos1/10 Cloverfield Lane')).toBe('standalone');
      expect(byFolder.get('videos/Chernobyl')).toBe('collection');
    });

    /**
     * Two folders with the same name on different drives are two different
     * things. Keying on the folder name alone would merge a show on one disk
     * into a film on another.
     */
    it('keeps folders of the same name on different drives apart', () => {
      const proposals = propose(['disk1/Avatar/a.mp4', 'disk2/Avatar/b.mp4']);

      expect(proposals).toHaveLength(2);
      expect(proposals.map((proposal) => proposal.folderKey)).toEqual([
        'disk1/Avatar',
        'disk2/Avatar',
      ]);
    });
  });

  /**
   * Reconcile applies these in order and an admin reads them in a list. A
   * proposal set that reshuffles between identical scans reads as a bug, so the
   * order is total: folder key, then season, then order index, then storage key.
   */
  describe('ordering is deterministic', () => {
    it('sorts proposals by folder key', () => {
      const proposals = propose(['b-disk/Film/f.mp4', 'a-disk/Film/f.mp4']);
      expect(proposals.map((proposal) => proposal.folderKey)).toEqual([
        'a-disk/Film',
        'b-disk/Film',
      ]);
    });

    it('sorts videos by season, then order index, then key', () => {
      const proposal = only([
        'disk1/Show/Season 02/01 - b.mp4',
        'disk1/Show/Season 01/02 - second.mp4',
        'disk1/Show/Season 01/01 - first.mp4',
      ]);

      expect(proposal.videos.map((video) => video.storageKey)).toEqual([
        'disk1/Show/Season 01/01 - first.mp4',
        'disk1/Show/Season 01/02 - second.mp4',
        'disk1/Show/Season 02/01 - b.mp4',
      ]);
    });

    // "ingest could not tell", not "episode zero" — the same rule nextEpisode uses.
    it('sorts a video with no order index last within its season', () => {
      const proposal = only([
        'disk1/Show/Season 01/Bonus Feature.mp4',
        'disk1/Show/Season 01/01 - first.mp4',
      ]);

      expect(proposal.videos.map((video) => video.orderIndex)).toEqual([1, null]);
    });

    it('gives the same answer whatever order the scan found the files in', () => {
      const paths = [
        'disk1/Show/Season 01/01 - a.mp4',
        'disk1/Show/Season 01/02 - b.mp4',
        'disk1/Film/film.mp4',
      ];

      expect(propose(paths)).toEqual(propose([...paths].reverse()));
    });
  });
});
