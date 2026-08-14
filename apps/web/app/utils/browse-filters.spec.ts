import { describe, expect, it } from 'vitest'

import {
  ANY,
  DEFAULT_BROWSE_FILTERS,
  activeFilterChips,
  browseFiltersToQuery,
  browseSearchParams,
  parseBrowseFilters,
} from './browse-filters'

describe('parseBrowseFilters', () => {
  it('reads nothing out of an empty URL', () => {
    expect(parseBrowseFilters({})).toEqual(DEFAULT_BROWSE_FILTERS)
  })

  it('reads one genre and a list of them alike', () => {
    // Vue Router hands over a string for one and an array for several, and a
    // page that understands only one of those shapes silently drops the other.
    expect(parseBrowseFilters({ genre: 'Drama' }).genres).toEqual(['Drama'])
    expect(parseBrowseFilters({ genre: ['Drama', 'Horror'] }).genres).toEqual(['Drama', 'Horror'])
  })

  it('drops an empty or missing genre rather than filtering on nothing', () => {
    expect(parseBrowseFilters({ genre: '' }).genres).toEqual([])
    expect(parseBrowseFilters({ genre: [null] as never }).genres).toEqual([])
  })

  it('falls back to the default sort when the URL names one that does not exist', () => {
    // The URL is writable by anyone, so an unknown value is an ordinary input
    // rather than something worth breaking a page over.
    expect(parseBrowseFilters({ sort: 'rating' }).sort).toBe('title')
    expect(parseBrowseFilters({ sort: 'year' }).sort).toBe('year')
  })

  it('falls back to the sentinel when the URL names an unknown kind or state', () => {
    expect(parseBrowseFilters({ kind: 'PODCAST' }).kind).toBe(ANY)
    expect(parseBrowseFilters({ kind: 'FILM' }).kind).toBe('FILM')
    expect(parseBrowseFilters({ state: 'SPICY' }).state).toBe(ANY)
    expect(parseBrowseFilters({ state: 'DRAFT' }).state).toBe('DRAFT')
  })

  it('treats an unreadable offset as the first page', () => {
    expect(parseBrowseFilters({ offset: 'banana' }).offset).toBe(0)
    expect(parseBrowseFilters({ offset: '-5' }).offset).toBe(0)
    expect(parseBrowseFilters({ offset: '50' }).offset).toBe(50)
  })

  it('keeps the tag the collection pages link with', () => {
    expect(parseBrowseFilters({ tag: 'christmas' }).tag).toBe('christmas')
  })
})

describe('browseFiltersToQuery', () => {
  it('writes nothing for a page with no filters on it', () => {
    // A clean URL stays clean, so `/browse` is what you share when you have
    // narrowed nothing.
    expect(browseFiltersToQuery(DEFAULT_BROWSE_FILTERS)).toEqual({})
  })

  it('omits a filter left at its default rather than spelling it out', () => {
    expect(browseFiltersToQuery({ ...DEFAULT_BROWSE_FILTERS, sort: 'title' })).toEqual({})
    expect(browseFiltersToQuery({ ...DEFAULT_BROWSE_FILTERS, kind: ANY })).toEqual({})
  })

  it('round-trips everything it writes', () => {
    const filters = {
      q: 'rickman',
      genres: ['Drama', 'Horror'],
      tag: 'christmas',
      kind: 'FILM' as const,
      state: 'DRAFT',
      sort: 'year' as const,
      offset: 50,
    }

    expect(parseBrowseFilters(browseFiltersToQuery(filters))).toEqual(filters)
  })
})

describe('browseSearchParams', () => {
  it('asks for the first page of everything by default', () => {
    expect(browseSearchParams(DEFAULT_BROWSE_FILTERS)).toBe('limit=50&sort=title')
  })

  it('repeats the genre parameter, which is how the API reads a list', () => {
    const params = browseSearchParams({ ...DEFAULT_BROWSE_FILTERS, genres: ['Drama', 'Horror'] })

    expect(params).toContain('genre=Drama')
    expect(params).toContain('genre=Horror')
  })

  it('sends nothing for a sentinel, because the API has no value for "any"', () => {
    const params = browseSearchParams({ ...DEFAULT_BROWSE_FILTERS, kind: ANY, state: ANY })

    expect(params).not.toContain('kind')
    expect(params).not.toContain('state')
  })

  it('sends a chosen kind and state', () => {
    const params = browseSearchParams({
      ...DEFAULT_BROWSE_FILTERS,
      kind: 'SHOW',
      state: 'ARCHIVED',
    })

    expect(params).toContain('kind=SHOW')
    expect(params).toContain('state=ARCHIVED')
  })

  it('omits the offset on the first page and sends it afterwards', () => {
    expect(browseSearchParams(DEFAULT_BROWSE_FILTERS)).not.toContain('offset')
    expect(browseSearchParams({ ...DEFAULT_BROWSE_FILTERS, offset: 50 })).toContain('offset=50')
  })
})

describe('activeFilterChips', () => {
  it('says nothing when nothing is narrowed', () => {
    expect(activeFilterChips(DEFAULT_BROWSE_FILTERS)).toEqual([])
  })

  it('names each narrowing, and how to undo just that one', () => {
    const chips = activeFilterChips({
      ...DEFAULT_BROWSE_FILTERS,
      genres: ['Drama'],
      tag: 'christmas',
      kind: 'FILM',
    })

    expect(chips).toEqual([
      { label: 'Drama', clear: { genres: [] } },
      { label: 'Tagged “christmas”', clear: { tag: null } },
      { label: 'Films', clear: { kind: ANY } },
    ])
  })

  it('gives every genre its own chip, so one can go without the rest', () => {
    const chips = activeFilterChips({ ...DEFAULT_BROWSE_FILTERS, genres: ['Drama', 'Horror'] })

    expect(chips).toEqual([
      { label: 'Drama', clear: { genres: ['Horror'] } },
      { label: 'Horror', clear: { genres: ['Drama'] } },
    ])
  })

  it('does not chip the search box, which shows its own text', () => {
    expect(activeFilterChips({ ...DEFAULT_BROWSE_FILTERS, q: 'rickman' })).toEqual([])
  })

  it('names the lifecycle filter only an admin can set', () => {
    expect(activeFilterChips({ ...DEFAULT_BROWSE_FILTERS, state: 'DRAFT' })).toEqual([
      { label: 'Draft', clear: { state: ANY } },
    ])
  })
})
