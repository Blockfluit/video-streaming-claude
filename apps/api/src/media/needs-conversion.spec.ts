import { needsConversion, type ConversionSignals } from './needs-conversion';

const playable: ConversionSignals = {
  extension: 'mp4',
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
  videoProfile: 'High',
};

const reasonsFor = (overrides: Partial<ConversionSignals>): string[] =>
  needsConversion({ ...playable, ...overrides }).reasons;

describe('needsConversion', () => {
  it('leaves a browser-ready file alone', () => {
    expect(needsConversion(playable)).toEqual({ needed: false, reasons: [] });
  });

  it('leaves webm alone', () => {
    expect(
      needsConversion({ ...playable, extension: 'webm', videoCodec: 'vp9', audioCodec: 'opus' }),
    ).toMatchObject({ needed: false });
  });

  describe('containers', () => {
    it.each(['mkv', 'avi', 'wmv', 'flv', 'mpg', 'ts', 'm2ts', 'vob'])(
      'flags .%s whatever is inside it',
      (extension) => {
        expect(needsConversion({ ...playable, extension })).toMatchObject({ needed: true });
        expect(reasonsFor({ extension })).toContain('container');
      },
    );

    it('does not care about the case of the extension', () => {
      expect(needsConversion({ ...playable, extension: 'MKV' })).toMatchObject({ needed: true });
    });
  });

  describe('video codecs', () => {
    it.each(['h264', 'vp8', 'vp9', 'av1'])('accepts %s', (videoCodec) => {
      expect(reasonsFor({ videoCodec })).not.toContain('video-codec');
    });

    // The case the whole feature exists for: an MKV with H.265 plays on almost
    // nothing, and <video> shows a black box with no useful error.
    it.each(['hevc', 'h265', 'mpeg4', 'mpeg2video', 'vc1', 'theora'])(
      'flags %s',
      (videoCodec) => {
        expect(reasonsFor({ videoCodec })).toContain('video-codec');
      },
    );
  });

  describe('audio codecs', () => {
    it.each(['aac', 'mp3', 'opus', 'vorbis'])('accepts %s', (audioCodec) => {
      expect(reasonsFor({ audioCodec })).not.toContain('audio-codec');
    });

    it.each(['ac3', 'eac3', 'dts', 'truehd', 'flac', 'pcm_s16le'])('flags %s', (audioCodec) => {
      expect(reasonsFor({ audioCodec })).toContain('audio-codec');
    });
  });

  describe('pixel format', () => {
    // Exactly what -pix_fmt yuv420p fixes. 10-bit has no universal hardware
    // decode support, so it plays as a black screen on plenty of devices.
    it.each(['yuv420p10le', 'yuv422p10le', 'yuv444p10le', 'p010le'])('flags %s', (pixelFormat) => {
      expect(reasonsFor({ pixelFormat })).toContain('pixel-format');
    });

    it('accepts 8-bit 4:2:0', () => {
      expect(reasonsFor({ pixelFormat: 'yuv420p' })).not.toContain('pixel-format');
    });
  });

  describe('H.264 profile', () => {
    it.each(['Baseline', 'Main', 'High', 'Constrained Baseline'])('accepts %s', (videoProfile) => {
      expect(reasonsFor({ videoProfile })).not.toContain('profile');
    });

    it.each(['High 10', 'High 4:2:2', 'High 4:4:4 Predictive'])('flags %s', (videoProfile) => {
      expect(reasonsFor({ videoProfile })).toContain('profile');
    });

    // A profile only means these things for H.264; VP9 and AV1 name their
    // profiles with numbers that would otherwise trip the check.
    it('ignores the profile of a codec that is not h264', () => {
      expect(reasonsFor({ videoCodec: 'vp9', videoProfile: 'Profile 2' })).not.toContain('profile');
    });
  });

  describe('unknown values', () => {
    /**
     * A failed probe leaves these null. Flagging for conversion would queue CPU
     * work on a guess; not flagging leaves a possibly-unplayable file alone.
     * The second is the cheaper mistake — the admin sees the probe error and
     * can convert by hand.
     */
    it('does not flag a video it could not probe', () => {
      expect(
        needsConversion({
          extension: 'mp4',
          videoCodec: null,
          audioCodec: null,
          pixelFormat: null,
          videoProfile: null,
        }),
      ).toMatchObject({ needed: false });
    });

    // The container is knowable without probing, so it still counts.
    it('still flags an unprobed file in a bad container', () => {
      expect(
        needsConversion({
          extension: 'mkv',
          videoCodec: null,
          audioCodec: null,
          pixelFormat: null,
          videoProfile: null,
        }),
      ).toMatchObject({ needed: true, reasons: ['container'] });
    });
  });

  it('reports every reason, so the UI can say why', () => {
    const result = needsConversion({
      extension: 'mkv',
      videoCodec: 'hevc',
      audioCodec: 'dts',
      pixelFormat: 'yuv420p10le',
      videoProfile: 'Main 10',
    });

    expect(result.needed).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(['container', 'video-codec', 'audio-codec', 'pixel-format']),
    );
  });
});
