import { sanitizeFilename, splitUploadName } from './filename';

/**
 * The client's `originalName` is metadata. It arrives from a browser, which
 * means it arrives from whoever is using the browser, and it is about to become
 * part of a path on the server.
 */
describe('sanitizeFilename', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeFilename("01 - Philosopher's Stone.mp4")).toBe("01 - Philosopher's Stone.mp4");
  });

  describe('path components', () => {
    // The whole point: a name is a name, never a path.
    it('keeps only the last segment of a path', () => {
      expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
      expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
      expect(sanitizeFilename('a/b/c/film.mp4')).toBe('film.mp4');
    });

    // Windows clients send backslashes, and a Linux filesystem treats those as
    // ordinary characters — so they have to be stripped here rather than relied
    // on to be separators.
    it('strips backslash separators too', () => {
      expect(sanitizeFilename('C:\\Users\\me\\film.mp4')).toBe('film.mp4');
    });

    it('refuses to become a traversal', () => {
      expect(sanitizeFilename('..')).not.toBe('..');
      expect(sanitizeFilename('.')).not.toBe('.');
      expect(sanitizeFilename('../..')).not.toBe('..');
    });
  });

  it('strips characters that have no business in a filename', () => {
    expect(sanitizeFilename('film\u0000.mp4')).toBe('film.mp4');
    expect(sanitizeFilename('film\n\r\t.mp4')).toBe('film.mp4');
  });

  // A leading dot would hide the file from the ingest scanner, which skips
  // dotfiles — an upload that silently never appears.
  it('does not produce a hidden file', () => {
    expect(sanitizeFilename('.hidden.mp4')).toBe('hidden.mp4');
    expect(sanitizeFilename('...film.mp4')).toBe('film.mp4');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeFilename('  spaced   out .mp4  ')).toBe('spaced out .mp4');
  });

  // ext4 allows 255 bytes; a long name plus a `-2` suffix must still fit.
  it('bounds the length', () => {
    const result = sanitizeFilename(`${'a'.repeat(500)}.mp4`);

    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('.mp4')).toBe(true);
  });

  it('always returns something usable', () => {
    expect(sanitizeFilename('')).toBe('upload');
    expect(sanitizeFilename('   ')).toBe('upload');
    expect(sanitizeFilename('/')).toBe('upload');
    expect(sanitizeFilename('\u0000')).toBe('upload');
  });

  it('leaves non-latin names alone — they are perfectly valid filenames', () => {
    expect(sanitizeFilename('日本語.mp4')).toBe('日本語.mp4');
    expect(sanitizeFilename('Amélie.mkv')).toBe('Amélie.mkv');
  });
});

describe('splitUploadName', () => {
  it('separates the stem from a lowercased extension', () => {
    expect(splitUploadName('Film.MP4')).toEqual({ basename: 'Film', extension: 'mp4' });
  });

  it('splits on the last dot', () => {
    expect(splitUploadName('S.W.A.T.mkv')).toEqual({ basename: 'S.W.A.T', extension: 'mkv' });
  });

  it('reports no extension when there is none', () => {
    expect(splitUploadName('README')).toEqual({ basename: 'README', extension: '' });
  });

  // Already sanitized by the time this runs, but a leading dot must never read
  // as "the whole name is an extension".
  it('does not treat a leading dot as an extension', () => {
    expect(splitUploadName('.mp4')).toEqual({ basename: '.mp4', extension: '' });
  });
});
