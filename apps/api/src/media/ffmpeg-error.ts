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

/**
 * ffprobe's own structured error, from `-show_error -of json`.
 *
 * Far better than reading stderr: it is a stable contract, and it arrives
 * already free of the banner, the per-run decoder address and the absolute
 * path. `-show_error` adds nothing to a successful probe, so it costs nothing
 * to always ask for it.
 *
 * The encoder has no equivalent — ffmpeg offers only text loglevels — so
 * `summariseStderr` remains the fallback for conversions, and for the failures
 * that produce no output at all.
 */
export function parseStructuredError(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { error?: { string?: string } };
    const message = parsed.error?.string?.trim();
    return message && message.length > 0 ? message : null;
  } catch {
    // Not JSON at all, or truncated. The stderr summary still applies.
    return null;
  }
}

/**
 * Combines ffprobe's structured message with whatever stderr adds.
 *
 * They overlap but neither contains the other: the structured error says
 * *Invalid data found when processing input*, while stderr says *moov atom not
 * found* — which is the part that actually tells you the file is a truncated
 * download. So the shared line is dropped and the rest is kept.
 */
function buildMessage(structured: string | null, detail: string): string {
  if (structured === null) return detail;
  if (detail === 'no output') return structured;

  const extra = detail
    .split('; ')
    .filter((part) => !part.includes(structured) && !structured.includes(part))
    .join('; ');

  return extra.length > 0 ? `${structured} (${extra})` : structured;
}

export class FfmpegError extends Error {
  constructor(
    readonly tool: 'ffmpeg' | 'ffprobe',
    readonly exitCode: number | null,
    /** Kept whole for the log, even though the message is a summary. */
    readonly stderr: string,
    /** ffprobe's `-show_error` JSON, when there was any. */
    readonly stdout = '',
  ) {
    super(`${tool} failed: ${buildMessage(parseStructuredError(stdout), summariseStderr(stderr))}`);
    this.name = 'FfmpegError';
  }
}

/**
 * ffmpeg ran, exited 0, and produced no frame.
 *
 * Its own kind because it is not a failure of the process — nothing crashed and
 * there is no stderr worth summarising. It means the seek landed somewhere the
 * file has nothing at: past the end, or past the bytes written so far while a
 * copy is still in flight. Named so the capture endpoint can answer with the
 * reason instead of a 500 the admin cannot act on.
 */
export class NoFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoFrameError';
  }
}
