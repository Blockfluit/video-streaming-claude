import { describe, expect, it } from 'vitest'

import { headlineCrew, type HeadlineCredit } from './credits'

const credit = (role: string, name: string): HeadlineCredit => ({ role, person: { name } })

describe('headlineCrew', () => {
  it('reads the three roles a film page leads with, in a fixed order', () => {
    const groups = headlineCrew([
      credit('COMPOSER', 'Bear McCreary'),
      credit('WRITER', 'Josh Campbell'),
      credit('DIRECTOR', 'Dan Trachtenberg'),
    ])

    expect(groups.map(g => g.label)).toEqual(['Directed by', 'Written by', 'Music by'])
    expect(groups[0]!.names).toEqual(['Dan Trachtenberg'])
  })

  /** An empty "Written by" reads as data that failed to load. */
  it('omits a role nobody is credited in', () => {
    const groups = headlineCrew([credit('DIRECTOR', 'Dan Trachtenberg')])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.label).toBe('Directed by')
  })

  it('has nothing to say about a title with no crew', () => {
    expect(headlineCrew([])).toEqual([])
    expect(headlineCrew([credit('ACTOR', 'John Goodman')])).toEqual([])
  })

  it('caps the names and says how many were left off', () => {
    const groups = headlineCrew([
      credit('WRITER', 'Josh Campbell'),
      credit('WRITER', 'Matt Stuecken'),
      credit('WRITER', 'Damien Chazelle'),
      credit('WRITER', 'A Fourth'),
      credit('WRITER', 'A Fifth'),
    ])

    expect(groups[0]!.names).toEqual(['Josh Campbell', 'Matt Stuecken', 'Damien Chazelle'])
    expect(groups[0]!.more).toBe(2)
  })

  it('reports nothing left off when everybody fits', () => {
    expect(headlineCrew([credit('DIRECTOR', 'Dan Trachtenberg')])[0]!.more).toBe(0)
  })

  /**
   * Found in a browser, on a real import. Story and Screenplay both collapse to
   * WRITER, so somebody credited for both was named twice in the same breath —
   * "Written by Josh Campbell, Matthew Stuecken, Josh Campbell".
   */
  it('names somebody once even when two of their jobs share a role', () => {
    const groups = headlineCrew([
      credit('WRITER', 'Josh Campbell'),
      credit('WRITER', 'Matthew Stuecken'),
      credit('WRITER', 'Josh Campbell'),
    ])

    expect(groups[0]!.names).toEqual(['Josh Campbell', 'Matthew Stuecken'])
    expect(groups[0]!.more).toBe(0)
  })

  /**
   * The server's order is total and deliberate; re-sorting here would let the
   * line reshuffle between identical requests, which reads as a rendering bug.
   */
  it('keeps the order it was given', () => {
    const groups = headlineCrew([
      credit('WRITER', 'Zoe'),
      credit('WRITER', 'Ada'),
    ])

    expect(groups[0]!.names).toEqual(['Zoe', 'Ada'])
  })

  it('ignores the crew that live behind the toggle', () => {
    const groups = headlineCrew([
      credit('PRODUCER', 'J.J. Abrams'),
      credit('CINEMATOGRAPHER', 'Jeff Cutter'),
      credit('EDITOR', 'Stefan Grube'),
      credit('OTHER', 'A Stunt Coordinator'),
    ])

    expect(groups).toEqual([])
  })
})
