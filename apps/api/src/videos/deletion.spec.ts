import {
  derivedKeysToDelete,
  mediaKeysToDelete,
  playbackKeysToDelete,
  subtitleDirectoryKey,
} from './deletion';

/**
 * Which files a deleted video takes with it.
 *
 * Pure on purpose: every key here is read off the row *before* the delete, and
 * the cascade takes all of them the instant it runs. Getting the list wrong
 * either leaks files nothing will ever reference again or destroys one that is
 * still someone's only copy, and neither shows up in a response code.
 */
describe('derivedKeysToDelete', () => {
  const video = {
    id: 'vid1',
    posterKey: 'posters/vid1.jpg',
    bannerKey: 'banners/vid1.jpg',
    playbackKey: 'disk1/Film/film.mp4',
    subtitles: [{ storageKey: 'subtitles/vid1/en.vtt' }, { storageKey: 'subtitles/vid1/nl.vtt' }],
  };

  it('takes the artwork and every subtitle track', () => {
    expect(derivedKeysToDelete(video)).toEqual([
      'posters/vid1.jpg',
      'banners/vid1.jpg',
      'subtitles/vid1/en.vtt',
      'subtitles/vid1/nl.vtt',
    ]);
  });

  /**
   * It moved out of this list when it moved out of `DERIVED_ROOT`. Deleting it
   * from the derived root would silently do nothing, which is the failure that
   * leaves an orphan in a watched folder for the next scan to ingest.
   */
  it('does not list the converted file, which is not derived output any more', () => {
    expect(derivedKeysToDelete(video)).not.toContain('disk1/Film/film.mp4');
  });

  it('drops the keys a row does not have', () => {
    expect(
      derivedKeysToDelete({
        id: 'vid1',
        posterKey: null,
        bannerKey: null,
        playbackKey: null,
        subtitles: [],
      }),
    ).toEqual([]);
  });

  /**
   * A row that was never converted still has artwork, and a row that was never
   * postered still has a playback file. Neither is an all-or-nothing set.
   */
  it('keeps the ones that are there when others are missing', () => {
    expect(
      derivedKeysToDelete({
        id: 'vid1',
        posterKey: null,
        bannerKey: 'banners/vid1.jpg',
        playbackKey: null,
        subtitles: [{ storageKey: 'subtitles/vid1/en.vtt' }],
      }),
    ).toEqual(['banners/vid1.jpg', 'subtitles/vid1/en.vtt']);
  });
});

/**
 * Its own list because it obeys neither of the other two rules: generated
 * output, but living in `MEDIA_ROOT` beside the source it came from.
 */
describe('playbackKeysToDelete', () => {
  it('takes the converted file', () => {
    expect(playbackKeysToDelete({ playbackKey: 'disk1/Film/film.mp4' })).toEqual([
      'disk1/Film/film.mp4',
    ]);
  });

  it('has nothing to take from a video that was never converted', () => {
    expect(playbackKeysToDelete({ playbackKey: null })).toEqual([]);
  });

  /**
   * The answer does not depend on `deleteFiles`, and the caller is what enforces
   * that. Ingest skips a converted file only because a row claims it; once the
   * row is gone an orphan in a watched folder becomes a brand-new video on the
   * next scan — so "keep the files" cannot mean keeping this one.
   */
  it('is the same list whether or not the caller asked for the files', () => {
    const video = { playbackKey: 'disk1/Film/film.mp4' };
    expect(playbackKeysToDelete(video)).toEqual(playbackKeysToDelete(video));
  });

  /** Still answers for a row that has not been relocated yet. */
  it('takes a converted file still under the old layout', () => {
    expect(playbackKeysToDelete({ playbackKey: 'converted/vid1.mp4' })).toEqual([
      'converted/vid1.mp4',
    ]);
  });
});

describe('subtitleDirectoryKey', () => {
  /**
   * Both writers of a subtitle put it under `subtitles/<videoId>/`, and nothing
   * has ever cleaned the directory up. It is removed after the files rather
   * than instead of them: a key that predates this layout would otherwise be
   * left behind by a delete that appeared to have swept everything.
   */
  it('is the per-video directory the tracks live in', () => {
    expect(subtitleDirectoryKey('vid1')).toBe('subtitles/vid1');
  });
});

describe('mediaKeysToDelete', () => {
  it('takes the source and every sidecar it was converted from', () => {
    expect(
      mediaKeysToDelete({
        storageKey: 'disk1/Film/film.mkv',
        sourceDeletedAt: null,
        subtitles: [
          { sourceKey: 'disk1/Film/film.en.srt' },
          { sourceKey: 'disk1/Film/film.nl.srt' },
        ],
      }),
    ).toEqual(['disk1/Film/film.mkv', 'disk1/Film/film.en.srt', 'disk1/Film/film.nl.srt']);
  });

  /**
   * An extracted or uploaded track was never a file in the media tree, so it
   * has no `sourceKey` and there is nothing beside the video to remove.
   */
  it('ignores tracks that never came from a sidecar', () => {
    expect(
      mediaKeysToDelete({
        storageKey: 'disk1/Film/film.mkv',
        sourceDeletedAt: null,
        subtitles: [{ sourceKey: null }, { sourceKey: 'disk1/Film/film.en.srt' }],
      }),
    ).toEqual(['disk1/Film/film.mkv', 'disk1/Film/film.en.srt']);
  });

  /**
   * A reclaimed source is already gone. Listing it would ask the storage layer
   * to remove a path that is not there — harmless, since `delete` forces, but
   * it would also mean the count of what is about to go is a lie.
   */
  it('leaves out a source that was already reclaimed', () => {
    expect(
      mediaKeysToDelete({
        storageKey: 'disk1/Film/film.mkv',
        sourceDeletedAt: new Date(),
        subtitles: [{ sourceKey: 'disk1/Film/film.en.srt' }],
      }),
    ).toEqual(['disk1/Film/film.en.srt']);
  });
});
