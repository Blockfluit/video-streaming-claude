import { derivedKeysToDelete, mediaKeysToDelete, subtitleDirectoryKey } from './deletion';

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
    playbackKey: 'converted/vid1.mp4',
    subtitles: [{ storageKey: 'subtitles/vid1/en.vtt' }, { storageKey: 'subtitles/vid1/nl.vtt' }],
  };

  it('takes the artwork, the converted file and every subtitle track', () => {
    expect(derivedKeysToDelete(video)).toEqual([
      'posters/vid1.jpg',
      'banners/vid1.jpg',
      'converted/vid1.mp4',
      'subtitles/vid1/en.vtt',
      'subtitles/vid1/nl.vtt',
    ]);
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
