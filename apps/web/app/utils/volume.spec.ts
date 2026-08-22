import { describe, expect, it } from 'vitest'

import { parseVolume } from './volume'

/**
 * What comes back from `localStorage` is a string anyone can edit, left by some
 * other version of this code, or absent — and the value it decides is
 * `HTMLMediaElement.volume`, which **throws** on anything outside 0–1 and on
 * `NaN`. A thrown setter in `onMounted` takes the whole player down, so every
 * unusable reading here has to become `null` — meaning "leave the browser's own
 * volume alone" — rather than a number nobody checked.
 */
describe('parseVolume', () => {
  it('reads back what was stored', () => {
    expect(parseVolume('{"volume":0.4,"muted":false}')).toEqual({ volume: 0.4, muted: false })
  })

  it('keeps a muted viewer muted', () => {
    expect(parseVolume('{"volume":0.8,"muted":true}')).toEqual({ volume: 0.8, muted: true })
  })

  /**
   * Silent and muted are different states — the native control draws them
   * differently and unmuting restores the slider — so a volume of zero is a
   * reading rather than a missing one.
   */
  it('treats a volume of zero as a choice, not an absence', () => {
    expect(parseVolume('{"volume":0,"muted":false}')).toEqual({ volume: 0, muted: false })
  })

  /** Nothing stored yet. The browser's own default is the right answer. */
  it('has no opinion when nothing was stored', () => {
    expect(parseVolume(null)).toBeNull()
  })

  it('has no opinion about something that is not a stored reading', () => {
    expect(parseVolume('0.5')).toBeNull()
    expect(parseVolume('not json at all')).toBeNull()
    expect(parseVolume('null')).toBeNull()
    expect(parseVolume('[0.5]')).toBeNull()
  })

  /**
   * `el.volume = NaN` throws a `TypeError`, and so does a string. These are the
   * readings that would end playback rather than adjust it.
   */
  it('refuses a volume that is not a finite number', () => {
    expect(parseVolume('{"volume":"0.5","muted":false}')).toBeNull()
    expect(parseVolume('{"volume":null,"muted":false}')).toBeNull()
    expect(parseVolume('{"muted":true}')).toBeNull()
  })

  /**
   * Clamped rather than refused: a value slightly outside the range is a
   * rounding artefact from whatever wrote it, and the viewer's intent — loud,
   * or nearly silent — is still legible in it.
   */
  it('clamps a volume from outside the range', () => {
    expect(parseVolume('{"volume":1.4,"muted":false}')).toEqual({ volume: 1, muted: false })
    expect(parseVolume('{"volume":-2,"muted":false}')).toEqual({ volume: 0, muted: false })
  })

  /**
   * Only a literal `true` mutes. Coercing would read the string `"false"` —
   * which is what a hand-edited entry produces — as a reason to start something
   * silently.
   */
  it('mutes only on a real boolean', () => {
    expect(parseVolume('{"volume":0.5,"muted":"false"}')).toEqual({ volume: 0.5, muted: false })
    expect(parseVolume('{"volume":0.5}')).toEqual({ volume: 0.5, muted: false })
  })
})
