import { describe, expect, it } from 'vitest'

import { collectionChip } from './kinds'

describe('collectionChip', () => {
  it('counts the seasons of a series', () => {
    expect(collectionChip({ seasonsHere: 3, videosHere: 40 })).toBe('3 seasons')
  })

  /**
   * Seasons win over videos. A show holds far more episodes than seasons, and
   * "40 films" would be both wrong and the more prominent of the two numbers.
   */
  it('says nothing about the episodes of a series', () => {
    expect(collectionChip({ seasonsHere: 1, videosHere: 12 })).toBe('1 season')
  })

  it('counts the films of a shelf that has no seasons', () => {
    expect(collectionChip({ seasonsHere: 0, videosHere: 8 })).toBe('8 films')
  })

  it('singularises both, because "1 films" reads as a bug', () => {
    expect(collectionChip({ seasonsHere: 0, videosHere: 1 })).toBe('1 film')
  })

  /**
   * An empty shelf is still a shelf, and still not a film. A card with no chip
   * at all means "this is a video", so an empty collection must not borrow it.
   */
  it('names an empty collection rather than counting nothing', () => {
    expect(collectionChip({ seasonsHere: 0, videosHere: 0 })).toBe('Collection')
  })

  /**
   * A payload from before the counts existed must not render "series". Absent
   * is not zero-and-known, but both settle on the safe, generic word.
   */
  it('falls back when the counts are missing', () => {
    expect(collectionChip({})).toBe('Collection')
    expect(collectionChip({ seasonsHere: null, videosHere: null })).toBe('Collection')
  })
})
