import { describe, expect, it } from 'vitest'

import {
  filmography,
  headlineCrew,
  roleLabel,
  type FilmographyCredit,
  type HeadlineCredit,
} from './credits'

/**
 * The slug is derived from the name so a fixture reads as one person, and two
 * credits written the same way really are the same person — which is what the
 * deduplication turns on.
 */
const credit = (role: string, name: string): HeadlineCredit => ({
  role,
  person: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
})

const names = (group: { people: { name: string }[] }): string[] =>
  group.people.map(person => person.name)

describe('headlineCrew', () => {
  it('reads the three roles a film page leads with, in a fixed order', () => {
    const groups = headlineCrew([
      credit('COMPOSER', 'Bear McCreary'),
      credit('WRITER', 'Josh Campbell'),
      credit('DIRECTOR', 'Dan Trachtenberg'),
    ])

    expect(groups.map(g => g.label)).toEqual(['Directed by', 'Written by', 'Music by'])
    expect(names(groups[0]!)).toEqual(['Dan Trachtenberg'])
  })

  /** The headline is a row of links, so each name has to carry where it goes. */
  it('carries the slug alongside the name', () => {
    const groups = headlineCrew([credit('DIRECTOR', 'Dan Trachtenberg')])

    expect(groups[0]!.people).toEqual([
      { name: 'Dan Trachtenberg', slug: 'dan-trachtenberg' },
    ])
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

    expect(names(groups[0]!)).toEqual(['Josh Campbell', 'Matt Stuecken', 'Damien Chazelle'])
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

    expect(names(groups[0]!)).toEqual(['Josh Campbell', 'Matthew Stuecken'])
    expect(groups[0]!.more).toBe(0)
  })

  /**
   * The same bug, pinned against the way it would come back.
   *
   * Each credit carries its **own** person record — which is what the API
   * actually returns, one object per credit row. The deduplication used to be a
   * `Set` of name strings; a `Set` of these records dedupes nothing, because
   * two credits for one person are two distinct objects that are never equal.
   * Keying on the slug is what makes it work, and this case fails if anybody
   * reaches for identity again.
   */
  it('deduplicates on the person, not on the credit object', () => {
    const person = { name: 'Josh Campbell', slug: 'josh-campbell' }
    const groups = headlineCrew([
      { role: 'WRITER', person: { ...person } },
      { role: 'WRITER', person: { ...person } },
    ])

    expect(names(groups[0]!)).toEqual(['Josh Campbell'])
    expect(groups[0]!.more).toBe(0)
  })

  /** Two people really can share a name; they do not share a slug. */
  it('keeps two different people who happen to share a name', () => {
    const groups = headlineCrew([
      { role: 'WRITER', person: { name: 'Chris Weitz', slug: 'chris-weitz' } },
      { role: 'WRITER', person: { name: 'Chris Weitz', slug: 'chris-weitz-2' } },
    ])

    expect(groups[0]!.people).toHaveLength(2)
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

    expect(names(groups[0]!)).toEqual(['Zoe', 'Ada'])
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

describe('filmography', () => {
  const onVideo = (
    over: Partial<FilmographyCredit> = {},
    video: Partial<NonNullable<FilmographyCredit['video']>> = {},
  ): FilmographyCredit => ({
    id: 'credit-1',
    role: 'ACTOR',
    characterName: null,
    collection: null,
    video: { id: 'video-1', slug: 'the-film', title: 'The Film', collections: [], ...video },
    ...over,
  })

  /**
   * **The bug this util exists for.** The person page read
   * `credit.video.collection` — singular, and gone for months. The API returns
   * `collections`, a list of join rows, because a film may sit on several
   * shelves. Reading the old field threw nothing; it was `undefined`, so the
   * card silently lost its second line.
   */
  it('names the collection a video belongs to', () => {
    const [group] = filmography([
      onVideo({}, { collections: [{ collection: { id: 'c1', slug: 'saga', title: 'The Saga' } }] }),
    ])

    expect(group!.cards[0]!.subtitle).toBe('The Saga')
  })

  it('names all of them rather than picking one', () => {
    const [group] = filmography([
      onVideo({}, {
        collections: [
          { collection: { id: 'c1', slug: 'saga', title: 'The Saga' } },
          { collection: { id: 'c2', slug: 'boxset', title: 'The Box Set' } },
        ],
      }),
    ])

    expect(group!.cards[0]!.subtitle).toBe('The Saga · The Box Set')
  })

  /** A standalone film is the ordinary case, not a video missing its shelf. */
  it('has no second line for a video on no shelf at all', () => {
    expect(filmography([onVideo()])[0]!.cards[0]!.subtitle).toBeNull()
  })

  it('lets a character name win over the shelf', () => {
    const [group] = filmography([
      onVideo({ characterName: 'Trinity' }, {
        collections: [{ collection: { id: 'c1', slug: 'saga', title: 'The Saga' } }],
      }),
    ])

    expect(group!.cards[0]!.subtitle).toBe('Trinity')
  })

  it("uses a collection credit's year, and nothing when it has none", () => {
    const credit = (year: number | null): FilmographyCredit => ({
      id: 'c', role: 'DIRECTOR', characterName: null, video: null,
      collection: { id: 'col', slug: 'show', title: 'The Show', year },
    })

    expect(filmography([credit(1999)])[0]!.cards[0]!.subtitle).toBe('1999')
    expect(filmography([credit(null)])[0]!.cards[0]!.subtitle).toBeNull()
  })

  it('points a card at the record it stands for', () => {
    const groups = filmography([
      onVideo(),
      { id: 'c2', role: 'DIRECTOR', characterName: null, video: null,
        collection: { id: 'col', slug: 'show', title: 'The Show', year: null } },
    ])

    expect(groups.map(g => g.cards[0]!.kind)).toEqual(['video', 'collection'])
    expect(groups[0]!.cards[0]!.slug).toBe('the-film')
    expect(groups[1]!.cards[0]!.id).toBe('col')
  })

  /**
   * Postgres orders `role asc` by the enum's declaration order, which is the
   * editorial order. Re-sorting here would make it alphabetical, and a
   * filmography that opens with "Cinematographer" is not one.
   */
  it('groups by role in the order it was given', () => {
    const groups = filmography([
      onVideo({ id: 'a', role: 'ACTOR' }),
      onVideo({ id: 'b', role: 'DIRECTOR' }),
      onVideo({ id: 'c', role: 'ACTOR' }),
    ])

    expect(groups.map(g => g.role)).toEqual(['ACTOR', 'DIRECTOR'])
    expect(groups[0]!.cards).toHaveLength(2)
    expect(groups[0]!.label).toBe('Actor')
  })

  /** One title can hold two credits for one person, so the credit is the key. */
  it('keys a card on the credit rather than on the title', () => {
    const groups = filmography([
      onVideo({ id: 'credit-a', characterName: 'Young Neo' }),
      onVideo({ id: 'credit-b', characterName: 'Old Neo' }),
    ])

    expect(groups[0]!.cards.map(c => c.creditId)).toEqual(['credit-a', 'credit-b'])
  })

  it('drops a credit with neither a collection nor a video', () => {
    expect(filmography([
      { id: 'c', role: 'ACTOR', characterName: null, collection: null, video: null },
    ])).toEqual([])
  })

  it('has nothing to say about a person with no credits', () => {
    expect(filmography([])).toEqual([])
  })
})

describe('roleLabel', () => {
  it('sentence-cases the enum, so a role reads as a word', () => {
    expect(roleLabel('DIRECTOR')).toBe('Director')
    expect(roleLabel('CINEMATOGRAPHER')).toBe('Cinematographer')
  })

  it('copes with the degenerate cases rather than throwing on them', () => {
    expect(roleLabel('')).toBe('')
    expect(roleLabel('X')).toBe('X')
  })
})
