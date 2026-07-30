/**
 * Turning an ffmpeg failure into something an admin can act on.
 *
 * `execFile`'s own error reads `Command failed: ffprobe -v error -show_streams
 * … /srv/library/media/Show/file.mkv` followed by the actual diagnosis. That
 * message is what ends up in `probeError`, which is displayed and capped at
 * 1000 characters — so the useful part gets pushed out by a command line the
 * reader cannot do anything with, and the server's absolute paths get shown
 * along the way.
 *
 * This is the one job a maintained ffmpeg wrapper would have done for us. The
 * only widely-used one (`fluent-ffmpeg`) is deprecated, so it is done here.
 */

/** Trailing lines carry the diagnosis; anything earlier is banner and configure flags. */
const KEEP_LINES = 4;
const MAX_LENGTH = 500;

/** `[mov,mp4,m4a @ 0x55b915868280] ` — the address differs per run, so it must not reach a report. */
const DECODER_TAG = /^\[[^\]]*@\s*0x[0-9a-f]+\]\s*/i;

/**
 * ffmpeg's own banner, which is never the reason something failed.
 *
 * Matched against the **trimmed** line — ffmpeg indents these, but the
 * indentation is gone by the time this runs.
 */
const NOISE = /^(?:ffmpeg|ffprobe) version |^built with |^configuration: |^lib[a-z]+\s+\d/;

/**
 * An absolute path in ffmpeg's own output, reduced to its filename.
 *
 * `/srv/library/media/Show/ep.mkv: Invalid data` becomes `ep.mkv: Invalid
 * data`. The admin recognises the filename; the deployment layout tells them
 * nothing and does not belong in a field the UI renders.
 */
const ABSOLUTE_PATH = /\/(?:[^\s/:]+\/)+([^\s/:]+)/g;

export function summariseStderr(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NOISE.test(line))
    .map((line) => line.replace(DECODER_TAG, '').replace(ABSOLUTE_PATH, '$1'));

  if (lines.length === 0) return 'no output';

  return lines.slice(-KEEP_LINES).join('; ').slice(0, MAX_LENGTH);
}

export class FfmpegError extends Error {
  constructor(
    readonly tool: 'ffmpeg' | 'ffprobe',
    readonly exitCode: number | null,
    /** Kept whole for the log, even though the message is a summary. */
    readonly stderr: string,
  ) {
    super(`${tool} failed: ${summariseStderr(stderr)}`);
    this.name = 'FfmpegError';
  }
}
