import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { FfmpegError, NoFrameError } from './ffmpeg-error';

const execFileAsync = promisify(execFile);

/**
 * Runs one of the binaries, turning a failure into an `FfmpegError`.
 *
 * `execFile`'s own error message leads with the whole command line — absolute
 * server paths and all — and pushes the actual diagnosis past the point where
 * `probeError` gets truncated. This keeps what ffmpeg complained about and
 * drops what it was asked to do.
 */
async function run(
  tool: 'ffmpeg' | 'ffprobe',
  binary: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(binary, args, options);
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
      code?: number | string;
    };

    // A missing binary is a deployment problem, not a bad file — say so plainly
    // rather than reporting it as an unreadable video.
    if (error.code === 'ENOENT') {
      throw new Error(`${binary} is not installed or not on PATH`);
    }

    throw new FfmpegError(
      tool,
      typeof error.code === 'number' ? error.code : null,
      error.stderr ?? '',
      // ffprobe writes its `-show_error` JSON to stdout even when it exits
      // non-zero, and promisify attaches it to the rejection.
      error.stdout ?? '',
    );
  }
}

/**
 * The only place the ffmpeg binaries are invoked.
 *
 * `execFile`, never `exec` — arguments go straight to the process rather than
 * through a shell, so a filename containing `;` or `$(…)` is a filename and not
 * a command. Every path reaching here came off a disk scan or a database row,
 * both of which contain whatever someone named their file.
 */

export interface ProbeResult {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  videoProfile: string | null;
  pixelFormat: string | null;
  /** Surfaced so the UI can warn before a conversion drops the alternates. */
  audioTracks: number;
  subtitleTracks: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

/** Probing a file should never take this long; something has gone wrong if it does. */
const PROBE_TIMEOUT_MS = 60_000;
const THUMBNAIL_TIMEOUT_MS = 120_000;
/** Subtitles are small; anything slower than this has gone wrong. */
const SUBTITLE_TIMEOUT_MS = 60_000;

@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  constructor(private readonly config: ConfigService) {}

  private get ffprobe(): string {
    return this.config.get<string>('FFPROBE_PATH') ?? 'ffprobe';
  }

  private get ffmpeg(): string {
    return this.config.get<string>('FFMPEG_PATH') ?? 'ffmpeg';
  }

  /** True when both binaries answer, so a missing install is a clear message rather than a failed probe. */
  async isAvailable(): Promise<boolean> {
    try {
      await Promise.all([
        run('ffprobe', this.ffprobe, ['-version'], { timeout: 10_000 }),
        run('ffmpeg', this.ffmpeg, ['-version'], { timeout: 10_000 }),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async probe(path: string): Promise<ProbeResult> {
    const { stdout } = await run(
      'ffprobe',
      this.ffprobe,
      [
        '-v',
        'error',
        // Structured failures on stdout. Adds nothing to a successful probe,
        // and replaces reading stderr when something goes wrong.
        '-show_error',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        path,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );

    return parseProbe(stdout);
  }

  /**
   * The raw stream list, for callers that need more than the summary `probe`
   * returns — subtitle extraction has to know each track's index and codec.
   */
  async probeStreams(path: string): Promise<
    { index: number; codec_type?: string; codec_name?: string; tags?: Record<string, string>; disposition?: Record<string, number> }[]
  > {
    const { stdout } = await run(
      'ffprobe',
      this.ffprobe,
      ['-v', 'error', '-show_error', '-show_streams', '-of', 'json', path],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );

    return (JSON.parse(stdout) as { streams?: [] }).streams ?? [];
  }

  /**
   * Converts a subtitle file to WebVTT.
   *
   * Mandatory rather than a nicety: `<track>` accepts only WebVTT, so an
   * `.srt` sidecar is invisible to a browser until this runs.
   *
   * `charset` is passed when the source is not UTF-8. Legacy `.srt` files are
   * very often Windows-1252, and ffmpeg does not *fail* on those — it produces
   * mojibake, which nobody notices until a viewer reads a line.
   */
  async convertSubtitle(source: string, destination: string, charset?: string): Promise<void> {
    await run(
      'ffmpeg',
      this.ffmpeg,
      [
        '-hide_banner',
        '-y',
        ...(charset ? ['-sub_charenc', charset] : []),
        '-i',
        source,
        '-c:s',
        'webvtt',
        destination,
      ],
      { timeout: SUBTITLE_TIMEOUT_MS },
    );
  }

  /**
   * Grabs a single frame as a JPEG.
   *
   * `-ss` before `-i` seeks by keyframe index rather than decoding up to the
   * timestamp — the difference between instant and minutes on a long file.
   */
  async captureFrame(
    source: string,
    atSeconds: number,
    destination: string,
    /**
     * Output width; the height follows the aspect ratio.
     *
     * Defaults to what a card needs, which is what every existing caller wants.
     * A hero asks for 1920 — a 640px frame stretched across a full-bleed
     * backdrop is visibly soft, and scaling up in the browser cannot put back
     * detail ffmpeg never wrote.
     */
    width = 640,
  ): Promise<void> {
    await run(
      'ffmpeg',
      this.ffmpeg,
      [
        '-hide_banner',
        '-y',
        '-ss',
        String(Math.max(0, atSeconds)),
        '-i',
        source,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        // Even width and height: some JPEG encoders reject odd dimensions.
        '-vf',
        `scale=${width}:-2`,
        destination,
      ],
      { timeout: THUMBNAIL_TIMEOUT_MS },
    );

    /*
     * ffmpeg exits **0** when `-ss` lands past the end of the file: it encodes
     * nothing, writes no output, and says so only on stderr. The caller then
     * renames a file that was never created, and what surfaces is
     * `ENOENT ... rename /srv/derived/tmp/...` — a filesystem error carrying
     * absolute server paths, for what is really "there is no frame there".
     *
     * Picking a timestamp at the very end of a video is an ordinary thing for
     * an admin to do, so it gets an ordinary answer.
     */
    if (!existsSync(destination)) {
      throw new NoFrameError(atSeconds);
    }
  }
}

/**
 * Pulls the fields the schema wants out of ffprobe's JSON.
 *
 * Exported for its own tests: the shape here is ffprobe's, not ours, and the
 * awkward parts (duration on the format vs the stream, missing dimensions) are
 * worth pinning without spawning a process.
 */
export function parseProbe(stdout: string): ProbeResult {
  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const streams = parsed.streams ?? [];

  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  // Container duration is the reliable one; a stream may not carry it at all.
  const duration = toNumber(parsed.format?.duration) ?? toNumber(video?.duration);

  return {
    durationSec: duration,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    videoProfile: video?.profile ?? null,
    pixelFormat: video?.pix_fmt ?? null,
    audioTracks: streams.filter((stream) => stream.codec_type === 'audio').length,
    subtitleTracks: streams.filter((stream) => stream.codec_type === 'subtitle').length,
  };
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  // ffprobe writes "N/A" for a duration it cannot determine.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
