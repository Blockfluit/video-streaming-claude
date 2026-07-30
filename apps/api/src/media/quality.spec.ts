import { qualityLabel } from '@video/shared';

/**
 * The rule that is easy to get wrong: each tier checks **width or height**,
 * never height alone. A 1080p film in 2.39:1 is 1920×800, and testing only the
 * height would hide the badge on most actual movies.
 */
describe('qualityLabel', () => {
  describe('the tiers', () => {
    it('labels 8K', () => {
      expect(qualityLabel(7680, 4320)).toBe('8K');
    });

    it('labels 4K', () => {
      expect(qualityLabel(3840, 2160)).toBe('4K');
    });

    it('labels QHD', () => {
      expect(qualityLabel(2560, 1440)).toBe('QHD');
    });

    it('labels HD', () => {
      expect(qualityLabel(1920, 1080)).toBe('HD');
    });
  });

  describe('letterboxed film, which is the whole point', () => {
    // 2.39:1 — the shape most cinema releases actually are.
    it('labels a 1920×800 film HD', () => {
      expect(qualityLabel(1920, 800)).toBe('HD');
    });

    it('labels a 3840×1600 film 4K', () => {
      expect(qualityLabel(3840, 1600)).toBe('4K');
    });

    it('labels a 2560×1080 ultrawide QHD', () => {
      expect(qualityLabel(2560, 1080)).toBe('QHD');
    });
  });

  // Checking either dimension also gets phone video right, where the large
  // number is the height.
  it('handles portrait video', () => {
    expect(qualityLabel(1080, 1920)).toBe('HD');
    expect(qualityLabel(2160, 3840)).toBe('4K');
  });

  describe('below 1080p', () => {
    // Never "SD" or "480p" — the badge is for calling out quality, and calling
    // out its absence just adds noise to every card.
    it('renders nothing rather than a lesser badge', () => {
      expect(qualityLabel(1280, 720)).toBeNull();
      expect(qualityLabel(854, 480)).toBeNull();
      expect(qualityLabel(640, 360)).toBeNull();
    });

    it('is null just below the HD threshold', () => {
      expect(qualityLabel(1919, 1079)).toBeNull();
    });
  });

  describe('boundaries', () => {
    it('includes the threshold itself at every tier', () => {
      expect(qualityLabel(1920, 0)).toBe('HD');
      expect(qualityLabel(0, 1080)).toBe('HD');
      expect(qualityLabel(2560, 0)).toBe('QHD');
      expect(qualityLabel(3840, 0)).toBe('4K');
      expect(qualityLabel(7680, 0)).toBe('8K');
    });

    it('takes the highest tier either dimension earns', () => {
      // A very wide but short frame is still judged on its width.
      expect(qualityLabel(3840, 800)).toBe('4K');
    });
  });

  describe('missing dimensions', () => {
    // An unprobed or failed video has no dimensions, and must not render a badge.
    it('is null when either dimension is unknown', () => {
      expect(qualityLabel(null, null)).toBeNull();
      expect(qualityLabel(1920, null)).toBe('HD');
      expect(qualityLabel(null, 1080)).toBe('HD');
    });

    it('is null for nonsense', () => {
      expect(qualityLabel(0, 0)).toBeNull();
      expect(qualityLabel(-1, -1)).toBeNull();
    });
  });
});
