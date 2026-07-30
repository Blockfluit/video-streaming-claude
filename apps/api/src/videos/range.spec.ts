import { STREAM_CHUNK_BYTES, parseRangeHeader } from './range';

const SIZE = 10_000;

describe('parseRangeHeader', () => {
  describe('no range to honour', () => {
    it('reports nothing for an absent header', () => {
      expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'none' });
      expect(parseRangeHeader('', SIZE)).toEqual({ kind: 'none' });
    });

    // RFC 7233: a server must ignore a range unit it does not understand,
    // which means answering 200 with the whole body rather than 416.
    it('ignores a unit that is not bytes', () => {
      expect(parseRangeHeader('items=0-5', SIZE)).toEqual({ kind: 'none' });
      expect(parseRangeHeader('seconds=0-5', SIZE)).toEqual({ kind: 'none' });
    });

    /**
     * Multiple ranges are legal, but answering one properly needs a
     * `multipart/byteranges` body. Ignoring the header and sending the whole
     * file is also legal, and is what every video client copes with — serving
     * just the first range would be a lie about what was asked for.
     */
    it('ignores a multi-range request rather than answering it wrongly', () => {
      expect(parseRangeHeader('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'none' });
    });
  });

  describe('a range it can serve', () => {
    it('reads an explicit start and end', () => {
      expect(parseRangeHeader('bytes=0-1023', SIZE)).toEqual({ kind: 'range', start: 0, end: 1023 });
      expect(parseRangeHeader('bytes=500-999', SIZE)).toEqual({
        kind: 'range',
        start: 500,
        end: 999,
      });
    });

    // What a <video> element opens with. Answering the whole file here would
    // send gigabytes to a browser that only wanted the moov atom.
    it('caps an open-ended range at one chunk', () => {
      expect(parseRangeHeader('bytes=0-', 10_000_000)).toEqual({
        kind: 'range',
        start: 0,
        end: STREAM_CHUNK_BYTES - 1,
      });
    });

    it('does not run an open-ended range past the end of a small file', () => {
      expect(parseRangeHeader('bytes=0-', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
    });

    it('clamps an end past the file to the last byte', () => {
      expect(parseRangeHeader('bytes=0-999999', SIZE)).toEqual({
        kind: 'range',
        start: 0,
        end: SIZE - 1,
      });
    });

    it('serves a single byte', () => {
      expect(parseRangeHeader('bytes=0-0', SIZE)).toEqual({ kind: 'range', start: 0, end: 0 });
    });

    it('serves the last byte', () => {
      expect(parseRangeHeader(`bytes=${SIZE - 1}-`, SIZE)).toEqual({
        kind: 'range',
        start: SIZE - 1,
        end: SIZE - 1,
      });
    });

    // A suffix range asks for the last N bytes — how a player finds the moov
    // atom in an MP4 that was not written for streaming.
    it('reads a suffix range', () => {
      expect(parseRangeHeader('bytes=-500', SIZE)).toEqual({
        kind: 'range',
        start: SIZE - 500,
        end: SIZE - 1,
      });
    });

    it('clamps a suffix longer than the file to the whole file', () => {
      expect(parseRangeHeader('bytes=-999999', SIZE)).toEqual({
        kind: 'range',
        start: 0,
        end: SIZE - 1,
      });
    });

    it('tolerates the whitespace some clients send', () => {
      expect(parseRangeHeader('bytes = 0 - 1023', SIZE)).toEqual({
        kind: 'range',
        start: 0,
        end: 1023,
      });
    });

    it('does not care about the case of the unit', () => {
      expect(parseRangeHeader('BYTES=0-99', SIZE)).toEqual({ kind: 'range', start: 0, end: 99 });
    });
  });

  describe('a range it cannot serve', () => {
    it('rejects a start past the end of the file', () => {
      expect(parseRangeHeader(`bytes=${SIZE}-`, SIZE)).toEqual({ kind: 'unsatisfiable' });
      expect(parseRangeHeader('bytes=999999-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    });

    it('rejects a backwards range', () => {
      expect(parseRangeHeader('bytes=500-100', SIZE)).toEqual({ kind: 'unsatisfiable' });
    });

    // A zero-length suffix asks for nothing, which no byte range can express.
    it('rejects a zero-length suffix', () => {
      expect(parseRangeHeader('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
    });

    it('rejects a malformed byte range', () => {
      expect(parseRangeHeader('bytes=', SIZE)).toEqual({ kind: 'unsatisfiable' });
      expect(parseRangeHeader('bytes=abc-def', SIZE)).toEqual({ kind: 'unsatisfiable' });
      expect(parseRangeHeader('bytes=1.5-2', SIZE)).toEqual({ kind: 'unsatisfiable' });
      expect(parseRangeHeader('bytes=-', SIZE)).toEqual({ kind: 'unsatisfiable' });
      expect(parseRangeHeader('bytes=--5', SIZE)).toEqual({ kind: 'unsatisfiable' });
    });

    // Negative numbers cannot appear: the minus is the suffix marker, so
    // `bytes=-5` means "last five bytes", never "start at -5".
    it('cannot be talked into a negative start', () => {
      const result = parseRangeHeader('bytes=-5', SIZE);

      expect(result).toEqual({ kind: 'range', start: SIZE - 5, end: SIZE - 1 });
    });

    /** An empty file has no byte to point at, so every range misses. */
    it('rejects any range against an empty file', () => {
      expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
      expect(parseRangeHeader('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' });
      expect(parseRangeHeader('bytes=-1', 0)).toEqual({ kind: 'unsatisfiable' });
    });
  });

  describe('the length it implies', () => {
    it('is inclusive of both ends, which is what Content-Length must say', () => {
      const result = parseRangeHeader('bytes=0-1023', SIZE);

      expect(result).toEqual({ kind: 'range', start: 0, end: 1023 });
      if (result.kind === 'range') {
        // 1024 bytes, not 1023 — an off-by-one here truncates every response.
        expect(result.end - result.start + 1).toBe(1024);
      }
    });
  });
});
