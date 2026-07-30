/**
 * Reading ffmpeg's `-progress pipe:1` stream.
 *
 * ffmpeg writes repeated blocks of `key=value` lines, each terminated by a
 * `progress=continue` or `progress=end` line. That is a structured contract —
 * far better than scraping the `frame= 120 fps=…` status line off stderr, which
 * is formatted for humans and changes between versions.
 *
 * Pure and incremental, because the interesting failure is a block split across
 * two chunks: a pipe can break anywhere, and reading `out_time_us=50` out of a
 * line that said `out_time_us=5000000` would send the progress bar backwards.
 */

export interface ProgressUpdate {
  /** Position in the output, in microseconds. */
  outTimeUs: number;
  /** Encoding speed as a multiple of realtime, when ffmpeg has reported one. */
  speed: number | null;
  /** True for the final block — ffmpeg says `progress=end`. */
  done: boolean;
}

export class ProgressReader {
  /** Whatever arrived after the last complete block. */
  private buffer = '';
  private fields = new Map<string, string>();

  /** Feeds a chunk in, and returns whatever complete blocks it completed. */
  push(chunk: string): ProgressUpdate[] {
    this.buffer += chunk;
    const updates: ProgressUpdate[] = [];

    // Only whole lines can be parsed; the remainder stays buffered.
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const separator = line.indexOf('=');
      if (separator === -1) continue;

      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();

      if (key !== 'progress') {
        this.fields.set(key, value);
        continue;
      }

      // `progress=` terminates a block.
      const update = this.toUpdate(value === 'end');
      this.fields.clear();
      if (update) updates.push(update);
    }

    return updates;
  }

  private toUpdate(done: boolean): ProgressUpdate | null {
    const outTimeUs = toNumber(this.fields.get('out_time_us'));
    // ffmpeg emits `N/A` before it has processed anything; Number('N/A') is NaN,
    // which would render as a NaN% progress bar.
    if (outTimeUs === null) return null;

    return { outTimeUs, speed: toNumber(this.fields.get('speed')?.replace(/x$/, '')), done };
  }
}

/** Fraction complete, or null when the duration was never probed. */
export function percentOf(outTimeUs: number, durationSec: number | null): number | null {
  if (durationSec === null || durationSec <= 0) return null;

  // ffmpeg can report slightly past the end, and `+faststart` keeps it working
  // after reaching 100% — a progress bar must not read 103%.
  return Math.min(1, outTimeUs / (durationSec * 1_000_000));
}

/**
 * Seconds of work left, from the speed multiplier ffmpeg reports.
 *
 * Deliberately not smoothed. An ETA that jumps is honest about a workload that
 * varies; one that glides is guessing.
 */
export function remainingSeconds(
  outTimeUs: number,
  durationSec: number | null,
  speed: number | null,
): number | null {
  if (durationSec === null || durationSec <= 0) return null;
  if (speed === null || speed <= 0) return null;

  const mediaLeft = Math.max(0, durationSec - outTimeUs / 1_000_000);

  return Math.round(mediaLeft / speed);
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
