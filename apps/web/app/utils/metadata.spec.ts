import { describe, expect, it } from 'vitest'

import { metadataSearchQuery } from './metadata'

describe('metadataSearchQuery', () => {
  it('asks for the first window without an offset', () => {
    expect(metadataSearchQuery('Arrival', 'both', null, 0, 20)).toBe(
      '/admin/metadata/search?title=Arrival&limit=20',
    )
  })

  it('asks for the window after the first', () => {
    expect(metadataSearchQuery('Arrival', 'both', null, 20, 20)).toBe(
      '/admin/metadata/search?title=Arrival&limit=20&offset=20',
    )
  })

  it('narrows by kind when it is not "both"', () => {
    expect(metadataSearchQuery('Arrival', 'movie', null, 0, 20)).toContain('type=movie')
  })

  it('leaves the kind out when it is "both"', () => {
    expect(metadataSearchQuery('Arrival', 'both', null, 0, 20)).not.toContain('type=')
  })

  it('carries a year filter through to later windows too', () => {
    expect(metadataSearchQuery('Arrival', 'both', 2016, 20, 20)).toContain('year=2016')
  })

  it('leaves the year out when it is null or undefined', () => {
    expect(metadataSearchQuery('Arrival', 'both', null, 0, 20)).not.toContain('year')
    expect(metadataSearchQuery('Arrival', 'both', undefined, 0, 20)).not.toContain('year')
  })
})
