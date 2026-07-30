import { FfmpegError, parseStructuredError, summariseStderr } from './ffmpeg-error';

describe('summariseStderr', () => {
  /**
   * ffmpeg says the useful thing last. Everything before it is banners,
   * configure flags and stream dumps — noise in an admin-facing field that is
   * truncated to 1000 characters.
   */
  it('keeps the diagnosis, not the preamble', () => {
    const stderr = [
      'ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers',
      '  built with gcc 13 (Ubuntu 13.2.0)',
      '  configuration: --prefix=/usr --extra-version=3ubuntu5 --toolchain=hardened',
      '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55b915868280] moov atom not found',
      'input.mp4: Invalid data found when processing input',
    ].join('\n');

    const summary = summariseStderr(stderr);

    expect(summary).toContain('moov atom not found');
    expect(summary).toContain('Invalid data found');
    expect(summary).not.toContain('configuration:');
    expect(summary).not.toContain('built with');
  });

  // The memory address in a decoder tag is different on every run, which would
  // make two reports of the same fault look like two different faults.
  it('drops the decoder context address', () => {
    expect(summariseStderr('[mov,mp4 @ 0x55b915868280] moov atom not found')).toBe(
      'moov atom not found',
    );
  });

  /**
   * ffmpeg echoes the path it was given. The admin recognises the filename; the
   * server's directory layout tells them nothing and does not belong in a field
   * the UI renders.
   */
  it('reduces an absolute path to its filename', () => {
    expect(summariseStderr('/srv/library/media/Show/ep.mkv: Invalid data found')).toBe(
      'ep.mkv: Invalid data found',
    );
  });

  it('leaves text that merely contains a slash alone', () => {
    expect(summariseStderr('bitrate 1000 kb/s is too low')).toBe('bitrate 1000 kb/s is too low');
  });

  it('joins several complaints readably', () => {
    expect(summariseStderr('first problem\nsecond problem')).toBe('first problem; second problem');
  });

  it('ignores blank lines', () => {
    expect(summariseStderr('\n\nreal problem\n\n')).toBe('real problem');
  });

  it('bounds the length, since this is stored and displayed', () => {
    const summary = summariseStderr(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));

    expect(summary.length).toBeLessThanOrEqual(500);
    // The last lines are the ones that matter, so they are what survives.
    expect(summary).toContain('line 199');
  });

  it('says something rather than nothing when stderr is empty', () => {
    expect(summariseStderr('')).toBe('no output');
    expect(summariseStderr('   \n  ')).toBe('no output');
  });
});

/**
 * ffprobe can report its failure as JSON on stdout (`-show_error -of json`),
 * which beats reading stderr: it is a stable contract, and it arrives without
 * the banner, the per-run decoder address or the absolute path.
 */
describe('parseStructuredError', () => {
  const failure = JSON.stringify({
    error: { code: -1094995529, string: 'Invalid data found when processing input' },
  });

  it('reads the message ffprobe reports', () => {
    expect(parseStructuredError(failure)).toBe('Invalid data found when processing input');
  });

  // A successful probe has no `error` key at all, so this must not invent one.
  it('is null for a successful probe', () => {
    expect(parseStructuredError(JSON.stringify({ streams: [], format: {} }))).toBeNull();
  });

  it('is null for output that is not JSON', () => {
    expect(parseStructuredError('')).toBeNull();
    expect(parseStructuredError('not json at all')).toBeNull();
    expect(parseStructuredError('{"error": {"string": "trunca')).toBeNull();
  });

  it('is null for an empty message', () => {
    expect(parseStructuredError(JSON.stringify({ error: { string: '  ' } }))).toBeNull();
  });
});

describe('FfmpegError', () => {
  it('reads as the tool plus what it complained about', () => {
    const error = new FfmpegError('ffprobe', 1, '[mov @ 0x1] moov atom not found');

    expect(error.message).toBe('ffprobe failed: moov atom not found');
    expect(error.name).toBe('FfmpegError');
  });

  // The full command line includes absolute server paths and adds nothing an
  // admin can act on.
  it('does not carry the command line', () => {
    const error = new FfmpegError('ffmpeg', 1, 'Invalid data found');

    expect(error.message).not.toContain('/');
    expect(error.message).not.toContain('-i');
  });

  it('keeps the exit code and raw stderr for the log', () => {
    const error = new FfmpegError('ffmpeg', 69, 'raw output here');

    expect(error.exitCode).toBe(69);
    expect(error.stderr).toBe('raw output here');
  });

  describe('when ffprobe reported a structured error', () => {
    const structured = JSON.stringify({ error: { string: 'Invalid data found' } });

    it('leads with the structured message', () => {
      const error = new FfmpegError('ffprobe', 1, '', structured);

      expect(error.message).toBe('ffprobe failed: Invalid data found');
    });

    /**
     * stderr is often the more specific of the two — "moov atom not found"
     * says what is actually wrong, where the structured message only says the
     * input was invalid. Both are worth keeping.
     */
    it('appends the more specific stderr detail', () => {
      const error = new FfmpegError('ffprobe', 1, '[mov @ 0x1] moov atom not found', structured);

      expect(error.message).toBe('ffprobe failed: Invalid data found (moov atom not found)');
    });

    it('does not repeat itself when stderr says the same thing', () => {
      const error = new FfmpegError('ffprobe', 1, 'Invalid data found', structured);

      expect(error.message).toBe('ffprobe failed: Invalid data found');
    });

    /**
     * The real shape from ffprobe 6.1 on a truncated download. stderr repeats
     * the structured message *and* adds the specific cause, so the duplicate
     * has to go without taking the useful half with it.
     */
    it('keeps the specific cause when stderr both repeats and adds', () => {
      const error = new FfmpegError(
        'ffprobe',
        1,
        '[mov,mp4 @ 0x55b9] moov atom not found\n/srv/media/x.mp4: Invalid data found when processing input',
        JSON.stringify({ error: { string: 'Invalid data found when processing input' } }),
      );

      expect(error.message).toBe(
        'ffprobe failed: Invalid data found when processing input (moov atom not found)',
      );
    });

    it('falls back to stderr when there is no structured error', () => {
      const error = new FfmpegError('ffmpeg', 1, 'Encoder not found', '');

      expect(error.message).toBe('ffmpeg failed: Encoder not found');
    });
  });
});
