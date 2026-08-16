import { withoutConvertedOutput } from './converted-output';
import { parseMediaPath } from './path-parser';
import type { ScanResult } from './media-scanner';

function file(relPath: string) {
  return { relPath, size: 1, mtime: new Date(0), parsed: parseMediaPath(relPath) };
}

function scanOf(overrides: Partial<ScanResult> = {}): ScanResult {
  return { videos: [], subtitles: [], issues: [], unreadable: [], ...overrides };
}

describe('withoutConvertedOutput', () => {
  it('drops a converted file and keeps the source beside it', () => {
    const scan = scanOf({
      videos: [file('disk1/Films/Heat/Heat.mkv'), file('disk1/Films/Heat/Heat.mp4')],
    });

    const filtered = withoutConvertedOutput(scan, ['disk1/Films/Heat/Heat.mp4']);

    expect(filtered.videos.map((entry) => entry.relPath)).toEqual(['disk1/Films/Heat/Heat.mkv']);
  });

  /**
   * A file's bucket depends on where it sits, so a converted file written
   * beside a loose source is an issue rather than a video. Filtering only
   * `videos` leaves it raising a complaint on every scan about a file nobody
   * put there.
   */
  it('drops a converted file that landed in the issues bucket', () => {
    const scan = scanOf({ issues: [file('disk1/Heat.mp4')] });

    const filtered = withoutConvertedOutput(scan, ['disk1/Heat.mp4']);

    expect(filtered.issues).toHaveLength(0);
  });

  it('leaves sidecars and unreadable directories alone', () => {
    const scan = scanOf({
      videos: [file('disk1/Films/Heat/Heat.mp4')],
      subtitles: [file('disk1/Films/Heat/Heat_en_English.srt')],
      unreadable: [{ relPath: 'disk1/Locked', reason: 'EACCES' }],
    });

    const filtered = withoutConvertedOutput(scan, ['disk1/Films/Heat/Heat.mp4']);

    expect(filtered.subtitles).toHaveLength(1);
    expect(filtered.unreadable).toHaveLength(1);
  });

  it('ignores rows that have never been converted', () => {
    const scan = scanOf({ videos: [file('disk1/Films/Heat/Heat.mkv')] });

    const filtered = withoutConvertedOutput(scan, [null, null]);

    expect(filtered.videos).toHaveLength(1);
  });

  it('is the identity when nothing has been converted', () => {
    const scan = scanOf({ videos: [file('disk1/Films/Heat/Heat.mkv')] });

    expect(withoutConvertedOutput(scan, [])).toBe(scan);
  });

  /**
   * A key whose file is not on disk is the normal state during a relocation,
   * and must not disturb anything else in the scan.
   */
  it('shrugs at a key that matches nothing on disk', () => {
    const scan = scanOf({ videos: [file('disk1/Films/Heat/Heat.mkv')] });

    const filtered = withoutConvertedOutput(scan, ['converted/clx123.mp4']);

    expect(filtered.videos).toHaveLength(1);
  });

  it('does not mutate the scan it was given', () => {
    const scan = scanOf({
      videos: [file('disk1/Films/Heat/Heat.mkv'), file('disk1/Films/Heat/Heat.mp4')],
    });

    withoutConvertedOutput(scan, ['disk1/Films/Heat/Heat.mp4']);

    expect(scan.videos).toHaveLength(2);
  });
});
