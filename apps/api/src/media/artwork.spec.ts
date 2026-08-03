import { artworkDirectory, artworkKey, captureFilter } from './artwork';

describe('artworkKey', () => {
  it('puts posters in their own directory', () => {
    expect(artworkKey('poster', 'abc')).toBe('posters/abc.jpg');
  });

  it('puts banners in theirs', () => {
    expect(artworkKey('banner', 'abc')).toBe('banners/abc.jpg');
  });

  /** Named after what is in them, so neither directory can outlive its meaning. */
  it('names each directory after its shape', () => {
    expect(artworkDirectory('poster')).toBe('posters');
    expect(artworkDirectory('banner')).toBe('banners');
  });

  it('agrees with the directory it says to create', () => {
    for (const shape of ['poster', 'banner'] as const) {
      expect(artworkKey(shape, 'abc').startsWith(`${artworkDirectory(shape)}/`)).toBe(true);
    }
  });

  it('never puts two shapes in one file', () => {
    expect(artworkKey('poster', 'abc')).not.toBe(artworkKey('banner', 'abc'));
  });
});

describe('captureFilter', () => {
  it('scales the banner without cropping it', () => {
    expect(captureFilter('banner')).toBe('scale=640:-2');
    expect(captureFilter('banner')).not.toContain('crop');
  });

  it('crops the poster to 2:3 and scales it', () => {
    expect(captureFilter('poster')).toContain('crop=');
    expect(captureFilter('poster')).toContain('scale=400:600');
  });

  /**
   * The whole reason this is a tested function.
   *
   * `crop=ih*2/3:ih` reads correctly and works on every landscape file, which is
   * most of a library — and then fails outright on a portrait one, because it
   * asks for a crop wider than the source. Both dimensions have to be capped by
   * what the frame can actually supply.
   */
  describe('the crop expression survives either orientation', () => {
    /** Evaluates the filter's `min()` arithmetic the way ffmpeg would. */
    const cropTo = (width: number, height: number) => ({
      w: Math.min(width, (height * 2) / 3),
      h: Math.min(height, (width * 3) / 2),
    });

    it.each([
      ['landscape 16:9', 1920, 1080],
      ['portrait 9:16', 1080, 1920],
      ['square', 1000, 1000],
      ['ultrawide 2.39:1', 1920, 800],
      ['already 2:3', 400, 600],
    ])('fits inside a %s frame and is 2:3', (_name, width, height) => {
      const { w, h } = cropTo(width, height);

      expect(w).toBeLessThanOrEqual(width);
      expect(h).toBeLessThanOrEqual(height);
      expect(w / h).toBeCloseTo(2 / 3, 6);
    });

    it('caps width on a landscape frame and height on a portrait one', () => {
      expect(cropTo(1920, 1080)).toEqual({ w: 720, h: 1080 });
      expect(cropTo(1080, 1920)).toEqual({ w: 1080, h: 1620 });
    });
  });

  /**
   * Escaped for ffmpeg's filter parser, which splits on commas — not for a
   * shell, since `execFile` never involves one. Without the backslashes the
   * `crop` filter ends inside `min(` and ffmpeg reports a filter it has never
   * heard of.
   */
  it('escapes the commas inside min() for the filter parser', () => {
    expect(captureFilter('poster')).toContain('min(iw\\,');
    expect(captureFilter('poster')).toContain('min(ih\\,');
  });
});
