import { FfmpegError, summariseStderr } from './ffmpeg-error';

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
});
