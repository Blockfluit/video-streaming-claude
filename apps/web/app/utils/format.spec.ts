import { describe, expect, it } from 'vitest'

import { progressPercent, runtime, timecode } from './format'

describe('timecode', () => {
  it('formats minutes and seconds', () => {
    expect(timecode(134)).toBe('2:14')
  })

  it('pads the seconds but not the minutes', () => {
    expect(timecode(65)).toBe('1:05')
  })

  /**
   * Omitted rather than shown as `0:02:14` — this has to match what a `<video>`
   * element displays, and what a comment pinned to a moment renders as.
   */
  it('leaves the hours out below an hour', () => {
    expect(timecode(3599)).toBe('59:59')
  })

  it('adds hours once there are any, padding the minutes', () => {
    expect(timecode(3600)).toBe('1:00:00')
    expect(timecode(3734)).toBe('1:02:14')
  })

  it('floors rather than rounds, so it never shows a second that has not arrived', () => {
    expect(timecode(59.9)).toBe('0:59')
  })

  it('survives the values a player actually produces before metadata loads', () => {
    expect(timecode(null)).toBe('0:00')
    expect(timecode(undefined)).toBe('0:00')
    expect(timecode(Number.NaN)).toBe('0:00')
    expect(timecode(-5)).toBe('0:00')
  })
})

describe('runtime', () => {
  it('reads as a runtime, not a timestamp', () => {
    expect(runtime(6420)).toBe('1h 47m')
    expect(runtime(720)).toBe('12m')
  })

  it('has nothing to say about an unprobed video', () => {
    expect(runtime(null)).toBeNull()
    expect(runtime(0)).toBeNull()
  })
})

describe('progressPercent', () => {
  it('is the fraction watched', () => {
    expect(progressPercent(300, 600)).toBe(50)
  })

  /**
   * A container can under-report its duration, leaving `lastPositionSec` a hair
   * past it — and a bar rendered at 100.3% overflows its track.
   */
  it('clamps a position past the end', () => {
    expect(progressPercent(601, 600)).toBe(100)
  })

  it('is zero when there is nothing to divide', () => {
    expect(progressPercent(null, 600)).toBe(0)
    expect(progressPercent(300, null)).toBe(0)
    expect(progressPercent(300, 0)).toBe(0)
  })
})
