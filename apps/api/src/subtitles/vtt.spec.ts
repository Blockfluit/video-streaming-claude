import { isProbablyUtf8, isWebVtt, stripBom } from './vtt';

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('isWebVtt', () => {
  it('accepts a plain WEBVTT file', () => {
    expect(isWebVtt(utf8('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n'))).toBe(true);
  });

  // The spec allows a header comment after the signature.
  it('accepts a header with a trailing note', () => {
    expect(isWebVtt(utf8('WEBVTT - This file has cues.\n\n'))).toBe(true);
    expect(isWebVtt(utf8('WEBVTT\tsomething\n'))).toBe(true);
  });

  /**
   * A BOM before the signature is common from Windows editors, and a browser
   * accepts it — so rejecting the upload would be refusing a file that works.
   */
  it('accepts a byte-order mark before the signature', () => {
    expect(isWebVtt(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('WEBVTT\n')]))).toBe(true);
  });

  it('rejects an SRT pretending to be a VTT', () => {
    expect(isWebVtt(utf8('1\n00:00:01,000 --> 00:00:02,000\nHello\n'))).toBe(false);
  });

  it('rejects anything else', () => {
    expect(isWebVtt(utf8(''))).toBe(false);
    expect(isWebVtt(utf8('<html></html>'))).toBe(false);
    expect(isWebVtt(Buffer.from([0x00, 0x01, 0x02]))).toBe(false);
  });

  // "WEBVTTX" is not the signature; the spec requires the header to end there.
  it('rejects a signature that runs into other text', () => {
    expect(isWebVtt(utf8('WEBVTTX\n'))).toBe(false);
  });

  it('is case-sensitive, as the spec is', () => {
    expect(isWebVtt(utf8('webvtt\n'))).toBe(false);
  });
});

describe('stripBom', () => {
  it('removes a UTF-8 BOM', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('WEBVTT')]);

    expect(stripBom(withBom).toString('utf8')).toBe('WEBVTT');
  });

  it('leaves a file without one alone', () => {
    expect(stripBom(utf8('WEBVTT')).toString('utf8')).toBe('WEBVTT');
  });
});

/**
 * Legacy `.srt` files are very often Windows-1252 rather than UTF-8. Feeding
 * one to ffmpeg as UTF-8 does not fail — it produces mojibake, which is worse
 * than an error because nobody notices until someone reads a subtitle.
 */
describe('isProbablyUtf8', () => {
  it('accepts ASCII', () => {
    expect(isProbablyUtf8(utf8('Hello there\n'))).toBe(true);
  });

  it('accepts real UTF-8', () => {
    expect(isProbablyUtf8(utf8('Café — naïve\n'))).toBe(true);
    expect(isProbablyUtf8(utf8('日本語の字幕\n'))).toBe(true);
    expect(isProbablyUtf8(utf8('Ærøskøbing'))).toBe(true);
  });

  it('rejects Windows-1252 high bytes that are not valid UTF-8', () => {
    // 0xE9 is é in CP1252, and an invalid lone lead byte in UTF-8.
    expect(isProbablyUtf8(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0a]))).toBe(false);
    // 0x96 (en dash in CP1252) is a continuation byte with nothing leading it.
    expect(isProbablyUtf8(Buffer.from([0x41, 0x96, 0x42]))).toBe(false);
  });

  it('accepts an empty file rather than calling it broken', () => {
    expect(isProbablyUtf8(Buffer.alloc(0))).toBe(true);
  });

  // Only the start is examined, so a huge file does not cost a full decode.
  it('does not mind being handed a large file', () => {
    const large = Buffer.concat([utf8('a'.repeat(200_000)), Buffer.from([0xe9])]);

    expect(isProbablyUtf8(large)).toBe(true);
  });
});
