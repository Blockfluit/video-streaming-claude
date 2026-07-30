import { classifySubtitleStreams } from './subtitle-streams';

const stream = (overrides: Record<string, unknown> = {}) => ({
  index: 2,
  codec_type: 'subtitle',
  codec_name: 'subrip',
  tags: { language: 'eng', title: 'English' },
  disposition: { default: 0, forced: 0 },
  ...overrides,
});

describe('classifySubtitleStreams', () => {
  it('takes text-based tracks', () => {
    const { extractable } = classifySubtitleStreams([stream()]);

    expect(extractable).toEqual([
      expect.objectContaining({ index: 2, language: 'eng', label: 'English' }),
    ]);
  });

  it.each(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'])('accepts %s', (codec_name) => {
    expect(classifySubtitleStreams([stream({ codec_name })]).extractable).toHaveLength(1);
  });

  /**
   * Bitmap subtitles are *images*. Turning them into WebVTT needs OCR, which is
   * out of scope — so they are skipped and reported, never silently dropped and
   * never allowed to fail the job.
   */
  it.each(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'])(
    'skips %s rather than failing',
    (codec_name) => {
      const result = classifySubtitleStreams([stream({ codec_name })]);

      expect(result.extractable).toHaveLength(0);
      expect(result.skipped).toEqual([expect.objectContaining({ codec: codec_name })]);
    },
  );

  it('reports both kinds from one file', () => {
    const result = classifySubtitleStreams([
      stream({ index: 2, codec_name: 'subrip' }),
      stream({ index: 3, codec_name: 'hdmv_pgs_subtitle' }),
      stream({ index: 4, codec_name: 'ass' }),
    ]);

    expect(result.extractable).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
  });

  it('ignores streams that are not subtitles', () => {
    const result = classifySubtitleStreams([
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      stream({ index: 2 }),
    ]);

    expect(result.extractable).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  describe('naming', () => {
    it('uses the track title when there is one', () => {
      const [track] = classifySubtitleStreams([
        stream({ tags: { language: 'nld', title: 'Nederlands (SDH)' } }),
      ]).extractable;

      expect(track.label).toBe('Nederlands (SDH)');
    });

    // A label is what the viewer picks from, so "Track 3" beats nothing at all.
    it('falls back to the language name, then to the index', () => {
      expect(
        classifySubtitleStreams([stream({ index: 3, tags: { language: 'nld' } })]).extractable[0]
          .label,
      ).toBe('Dutch');

      expect(
        classifySubtitleStreams([stream({ index: 3, tags: {} })]).extractable[0].label,
      ).toBe('Track 3');
    });

    it('defaults an unlabelled language to und, as Matroska does', () => {
      expect(classifySubtitleStreams([stream({ tags: {} })]).extractable[0].language).toBe('und');
    });

    it('survives a stream with no tags at all', () => {
      expect(
        classifySubtitleStreams([{ index: 2, codec_type: 'subtitle', codec_name: 'subrip' }])
          .extractable,
      ).toHaveLength(1);
    });
  });

  // The track flagged default in the container should be the one that is
  // default in the player.
  it('carries the default disposition through', () => {
    const [track] = classifySubtitleStreams([
      stream({ disposition: { default: 1, forced: 0 } }),
    ]).extractable;

    expect(track.isDefault).toBe(true);
  });

  it('handles a file with no subtitles', () => {
    expect(classifySubtitleStreams([])).toEqual({ extractable: [], skipped: [] });
  });
});
