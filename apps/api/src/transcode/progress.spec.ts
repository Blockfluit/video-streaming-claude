import { ProgressReader, percentOf, remainingSeconds } from './progress';

describe('ProgressReader', () => {
  let reader: ProgressReader;

  beforeEach(() => {
    reader = new ProgressReader();
  });

  const block = (fields: Record<string, string>): string =>
    `${Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`;

  it('reads a complete block', () => {
    const updates = reader.push(
      block({ frame: '120', out_time_us: '5000000', speed: '2.5x', progress: 'continue' }),
    );

    expect(updates).toEqual([{ outTimeUs: 5_000_000, speed: 2.5, done: false }]);
  });

  /**
   * `-progress pipe:1` writes to a pipe, so a block can be split across chunks
   * at any byte. Treating each chunk as a whole message loses updates and, worse,
   * can read `out_time_us=50` out of a line that said `out_time_us=5000000`.
   */
  it('waits for a block that arrives in pieces', () => {
    expect(reader.push('frame=120\nout_time_us=50')).toEqual([]);
    expect(reader.push('00000\nprogress=continue\n')).toEqual([
      { outTimeUs: 5_000_000, speed: null, done: false },
    ]);
  });

  it('reads several blocks from one chunk', () => {
    const updates = reader.push(
      block({ out_time_us: '1000000', progress: 'continue' }) +
        block({ out_time_us: '2000000', progress: 'continue' }),
    );

    expect(updates.map((update) => update.outTimeUs)).toEqual([1_000_000, 2_000_000]);
  });

  // `progress=end` is how ffmpeg says it has finished writing.
  it('marks the final block as done', () => {
    const updates = reader.push(block({ out_time_us: '9000000', progress: 'end' }));

    expect(updates).toEqual([{ outTimeUs: 9_000_000, speed: null, done: true }]);
  });

  /**
   * ffmpeg emits `N/A` before it has processed anything. Number('N/A') is NaN,
   * which would render as a NaN% progress bar.
   */
  it('ignores a block with no usable timestamp', () => {
    expect(reader.push(block({ out_time_us: 'N/A', speed: 'N/A', progress: 'continue' }))).toEqual(
      [],
    );
  });

  it('survives keys it does not know', () => {
    const updates = reader.push(
      block({ bitrate: '1500kbits/s', dup_frames: '0', out_time_us: '1000000', progress: 'continue' }),
    );

    expect(updates).toHaveLength(1);
  });

  it('ignores noise between blocks', () => {
    expect(reader.push('some stray line\n' + block({ out_time_us: '1000', progress: 'continue' })))
      .toHaveLength(1);
  });
});

describe('percentOf', () => {
  it('is the fraction of the known duration', () => {
    expect(percentOf(5_000_000, 10)).toBeCloseTo(0.5);
    expect(percentOf(10_000_000, 10)).toBeCloseTo(1);
  });

  it('starts at zero', () => {
    expect(percentOf(0, 10)).toBe(0);
  });

  /**
   * ffmpeg can report a timestamp slightly past the duration, and
   * `-movflags +faststart` means it keeps working after reaching the end.
   * A progress bar must not read 103%.
   */
  it('never exceeds one', () => {
    expect(percentOf(11_000_000, 10)).toBe(1);
  });

  // Without a probed duration there is nothing to be a fraction of.
  it('is null when the duration is unknown', () => {
    expect(percentOf(5_000_000, null)).toBeNull();
    expect(percentOf(5_000_000, 0)).toBeNull();
  });
});

describe('remainingSeconds', () => {
  it('estimates from the speed multiplier', () => {
    // 10s done of 60s, running at 2x: 50s of media left, at 2x → 25s.
    expect(remainingSeconds(10_000_000, 60, 2)).toBe(25);
  });

  it('is zero at the end rather than a negative number', () => {
    expect(remainingSeconds(60_000_000, 60, 2)).toBe(0);
  });

  it('is null when there is nothing to estimate from', () => {
    expect(remainingSeconds(10_000_000, null, 2)).toBeNull();
    expect(remainingSeconds(10_000_000, 60, null)).toBeNull();
    // A speed of zero would divide by zero and report Infinity seconds.
    expect(remainingSeconds(10_000_000, 60, 0)).toBeNull();
  });
});
