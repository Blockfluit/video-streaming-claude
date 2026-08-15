import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMBED_ORIGIN, LISTENING, PLAYER_ORIGINS, readPlayerSignal, subscribeToPlayer } from './youtube-embed'

/** What the embed actually posts: a JSON *string*, not an object. */
function posted(payload: unknown): string {
  return JSON.stringify(payload)
}

const ORIGIN = 'https://www.youtube-nocookie.com'

describe('readPlayerSignal', () => {
  it('reads a start out of a PLAYING state change', () => {
    expect(readPlayerSignal(ORIGIN, posted({ event: 'onStateChange', info: 1 }))).toBe('playing')
  })

  it('reads it from the other YouTube host too', () => {
    // The embed is served from the no-cookie host, but the player has been
    // observed posting from the plain one. Accepting only the host in the `src`
    // is how the reveal silently never happens.
    expect(readPlayerSignal('https://www.youtube.com', posted({ event: 'onStateChange', info: 1 })))
      .toBe('playing')
  })

  /**
   * The whole point of the handshake. A video that is private, deleted, or that
   * its owner does not allow to be embedded says so — and the hero has to stay
   * on the banner rather than fade a grey error card over the artwork.
   */
  it.each([2, 5, 100, 101, 150])('reads a failure out of error %i', (code) => {
    expect(readPlayerSignal(ORIGIN, posted({ event: 'onError', info: code }))).toBe('failed')
  })

  /**
   * Origin is the only thing separating the player from every other frame,
   * extension and script posting at this window. Without the check, anything at
   * all could reveal a trailer that never started.
   */
  it.each([
    'https://evil.example',
    'https://youtube.com.evil.example',
    'https://notyoutube.com',
    'null',
    '',
  ])('ignores a message from %s', (origin) => {
    expect(readPlayerSignal(origin, posted({ event: 'onStateChange', info: 1 }))).toBeNull()
  })

  it('tolerates the payload arriving already parsed', () => {
    expect(readPlayerSignal(ORIGIN, { event: 'onStateChange', info: 1 })).toBe('playing')
  })

  /**
   * A `message` handler that throws takes out every later listener on the page,
   * and this one hears everything the window is sent — including plenty that is
   * not JSON at all.
   */
  it.each([
    ['malformed JSON', '{not json'],
    ['a bare string', 'hello'],
    ['null', null],
    ['a number', 7],
    ['an array', [1, 2, 3]],
  ])('ignores %s rather than throwing', (_name, data) => {
    expect(() => readPlayerSignal(ORIGIN, data)).not.toThrow()
    expect(readPlayerSignal(ORIGIN, data)).toBeNull()
  })

  /**
   * `infoDelivery` arrives several times a second while a video plays. Treating
   * anything that is not an error as a start would reveal a player that is still
   * buffering, which is the black rectangle this exists to avoid.
   */
  it.each([
    ['a time update', { event: 'infoDelivery', info: { currentTime: 3.2 } }],
    ['readiness', { event: 'onReady' }],
    ['unstarted', { event: 'onStateChange', info: -1 }],
    ['buffering', { event: 'onStateChange', info: 3 }],
    ['paused', { event: 'onStateChange', info: 2 }],
    ['ended', { event: 'onStateChange', info: 0 }],
    ['no event at all', { info: 1 }],
  ])('says nothing about %s', (_name, payload) => {
    expect(readPlayerSignal(ORIGIN, posted(payload))).toBeNull()
  })
})

describe('LISTENING', () => {
  /**
   * The embed posts nothing until it is subscribed to, so this string is what
   * makes every assertion above reachable at all. Pinned as JSON rather than
   * built at the call site because a `channel` of anything but `widget` is
   * ignored in silence.
   */
  it('is the subscribe message the embed answers', () => {
    expect(JSON.parse(LISTENING)).toEqual({ event: 'listening', id: 1, channel: 'widget' })
  })
})

describe('PLAYER_ORIGINS', () => {
  it('is exactly the two hosts an embed is served from', () => {
    expect([...PLAYER_ORIGINS]).toEqual([
      'https://www.youtube-nocookie.com',
      'https://www.youtube.com',
    ])
  })
})

/**
 * The retry is the whole point of this helper, and it is exactly the kind of
 * thing that looks right and does nothing: a single `postMessage` at `load`
 * lands before the player has a listener, and the silence that follows is
 * indistinguishable from an embed with nothing to say.
 */
describe('subscribeToPlayer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Only the one property the helper touches, so no DOM is needed. */
  function fakeFrame() {
    return { contentWindow: { postMessage: vi.fn<(message: string, targetOrigin: string) => void>() } }
  }

  it('asks immediately rather than waiting out the first interval', () => {
    const frame = fakeFrame()
    subscribeToPlayer(frame)

    expect(frame.contentWindow.postMessage).toHaveBeenCalledTimes(1)
    expect(frame.contentWindow.postMessage).toHaveBeenCalledWith(LISTENING, EMBED_ORIGIN)
  })

  it('keeps asking, because the first ask lands before the player is listening', () => {
    const frame = fakeFrame()
    subscribeToPlayer(frame, 300, 4000)

    vi.advanceTimersByTime(900)
    expect(frame.contentWindow.postMessage).toHaveBeenCalledTimes(4)
  })

  // A page left posting at a third party forever is its own bug.
  it('gives up eventually', () => {
    const frame = fakeFrame()
    subscribeToPlayer(frame, 300, 1000)

    vi.advanceTimersByTime(1000)
    const asked = frame.contentWindow.postMessage.mock.calls.length

    vi.advanceTimersByTime(10_000)
    expect(frame.contentWindow.postMessage).toHaveBeenCalledTimes(asked)
  })

  it('stops when cancelled, so a torn-down trailer stops talking', () => {
    const frame = fakeFrame()
    const cancel = subscribeToPlayer(frame, 300, 4000)

    vi.advanceTimersByTime(300)
    cancel()
    vi.advanceTimersByTime(3000)

    expect(frame.contentWindow.postMessage).toHaveBeenCalledTimes(2)
  })

  /**
   * A cross-origin iframe that has been removed from the document reports a null
   * `contentWindow`, and this runs on a timer that can outlive the element.
   */
  it('tolerates a frame that has gone away', () => {
    expect(() => {
      const cancel = subscribeToPlayer({ contentWindow: null })
      vi.advanceTimersByTime(1000)
      cancel()
    }).not.toThrow()
  })
})
