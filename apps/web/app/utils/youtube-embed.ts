/**
 * Hearing whether a YouTube embed actually started.
 *
 * The hero shows its banner and fades the trailer over it. Fading it in blindly
 * is what it used to do, and it is wrong in the one case that matters: when the
 * video will not play — autoplay refused, embedding disabled by the owner, the
 * video pulled — YouTube paints its own grey "Video unavailable" card, and that
 * card is what got faded across the artwork. The banner is the fallback, so the
 * page has to know whether to use it.
 *
 * `enablejsapi=1` is already in the embed URL, and it is enough on its own: the
 * player answers a `postMessage` handshake without the `iframe_api` script being
 * loaded. Sending {@link LISTENING} at the iframe subscribes to its events, and
 * it then posts `onReady`, `onStateChange` and `onError` back. That avoids
 * pulling a third-party script into every page — which is the same instinct that
 * put the embed on the no-cookie host and kept the request from happening at all
 * until the trailer starts.
 *
 * The classification is pure and lives here so it can be tested without a
 * browser: the handler around it is four lines, and this is where the mistakes
 * are.
 */

/** Subscribes to the player's events. It posts nothing until it receives this. */
export const LISTENING = JSON.stringify({ event: 'listening', id: 1, channel: 'widget' })

/**
 * Both, deliberately. The `src` is the no-cookie host, but the player posts from
 * the plain one in some versions, and accepting only the host in the `src` is a
 * reveal that silently never happens.
 */
export const EMBED_ORIGIN = 'https://www.youtube-nocookie.com'

export const PLAYER_ORIGINS = [
  EMBED_ORIGIN,
  'https://www.youtube.com',
] as const

/** `null` means "not something worth acting on", which is nearly every message. */
export type PlayerSignal = 'playing' | 'failed' | null

/** `1` is PLAYING. The rest — unstarted, ended, paused, buffering — are not. */
const PLAYING = 1

/**
 * What, if anything, a `message` event says about the trailer.
 *
 * Deliberately narrow. `infoDelivery` arrives several times a second during
 * playback and says nothing about whether the picture is up yet, so treating
 * "not an error" as a start would reveal a black rectangle that is still
 * buffering. Only PLAYING means playing.
 *
 * The origin check is the only thing separating the player from every other
 * frame, extension and script posting at this window — a listener on `window`
 * hears all of them.
 */
export function readPlayerSignal(origin: string, data: unknown): PlayerSignal {
  if (!(PLAYER_ORIGINS as readonly string[]).includes(origin)) return null

  const message = parse(data)
  if (!message) return null

  if (message.event === 'onError') return 'failed'
  if (message.event === 'onStateChange' && message.info === PLAYING) return 'playing'

  return null
}

/**
 * The embed posts a JSON *string*, but a parsed object is accepted too — a stub
 * in a test, or a future version of the player, should not be the reason this
 * stops working.
 *
 * Never throws. This runs inside a `message` handler that is sent everything the
 * page receives, most of which is not JSON, and an exception there takes out the
 * listener along with the trailer.
 */
function parse(data: unknown): { event?: unknown, info?: unknown } | null {
  if (typeof data === 'string') {
    try {
      return parse(JSON.parse(data))
    }
    catch {
      return null
    }
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null

  return data as { event?: unknown, info?: unknown }
}
