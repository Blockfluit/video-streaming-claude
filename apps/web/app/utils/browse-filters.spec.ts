import { describe, expect, it } from 'vitest'

import {
  ANY,
  DEFAULT_BROWSE_FILTERS,
  activeFilterChips,
  applyBrowseChange,
  browseFiltersToQuery,
  browseSearchParams,
  browseSortOptions,
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

  it('ignores a leftover offset rather than reading it as a filter', () => {
    // The page used to keep its position in the URL. A link written back then
    // still opens, and opens at the top — where a scroll position that meant
    // something on somebody else's screen belongs.
    expect(parseBrowseFilters({ offset: '50' })).toEqual(DEFAULT_BROWSE_FILTERS)
  })

  it('keeps the tag the collection pages link with', () => {
    expect(parseBrowseFilters({ tag: 'christmas' }).tag).toBe('christmas')
  })
})

describe('parseBrowseFilters — relevance', () => {
  it('reads relevance when there is a search to be relevant to', () => {
    expect(parseBrowseFilters({ q: 'matrix', sort: 'relevance' }).sort).toBe('relevance')
  })

  it('refuses relevance from a URL carrying no search', () => {
    // A bookmark saved mid-search, or a hand-edited address. Collapsed here so
    // that `/browse` and `/browse?sort=relevance` produce one query string
    // rather than two — `browsePlaceKey` is keyed on that string, so otherwise
    // one list would remember two scroll positions.
    expect(parseBrowseFilters({ sort: 'relevance' }).sort).toBe('title')
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
    expect(browseSearchParams(DEFAULT_BROWSE_FILTERS, 50)).toContain('offset=50')
  })

  it('asks for a bigger window when the scroll asks for one', () => {
    expect(browseSearchParams(DEFAULT_BROWSE_FILTERS, 50, 100)).toBe(
      'limit=100&sort=title&offset=50',
    )
  })

  /*
   * The filters alone are the identity of a list, which is what the saved
   * scroll position is keyed on. If a window ever leaked into that string, one
   * list would have a different key at every depth and coming back would never
   * find a place.
   */
  it('describes the same list the same way at any depth', () => {
    const filters = { ...DEFAULT_BROWSE_FILTERS, genres: ['Drama'] }

    expect(browseSearchParams(filters)).toBe(browseSearchParams(filters))
    expect(browseSearchParams(filters, 200, 100)).toContain('genre=Drama')
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

describe('applyBrowseChange', () => {
  const searching = { ...DEFAULT_BROWSE_FILTERS, q: 'matrix', sort: 'relevance' as const }

  it('selects Best match when a search begins', () => {
    // Typing a search and then reading the answer alphabetically is not what
    // anybody means by searching.
    expect(applyBrowseChange(DEFAULT_BROWSE_FILTERS, { q: 'matrix' }).sort).toBe('relevance')
  })

  it('puts Title back when the search is cleared', () => {
    expect(applyBrowseChange(searching, { q: '' }).sort).toBe('title')
  })

  it('leaves a sort somebody chose alone while they type', () => {
    // A control that undoes your decision every time you press a key is worse
    // than one that never helps.
    const byYear = { ...DEFAULT_BROWSE_FILTERS, sort: 'year' as const }

    expect(applyBrowseChange(byYear, { q: 'matrix' }).sort).toBe('year')
  })

  it('leaves a sort somebody chose alone when they clear the box', () => {
    const byYear = { ...DEFAULT_BROWSE_FILTERS, q: 'matrix', sort: 'year' as const }

    expect(applyBrowseChange(byYear, { q: '' }).sort).toBe('year')
  })

  it('takes an explicit choice in either direction', () => {
    expect(applyBrowseChange(searching, { sort: 'year' }).sort).toBe('year')
    expect(applyBrowseChange(DEFAULT_BROWSE_FILTERS, { sort: 'year' }).sort).toBe('year')
  })

  it('keeps Best match while the search is only being edited', () => {
    expect(applyBrowseChange(searching, { q: 'matrix reloaded' }).sort).toBe('relevance')
  })

  it('does not disturb the sort when some other filter moves', () => {
    expect(applyBrowseChange(searching, { genres: ['Drama'] }).sort).toBe('relevance')
    expect(applyBrowseChange(DEFAULT_BROWSE_FILTERS, { kind: 'FILM' }).sort).toBe('title')
  })
})

describe('browseSortOptions', () => {
  it('offers Best match only while there is a search, and offers it first', () => {
    expect(browseSortOptions(DEFAULT_BROWSE_FILTERS).map((option) => option.value)).toEqual([
      'title',
      'year',
      'added',
    ])

    expect(
      browseSortOptions({ ...DEFAULT_BROWSE_FILTERS, q: 'matrix' }).map((option) => option.value),
    ).toEqual(['relevance', 'title', 'year', 'added'])
  })

  it('names it for what it does rather than for the wire value', () => {
    expect(browseSortOptions({ ...DEFAULT_BROWSE_FILTERS, q: 'matrix' })[0]).toEqual({
      label: 'Best match',
      value: 'relevance',
    })
  })
})
