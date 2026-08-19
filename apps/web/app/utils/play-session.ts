/**
 * A fresh play-session id, on origins where `crypto.randomUUID` does not exist.
 *
 * `randomUUID` is restricted to **secure contexts** — HTTPS, or localhost. Every
 * other origin gets `undefined`, and the player called it directly at setup, so
 * a component that works perfectly on `localhost:3000` threw
 * `crypto.randomUUID is not a function` the moment the same dev server was
 * opened from a phone at `http://192.168.178.x:3100`. Nuxt then replaced the
 * page with its error screen, which is the 500 that gets reported: not a server
 * fault at all, but hydration dying on the client.
 *
 * `getRandomValues` has no such restriction and is what the fallback is built
 * on, so the value is still random rather than guessable.
 *
 * It has to be a **real UUID**: `heartbeatSchema` in `packages/shared` declares
 * `playSessionId: z.uuid()`, so anything merely unique — a timestamp, a random
 * string — would be refused by the API on every beat, and the view count and
 * resume position would quietly stop being written.
 *
 * The bytes are stamped to version 4 and variant 1 (RFC 4122) for that reason:
 * zod checks the shape *and* those two fields, so raw random bytes fail it
 * about fifteen times in sixteen.
 */
export function newPlaySessionId(source: Partial<Crypto> | undefined = globalThis.crypto): string {
  if (typeof source?.randomUUID === 'function') return source.randomUUID()

  if (typeof source?.getRandomValues !== 'function') {
    // Nothing to be random with. Better to say so here than to send a value the
    // API refuses on every heartbeat for the rest of the session.
    throw new Error('no crypto source for a play session id')
  }

  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 1

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}
