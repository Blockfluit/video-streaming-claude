import { describe, expect, it } from 'vitest'

import { LISTENING, PLAYER_ORIGINS, readPlayerSignal } from './youtube-embed'

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
