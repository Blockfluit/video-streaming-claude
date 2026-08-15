/**
 * Hearing whether a YouTube embed has failed.
 *
 * The hero shows its banner and fades the trailer over it. When a video will not
 * play — embedding disabled by the owner, the video pulled — YouTube paints its
 * own grey "Video unavailable" card, and fading *that* over the artwork is worse
 * than the banner the page already has. So the page listens, and retreats to the
 * banner when the player says it has failed.
 *
 * **What it must never do is wait for permission to start.** An earlier version
 * gated the reveal on hearing `onStateChange / info: 1` and unmounted the iframe
 * if that never arrived. It never arrived — the embed does not reliably answer
 * — so every viewer got the banner and nothing else, on every title, while the
 * test suite passed against a stub that always answered. Silence now means
 * "carry on"; only an error means stop.
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
 * Ask to be subscribed, repeatedly, until the embed answers.
 *
 * Posting once is not enough and that is very likely why nothing was ever heard.
 * An iframe's `load` fires when its *document* arrives, which is before the
 * player's own script has attached its `message` listener — so a single message
 * sent at that moment lands on nothing, and the embed never asks again. Nothing
 * reports this: the page simply hears silence forever.
 *
 * Returns its own canceller rather than taking a signal, because the two things
 * that end it — an answer arriving, and the trailer being torn down — live in
 * different places in the component.
 */
export function subscribeToPlayer(
  /**
   * Structural rather than `HTMLIFrameElement`, which an `<iframe>` satisfies and
   * a test fake can too — this needs no DOM to be worth testing. `null` is the
   * ordinary state of a frame that has been removed while the timer still runs.
   */
  frame: { contentWindow: { postMessage: (message: string, targetOrigin: string) => void } | null },
  everyMs = 300,
  forMs = 4000,
): () => void {
  const post = (): void => {
    frame.contentWindow?.postMessage(LISTENING, EMBED_ORIGIN)
  }

  post()
  const repeat = setInterval(post, everyMs)
  // Bounded: an embed that has not answered in four seconds is not going to, and
  // a page left posting at a third party forever is its own bug.
  const giveUp = setTimeout(() => clearInterval(repeat), forMs)

  return () => {
    clearInterval(repeat)
    clearTimeout(giveUp)
  }
}

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
