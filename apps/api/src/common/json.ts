/**
 * `JSON.stringify` throws on a BigInt rather than serialising it, and
 * `Video.sizeBytes` is one.
 *
 * Rendered as a **string**, not a number: a file over 9 PB would lose precision
 * as a JSON number, and more practically a client that reads it as a number
 * cannot tell a rounded value from an exact one. Strings are unambiguous, and
 * a size is displayed far more often than it is arithmetic.
 */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
