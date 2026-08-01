import { spawn } from 'node:child_process';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { FfmpegError } from '../media/ffmpeg-error';
import { ProgressReader, percentOf, remainingSeconds, type ProgressUpdate } from './progress';

/**
 * Runs the actual conversion.
 *
 * `spawn` rather than `execFile` here, because a transcode is long-running and
 * has to be watchable and killable: progress arrives on stdout while it runs,
 * and cancelling means signalling the child rather than waiting.
 */

export interface TranscodeOptions {
  source: string;
  destination: string;
  /** Known from the probe; without it there is no percentage to report. */
  durationSec: number | null;
  crf: number;
  preset: string;
  onProgress: (progress: {
    percent: number | null;
    etaSeconds: number | null;
    /** The tail of ffmpeg's own stderr, so the UI can show what it is doing. */
    logTail: string;
  }) => void;
  /** Aborting kills the child. */
  signal: AbortSignal;
}

@Injectable()
export class Transcoder {
  private readonly logger = new Logger(Transcoder.name);

  constructor(private readonly config: ConfigService) {}

  private get ffmpeg(): string {
    return this.config.get<string>('FFMPEG_PATH') ?? 'ffmpeg';
  }

  /**
   * The plan's command, with the three settings that each prevent a specific
   * failure:
   *
   * - `-movflags +faststart` moves the moov atom to the front. Without it,
   *   progressive playback cannot begin until the whole file has downloaded,
   *   which would defeat the Range streaming this app is built on. It also
   *   means ffmpeg does a final rewrite pass *after* reaching 100%, so the bar
   *   sits at 100% for a moment before finishing — expected, not a hang.
   * - `-pix_fmt yuv420p` forces 8-bit 4:2:0, the only profile with universal
   *   hardware decode support.
   * - `-ac 2` downmixes to stereo, avoiding 5.1 tracks that play silently or
   *   centre-channel-only on many devices.
   */
  async convert(options: TranscodeOptions): Promise<void> {
    const args = [
      '-hide_banner',
      '-y',
      '-i',
      options.source,
      '-c:v',
      'libx264',
      '-crf',
      String(options.crf),
      '-preset',
      options.preset,
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      options.destination,
    ];

    await this.run(args, options);
  }

  /** Pulls one text subtitle stream out of a container and writes it as WebVTT. */
  async extractSubtitle(source: string, streamIndex: number, destination: string): Promise<void> {
    await this.run(
      [
        '-hide_banner',
        '-y',
        '-i',
        source,
        // The absolute stream index, not the nth subtitle — `0:s:1` and `0:3`
        // are different things and only the second is unambiguous.
        '-map',
        `0:${streamIndex}`,
        '-c:s',
        'webvtt',
        destination,
      ],
      { onProgress: () => undefined, durationSec: null, signal: new AbortController().signal },
    );
  }

  private run(
    args: string[],
    options: Pick<TranscodeOptions, 'onProgress' | 'durationSec' | 'signal'>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const reader = new ProgressReader();

      /*
       * Two bounded buffers over the same stream, for two different readers.
       *
       * `-nostats` used to be passed, which left stderr empty on a healthy
       * encode — good for the error message, useless for anyone wanting to see
       * what ffmpeg is doing. Without it the status line streams, but it also
       * repeats several times a second and would push the one line that
       * explains a failure out of a single 8KB window.
       *
       * So `diagnostics` drops the status lines and is what FfmpegError reads;
       * `display` keeps everything and is what the admin sees.
       */
      let diagnostics = '';
      let display = '';
      let pendingLine = '';

      const isStatusLine = (line: string): boolean =>
        /^(frame|size)=/.test(line.trimStart()) || line.trimStart().startsWith('video:');

      const appendStderr = (chunk: string): void => {
        display = (display + chunk).slice(-8_000);

        // Diagnostics are split on whole lines, so a status line cannot be
        // half-classified by an arbitrary chunk boundary.
        pendingLine += chunk;
        const lines = pendingLine.split('\n');
        pendingLine = lines.pop() ?? '';
        const kept = lines.filter((line) => line.trim() !== '' && !isStatusLine(line));
        if (kept.length > 0) {
          diagnostics = (diagnostics + kept.join('\n') + '\n').slice(-8_000);
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const update of reader.push(chunk)) {
          this.report(update, options, display);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', appendStderr);

      const onAbort = (): void => {
        // SIGKILL rather than SIGTERM: ffmpeg handles SIGTERM by finalising the
        // file it is writing, and a cancelled job must not leave something that
        // looks finished.
        child.kill('SIGKILL');
      };
      options.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error) => {
        options.signal.removeEventListener('abort', onAbort);
        reject(error);
      });

      child.on('close', (code, signal) => {
        options.signal.removeEventListener('abort', onAbort);

        if (options.signal.aborted) {
          reject(new CancelledError());
          return;
        }

        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new FfmpegError(
            'ffmpeg',
            code,
            diagnostics || display || `killed by ${signal ?? 'unknown signal'}`,
          ),
        );
      });
    });
  }

  private report(
    update: ProgressUpdate,
    options: Pick<TranscodeOptions, 'onProgress' | 'durationSec'>,
    logTail: string,
  ): void {
    options.onProgress({
      percent: percentOf(update.outTimeUs, options.durationSec),
      etaSeconds: remainingSeconds(update.outTimeUs, options.durationSec, update.speed),
      logTail,
    });
  }
}

/** Distinguishes a deliberate cancel from a failure, so the job records the right thing. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}
