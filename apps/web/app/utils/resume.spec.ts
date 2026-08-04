import { describe, expect, it } from 'vitest'

import { resumePoint } from './resume'

/**
 * The predicate decides where playback *starts*, not merely whether a button
 * appears, so every boundary here is a place someone lands rather than a label
 * that reads oddly.
 */
describe('resumePoint', () => {
  it('returns the position for someone part-way through', () => {
    expect(resumePoint(600, 3600)).toBe(600)
  })

  /**
   * The first seconds are the credits, the wrong episode, or a stream that was
   * opened and closed. Resuming into them offers nothing and costs a seek.
   */
  it('ignores the first five seconds', () => {
    expect(resumePoint(5, 3600)).toBeNull()
    expect(resumePoint(5.01, 3600)).toBe(5.01)
  })

  /**
   * Past 95% is a rewatch. Resuming there drops the viewer into the closing
   * titles of something they have already finished.
   */
  it('starts over rather than resuming into the last five per cent', () => {
    expect(resumePoint(3420, 3600)).toBeNull()
    expect(resumePoint(3419, 3600)).toBe(3419)
  })

  /**
   * A failed probe writes `durationSec: 0`, which is the same trap `completed`
   * has: `x < 0 * 0.95` is false for every position, so without the guard an
   * unprobed video would never resume — and with a naive one it would resume
   * anywhere. Neither is a decision worth making from a number nobody measured.
   */
  it('refuses to place a position inside a duration it does not know', () => {
    expect(resumePoint(600, 0)).toBeNull()
    expect(resumePoint(600, null)).toBeNull()
    expect(resumePoint(600, undefined)).toBeNull()
    expect(resumePoint(600, -1)).toBeNull()
  })

  it('has nothing to resume when nothing was stored', () => {
    expect(resumePoint(null, 3600)).toBeNull()
    expect(resumePoint(undefined, 3600)).toBeNull()
    expect(resumePoint(0, 3600)).toBeNull()
  })

  /** `NaN` is what `el.duration` reads as before metadata arrives. */
  it('survives the values a player produces before metadata loads', () => {
    expect(resumePoint(600, Number.NaN)).toBeNull()
    expect(resumePoint(Number.NaN, 3600)).toBeNull()
    expect(resumePoint(600, Number.POSITIVE_INFINITY)).toBeNull()
  })

  /**
   * A container can under-report its duration, so a stored position can sit
   * past the end of it. That is a finished video, not a resume point.
   */
  it('treats a position past the end as finished', () => {
    expect(resumePoint(3601, 3600)).toBeNull()
  })
})
