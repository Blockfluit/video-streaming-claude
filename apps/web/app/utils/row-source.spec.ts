import { ROW_SOURCE_SPECS, ROW_SOURCES } from '@video/shared'
import { describe, expect, it } from 'vitest'

import { rowSpec } from './row-source'

describe('rowSpec', () => {
  it.each(ROW_SOURCES)('returns the real spec for %s', (source) => {
    expect(rowSpec(source)).toBe(ROW_SOURCE_SPECS[source])
  })

  it('falls back rather than throwing on a source it has never heard of', () => {
    // The lookup that used to be inline: `ROW_SOURCE_SPECS[row.source].label`
    // throws on this, and a render that throws draws nothing — so one row from a
    // newer API blanked the entire screen.
    expect(() => rowSpec('BECAUSE_YOU_WATCHED')).not.toThrow()
  })

  it('names the unknown source, so an admin can still tell the rows apart', () => {
    expect(rowSpec('BECAUSE_YOU_WATCHED').label).toBe('BECAUSE_YOU_WATCHED')
  })

  it('offers no settings for one, rather than the wrong ones', () => {
    // `fields` drives which controls the form renders. Guessing here would show
    // a tag filter on a row that does not read tags.
    expect(rowSpec('BECAUSE_YOU_WATCHED').fields).toEqual([])
  })
})
