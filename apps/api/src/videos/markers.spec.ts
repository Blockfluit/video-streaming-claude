import { validateMarkers, type Markers } from './markers';

const none: Markers = {
  introStartSec: null,
  introEndSec: null,
  outroStartSec: null,
  outroEndSec: null,
};

const fieldsIn = (markers: Partial<Markers>, durationSec: number | null = 600): string[] =>
  validateMarkers({ ...none, ...markers }, durationSec).map((issue) => issue.field);

describe('validateMarkers', () => {
  it('accepts a video with no markers at all', () => {
    expect(validateMarkers(none, 600)).toEqual([]);
  });

  it('accepts a complete intro and outro', () => {
    expect(
      fieldsIn({ introStartSec: 5, introEndSec: 65, outroStartSec: 540, outroEndSec: 600 }),
    ).toEqual([]);
  });

  // "A video may define an intro and no outro."
  it('accepts one range without the other', () => {
    expect(fieldsIn({ introStartSec: 5, introEndSec: 65 })).toEqual([]);
    expect(fieldsIn({ outroStartSec: 540, outroEndSec: 600 })).toEqual([]);
  });

  /**
   * Half a range is a legitimate intermediate state: the editor sets markers by
   * scrubbing to a position and clicking "Set intro start", so a start exists
   * before its end does. The player simply ignores a range it cannot use.
   */
  it('accepts half a range, which is what the editor produces mid-edit', () => {
    expect(fieldsIn({ introStartSec: 5 })).toEqual([]);
    expect(fieldsIn({ introEndSec: 65 })).toEqual([]);
    expect(fieldsIn({ outroStartSec: 540 })).toEqual([]);
  });

  describe('ordering', () => {
    it('rejects an end before its start', () => {
      expect(fieldsIn({ introStartSec: 65, introEndSec: 5 })).toEqual(['introEndSec']);
      expect(fieldsIn({ outroStartSec: 600, outroEndSec: 540 })).toEqual(['outroEndSec']);
    });

    // A zero-length range would show a button that seeks nowhere.
    it('rejects an end equal to its start', () => {
      expect(fieldsIn({ introStartSec: 30, introEndSec: 30 })).toEqual(['introEndSec']);
    });

    it('only checks a pair once both ends are set', () => {
      expect(fieldsIn({ introStartSec: 65 })).toEqual([]);
    });

    it('checks the two ranges independently', () => {
      expect(
        fieldsIn({ introStartSec: 65, introEndSec: 5, outroStartSec: 600, outroEndSec: 540 }),
      ).toEqual(['introEndSec', 'outroEndSec']);
    });
  });

  describe('against the duration', () => {
    it('accepts a marker exactly at the end', () => {
      expect(fieldsIn({ outroStartSec: 540, outroEndSec: 600 }, 600)).toEqual([]);
    });

    it('rejects a marker past the end', () => {
      expect(fieldsIn({ outroEndSec: 601 }, 600)).toEqual(['outroEndSec']);
      expect(fieldsIn({ introStartSec: 700 }, 600)).toEqual(['introStartSec']);
    });

    /**
     * An unprobed video has no duration to check against. Refusing markers
     * entirely would mean a probe failure also blocks curation, so the ordering
     * rules still apply and the upper bound simply does not.
     */
    it('skips the bound when the duration is unknown', () => {
      expect(fieldsIn({ outroEndSec: 99999 }, null)).toEqual([]);
      // Ordering is still enforced.
      expect(fieldsIn({ introStartSec: 65, introEndSec: 5 }, null)).toEqual(['introEndSec']);
    });
  });

  describe('values that are not times', () => {
    it('rejects a negative marker', () => {
      expect(fieldsIn({ introStartSec: -1 })).toEqual(['introStartSec']);
    });

    it('accepts zero, which is a real position', () => {
      expect(fieldsIn({ introStartSec: 0, introEndSec: 30 })).toEqual([]);
    });

    it('rejects a value that is not finite', () => {
      expect(fieldsIn({ introStartSec: Number.NaN })).toEqual(['introStartSec']);
      expect(fieldsIn({ introEndSec: Number.POSITIVE_INFINITY })).toEqual(['introEndSec']);
    });
  });

  it('explains itself, since the message reaches the editor', () => {
    const [issue] = validateMarkers({ ...none, introStartSec: 65, introEndSec: 5 }, 600);

    expect(issue.message).toMatch(/after/i);
  });
});
