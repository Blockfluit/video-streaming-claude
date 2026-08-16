import { isHiddenEntry } from '../ingest/watch-ignore';
import { parseMediaPath, VIDEO_EXTENSIONS } from '../ingest/path-parser';
import {
  convertedKeyFor,
  convertedKeyVariant,
  convertingTemporaryKey,
  playbackRoot,
} from './converted-key';

describe('convertedKeyFor', () => {
  it('puts the converted file in the source folder, under the source name', () => {
    expect(convertedKeyFor('disk1/Films/Heat (1995)/Heat.mkv')).toBe(
      'disk1/Films/Heat (1995)/Heat.mp4',
    );
  });

  it('keeps a season folder', () => {
    expect(convertedKeyFor('disk1/Show/Season 1/01 - Pilot.avi')).toBe(
      'disk1/Show/Season 1/01 - Pilot.mp4',
    );
  });

  /**
   * The one that destroys an archive if it is wrong. ffmpeg truncates its
   * output the moment it opens it, so returning the source key would empty the
   * film before the encode had read a frame of it.
   */
  it('never returns the source itself when the source is already an mp4', () => {
    expect(convertedKeyFor('disk1/Films/Heat/Heat.mp4')).toBe(
      'disk1/Films/Heat/Heat.converted.mp4',
    );
  });

  it('recognises an upper-case extension as the same container', () => {
    expect(convertedKeyFor('disk1/Films/Heat/Heat.MP4')).toBe(
      'disk1/Films/Heat/Heat.converted.mp4',
    );
  });

  /**
   * A property rather than a list, so adding a container to VIDEO_EXTENSIONS
   * later cannot quietly reintroduce the overwrite.
   */
  it.each(VIDEO_EXTENSIONS)('never returns the source for a .%s source', (extension) => {
    const source = `disk1/Films/Heat/Heat.${extension}`;
    expect(convertedKeyFor(source)).not.toBe(source);
  });

  it('leaves dots inside the name alone', () => {
    expect(convertedKeyFor('disk1/Films/Heat/Heat.1995.1080p.mkv')).toBe(
      'disk1/Films/Heat/Heat.1995.1080p.mp4',
    );
  });

  /** A backslash is a legal character in a Linux filename, never a separator. */
  it('does not treat a backslash as a folder', () => {
    expect(convertedKeyFor('disk1/Films/Odd/Back\\slash.mkv')).toBe(
      'disk1/Films/Odd/Back\\slash.mp4',
    );
  });

  it('survives non-ascii and bracketed names', () => {
    expect(convertedKeyFor('disk1/Films/Amélie (2001)/Amélie [1080p].mkv')).toBe(
      'disk1/Films/Amélie (2001)/Amélie [1080p].mp4',
    );
  });
});

describe('convertedKeyVariant', () => {
  it('agrees with convertedKeyFor at zero', () => {
    const source = 'disk1/Films/Heat/Heat.mkv';
    expect(convertedKeyVariant(source, 0)).toBe(convertedKeyFor(source));
  });

  /** The suffix convention uploads already use for a name that is taken. */
  it('numbers from two upwards', () => {
    expect(convertedKeyVariant('disk1/Films/Heat/Heat.mkv', 1)).toBe(
      'disk1/Films/Heat/Heat-2.mp4',
    );
    expect(convertedKeyVariant('disk1/Films/Heat/Heat.mkv', 2)).toBe(
      'disk1/Films/Heat/Heat-3.mp4',
    );
  });

  it('keeps the mp4 source safe at every index', () => {
    const source = 'disk1/Films/Heat/Heat.mp4';

    for (let index = 0; index < 5; index += 1) {
      expect(convertedKeyVariant(source, index)).not.toBe(source);
    }

    expect(convertedKeyVariant(source, 1)).toBe('disk1/Films/Heat/Heat.converted-2.mp4');
  });

  it('never produces the same name twice', () => {
    const keys = [0, 1, 2, 3].map((index) =>
      convertedKeyVariant('disk1/Films/Heat/Heat.mkv', index),
    );

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('convertingTemporaryKey', () => {
  it('sits in the folder the finished file is going to', () => {
    const temporary = convertingTemporaryKey('disk1/Films/Heat/Heat.mkv', 'job1');
    const folder = (key: string): string => key.slice(0, key.lastIndexOf('/'));

    expect(folder(temporary)).toBe(folder(convertedKeyFor('disk1/Films/Heat/Heat.mkv')));
  });

  it('names the job, so two conversions cannot share a file', () => {
    expect(convertingTemporaryKey('disk1/Films/Heat/Heat.mkv', 'job1')).not.toBe(
      convertingTemporaryKey('disk1/Films/Heat/Heat.mkv', 'job2'),
    );
  });

  /**
   * The whole reason it is dot-prefixed. The file is being written inside the
   * watched tree, so if either the scanner or the watcher could see it, a
   * half-written encode would be ingested as a video.
   *
   * Asserted against the real predicates rather than by eyeballing the name —
   * that is the claim that matters, and it spans three modules.
   */
  it('is invisible to the scanner and to the watcher', () => {
    const temporary = convertingTemporaryKey('disk1/Films/Heat/Heat.mkv', 'job1');

    expect(parseMediaPath(temporary)).toMatchObject({ kind: 'ignored', reason: 'dotfile' });
    expect(isHiddenEntry('/srv/media', `/srv/media/${temporary}`)).toBe(true);
  });

  it('is not the key the finished file takes', () => {
    expect(convertingTemporaryKey('disk1/Films/Heat/Heat.mkv', 'job1')).not.toBe(
      convertedKeyFor('disk1/Films/Heat/Heat.mkv'),
    );
  });
});

/**
 * A shim with a scheduled death: it exists so an install whose files have not
 * been relocated yet keeps playing. Once `/admin/jobs/relocate-conversions` has
 * run everywhere, this and its callers collapse to `'media'`.
 */
describe('playbackRoot', () => {
  it('reads a legacy key as derived', () => {
    expect(playbackRoot('converted/clx123.mp4')).toBe('derived');
  });

  it('reads a relocated key as media', () => {
    expect(playbackRoot('disk1/Films/Heat/Heat.mp4')).toBe('media');
  });

  /** A drive that happens to be called `converted` is still a drive. */
  it('does not mistake a media folder of that name for the legacy one', () => {
    expect(playbackRoot('converted-films/Heat/Heat.mp4')).toBe('media');
  });
});
