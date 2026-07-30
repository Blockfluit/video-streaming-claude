/**
 * Parsing a `Range` request header — pure, so the awkward cases can be
 * enumerated without a file or a socket.
 *
 * This is the piece that makes seeking work. `StreamableFile` alone answers
 * `200` with the whole body, and a browser that cannot get a `206` cannot seek:
 * dragging the scrubber does nothing, and the timeline never appears.
 */

/**
 * How much an open-ended range (`bytes=500-`) returns.
 *
 * A `<video>` element opens with `bytes=0-` and would otherwise be sent the
 * entire file — gigabytes, to answer a request for the metadata at the front.
 * The player asks for more as it plays.
 */
export const STREAM_CHUNK_BYTES = 1024 * 1024;

export type RangeRequest =
  /** No range to honour — answer `200` with the whole body. */
  | { kind: 'none' }
  /** Inclusive of both ends, as `Content-Range` is. */
  | { kind: 'range'; start: number; end: number }
  /** Syntactically a byte range, but not one this file can satisfy — answer `416`. */
  | { kind: 'unsatisfiable' };

/** `start-end`, `start-`, or `-suffixLength`. Digits only: the leading `-` is the suffix marker. */
const BYTE_RANGE = /^\s*(\d*)\s*-\s*(\d*)\s*$/;

/**
 * @param header the raw `Range` header, if any
 * @param size the size of the file being served, in bytes
 */
export function parseRangeHeader(header: string | undefined, size: number): RangeRequest {
  if (!header) return { kind: 'none' };

  const separator = header.indexOf('=');
  if (separator === -1) return { kind: 'none' };

  const unit = header.slice(0, separator).trim().toLowerCase();
  // RFC 7233: a range unit we do not understand must be ignored, not rejected.
  if (unit !== 'bytes') return { kind: 'none' };

  const spec = header.slice(separator + 1);

  // Multiple ranges need a `multipart/byteranges` body to answer honestly.
  // Ignoring the header and sending the whole file is equally legal and is what
  // every video client copes with.
  if (spec.includes(',')) return { kind: 'none' };

  const match = BYTE_RANGE.exec(spec);
  if (!match) return { kind: 'unsatisfiable' };

  const [, rawStart, rawEnd] = match;

  // `bytes=-` says nothing at all.
  if (rawStart === '' && rawEnd === '') return { kind: 'unsatisfiable' };

  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0 || size === 0) return { kind: 'unsatisfiable' };

    return { kind: 'range', start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  // A start at or past the end has no bytes behind it. This also covers an
  // empty file, where every range misses.
  if (start >= size) return { kind: 'unsatisfiable' };

  if (rawEnd === '') {
    // Open-ended: one chunk, or the rest of the file if that is shorter.
    return { kind: 'range', start, end: Math.min(start + STREAM_CHUNK_BYTES - 1, size - 1) };
  }

  const requestedEnd = Number(rawEnd);
  if (requestedEnd < start) return { kind: 'unsatisfiable' };

  // An end past the file is not an error — it means "to the end".
  return { kind: 'range', start, end: Math.min(requestedEnd, size - 1) };
}
