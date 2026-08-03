import { resolveArtwork } from './artwork-resolution';

describe('resolveArtwork', () => {
  it('prefers the first candidate', () => {
    expect(resolveArtwork('posters/own.jpg', 'posters/episode.jpg')).toEqual({
      kind: 'stored',
      key: 'posters/own.jpg',
    });
  });

  /**
   * The case the whole thing exists for. A collection with no poster of its own
   * is not a collection with no poster — it is one nobody has overridden, and it
   * should show what is on the shelf.
   */
  it('falls through to the next when there is no override', () => {
    expect(resolveArtwork(null, 'posters/episode.jpg')).toEqual({
      kind: 'stored',
      key: 'posters/episode.jpg',
    });
  });

  it('reaches the stock image only when nothing is available', () => {
    expect(resolveArtwork(null, null)).toEqual({ kind: 'fallback' });
    expect(resolveArtwork()).toEqual({ kind: 'fallback' });
  });

  it('treats undefined like null, for a payload that did not select the column', () => {
    expect(resolveArtwork(undefined, 'posters/episode.jpg')).toEqual({
      kind: 'stored',
      key: 'posters/episode.jpg',
    });
  });

  /**
   * `''` joined onto DERIVED_ROOT is the root directory itself. Reading it fails
   * as EISDIR, which reports nothing anybody can act on, and it is never what a
   * caller meant — an empty column is an absent one.
   */
  it('does not treat an empty string as a key', () => {
    expect(resolveArtwork('', 'posters/episode.jpg')).toEqual({
      kind: 'stored',
      key: 'posters/episode.jpg',
    });
    expect(resolveArtwork('')).toEqual({ kind: 'fallback' });
  });

  it('keeps looking past several absent candidates', () => {
    expect(resolveArtwork(null, undefined, '', 'posters/last.jpg')).toEqual({
      kind: 'stored',
      key: 'posters/last.jpg',
    });
  });
});
