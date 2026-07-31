import { MAX_BEAT_SECONDS, applyBeat, type ProgressState } from './progress';

const fresh: ProgressState = {
  lastPositionSec: 0,
  maxPositionSec: 0,
  secondsWatched: 0,
  viewCount: 0,
  completed: false,
};

/** A 600-second video, so the completion threshold sits at 540. */
const beat = (
  positionSec: number,
  deltaSec: number,
  existing: ProgressState | null = fresh,
  options: { durationSec?: number | null; isNewPlaySession?: boolean } = {},
): ProgressState =>
  applyBeat(existing, { positionSec, deltaSec }, {
    durationSec: options.durationSec === undefined ? 600 : options.durationSec,
    isNewPlaySession: options.isNewPlaySession ?? false,
  });

describe('applyBeat', () => {
  describe('the first beat of a video nobody has watched', () => {
    it('starts from zero rather than needing a row to exist first', () => {
      expect(beat(10, 10, null, { isNewPlaySession: true })).toEqual({
        lastPositionSec: 10,
        maxPositionSec: 10,
        secondsWatched: 10,
        viewCount: 1,
        completed: false,
      });
    });
  });

  describe('position', () => {
    it('follows the playhead forwards', () => {
      expect(beat(120, 10).lastPositionSec).toBe(120);
    });

    /**
     * `lastPositionSec` is where the viewer *is*, so it goes backwards when they
     * seek backwards — that is what resume has to restore. `maxPositionSec` is
     * how far they ever got, and is what completion is judged on.
     */
    it('follows the playhead backwards, unlike the high-water mark', () => {
      const after = beat(30, 5, { ...fresh, lastPositionSec: 200, maxPositionSec: 200 });

      expect(after.lastPositionSec).toBe(30);
      expect(after.maxPositionSec).toBe(200);
    });

    /**
     * Browsers report a `currentTime` a hair past `duration` at the end of
     * playback, and a container's declared duration is not always exact. Storing
     * it verbatim would offer a resume that seeks past the end.
     */
    it('clamps a position past the end of the video', () => {
      expect(beat(600.4, 1).lastPositionSec).toBe(600);
      expect(beat(600.4, 1).maxPositionSec).toBe(600);
    });

    it('leaves the position alone when the duration is unknown', () => {
      expect(beat(9000, 1, fresh, { durationSec: null }).lastPositionSec).toBe(9000);
    });
  });

  describe('accumulated time', () => {
    it('adds the beat to what was already watched', () => {
      expect(beat(120, 10, { ...fresh, secondsWatched: 55 }).secondsWatched).toBe(65);
    });

    /**
     * The cap is against a *buggy* client — a delta computed from a bad
     * subtraction, or a timer that fired in a loop. Beats arrive every 10s, so
     * anything past 30 already means beats were missed.
     */
    it('caps a single beat, so one bad delta cannot rewrite the total', () => {
      expect(beat(120, 40_000).secondsWatched).toBe(MAX_BEAT_SECONDS);
    });

    /**
     * Capping rather than rejecting: a client that missed two beats still has a
     * real position to record, and refusing the whole beat would throw away the
     * viewer's resume point along with the excess seconds.
     */
    it('still records the position from a beat whose delta was capped', () => {
      expect(beat(120, 40_000).lastPositionSec).toBe(120);
    });

    it('accepts a beat that carries no watched time, such as a pause', () => {
      expect(beat(120, 0, { ...fresh, secondsWatched: 55 })).toMatchObject({
        secondsWatched: 55,
        lastPositionSec: 120,
      });
    });
  });

  describe('view count', () => {
    // One page load is one view, however many beats it sends.
    it('counts a new play session once', () => {
      const first = beat(10, 10, fresh, { isNewPlaySession: true });
      const second = beat(20, 10, first, { isNewPlaySession: false });
      const third = beat(30, 10, second, { isNewPlaySession: false });

      expect(third.viewCount).toBe(1);
    });

    it('counts a second play session separately', () => {
      const after = beat(10, 10, { ...fresh, viewCount: 1 }, { isNewPlaySession: true });

      expect(after.viewCount).toBe(2);
    });
  });

  describe('completion', () => {
    it('is not complete before 90% of the video', () => {
      expect(beat(539, 10).completed).toBe(false);
    });

    // 90% rather than 100%: nobody sits through the credits.
    it('is complete at 90%', () => {
      expect(beat(540, 10).completed).toBe(true);
    });

    /**
     * Judged on the high-water mark, so seeking back to the start to rewatch a
     * scene does not un-finish a video.
     */
    it('stays complete after seeking backwards', () => {
      const finished = beat(600, 10);
      const rewound = beat(5, 10, finished);

      expect(rewound.completed).toBe(true);
    });

    it('leaves the flag alone when the duration is unknown', () => {
      expect(beat(9000, 10, { ...fresh, completed: true }, { durationSec: null }).completed).toBe(
        true,
      );
      expect(beat(9000, 10, fresh, { durationSec: null }).completed).toBe(false);
    });

    // A failed probe writes 0, which would otherwise make every video complete.
    it('is never complete on a zero duration', () => {
      expect(beat(0, 10, fresh, { durationSec: 0 }).completed).toBe(false);
    });
  });
});
