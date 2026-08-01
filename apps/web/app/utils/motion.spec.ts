import { describe, expect, it } from 'vitest'

import { shouldAutoplayTrailer } from './motion'

describe('shouldAutoplayTrailer', () => {
  const fine = { reducedMotion: false, saveData: false, effectiveType: '4g' }

  it('plays on an ordinary connection with motion allowed', () => {
    expect(shouldAutoplayTrailer(fine)).toBe(true)
  })

  /**
   * A hero that starts moving on its own is exactly what this preference is
   * about, so this is the one case that must never be got wrong.
   */
  it('does not play under reduced motion', () => {
    expect(shouldAutoplayTrailer({ ...fine, reducedMotion: true })).toBe(false)
  })

  it('does not play under save-data', () => {
    expect(shouldAutoplayTrailer({ ...fine, saveData: true })).toBe(false)
  })

  it.each(['slow-2g', '2g', '3g'])('does not play on %s', (effectiveType) => {
    expect(shouldAutoplayTrailer({ ...fine, effectiveType })).toBe(false)
  })

  /**
   * `navigator.connection` is not in every browser. An absent signal is not a
   * slow connection, and refusing on it would mean Firefox and Safari never
   * play a trailer at all.
   */
  it('plays when the browser reports no connection information', () => {
    expect(shouldAutoplayTrailer({ reducedMotion: false, saveData: false })).toBe(true)
    expect(shouldAutoplayTrailer({ reducedMotion: false, saveData: false, effectiveType: null })).toBe(
      true,
    )
  })

  it('plays on an effectiveType it has never heard of', () => {
    expect(shouldAutoplayTrailer({ ...fine, effectiveType: '6g' })).toBe(true)
  })
})
