/**
 * Small checks on subtitle bytes, kept pure and separate because both are
 * about the kind of failure that is silent rather than loud.
 */

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Removes a UTF-8 byte-order mark, which Windows editors add and nothing else wants. */
export function stripBom(buffer: Buffer): Buffer {
  return buffer.subarray(0, 3).equals(BOM) ? buffer.subarray(3) : buffer;
}

/**
 * True when the bytes really are WebVTT.
 *
 * An uploaded file claiming to be a subtitle but holding an SRT loads as an
 * empty track — the player shows a language the viewer can select and nothing
 * appears. Better to refuse it at the door.
 *
 * The signature is `WEBVTT`, optionally followed by a space, tab or a line
 * break. A BOM in front is tolerated because browsers tolerate it.
 */
export function isWebVtt(buffer: Buffer): boolean {
  const head = stripBom(buffer).subarray(0, 16).toString('latin1');

  if (!head.startsWith('WEBVTT')) return false;

  // The header ends there, so what follows must be whitespace or nothing.
  const next = head.charAt(6);
  return next === '' || next === ' ' || next === '\t' || next === '\n' || next === '\r';
}

/** How much of a file to examine. Enough to catch an accented character early on. */
const SNIFF_BYTES = 64 * 1024;

/**
 * Whether a file decodes as UTF-8.
 *
 * Legacy `.srt` files are very often Windows-1252. Handing one to ffmpeg as
 * UTF-8 does not fail — it produces mojibake, and nobody notices until a viewer
 * reads a line. Detecting it lets the conversion retry with the right charset.
 *
 * Only the start is examined: a subtitle with an accent in it will have one
 * within the first few kilobytes, and decoding a whole file to answer a yes/no
 * question is wasteful.
 */
export function isProbablyUtf8(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, SNIFF_BYTES);

  // TextDecoder in fatal mode throws on any sequence that is not valid UTF-8.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    // The sample may have been cut mid-character. Retry a little shorter before
    // blaming the file — otherwise a multi-byte character straddling the
    // boundary would look like corruption.
    if (buffer.length <= SNIFF_BYTES) return false;

    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, SNIFF_BYTES - 4));
      return true;
    } catch {
      return false;
    }
  }
}
