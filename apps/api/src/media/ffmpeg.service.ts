import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const run = promisify(execFile);

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
        run(this.ffprobe, ['-version'], { timeout: 10_000 }),
        run(this.ffmpeg, ['-version'], { timeout: 10_000 }),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async probe(path: string): Promise<ProbeResult> {
    const { stdout } = await run(
      this.ffprobe,
      [
        '-v',
        'error',
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
   * Grabs a single frame as a JPEG.
   *
   * `-ss` before `-i` seeks by keyframe index rather than decoding up to the
   * timestamp — the difference between instant and minutes on a long file.
   */
  async captureFrame(source: string, atSeconds: number, destination: string): Promise<void> {
    await run(
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
        'scale=640:-2',
        destination,
      ],
      { timeout: THUMBNAIL_TIMEOUT_MS },
    );
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
